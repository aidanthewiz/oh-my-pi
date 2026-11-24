import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

describe("SessionManager artifact terminal release", () => {
	let tempDir: TempDir;
	const managers: SessionManager[] = [];
	const spillRoots = new Set<string>();

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-artifact-release-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.close();
		for (const root of spillRoots) await fs.promises.rm(root, { recursive: true, force: true });
		spillRoots.clear();
		tempDir.removeSync();
	});

	function inMemory(): SessionManager {
		const manager = SessionManager.inMemory(tempDir.path());
		managers.push(manager);
		spillRoots.add(manager.getArtifactManager().dir);
		return manager;
	}

	it("drops new spill writes after terminal release", async () => {
		const manager = inMemory();
		const payload = `live-${crypto.randomUUID()}`;
		expect(await manager.saveArtifact(payload)).toBe("0");
		await manager.close();
		manager.releaseRetainedEntries();
		manager.releaseRetainedEntries();
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`)).toBeUndefined();
		expect(await manager.getArtifactContent("0", Buffer.byteLength(payload))).toBeNull();
	});

	it("keeps accepting spill writes across nonterminal close and branch changes", async () => {
		const manager = inMemory();
		const firstEntry = manager.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
		expect(await manager.saveArtifact("first spill")).toBe("0");
		await manager.close();
		manager.appendMessage({ role: "user", content: "second branch", timestamp: Date.now() });
		manager.branch(firstEntry);
		expect(await manager.saveArtifact("second spill")).toBe("1");
	});

	it("preserves adopted artifacts and their owner when a child is released", async () => {
		const shared = new ArtifactManager(path.join(tempDir.path(), "shared"), null);
		const child = inMemory();
		const sibling = inMemory();
		child.adoptArtifactManager(shared);
		sibling.adoptArtifactManager(shared);
		const firstId = await child.saveArtifact("completed child output");
		if (!firstId) throw new Error("Expected a child artifact id");
		await child.close();
		child.releaseRetainedEntries();
		expect(await child.saveArtifact(`late-${crypto.randomUUID()}`)).toBeUndefined();
		expect(await child.allocateArtifactPath()).toEqual({});
		const secondId = await sibling.saveArtifact("sibling output");
		if (!secondId) throw new Error("Expected a sibling artifact id");
		expect(secondId).not.toBe(firstId);
		const firstPath = await child.getArtifactPath(firstId);
		const secondPath = await sibling.getArtifactPath(secondId);
		if (!firstPath || !secondPath) throw new Error("Expected retained artifact paths");
		expect(await Bun.file(firstPath).text()).toBe("completed child output");
		expect(await Bun.file(secondPath).text()).toBe("sibling output");
		expect(await fs.promises.readdir(shared.dir)).toHaveLength(2);
	});

	it("finishes a disk spill admitted before release and keeps persisted output readable", async () => {
		const ready = Promise.withResolvers<void>();
		const shared = new ArtifactManager(path.join(tempDir.path(), "pending"), null, ready.promise);
		const manager = inMemory();
		manager.adoptArtifactManager(shared);
		const content = `complete-${crypto.randomUUID()}-${"x".repeat(32 * 1024)}`;
		const saving = manager.saveArtifact(content);
		await manager.close();
		manager.releaseRetainedEntries();
		ready.resolve();
		const id = await saving;
		if (!id) throw new Error("Expected the admitted spill to finish");
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected the completed artifact to remain readable");
		expect(await Bun.file(artifactPath).text()).toBe(content);
	});

	it("keeps owned disk artifacts readable after release without creating new spills", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		managers.push(manager);
		const id = await manager.saveArtifact("persisted output");
		if (!id) throw new Error("Expected a persisted artifact id");
		await manager.close();
		manager.releaseRetainedEntries();
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected the persisted artifact path");
		expect(await Bun.file(artifactPath).text()).toBe("persisted output");
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`)).toBeUndefined();
		expect(await manager.allocateArtifactPath()).toEqual({});
		expect(await manager.getArtifactContent(id, 1024)).toBeNull();
	});

	it("recovers elided PR file metadata from a real in-memory OutputMeta spill", async () => {
		const manager = inMemory();
		const files = Array.from({ length: 81 }, (_, index) => ({
			filename: index === 40 ? "armature/src/terminal-route.tsx" : `internal/route-${index}.go`,
			status: index === 40 ? "modified" : "added",
			additions: index + 1,
			deletions: index,
			patch: `λ東京🦊-${index}-`.repeat(1_024),
		}));
		const payload = JSON.stringify(files, null, 2);
		const result = await postProcessToolResult(
			{ content: [{ type: "text", text: payload }], details: {} },
			"github_get_files",
			{
				sessionManager: manager,
				settings: Settings.isolated({
					"tools.artifactSpillThreshold": 4,
					"tools.artifactHeadBytes": 1,
					"tools.artifactTailBytes": 1,
					"tools.artifactTailLines": 10,
				}),
			} as unknown as AgentToolContext,
		);
		const truncation = result.details?.meta?.truncation;
		if (!truncation?.artifactId) throw new Error("Expected an owned spilled artifact");
		expect(truncation.direction).toBe("middle");
		expect(result.content.some(part => part.type === "text" && part.text.includes(files[40]!.filename))).toBe(false);
		const recovered = await manager.getArtifactContent(truncation.artifactId, truncation.totalBytes);
		if (recovered === null) throw new Error("Expected complete bounded artifact recovery");
		const normalized = (JSON.parse(recovered) as typeof files).map(({ filename, status, additions, deletions }) => ({
			filename,
			status,
			additions,
			deletions,
		}));
		expect(normalized[40]).toEqual({
			filename: "armature/src/terminal-route.tsx",
			status: "modified",
			additions: 41,
			deletions: 40,
		});
		expect(Buffer.byteLength(recovered, "utf8")).toBe(truncation.totalBytes);
	});

	it("isolates equal numeric IDs across owners and clears the old namespace when switching sessions", async () => {
		const first = inMemory();
		const second = inMemory();
		const firstId = await first.saveArtifact('{"owner":"first","route":"/first"}');
		const secondId = await second.saveArtifact('{"owner":"second","route":"/second"}');
		if (firstId === undefined || secondId === undefined) throw new Error("Expected artifact IDs");
		expect(firstId).toBe(secondId);
		expect(JSON.parse((await first.getArtifactContent(firstId, 1024))!)).toEqual({ owner: "first", route: "/first" });
		expect(JSON.parse((await second.getArtifactContent(secondId, 1024))!)).toEqual({
			owner: "second",
			route: "/second",
		});
		await first.newSession();
		spillRoots.add(first.getArtifactManager().dir);
		expect(await first.getArtifactContent(firstId, 1024)).toBeNull();
		const nextId = await first.saveArtifact('{"owner":"replacement","route":"/new"}');
		if (nextId === undefined) throw new Error("Expected replacement artifact ID");
		expect(nextId).toBe(firstId);
		expect(JSON.parse((await first.getArtifactContent(nextId, 1024))!)).toEqual({
			owner: "replacement",
			route: "/new",
		});
	});

	it("restores the original spill namespace after another owner reuses its numeric ID", async () => {
		const manager = inMemory();
		const id = await manager.saveArtifact('{"owner":"original"}');
		if (id === undefined) throw new Error("Expected original artifact ID");
		const original = manager.captureState();
		await manager.newSession();
		spillRoots.add(manager.getArtifactManager().dir);
		expect(await manager.saveArtifact('{"owner":"replacement"}')).toBe(id);
		manager.restoreState(original);
		expect(await manager.getArtifactContent(id, 1024)).toBe('{"owner":"original"}');
		const nextId = await manager.saveArtifact('{"owner":"original","next":true}');
		if (nextId === undefined) throw new Error("Expected next artifact ID");
		expect(await manager.getArtifactContent(id, 1024)).toBe('{"owner":"original"}');
		expect(await manager.getArtifactContent(nextId, 1024)).toBe('{"owner":"original","next":true}');
	});

	it("enforces UTF-8 byte limits and rejects invalid or missing spill requests without a transcript file", async () => {
		const manager = inMemory();
		const content = "λ東京🦊";
		const id = await manager.saveArtifact(content);
		if (id === undefined) throw new Error("Expected artifact ID");
		const bytes = Buffer.byteLength(content, "utf8");
		expect(await manager.getArtifactContent(id, content.length)).toBeNull();
		expect(await manager.getArtifactContent(id, bytes)).toBe(content);
		expect(await manager.getArtifactContent(id, -1)).toBeNull();
		expect(await manager.getArtifactContent(id, Number.NaN)).toBeNull();
		expect(await manager.getArtifactContent("../0", bytes)).toBeNull();
		expect(await manager.getArtifactContent("99", bytes)).toBeNull();
		const emptyId = await manager.saveArtifact("");
		if (emptyId === undefined) throw new Error("Expected empty artifact ID");
		expect(await manager.getArtifactContent(emptyId, 0)).toBe("");
	});

	it("reads bounded persisted Unicode text but refuses oversized files and symbolic links outside the owner", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		managers.push(manager);
		const content = '{"route":"/東京🦊","status":"modified"}';
		const id = await manager.saveArtifact(content);
		if (id === undefined) throw new Error("Expected persisted artifact ID");
		const bytes = Buffer.byteLength(content, "utf8");
		expect(await manager.getArtifactContent(id, bytes - 1)).toBeNull();
		expect(JSON.parse((await manager.getArtifactContent(id, bytes))!)).toEqual({
			route: "/東京🦊",
			status: "modified",
		});
		const privatePath = tempDir.join("another-owner.log");
		await Bun.write(privatePath, "private other-owner content");
		const artifactsDir = manager.getArtifactManager().dir;
		await fs.promises.symlink(privatePath, path.join(artifactsDir, "99.log"));
		expect(await manager.getArtifactContent("99", 1024)).toBeNull();
		expect(await manager.getArtifactContent("100", 1024)).toBeNull();
	});

	it("rejects an artifact directory redirected to another owner's namespace", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		const otherDir = tempDir.join("other-owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir, null));
		const id = await manager.saveArtifact("owned bytes");
		if (id === undefined) throw new Error("Expected artifact ID");
		await fs.promises.mkdir(otherDir);
		await Bun.write(path.join(otherDir, `${id}.log`), "private other-owner bytes");
		await fs.promises.rename(ownerDir, tempDir.join("displaced-owner"));
		await fs.promises.symlink(otherDir, ownerDir, "dir");
		expect(await manager.getArtifactContent(id, 1024)).toBeNull();
	});

	it("rejects invalid UTF-8 rather than returning equal-length replacement text", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir, null));
		await fs.promises.mkdir(ownerDir);
		await Bun.write(path.join(ownerDir, "0.log"), new Uint8Array([0xf0, 0x9f, 0xa6]));
		expect(await manager.getArtifactContent("0", 3)).toBeNull();
	});

	it("ignores unpublished staging files and returns the published payload after the atomic rename", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir, null));
		await fs.promises.mkdir(ownerDir);
		const staged = path.join(ownerDir, "0.log.tmp-interrupted");
		const published = path.join(ownerDir, "0.log");
		await Bun.write(staged, "incomplete");
		expect(await manager.getArtifactContent("0", 1024)).toBeNull();
		await Bun.write(published, "complete payload");
		expect(await manager.getArtifactContent("0", 1024)).toBe("complete payload");
		await fs.promises.rm(published);
		await Bun.write(staged, "renamed payload");
		await fs.promises.rename(staged, published);
		expect(await manager.getArtifactContent("0", 1024)).toBe("renamed payload");
	});

	for (const ownerChange of ["unchanged", "switch", "release", "adopt"] as const) {
		it(`waits for a branch artifact copy (owner: ${ownerChange})`, async () => {
			const manager = SessionManager.create(tempDir.path(), tempDir.path());
			managers.push(manager);
			const content = "retained branch payload";
			const id = await manager.saveArtifact(content);
			if (!id) throw new Error("Expected a persisted artifact id");
			const leafId = manager.appendMessage({
				role: "user",
				content: `Retain local://${id}.log`,
				timestamp: 1,
			});
			await manager.ensureOnDisk();
			const copying = Promise.withResolvers<void>();
			const releaseCopy = Promise.withResolvers<void>();
			const mkdir = fs.promises.mkdir.bind(fs.promises);
			const lstat = fs.promises.lstat.bind(fs.promises);
			const branchFile = manager.createBranchedSession(leafId, { copyArtifacts: true });
			if (!branchFile) throw new Error("Expected a persisted branch");
			const destinationDir = manager.getArtifactsDir();
			if (!destinationDir) throw new Error("Expected the branch artifact directory");
			const artifacts = manager.getArtifactManager();
			if (!artifacts) throw new Error("Expected the branch artifact manager");
			vi.spyOn(fs.promises, "mkdir").mockImplementation((async (target, options) => {
				if (target.toString() === destinationDir) {
					copying.resolve();
					await releaseCopy.promise;
				}
				return mkdir(target, options);
			}) as typeof fs.promises.mkdir);
			vi.spyOn(fs.promises, "lstat").mockImplementation((async (target, options) => {
				if (target.toString() === destinationDir) return fs.lstatSync(target, options);
				return lstat(target, options);
			}) as typeof fs.promises.lstat);
			let reading: Promise<string | null> | undefined;
			try {
				await withTimeout(copying.promise, 2_000, "Branch artifact copy never reached its destination");
				expect(fs.existsSync(destinationDir)).toBe(false);
				reading = manager.getArtifactContent(id, 1024);
				if (ownerChange === "switch") await manager.newSession();
				else if (ownerChange === "release") manager.releaseRetainedEntries();
				else if (ownerChange === "adopt")
					manager.adoptArtifactManager(new ArtifactManager(tempDir.join("adopted"), null));
				releaseCopy.resolve();
				expect(await reading).toBe(ownerChange === "unchanged" ? content : null);
			} finally {
				releaseCopy.resolve();
				await reading;
				await artifacts.ready;
			}
		});
	}

	for (const replaceDirectory of [false, true]) {
		it(`returns ${replaceDirectory ? "null" : "owned bytes"} when the directory is ${replaceDirectory ? "replaced" : "unchanged"} during lookup`, async () => {
			const manager = inMemory();
			const ownerDir = tempDir.join("lookup-owner");
			const artifacts = new ArtifactManager(ownerDir, null);
			manager.adoptArtifactManager(artifacts);
			const ownedContent = '{"owner":"original"}';
			const id = await manager.saveArtifact(ownedContent);
			if (id === undefined) throw new Error("Expected disk artifact ID");
			const lookupEntered = Promise.withResolvers<void>();
			const releaseLookup = Promise.withResolvers<void>();
			const lstat = fs.promises.lstat.bind(fs.promises);
			vi.spyOn(fs.promises, "lstat").mockImplementation((async (target, options) => {
				const result = await lstat(target, options);
				if (target.toString() === path.join(ownerDir, `${id}.log`)) {
					lookupEntered.resolve();
					await releaseLookup.promise;
				}
				return result;
			}) as typeof fs.promises.lstat);
			const reading = manager.getArtifactContent(id, 1024);
			try {
				await withTimeout(lookupEntered.promise, 2_000, "Owned artifact never reached lookup");
				if (replaceDirectory) {
					await fs.promises.rename(ownerDir, tempDir.join("displaced-lookup-owner"));
					await fs.promises.mkdir(ownerDir);
					await Bun.write(path.join(ownerDir, `${id}.log`), '{"owner":"replacement"}');
				}
				releaseLookup.resolve();
				expect(await reading).toBe(replaceDirectory ? null : ownedContent);
			} finally {
				releaseLookup.resolve();
				await reading;
			}
		});
	}

	it("discards an admitted disk read when its owner switches before the artifact lookup completes", async () => {
		const manager = inMemory();
		const artifactDir = tempDir.join("old-owner");
		const original = new ArtifactManager(artifactDir, null);
		manager.adoptArtifactManager(original);
		const id = await manager.saveArtifact('{"owner":"old"}');
		if (id === undefined) throw new Error("Expected disk artifact ID");
		const ready = Promise.withResolvers<void>();
		manager.adoptArtifactManager(new ArtifactManager(artifactDir, null, ready.promise));
		const reading = manager.getArtifactContent(id, 1024);
		await manager.newSession();
		spillRoots.add(manager.getArtifactManager().dir);
		const replacementId = await manager.saveArtifact('{"owner":"new"}');
		if (replacementId === undefined) throw new Error("Expected replacement artifact ID");
		ready.resolve();
		expect(await reading).toBeNull();
		expect(JSON.parse((await manager.getArtifactContent(replacementId, 1024))!)).toEqual({ owner: "new" });
	});

	for (const transition of ["switch", "release", "adopt", "directory"] as const) {
		it(`does not return old-owner bytes when ${transition} happens during the file-close await`, async () => {
			const manager = inMemory();
			const ownerDir = tempDir.join("closing-owner");
			manager.adoptArtifactManager(new ArtifactManager(ownerDir, null));
			const id = await manager.saveArtifact('{"owner":"old","route":"/private"}');
			if (id === undefined) throw new Error("Expected disk artifact ID");
			const artifactPath = await manager.getArtifactPath(id);
			if (!artifactPath) throw new Error("Expected owned artifact path");
			const closeEntered = Promise.withResolvers<void>();
			const releaseClose = Promise.withResolvers<void>();
			const open = fs.promises.open.bind(fs.promises);
			vi.spyOn(fs.promises, "open").mockImplementation(async (filePath, flags, mode) => {
				const file = await open(filePath, flags, mode);
				if (filePath === artifactPath) {
					const close = file.close.bind(file);
					vi.spyOn(file, "close").mockImplementation(async () => {
						closeEntered.resolve();
						await releaseClose.promise;
						await close();
					});
				}
				return file;
			});
			const reading = manager.getArtifactContent(id, 1024);
			try {
				await withTimeout(closeEntered.promise, 2_000, "Owned artifact never reached file close");
				if (transition === "switch") await manager.newSession();
				else if (transition === "release") manager.releaseRetainedEntries();
				else if (transition === "adopt") {
					manager.adoptArtifactManager(new ArtifactManager(tempDir.join("replacement-owner"), null));
				} else {
					await fs.promises.rename(ownerDir, tempDir.join("displaced-owner"));
					await fs.promises.mkdir(ownerDir);
					await Bun.write(path.join(ownerDir, `${id}.log`), "replacement namespace");
				}
				releaseClose.resolve();
				expect(await reading).toBeNull();
			} finally {
				releaseClose.resolve();
				await reading;
			}
		});
	}
});
