import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { isSyntheticToolResultMessage } from "@oh-my-pi/pi-agent-core";
import {
	collectPendingToolCalls,
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	describePendingToolCalls,
	SESSION_EXIT_CUSTOM_TYPE,
	TOOL_EXECUTION_START_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import {
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { copySessionArtifacts, SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getTerminalId } from "@oh-my-pi/pi-tui";
import { isTaskToolDetails, type TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { getAgentDir, getTerminalSessionsDir, removeWithRetries, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { withArtifactPublicationLock } from "../../src/session/artifact-publication";
import {
	writeArtifact,
	artifactFileGeneration,
	serializeStructuredArtifactSidecar,
	parseStructuredArtifactSidecar,
} from "../../src/session/artifacts";
import { promises } from "node:fs";

interface JsonlMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: {
		role: "user";
		content: string;
		timestamp: number;
	};
}

async function createSessionWithArtifacts(root: string): Promise<{
	cwd: string;
	sessionDir: string;
	sourceFile: string;
	sourceArtifactsDir: string;
}> {
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	const sourceFile = path.join(sessionDir, "source.jsonl");
	const sourceArtifactsDir = sourceFile.slice(0, -".jsonl".length);
	const sourceHeader: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: "source-with-artifacts",
		timestamp: new Date().toISOString(),
		cwd,
	};
	await fs.mkdir(path.join(sourceArtifactsDir, "nested"), { recursive: true });
	await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
	await Bun.write(path.join(sourceArtifactsDir, "1.read.log"), "tool output");
	await Bun.write(path.join(sourceArtifactsDir, "nested", "result.txt"), "nested output");
	return { cwd, sessionDir, sourceFile, sourceArtifactsDir };
}

/** Load a session file's transcript entries, dropping the non-entry session header. */
async function loadHistory(file: string): Promise<SessionEntry[]> {
	const entries = await loadEntriesFromFile(file);
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

async function writeStructuredArtifact(dir: string, id: string, data: unknown, markdown: string): Promise<string> {
	return withArtifactPublicationLock(async () => {
		const primary = path.join(dir, `${id}.md`);
		await fs.mkdir(path.dirname(primary), { recursive: true });
		await writeArtifact(primary, markdown);
		const generation = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
		await fs.writeFile(
			path.join(dir, `${id}.json`),
			serializeStructuredArtifactSidecar(JSON.stringify(data), generation),
		);
		return generation;
	});
}

async function readStructuredArtifact(dir: string, id: string): Promise<unknown> {
	const primary = path.join(dir, `${id}.md`);
	const generation = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
	try {
		return parseStructuredArtifactSidecar(await fs.readFile(path.join(dir, `${id}.json`), "utf8"), generation)?.data;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

describe("structured fork artifacts", () => {
	it("preserves complete schema-invalid results through persisted fork and cold reopen", async () => {
		using root = TempDir.createSync("@omp-structured-fork-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		const data = { invalidForSchema: "complete submitted data".repeat(10_000), sentinel: "not in the preview" };
		const markdown = "Schema validation failed. Submitted preview: complete submitted data…";
		const sourceGenerations = new Map<string, string>();
		for (const id of ["Worker", "nested/Worker"]) {
			sourceGenerations.set(id, await writeStructuredArtifact(sourceArtifactsDir, id, data, markdown));
		}
		const fork = await SessionManager.forkFrom(sourceFile, cwd, sessionDir);
		const forkFile = fork.getSessionFile()!;
		try {
			fork.appendMessage({ role: "user", content: "Keep the fork and its complete result", timestamp: 1 });
			await fork.flush();
			const destination = fork.getArtifactsDir()!;
			for (const id of sourceGenerations.keys()) {
				expect(await fs.readFile(path.join(destination, `${id}.md`), "utf8")).toBe(markdown);
				expect(
					artifactFileGeneration(await fs.stat(path.join(destination, `${id}.md`), { bigint: true })),
				).not.toBe(sourceGenerations.get(id));
				expect(await readStructuredArtifact(destination, id)).toEqual(data);
				expect(await readStructuredArtifact(sourceArtifactsDir, id)).toEqual(data);
			}
		} finally {
			await fork.close();
		}
		const reopened = await SessionManager.open(forkFile, sessionDir);
		try {
			expect(await readStructuredArtifact(reopened.getArtifactsDir()!, "Worker")).toEqual(data);
			expect(await readStructuredArtifact(reopened.getArtifactsDir()!, "nested/Worker")).toEqual(data);
		} finally {
			await reopened.close();
		}
	});

	it.each(["stale", "legacy"] as const)("does not rebind a %s sidecar onto a copied primary", async state => {
		using root = TempDir.createSync("@omp-unbound-fork-");
		const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		const markdown = "The current non-JSON Markdown result";
		await writeStructuredArtifact(sourceArtifactsDir, "Worker", { privateResult: "older generation" }, markdown);
		if (state === "stale") await writeArtifact(path.join(sourceArtifactsDir, "Worker.md"), markdown);
		else await fs.writeFile(path.join(sourceArtifactsDir, "Worker.json"), '{"privateResult":"legacy unbound data"}');
		const destinationFile = path.join(sessionDir, "copied.jsonl");
		await copySessionArtifacts(sourceFile, destinationFile);
		const destination = destinationFile.slice(0, -6);
		expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe(markdown);
		expect(await readStructuredArtifact(destination, "Worker")).toBeUndefined();
	});

	it.each(["md", "json"] as const)(
		"preserves an occupied destination %s and never makes its sidecar authoritative",
		async kind => {
			using root = TempDir.createSync("@omp-occupied-fork-");
			const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
			await writeStructuredArtifact(sourceArtifactsDir, "Worker", { from: "source" }, "Source report");
			const destinationFile = path.join(sessionDir, "occupied.jsonl");
			const destination = destinationFile.slice(0, -6);
			await fs.mkdir(destination);
			const occupied = path.join(destination, `Worker.${kind}`);
			await fs.writeFile(occupied, "Destination-owned content");
			await copySessionArtifacts(sourceFile, destinationFile);
			expect(await fs.readFile(occupied, "utf8")).toBe("Destination-owned content");
			expect(await readStructuredArtifact(destination, "Worker")).toBeUndefined();
			if (kind === "md")
				await expect(fs.stat(path.join(destination, "Worker.json"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(path.join(destination, "1.read.log"), "utf8")).toBe("tool output");
			expect(await fs.readFile(path.join(destination, "nested/result.txt"), "utf8")).toBe("nested output");
		},
	);

	it("rejects a source pair replaced while its Markdown is being copied", async () => {
		using root = TempDir.createSync("@omp-changing-fork-");
		const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		await writeStructuredArtifact(sourceArtifactsDir, "Worker", { generation: "old" }, "Schema error preview");
		const primary = await fs.realpath(path.join(sourceArtifactsDir, "Worker.md"));
		const copyFile = promises.copyFile;
		let replaced = false;
		const copy = vi.spyOn(promises, "copyFile").mockImplementation(async (...args) => {
			await copyFile(...args);
			if (args[0] === primary && !replaced) {
				replaced = true;
				await writeStructuredArtifact(sourceArtifactsDir, "Worker", { generation: "new" }, "Schema error preview");
			}
		});
		const destinationFile = path.join(sessionDir, "changing.jsonl");
		try {
			await copySessionArtifacts(sourceFile, destinationFile);
		} finally {
			copy.mockRestore();
		}
		expect(replaced).toBe(true);
		expect(await readStructuredArtifact(sourceArtifactsDir, "Worker")).toEqual({ generation: "new" });
		await expect(fs.stat(path.join(destinationFile.slice(0, -6), "Worker.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it.each([false, true])(
		"preserves a coordinated accepted replacement after sidecar staging (failure: %s)",
		async fail => {
			using root = TempDir.createSync("@omp-coordinated-fork-");
			const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
			const markdown = "The same shortened schema-error preview";
			await writeStructuredArtifact(sourceArtifactsDir, "Worker", { generation: "source" }, markdown);
			const destinationFile = path.join(sessionDir, "racing.jsonl");
			const destination = destinationFile.slice(0, -6);
			const staged = Promise.withResolvers<void>();
			const resume = Promise.withResolvers<void>();
			const writeFile = promises.writeFile;
			let stagedPath: string | undefined;
			const publication = vi.spyOn(promises, "writeFile").mockImplementation(async (...args) => {
				if (
					!stagedPath &&
					String(args[0]).startsWith(path.join(destination, "Worker.md.copy-")) &&
					path.basename(String(args[0])) === "sidecar"
				) {
					stagedPath = String(args[0]);
					await writeFile(stagedPath, fail ? '{"schema"' : args[1], args[2]);
					staged.resolve();
					await resume.promise;
					if (fail) throw Object.assign(new Error("Synthetic staging volume is full"), { code: "ENOSPC" });
					return;
				}
				return writeFile(...args);
			});
			const copying = copySessionArtifacts(sourceFile, destinationFile);
			let replacement: Promise<string> | undefined;
			try {
				await Promise.race([
					staged.promise,
					copying.then(() => {
						throw new Error("Copy finished before structured staging");
					}),
				]);
				replacement = writeStructuredArtifact(destination, "Worker", { generation: "accepted" }, markdown);
				expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe(markdown);
			} finally {
				resume.resolve();
				try {
					await copying;
					await replacement;
				} finally {
					publication.mockRestore();
				}
			}
			expect(stagedPath).toBeDefined();
			await expect(fs.stat(stagedPath!)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe(markdown);
			expect(await readStructuredArtifact(destination, "Worker")).toEqual({ generation: "accepted" });
			expect(await fs.readFile(path.join(destination, "1.read.log"), "utf8")).toBe("tool output");
			expect(await readStructuredArtifact(sourceArtifactsDir, "Worker")).toEqual({ generation: "source" });
		},
	);

	it.each(["Worker.md", "1.read.log"])(
		"keeps a failed %s stage undiscoverable and permits a complete retry",
		async name => {
			using root = TempDir.createSync("@omp-staged-copy-failure-");
			const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
			const data = { complete: "Submitted structured data".repeat(100) };
			const markdown = "Complete Markdown result";
			await writeStructuredArtifact(sourceArtifactsDir, "Worker", data, markdown);
			const sourcePrimary = await fs.realpath(path.join(sourceArtifactsDir, name));
			const destinationFile = path.join(sessionDir, "staged-failure.jsonl");
			const destination = destinationFile.slice(0, -6);
			const copyFile = promises.copyFile;
			let failedStagingPath: string | undefined;
			const copy = vi.spyOn(promises, "copyFile").mockImplementation(async (...args) => {
				await copyFile(...args);
				if (args[0] === sourcePrimary && !failedStagingPath) {
					failedStagingPath = String(args[1]);
					await fs.truncate(failedStagingPath, 8);
					throw Object.assign(new Error("Synthetic staging volume is full"), { code: "ENOSPC" });
				}
			});
			try {
				await copySessionArtifacts(sourceFile, destinationFile);
			} finally {
				copy.mockRestore();
			}
			expect(failedStagingPath).toBeDefined();
			await expect(fs.stat(failedStagingPath!)).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(path.join(destination, name))).rejects.toMatchObject({ code: "ENOENT" });
			if (name === "Worker.md")
				await expect(fs.stat(path.join(destination, "Worker.json"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await readStructuredArtifact(sourceArtifactsDir, "Worker")).toEqual(data);
			await copySessionArtifacts(sourceFile, destinationFile);
			expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe(markdown);
			expect(await readStructuredArtifact(destination, "Worker")).toEqual(data);
			expect(await fs.readFile(path.join(destination, "1.read.log"), "utf8")).toBe("tool output");
		},
	);

	it("keeps complete Markdown and later artifacts when optional sidecar staging fails", async () => {
		using root = TempDir.createSync("@omp-sidecar-copy-failure-");
		const { sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		const data = { complete: "Submitted structured data".repeat(100) };
		const markdown = "Complete source Markdown";
		await writeStructuredArtifact(sourceArtifactsDir, "Worker", data, markdown);
		const destinationFile = path.join(sessionDir, "sidecar-failure.jsonl");
		const destination = destinationFile.slice(0, -6);
		const writeFile = promises.writeFile;
		let failedStagingPath: string | undefined;
		const write = vi.spyOn(promises, "writeFile").mockImplementation(async (...args) => {
			if (
				String(args[0]).startsWith(path.join(destination, "Worker.md.copy-")) &&
				path.basename(String(args[0])) === "sidecar" &&
				!failedStagingPath
			) {
				failedStagingPath = String(args[0]);
				await writeFile(failedStagingPath, '{"schema"', { flag: "wx", mode: 0o600 });
				throw Object.assign(new Error("Synthetic staging volume is full"), { code: "ENOSPC" });
			}
			return writeFile(...args);
		});
		try {
			await copySessionArtifacts(sourceFile, destinationFile);
		} finally {
			write.mockRestore();
		}
		expect(failedStagingPath).toBeDefined();
		await expect(fs.stat(failedStagingPath!)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe(markdown);
		expect(await readStructuredArtifact(destination, "Worker")).toBeUndefined();
		expect(await fs.readFile(path.join(destination, "1.read.log"), "utf8")).toBe("tool output");
		expect(await fs.readFile(path.join(destination, "nested/result.txt"), "utf8")).toBe("nested output");
		expect(await readStructuredArtifact(sourceArtifactsDir, "Worker")).toEqual(data);
	});
	it("preserves complete structured results through directory merge, rollback and cold reopen", async () => {
		using root = TempDir.createSync("@omp-structured-move-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		const newCwd = path.join(root.path(), "new-project");
		const targetSessionDir = path.join(root.path(), "moved-sessions");
		await fs.mkdir(cwd);
		await fs.mkdir(newCwd);
		const destination = path.join(targetSessionDir, path.basename(sourceArtifactsDir));
		await fs.mkdir(path.join(destination, "nested"), { recursive: true });
		const data = { invalidForSchema: "Complete data outside the shortened preview".repeat(1_000) };
		for (const id of ["Worker", "nested/Worker"])
			await writeStructuredArtifact(sourceArtifactsDir, id, data, "Schema error preview");
		const manager = await SessionManager.open(sourceFile, sessionDir);
		try {
			manager.appendMessage({ role: "user", content: "Retain the moved session", timestamp: 1 });
			await manager.flush();
			const snapshot = manager.captureState();
			await manager.moveTo(newCwd, targetSessionDir);
			for (const id of ["Worker", "nested/Worker"])
				expect(await readStructuredArtifact(manager.getArtifactsDir()!, id)).toEqual(data);
			await manager.rollbackMove(snapshot);
			expect(manager.getSessionFile()).toBe(sourceFile);
			for (const id of ["Worker", "nested/Worker"])
				expect(await readStructuredArtifact(manager.getArtifactsDir()!, id)).toEqual(data);
		} finally {
			await manager.close();
		}
		const reopened = await SessionManager.open(sourceFile, sessionDir);
		try {
			for (const id of ["Worker", "nested/Worker"])
				expect(await readStructuredArtifact(reopened.getArtifactsDir()!, id)).toEqual(data);
		} finally {
			await reopened.close();
		}
	});

	it("keeps an occupied structured destination and its stranded source pair during a merge", async () => {
		using root = TempDir.createSync("@omp-occupied-artifact-merge-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
		const targetSessionDir = path.join(root.path(), "moved-sessions");
		const destination = path.join(targetSessionDir, path.basename(sourceArtifactsDir));
		await fs.mkdir(cwd);
		await writeStructuredArtifact(sourceArtifactsDir, "Worker", { owner: "source" }, "Source Markdown");
		await writeStructuredArtifact(destination, "Worker", { owner: "destination" }, "Accepted destination Markdown");
		const manager = await SessionManager.open(sourceFile, sessionDir);
		try {
			manager.appendMessage({ role: "user", content: "Retain the moved session", timestamp: 1 });
			await manager.flush();
			await manager.moveTo(cwd, targetSessionDir);
			expect(await fs.readFile(path.join(destination, "Worker.md"), "utf8")).toBe("Accepted destination Markdown");
			expect(await readStructuredArtifact(destination, "Worker")).toEqual({ owner: "destination" });
			expect(await fs.readFile(path.join(sourceArtifactsDir, "Worker.md"), "utf8")).toBe("Source Markdown");
			expect(await readStructuredArtifact(sourceArtifactsDir, "Worker")).toEqual({ owner: "source" });
			expect(await fs.readFile(path.join(destination, "nested/result.txt"), "utf8")).toBe("nested output");
		} finally {
			await manager.close();
		}
	});

	it.each(["Worker", "nested/Worker"])(
		"retains %s's complete source pair after primary-stage failure while merging later artifacts",
		async id => {
			using root = TempDir.createSync("@omp-failed-structured-merge-");
			const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(root.path());
			const targetSessionDir = path.join(root.path(), "moved-sessions");
			const destination = path.join(targetSessionDir, path.basename(sourceArtifactsDir));
			await fs.mkdir(cwd);
			await fs.mkdir(path.join(destination, "nested"), { recursive: true });
			const data = { complete: "Full submitted data outside the preview".repeat(1_000) };
			const markdown = "Complete source Markdown";
			await writeStructuredArtifact(sourceArtifactsDir, id, data, markdown);
			const primary = path.join(sourceArtifactsDir, `${id}.md`);
			const manager = await SessionManager.open(sourceFile, sessionDir);
			let failedStage: string | undefined;
			try {
				manager.appendMessage({ role: "user", content: "Retain the moved session", timestamp: 1 });
				await manager.flush();
				const copyFile = promises.copyFile;
				const copy = vi.spyOn(promises, "copyFile").mockImplementation(async (...args) => {
					await copyFile(...args);
					if (String(args[0]) === primary && !failedStage) {
						failedStage = String(args[1]);
						await fs.truncate(failedStage, 8);
						throw Object.assign(new Error("Synthetic staging volume is full"), { code: "ENOSPC" });
					}
				});
				try {
					await manager.moveTo(cwd, targetSessionDir);
				} finally {
					copy.mockRestore();
				}
				expect(failedStage).toBeDefined();
				await expect(fs.stat(failedStage!)).rejects.toMatchObject({ code: "ENOENT" });
				expect(manager.getArtifactsDir()).toBe(destination);
				expect(await fs.readFile(primary, "utf8")).toBe(markdown);
				expect(await readStructuredArtifact(sourceArtifactsDir, id)).toEqual(data);
				await expect(fs.stat(path.join(destination, `${id}.md`))).rejects.toMatchObject({ code: "ENOENT" });
				await expect(fs.stat(path.join(destination, `${id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
				expect(await fs.readFile(path.join(destination, "1.read.log"), "utf8")).toBe("tool output");
				expect(await fs.readFile(path.join(destination, "nested/result.txt"), "utf8")).toBe("nested output");
			} finally {
				await manager.close();
			}
		},
	);
});

describe("SessionManager.forkFrom", () => {
	it("retains the bound tuple through clone, persisted copy, full fork, branch, import and cold reopen", async () => {
		using root = TempDir.createSync("@omp-portable-fork-");
		const storage = new MemorySessionStorage();
		const dir = path.join(root.path(), "sessions");
		const cwd = root.path();
		const card = { code: "FORK", emoji: "🧪", nf: "nf-md-flask" };
		const manager = SessionManager.create(cwd, dir, storage);
		manager.appendMessage({ role: "user", content: "synthetic branch", timestamp: 1 });
		await manager.ensureOnDisk();
		await manager.setSessionName("Portable fork", "user", undefined, card);
		const updatedAt = manager.titleUpdatedAt;
		const sourceFile = manager.getSessionFile()!;
		const clone = manager.cloneCurrentSession({ persist: false });
		try {
			expect(clone.getSessionName()).toBe("Portable fork");
			expect(clone.getSessionTitleCard()).toEqual(card);
			expect(clone.titleUpdatedAt).toBe(updatedAt);
		} finally {
			await clone.close();
		}
		const copy = await manager.persistCopy({ sessionDir: path.join(root.path(), "copies") }, storage);
		const copiedFile = copy.getSessionFile()!;
		await copy.close();
		await manager.fork();
		const fullFile = manager.getSessionFile()!;
		expect(fullFile).not.toBe(sourceFile);
		manager.createBranchedSession(manager.getLeafId()!, { copyArtifacts: false });
		await manager.flush();
		const branchFile = manager.getSessionFile()!;
		await manager.close();
		const forked = await SessionManager.forkFrom(sourceFile, cwd, dir, storage, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const foreignFile = forked.getSessionFile()!;
		await forked.close();
		for (const file of [sourceFile, copiedFile, fullFile, branchFile, foreignFile]) {
			for (let pass = 0; pass < 2; pass++) {
				const cold = await SessionManager.open(file, dir, storage);
				try {
					expect(cold.getSessionName()).toBe("Portable fork");
					expect(cold.getSessionTitleCard()).toEqual(card);
					expect(cold.titleSource).toBe("user");
					expect(cold.titleUpdatedAt).toBe(updatedAt);
				} finally {
					await cold.close();
				}
			}
		}
	});

	it("suppresses terminal breadcrumbs while preserving source history under a new parented session", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-");
		const previousAgentDir = getAgentDir();
		const previousTermSessionId = process.env.TERM_SESSION_ID;
		setAgentDir(path.join(tempDir.path(), "agent"));
		process.env.TERM_SESSION_ID = "omp-fork-test";
		try {
			const cwd = path.join(tempDir.path(), "project");
			const sessionDir = path.join(tempDir.path(), "sessions");
			await fs.mkdir(sessionDir, { recursive: true });
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const timestamp = new Date().toISOString();
			const sourceHeader: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "source-session",
				timestamp,
				cwd,
			};
			const sourceMessage: JsonlMessageEntry = {
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp,
				message: { role: "user", content: "hello", timestamp: Date.now() },
			};
			const sourceText = `${JSON.stringify(sourceHeader)}\n${JSON.stringify(sourceMessage)}\n`;
			await Bun.write(sourceFile, sourceText);

			const terminalId = getTerminalId();
			expect(terminalId).toBeString();
			const breadcrumbFile = path.join(getTerminalSessionsDir(), terminalId ?? "missing");
			await removeWithRetries(breadcrumbFile);

			const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
				suppressBreadcrumb: true,
			});
			await Bun.sleep(10);
			const cloneFile = forked.getSessionFile();
			expect(cloneFile).toBeString();
			if (!cloneFile) throw new Error("expected forked session file");

			expect(await Bun.file(sourceFile).text()).toBe(sourceText);
			expect(await Bun.file(breadcrumbFile).exists()).toBe(false);
			expect(cloneFile).not.toBe(sourceFile);

			const cloneEntries = await loadEntriesFromFile(cloneFile);
			const cloneHeader = cloneEntries.find((entry): entry is SessionHeader => entry.type === "session");
			const cloneMessage = cloneEntries.find((entry): entry is SessionMessageEntry => entry.type === "message");
			expect(cloneHeader?.id).not.toBe(sourceHeader.id);
			expect(cloneHeader?.parentSession).toBe(sourceHeader.id);
			expect(cloneHeader?.cwd).toBe(cwd);
			if (cloneMessage?.message.role !== "user") throw new Error("expected forked user message");
			expect(cloneMessage.message.content).toBe("hello");
		} finally {
			if (previousTermSessionId === undefined) {
				delete process.env.TERM_SESSION_ID;
			} else {
				process.env.TERM_SESSION_ID = previousTermSessionId;
			}
			setAgentDir(previousAgentDir);
		}
	});

	it("copies source artifacts recursively into the fork by default", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-artifacts-");
		const { cwd, sessionDir, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).text()).toBe("tool output");
		expect(await Bun.file(path.join(forkArtifactsDir, "nested", "result.txt")).text()).toBe("nested output");
		expect(await Bun.file(path.join(sourceArtifactsDir, "1.read.log")).text()).toBe("tool output");
	});

	it("forks a seance in place: source untouched, history kept, startup contracts inert, artifacts not copied", async () => {
		using tempDir = TempDir.createSync("@omp-session-seance-fork-");
		const { cwd, sourceFile, sourceArtifactsDir } = await createSessionWithArtifacts(tempDir.path());
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "source-session",
			timestamp,
			cwd,
			additionalDirectories: [path.join(tempDir.path(), "parent-workspace")],
		};
		const inheritedInit = {
			type: "session_init",
			id: "inherited-init",
			parentId: null,
			timestamp,
			systemPrompt: ["unrestricted source prompt"],
			task: "unrestricted source task",
			tools: ["read", "write", "task"],
			agent: "task",
			spawns: "*",
		};
		const request = {
			type: "message",
			id: "witness-request",
			parentId: "inherited-init",
			timestamp,
			message: { role: "user", content: "early request before resume", timestamp: 1 },
		};
		const laterInit = {
			...inheritedInit,
			id: "later-inherited-init",
			parentId: "witness-request",
			systemPrompt: ["later unrestricted resume prompt"],
		};
		const laterMessage = {
			type: "message",
			id: "later-source-message",
			parentId: "later-inherited-init",
			timestamp,
			message: { role: "user", content: "later source turn", timestamp: 3 },
		};
		const sourceText = `${[sourceHeader, inheritedInit, request, laterInit, laterMessage]
			.map(entry => JSON.stringify(entry))
			.join("\n")}\n`;
		await Bun.write(sourceFile, sourceText);

		const forkFile = path.join(tempDir.path(), "forks", "seance.jsonl");
		const forked = await SessionManager.forkFrom(sourceFile, cwd, undefined, undefined, {
			seance: true,
			suppressBreadcrumb: true,
			sessionFile: forkFile,
			resetInheritedCost: true,
			repairInterruptedTail: true,
		});
		try {
			expect(await fs.readFile(sourceFile, "utf8")).toBe(sourceText);
			const asSourceInit = { type: "custom", customType: "source_session_init" };
			expect(await loadHistory(forkFile)).toEqual([
				{ ...asSourceInit, id: inheritedInit.id, parentId: null, timestamp, data: inheritedInit },
				request,
				{ ...asSourceInit, id: laterInit.id, parentId: laterInit.parentId, timestamp, data: laterInit },
				laterMessage,
			] as unknown as SessionEntry[]);
			// Revival reads the header's source pointer and finds no inherited contract to resurrect.
			expect(await SessionManager.peekSessionInit(forkFile)).toMatchObject({
				seanceSource: await fs.realpath(sourceFile),
				init: null,
			});
			expect(forked.getSeanceSourceArtifactsDir()).toBe(await fs.realpath(sourceArtifactsDir));
			expect(forked.getAdditionalDirectories()).toEqual([]);
			await expect(fs.stat(forkFile.slice(0, -".jsonl".length))).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await forked.close();
		}
	});

	it("keeps a memory-backed seance source key authoritative over a physical symlink at that key", async () => {
		using root = TempDir.createSync("@omp-memory-seance-source-");
		const storage = new MemorySessionStorage();
		const dir = path.join(root.path(), "sessions");
		const source = SessionManager.create(root.path(), dir, storage);
		source.appendMessage({ role: "user", content: "memory-owned history", timestamp: 1 });
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile()!;
		const sourceId = source.getSessionId();
		const physicalTarget = path.join(root.path(), "physical.jsonl");
		const decoy = '{"type":"session","version":3,"id":"physical-decoy","timestamp":"2026-10-01T00:00:00.000Z"}\n';
		await Bun.write(physicalTarget, decoy);
		await fs.mkdir(path.dirname(sourceFile), { recursive: true });
		await fs.symlink(physicalTarget, sourceFile, "file");
		const fork = await SessionManager.forkFrom(sourceFile, root.path(), dir, storage, {
			seance: true,
			suppressBreadcrumb: true,
		});
		try {
			expect(fork.getHeader()?.parentSession).toBe(sourceId);
			expect(fork.getSeanceSourceArtifactsDir()).toBe(sourceFile.slice(0, -6));
			expect(fork.getEntries()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "message",
						message: expect.objectContaining({ content: "memory-owned history" }),
					}),
				]),
			);
			expect(await fs.readFile(physicalTarget, "utf8")).toBe(decoy);
		} finally {
			await fork.close();
			await source.close();
		}
	});
	it("does not copy artifacts when the caller opts out", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-no-artifacts-");
		const { cwd, sessionDir, sourceFile } = await createSessionWithArtifacts(tempDir.path());

		const forked = await SessionManager.forkFrom(sourceFile, cwd, sessionDir, undefined, {
			copyArtifacts: false,
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "1.read.log")).exists()).toBe(false);
	});

	it("does not treat an extensionless source's parent directory as artifacts", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-extensionless-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const forkDir = path.join(tempDir.path(), "forks");
		const sourceFile = path.join(sessionDir, "source");
		const unrelatedFile = path.join(sessionDir, "unrelated.txt");
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "extensionless-source",
			timestamp: new Date().toISOString(),
			cwd,
		};
		await fs.mkdir(sessionDir, { recursive: true });
		await Bun.write(sourceFile, `${JSON.stringify(sourceHeader)}\n`);
		await Bun.write(unrelatedFile, "must not be copied");

		const forked = await SessionManager.forkFrom(sourceFile, cwd, forkDir, undefined, {
			suppressBreadcrumb: true,
		});
		const forkFile = forked.getSessionFile();
		if (!forkFile) throw new Error("expected forked session file");
		const forkArtifactsDir = forkFile.slice(0, -".jsonl".length);

		expect(await Bun.file(path.join(forkArtifactsDir, "unrelated.txt")).exists()).toBe(false);
		expect(await Bun.file(unrelatedFile).text()).toBe("must not be copied");
	});

	it("zeroes inherited cost while preserving token counts only when reset is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-cost-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const sourceHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "cost-source",
			timestamp,
			cwd,
		};
		const assistantEntry = {
			type: "message",
			id: "assistant-1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "task-call-1", name: "task", arguments: { task: "inspect" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 10,
					cacheWrite: 5,
					totalTokens: 165,
					premiumRequests: 2,
					credits: { cost: 3, committedCost: 3, acuCost: 1 },
					cost: { input: 1, output: 4, cacheRead: 0.5, cacheWrite: 0.5, total: 6 },
				},
			},
		};
		const taskUsage = {
			input: 40,
			output: 10,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 53,
			premiumRequests: 3,
			credits: { cost: 10, committedCost: 10, acuCost: 2 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedUsage = {
			input: 5,
			output: 3,
			cacheRead: 1,
			cacheWrite: 2,
			totalTokens: 11,
			premiumRequests: 1,
			credits: { cost: 4, committedCost: 4, acuCost: 1 },
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
		};
		const nestedTaskSnapshot = (
			id: string,
			usage: typeof taskUsage,
			progressCost: number,
			nestedTask?: TaskToolDetails,
		): TaskToolDetails => ({
			projectAgentsDir: null,
			usage,
			totalDurationMs: 1,
			results: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					task: "inspect nested",
					exitCode: 0,
					output: "done",
					stderr: "",
					truncated: false,
					durationMs: 1,
					tokens: usage.totalTokens,
					requests: 1,
					usage,
					...(nestedTask ? { extractedToolData: { task: [nestedTask] } } : {}),
				},
			],
			progress: [
				{
					index: 0,
					id,
					agent: "worker",
					agentSource: "bundled",
					status: "completed",
					task: "inspect nested",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: usage.totalTokens,
					cost: progressCost,
					durationMs: 1,
				},
			],
		});
		const grandchildUsage = { ...nestedUsage, input: 8, totalTokens: 16 };
		const inflightUsage = { ...nestedUsage, input: 6, totalTokens: 12 };
		const inflightGrandchildUsage = { ...nestedUsage, input: 9, totalTokens: 18 };
		const progressGrandchildUsage = { ...nestedUsage, input: 7, totalTokens: 14 };
		const grandchildDetails = nestedTaskSnapshot("grandchild", grandchildUsage, 17);
		const inflightGrandchildDetails = nestedTaskSnapshot("inflight-grandchild", inflightGrandchildUsage, 19);
		const inflightTaskDetails = nestedTaskSnapshot("inflight", inflightUsage, 9, inflightGrandchildDetails);
		const progressGrandchildDetails = nestedTaskSnapshot("progress-grandchild", progressGrandchildUsage, 21);
		const taskResultEntry = {
			type: "message",
			id: "task-result-1",
			parentId: "assistant-1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "task-call-1",
				toolName: "task",
				content: [{ type: "text", text: "completed worker" }],
				isError: false,
				timestamp: Date.now(),
				details: {
					usage: taskUsage,
					results: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							task: "inspect",
							exitCode: 0,
							output: "done",
							stderr: "",
							truncated: false,
							durationMs: 1,
							tokens: 11,
							requests: 1,
							usage: nestedUsage,
							extractedToolData: { task: [grandchildDetails] },
						},
					],
					progress: [
						{
							index: 0,
							id: "nested-agent",
							agent: "worker",
							agentSource: "bundled",
							status: "completed",
							task: "inspect",
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							requests: 1,
							tokens: 11,
							cost: 10,
							inflightTaskDetails,
							extractedToolData: { task: [progressGrandchildDetails] },
							durationMs: 1,
						},
					],
				},
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(sourceHeader)}\n${JSON.stringify(assistantEntry)}\n${JSON.stringify(taskResultEntry)}\n`,
		);
		const sourceText = await Bun.file(sourceFile).text();
		const sourceManager = await SessionManager.open(sourceFile, sessionDir, undefined, { suppressBreadcrumb: true });

		const findAssistant = async (file: string) => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find((e): e is SessionMessageEntry => e.type === "message");
			if (entry?.message.role !== "assistant") throw new Error("expected assistant message");
			return entry.message;
		};
		const findTaskDetails = async (file: string): Promise<TaskToolDetails> => {
			const entries = await loadEntriesFromFile(file);
			const entry = entries.find(
				(e): e is SessionMessageEntry =>
					e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "task",
			);
			if (!entry || entry.message.role !== "toolResult") throw new Error("expected task tool result");
			if (!isTaskToolDetails(entry.message.details)) throw new Error("expected task tool details");
			return entry.message.details;
		};
		const findNestedTaskDetails = (extractedToolData: Record<string, unknown[]> | undefined): TaskToolDetails => {
			const nested = extractedToolData?.task?.[0];
			if (!isTaskToolDetails(nested)) throw new Error("expected nested task details");
			return nested;
		};
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const expectUsagePreserved = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(expected.cost);
			expect(actual?.credits).toEqual(expected.credits);
			expect(actual?.premiumRequests).toBe(expected.premiumRequests);
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};
		const expectUsageReset = (actual: Usage | undefined, expected: Usage) => {
			expect(actual?.cost).toEqual(zeroCost);
			expect(actual?.credits).toBeUndefined();
			expect(actual?.premiumRequests).toBeUndefined();
			expect(actual?.input).toBe(expected.input);
			expect(actual?.output).toBe(expected.output);
			expect(actual?.cacheRead).toBe(expected.cacheRead);
			expect(actual?.cacheWrite).toBe(expected.cacheWrite);
			expect(actual?.totalTokens).toBe(expected.totalTokens);
		};

		const preserved = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "keep"), undefined, {
			suppressBreadcrumb: true,
		});
		const preservedFile = preserved.getSessionFile();
		if (!preservedFile) throw new Error("expected preserved fork file");
		const preservedMessage = await findAssistant(preservedFile);
		expect(preservedMessage.usage.cost.total).toBe(6);
		expect(preservedMessage.usage.premiumRequests).toBe(2);
		const preservedTaskDetails = await findTaskDetails(preservedFile);
		expect(preserved.getUsageStatistics().cost).toBe(16);
		expect(preservedTaskDetails.usage?.cost).toEqual(taskUsage.cost);
		expect(preservedTaskDetails.usage?.credits).toEqual(taskUsage.credits);
		expect(preservedTaskDetails.usage?.premiumRequests).toBe(taskUsage.premiumRequests);
		expect(preservedTaskDetails.results[0]?.usage?.cost).toEqual(nestedUsage.cost);
		expect(preservedTaskDetails.results[0]?.usage?.credits).toEqual(nestedUsage.credits);
		expect(preservedTaskDetails.results[0]?.usage?.premiumRequests).toBe(nestedUsage.premiumRequests);
		expect(preservedTaskDetails.progress?.[0]?.cost).toBe(10);
		const preservedTaskResult = preservedTaskDetails.results[0];
		if (!preservedTaskResult) throw new Error("expected direct task result");
		const preservedGrandchild = findNestedTaskDetails(preservedTaskResult.extractedToolData);
		expectUsagePreserved(preservedGrandchild.usage, grandchildUsage);
		expectUsagePreserved(preservedGrandchild.results[0]?.usage, grandchildUsage);
		expect(preservedGrandchild.progress?.[0]?.cost).toBe(17);
		const preservedProgress = preservedTaskDetails.progress?.[0];
		if (!preservedProgress) throw new Error("expected task progress");
		const preservedInflight = preservedProgress.inflightTaskDetails;
		if (!preservedInflight) throw new Error("expected in-flight task details");
		expectUsagePreserved(preservedInflight.usage, inflightUsage);
		expectUsagePreserved(preservedInflight.results[0]?.usage, inflightUsage);
		expect(preservedInflight.progress?.[0]?.cost).toBe(9);
		const preservedInflightGrandchild = findNestedTaskDetails(preservedInflight.results[0]?.extractedToolData);
		expectUsagePreserved(preservedInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsagePreserved(preservedInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(preservedInflightGrandchild.progress?.[0]?.cost).toBe(19);
		const preservedProgressGrandchild = findNestedTaskDetails(preservedProgress.extractedToolData);
		expectUsagePreserved(preservedProgressGrandchild.usage, progressGrandchildUsage);
		expectUsagePreserved(preservedProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(preservedProgressGrandchild.progress?.[0]?.cost).toBe(21);

		const reset = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "reset"), undefined, {
			suppressBreadcrumb: true,
			resetInheritedCost: true,
		});
		const resetFile = reset.getSessionFile();
		if (!resetFile) throw new Error("expected reset fork file");
		const resetMessage = await findAssistant(resetFile);
		expect(resetMessage.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
		expect(resetMessage.usage.credits).toBeUndefined();
		expect(resetMessage.usage.premiumRequests).toBeUndefined();
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetMessage.usage.input).toBe(100);
		expect(resetMessage.usage.output).toBe(50);
		expect(resetMessage.usage.totalTokens).toBe(165);
		const resetTaskDetails = await findTaskDetails(resetFile);
		expectUsageReset(resetTaskDetails.usage, taskUsage);
		expect(resetTaskDetails.results[0]?.usage?.cost).toEqual(zeroCost);
		expect(resetTaskDetails.results[0]?.usage?.credits).toBeUndefined();
		expect(resetTaskDetails.results[0]?.usage?.premiumRequests).toBeUndefined();
		expect(resetTaskDetails.progress?.[0]?.cost).toBe(0);
		expect(resetTaskDetails.progress?.[0]?.tokens).toBe(11);
		const resetTaskResult = resetTaskDetails.results[0];
		if (!resetTaskResult) throw new Error("expected direct task result");
		expectUsageReset(resetTaskResult.usage, nestedUsage);
		const resetGrandchild = findNestedTaskDetails(resetTaskResult.extractedToolData);
		expectUsageReset(resetGrandchild.usage, grandchildUsage);
		expectUsageReset(resetGrandchild.results[0]?.usage, grandchildUsage);
		expect(resetGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetGrandchild.progress?.[0]?.tokens).toBe(grandchildUsage.totalTokens);
		const resetProgress = resetTaskDetails.progress?.[0];
		if (!resetProgress) throw new Error("expected task progress");
		const resetInflight = resetProgress.inflightTaskDetails;
		if (!resetInflight) throw new Error("expected in-flight task details");
		expectUsageReset(resetInflight.usage, inflightUsage);
		expectUsageReset(resetInflight.results[0]?.usage, inflightUsage);
		expect(resetInflight.progress?.[0]?.cost).toBe(0);
		expect(resetInflight.progress?.[0]?.tokens).toBe(inflightUsage.totalTokens);
		const resetInflightGrandchild = findNestedTaskDetails(resetInflight.results[0]?.extractedToolData);
		expectUsageReset(resetInflightGrandchild.usage, inflightGrandchildUsage);
		expectUsageReset(resetInflightGrandchild.results[0]?.usage, inflightGrandchildUsage);
		expect(resetInflightGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetInflightGrandchild.progress?.[0]?.tokens).toBe(inflightGrandchildUsage.totalTokens);
		const resetProgressGrandchild = findNestedTaskDetails(resetProgress.extractedToolData);
		expectUsageReset(resetProgressGrandchild.usage, progressGrandchildUsage);
		expectUsageReset(resetProgressGrandchild.results[0]?.usage, progressGrandchildUsage);
		expect(resetProgressGrandchild.progress?.[0]?.cost).toBe(0);
		expect(resetProgressGrandchild.progress?.[0]?.tokens).toBe(progressGrandchildUsage.totalTokens);
		// Token counts are context, not spend — compaction anchors depend on them.
		expect(resetTaskDetails.usage?.input).toBe(40);
		expect(resetTaskDetails.usage?.cacheRead).toBe(2);
		expect(resetTaskDetails.usage?.totalTokens).toBe(53);
		expect(resetTaskDetails.results[0]?.usage?.input).toBe(5);
		expect(resetTaskDetails.results[0]?.usage?.cacheRead).toBe(1);
		expect(resetTaskDetails.results[0]?.usage?.totalTokens).toBe(11);
		const sourceMessage = sourceManager.getEntries().find(entry => entry.type === "message");
		if (sourceMessage?.type !== "message" || sourceMessage.message.role !== "assistant") {
			throw new Error("expected source assistant message");
		}
		expect(sourceMessage.message.usage.cost.total).toBe(6);
		expect(sourceMessage.message.usage.premiumRequests).toBe(2);
		expect(await Bun.file(sourceFile).text()).toBe(sourceText);
		await sourceManager.close();
	});

	for (const { name, createStorage, padding } of [
		{ name: "buffered file", createStorage: () => new FileSessionStorage(), padding: "" },
		{ name: "streamed file", createStorage: () => new FileSessionStorage(), padding: "x".repeat(8 * 1024 * 1024) },
		{ name: "memory", createStorage: () => new MemorySessionStorage(), padding: "" },
	]) {
		it(`keeps independently loaded ${name} entries unchanged when the fork migrates and branches`, async () => {
			using tempDir = TempDir.createSync("@omp-session-fork-ownership-");
			const cwd = tempDir.path();
			const sessionDir = path.join(cwd, "sessions");
			const sourceFile = path.join(sessionDir, "source.jsonl");
			const storage = createStorage();
			const timestamp = new Date().toISOString();
			const sourceText =
				[
					{ type: "session", version: 2, id: "legacy-source", timestamp, cwd },
					{
						type: "message",
						id: "user",
						parentId: null,
						timestamp,
						message: { role: "user", content: "source", timestamp: 1 },
					},
					{
						type: "message",
						id: "hook",
						parentId: "user",
						timestamp,
						message: {
							role: "hookMessage",
							customType: "legacy",
							content: padding || "legacy output",
							display: true,
							timestamp: 2,
						},
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n") + "\n";
			await storage.writeText(sourceFile, sourceText);
			const loadedBeforeFork = await loadEntriesFromFile(sourceFile, storage);
			const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(cwd, "forks"), storage, {
				suppressBreadcrumb: true,
				copyArtifacts: false,
			});
			const migrated = forked.getEntries().find(entry => entry.id === "hook");
			expect(migrated).toMatchObject({ type: "message", message: { role: "custom", customType: "legacy" } });
			forked.branch("user");
			forked.appendMessage({ role: "user", content: "fork-only continuation", timestamp: 3 });
			expect(forked.buildSessionContext().messages).toMatchObject([
				{ role: "user", content: "source" },
				{ role: "user", content: "fork-only continuation" },
			]);
			await forked.close();
			expect(loadedBeforeFork[0]).toMatchObject({ type: "session", version: 2 });
			expect(loadedBeforeFork[2]).toMatchObject({ type: "message", message: { role: "hookMessage" } });
			expect(loadedBeforeFork).toEqual(await loadEntriesFromFile(sourceFile, storage));
			expect(await storage.readText(sourceFile)).toBe(sourceText);
		});
	}

	it("pairs an unresolved tool call with an unknown-outcome result only when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "live-parent",
			timestamp,
			cwd,
		};
		// Parent is mid-turn: the assistant emitted a tool call whose result was
		// delivered only to the parent, so the forked tail is non-terminal.
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const untouched = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "untouched"),
			undefined,
			{
				suppressBreadcrumb: true,
			},
		);
		const untouchedEntries = await loadHistory(untouched.getSessionFile()!);
		expect(collectPendingToolCalls(untouchedEntries).map(call => call.toolCallId)).toEqual(["toolu_live"]);

		const repaired = await SessionManager.forkFrom(
			sourceFile,
			cwd,
			path.join(tempDir.path(), "repaired"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const repairedEntries = await loadHistory(repaired.getSessionFile()!);
		expect(collectPendingToolCalls(repairedEntries)).toEqual([]);
		const result = repairedEntries.find(
			(entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult",
		);
		if (!result || result.message.role !== "toolResult") throw new Error("expected an unknown tool result");
		expect(result.message.toolCallId).toBe("toolu_live");
		expect(result.message.isError).toBe(true);
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
	});

	it("leaves an exited source's interrupted tail to resume recovery", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-exited-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const entries = [
			{ type: "session", version: CURRENT_SESSION_VERSION, id: "crashed-parent", timestamp, cwd },
			{
				type: "message",
				id: "m1",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "toolu_crashed", name: "bash", arguments: { command: "make" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude",
					stopReason: "toolUse",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			},
			{
				type: "custom",
				id: "m2",
				parentId: "m1",
				timestamp,
				customType: SESSION_EXIT_CUSTOM_TYPE,
				data: { reason: "uncaughtException", kind: "fatal", recordedAt: timestamp },
			},
		];
		await Bun.write(sourceFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch).map(call => call.toolCallId)).toEqual(["toolu_crashed"]);
		expect(describePendingToolCalls(branch)).toContain("toolu_crashed");
		expect(createInterruptedTurnAbortMessage(branch)?.stopReason).toBe("aborted");
		const [result] = createInterruptedToolResults(branch);
		expect(result?.toolCallId).toBe("toolu_crashed");
		expect(
			result?.content.some(block => block.type === "text" && block.text.includes("Previous OMP process exited")),
		).toBe(true);
	});

	it("retains the length-stop guard only when a call has no start marker", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-length-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "length-limited-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_truncated",
						name: "write",
						arguments: { path: "partial.txt", content: "incomplete payload" },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "length",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		await Bun.write(sourceFile, `${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n`);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const result = branch.find(
			(entry): entry is SessionMessageEntry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				isSyntheticToolResultMessage(entry.message),
		);
		if (!result || !isSyntheticToolResultMessage(result.message)) {
			throw new Error("expected a synthetic tool result for the truncated call");
		}
		expect(result.message.toolCallId).toBe("toolu_truncated");
		expect(result.message.details).toMatchObject({ source: "assistant_stop_length", executed: false });
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("truncated and unsafe to run"),
			),
		).toBe(true);
		const startedSourceFile = path.join(sessionDir, "started-source.jsonl");
		const startedHeader = { ...header, id: "length-started-parent" };
		const startMarker = {
			type: "custom",
			id: "m2",
			parentId: "m1",
			timestamp,
			customType: TOOL_EXECUTION_START_CUSTOM_TYPE,
			data: { toolCallId: "toolu_truncated", toolName: "write", startedAt: timestamp },
		};
		await Bun.write(
			startedSourceFile,
			`${JSON.stringify(startedHeader)}\n${JSON.stringify(assistant)}\n${JSON.stringify(startMarker)}\n`,
		);
		const startedFork = await SessionManager.forkFrom(
			startedSourceFile,
			cwd,
			path.join(tempDir.path(), "started-fork"),
			undefined,
			{
				suppressBreadcrumb: true,
				repairInterruptedTail: true,
			},
		);
		const startedEntries = await loadHistory(startedFork.getSessionFile()!);
		expect(collectPendingToolCalls(startedEntries)).toEqual([]);
		const startedResult = startedEntries.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_truncated",
		);
		if (startedResult?.type !== "message" || startedResult.message.role !== "toolResult") {
			throw new Error("expected the started length-stopped call to be paired");
		}
		expect(isSyntheticToolResultMessage(startedResult.message)).toBe(false);
		expect(startedResult.message).not.toHaveProperty("details");
		expect(
			startedResult.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
	});

	it("repairs only the active branch when sibling paths contain assistants and results", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-branch-repair-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "branched-parent",
			timestamp,
			cwd,
		};
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const activeAssistant = {
			type: "message",
			id: "active-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_active", name: "bash", arguments: { command: "sleep 40" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const siblingResult = {
			type: "message",
			id: "sibling-result",
			parentId: "active-assistant",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_active",
				toolName: "bash",
				content: [{ type: "text", text: "completed on abandoned branch" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		const siblingAssistant = {
			type: "message",
			id: "sibling-assistant",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_sibling", name: "read", arguments: { path: "old.txt" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage,
			},
		};
		const activeLeaf = {
			type: "message",
			id: "active-leaf",
			parentId: "active-assistant",
			timestamp,
			message: { role: "user", content: "continue on this branch", timestamp: Date.now() },
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(activeAssistant)}\n${JSON.stringify(siblingResult)}\n${JSON.stringify(siblingAssistant)}\n${JSON.stringify(activeLeaf)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const branch = forked.getBranch();
		expect(collectPendingToolCalls(branch)).toEqual([]);
		const result = branch.find(
			entry =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolCallId === "toolu_active",
		);
		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("expected the active branch's unknown tool result");
		}
		expect(result.message).not.toHaveProperty("details");
		expect(
			result.message.content.some(
				block => block.type === "text" && block.text.includes("may still be running this tool"),
			),
		).toBe(true);
		expect(
			(await loadHistory(forked.getSessionFile()!)).some(
				entry =>
					entry.type === "message" &&
					isSyntheticToolResultMessage(entry.message) &&
					entry.message.toolCallId === "toolu_sibling",
			),
		).toBe(false);
	});

	it("leaves an already-terminal tail with a completed tool call untouched when repair is requested", async () => {
		using tempDir = TempDir.createSync("@omp-session-fork-terminal-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const sourceFile = path.join(sessionDir, "source.jsonl");
		const timestamp = new Date().toISOString();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "settled-parent",
			timestamp,
			cwd,
		};
		const assistant = {
			type: "message",
			id: "m1",
			parentId: null,
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_done", name: "bash", arguments: { command: "echo hi" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				stopReason: "toolUse",
				timestamp: Date.now(),
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};
		const toolResult = {
			type: "message",
			id: "m2",
			parentId: "m1",
			timestamp,
			message: {
				role: "toolResult",
				toolCallId: "toolu_done",
				toolName: "bash",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: Date.now(),
			},
		};
		await Bun.write(
			sourceFile,
			`${JSON.stringify(header)}\n${JSON.stringify(assistant)}\n${JSON.stringify(toolResult)}\n`,
		);

		const forked = await SessionManager.forkFrom(sourceFile, cwd, path.join(tempDir.path(), "fork"), undefined, {
			suppressBreadcrumb: true,
			repairInterruptedTail: true,
		});
		const forkedEntries = await loadHistory(forked.getSessionFile()!);
		const messageEntries = forkedEntries.filter(entry => entry.type === "message");
		expect(messageEntries).toHaveLength(2);
		expect(collectPendingToolCalls(forkedEntries)).toEqual([]);
		expect(forkedEntries.some(entry => entry.type === "message" && isSyntheticToolResultMessage(entry.message))).toBe(
			false,
		);
	});
});
