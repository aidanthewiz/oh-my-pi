import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

interface RetentionProbeResult {
	baselineBytes: number;
	liveBytes: number;
	releasedBytes: number;
	retainedEntries: number;
}

describe("SessionManager artifact terminal release", () => {
	let tempDir: TempDir;
	const managers: SessionManager[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-artifact-release-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.close();
		tempDir.removeSync();
	});

	function inMemory(): SessionManager {
		const manager = SessionManager.inMemory(tempDir.path());
		managers.push(manager);
		return manager;
	}

	it("makes spill payloads collectible while the released manager remains reachable", async () => {
		const probe = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../fixtures/sdk-artifact-retention-probe.ts")],
			{
				cwd: path.join(import.meta.dir, "../../../.."),
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: tempDir.path(),
					BUN_JSC_useConcurrentJIT: "0",
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(probe.stdout).text(),
			new Response(probe.stderr).text(),
			probe.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout) as RetentionProbeResult;
		expect(result.liveBytes - result.baselineBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(result.releasedBytes - result.baselineBytes).toBeLessThan(2 * 1024 * 1024);
		expect(result.retainedEntries).toBe(0);
	});

	it("drops new spill writes after terminal release", async () => {
		const manager = inMemory();
		const payload = `live-${crypto.randomUUID()}`;
		expect(await manager.saveArtifact(payload, "read")).toBe("0");
		await manager.close();
		manager.releaseRetainedEntries();
		manager.releaseRetainedEntries();
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`, "read")).toBeUndefined();
		expect(await manager.getArtifactContent("0", Buffer.byteLength(payload))).toBeNull();
	});

	it("keeps accepting spill writes across nonterminal close and branch changes", async () => {
		const manager = inMemory();
		const firstEntry = manager.appendMessage({ role: "user", content: "first branch", timestamp: Date.now() });
		expect(await manager.saveArtifact("first spill", "read")).toBe("0");
		await manager.close();
		manager.appendMessage({ role: "user", content: "second branch", timestamp: Date.now() });
		manager.branch(firstEntry);
		expect(await manager.saveArtifact("second spill", "read")).toBe("1");
	});

	it("preserves adopted artifacts and their owner when a child is released", async () => {
		const shared = new ArtifactManager(path.join(tempDir.path(), "shared"));
		const child = inMemory();
		const sibling = inMemory();
		child.adoptArtifactManager(shared);
		sibling.adoptArtifactManager(shared);
		const firstId = await child.saveArtifact("completed child output", "task");
		if (!firstId) throw new Error("Expected a child artifact id");
		await child.close();
		child.releaseRetainedEntries();
		expect(await child.saveArtifact(`late-${crypto.randomUUID()}`, "task")).toBeUndefined();
		expect(await child.allocateArtifactPath("task")).toEqual({});
		const secondId = await sibling.saveArtifact("sibling output", "task");
		if (!secondId) throw new Error("Expected a sibling artifact id");
		expect(secondId).not.toBe(firstId);
		const firstPath = await child.getArtifactPath(firstId);
		const secondPath = await sibling.getArtifactPath(secondId);
		if (!firstPath || !secondPath) throw new Error("Expected retained artifact paths");
		expect(await Bun.file(firstPath).text()).toBe("completed child output");
		expect(await Bun.file(secondPath).text()).toBe("sibling output");
		expect(await shared.listFiles()).toHaveLength(2);
	});

	it("finishes a disk spill admitted before release and keeps persisted output readable", async () => {
		const ready = Promise.withResolvers<void>();
		const shared = new ArtifactManager(path.join(tempDir.path(), "pending"), ready.promise);
		const manager = inMemory();
		manager.adoptArtifactManager(shared);
		const content = `complete-${crypto.randomUUID()}-${"x".repeat(32 * 1024)}`;
		const saving = manager.saveArtifact(content, "task");
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
		const id = await manager.saveArtifact("persisted output", "bash");
		if (!id) throw new Error("Expected a persisted artifact id");
		await manager.close();
		manager.releaseRetainedEntries();
		const artifactPath = await manager.getArtifactPath(id);
		if (!artifactPath) throw new Error("Expected the persisted artifact path");
		expect(await Bun.file(artifactPath).text()).toBe("persisted output");
		expect(await manager.saveArtifact(`late-${crypto.randomUUID()}`, "bash")).toBeUndefined();
		expect(await manager.allocateArtifactPath("bash")).toEqual({});
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
		const firstId = await first.saveArtifact('{"owner":"first","route":"/first"}', "mcp");
		const secondId = await second.saveArtifact('{"owner":"second","route":"/second"}', "mcp");
		if (firstId === undefined || secondId === undefined) throw new Error("Expected artifact IDs");
		expect(firstId).toBe(secondId);
		expect(JSON.parse((await first.getArtifactContent(firstId, 1024))!)).toEqual({ owner: "first", route: "/first" });
		expect(JSON.parse((await second.getArtifactContent(secondId, 1024))!)).toEqual({
			owner: "second",
			route: "/second",
		});
		await first.newSession();
		expect(await first.getArtifactContent(firstId, 1024)).toBeNull();
		const nextId = await first.saveArtifact('{"owner":"replacement","route":"/new"}', "mcp");
		if (nextId === undefined) throw new Error("Expected replacement artifact ID");
		expect(nextId).toBe(firstId);
		expect(JSON.parse((await first.getArtifactContent(nextId, 1024))!)).toEqual({
			owner: "replacement",
			route: "/new",
		});
	});

	it("restores the original memory artifact namespace after another owner reuses its numeric ID", async () => {
		const manager = inMemory();
		const id = await manager.saveArtifact('{"owner":"original"}', "mcp");
		if (id === undefined) throw new Error("Expected original artifact ID");
		const original = manager.captureState();
		await manager.newSession();
		expect(await manager.saveArtifact('{"owner":"replacement"}', "mcp")).toBe(id);
		manager.restoreState(original);
		expect(await manager.getArtifactContent(id, 1024)).toBe('{"owner":"original"}');
		const nextId = await manager.saveArtifact('{"owner":"original","next":true}', "mcp");
		if (nextId === undefined) throw new Error("Expected next artifact ID");
		expect(await manager.getArtifactContent(id, 1024)).toBe('{"owner":"original"}');
		expect(await manager.getArtifactContent(nextId, 1024)).toBe('{"owner":"original","next":true}');
	});

	it("enforces UTF-8 byte limits and rejects invalid or missing artifact requests in memory", async () => {
		const manager = inMemory();
		const content = "λ東京🦊";
		const id = await manager.saveArtifact(content, "mcp");
		if (id === undefined) throw new Error("Expected artifact ID");
		const bytes = Buffer.byteLength(content, "utf8");
		expect(await manager.getArtifactContent(id, content.length)).toBeNull();
		expect(await manager.getArtifactContent(id, bytes)).toBe(content);
		expect(await manager.getArtifactContent(id, -1)).toBeNull();
		expect(await manager.getArtifactContent(id, Number.NaN)).toBeNull();
		expect(await manager.getArtifactContent("../0", bytes)).toBeNull();
		expect(await manager.getArtifactContent("99", bytes)).toBeNull();
		const emptyId = await manager.saveArtifact("", "mcp");
		if (emptyId === undefined) throw new Error("Expected empty artifact ID");
		expect(await manager.getArtifactContent(emptyId, 0)).toBe("");
	});

	it("reads bounded persisted Unicode text but refuses oversized files and symbolic links outside the owner", async () => {
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		managers.push(manager);
		const content = '{"route":"/東京🦊","status":"modified"}';
		const id = await manager.saveArtifact(content, "mcp");
		if (id === undefined) throw new Error("Expected persisted artifact ID");
		const bytes = Buffer.byteLength(content, "utf8");
		expect(await manager.getArtifactContent(id, bytes - 1)).toBeNull();
		expect(JSON.parse((await manager.getArtifactContent(id, bytes))!)).toEqual({
			route: "/東京🦊",
			status: "modified",
		});
		const privatePath = tempDir.join("another-owner.log");
		await Bun.write(privatePath, "private other-owner content");
		const artifactsDir = manager.getArtifactsDir();
		if (!artifactsDir) throw new Error("Expected owner artifact directory");
		await fs.promises.symlink(privatePath, path.join(artifactsDir, "99.mcp.log"));
		expect(await manager.getArtifactContent("99", 1024)).toBeNull();
		expect(await manager.getArtifactContent("100", 1024)).toBeNull();
	});

	it("rejects an artifact directory redirected to another owner's namespace", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		const otherDir = tempDir.join("other-owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir));
		const id = await manager.saveArtifact("owned bytes", "mcp");
		if (id === undefined) throw new Error("Expected artifact ID");
		await fs.promises.mkdir(otherDir);
		await Bun.write(path.join(otherDir, `${id}.mcp.log`), "private other-owner bytes");
		await fs.promises.rename(ownerDir, tempDir.join("displaced-owner"));
		await fs.promises.symlink(otherDir, ownerDir, "dir");
		expect(await manager.getArtifactContent(id, 1024)).toBeNull();
	});

	it("rejects invalid UTF-8 rather than returning equal-length replacement text", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir));
		await fs.promises.mkdir(ownerDir);
		await Bun.write(path.join(ownerDir, "0.mcp.log"), new Uint8Array([0xf0, 0x9f, 0xa6]));
		expect(await manager.getArtifactContent("0", 3)).toBeNull();
	});

	it("ignores unpublished staging files and returns the published payload after the atomic rename", async () => {
		const manager = inMemory();
		const ownerDir = tempDir.join("owner");
		manager.adoptArtifactManager(new ArtifactManager(ownerDir));
		await fs.promises.mkdir(ownerDir);
		const staged = path.join(ownerDir, "0.mcp.log.tmp-interrupted");
		const published = path.join(ownerDir, "0.mcp.log");
		await Bun.write(staged, "incomplete");
		expect(await manager.getArtifactContent("0", 1024)).toBeNull();
		await Bun.write(published, "complete payload");
		expect(await manager.getArtifactContent("0", 1024)).toBe("complete payload");
		await fs.promises.rm(published);
		await Bun.write(staged, "renamed payload");
		await fs.promises.rename(staged, published);
		expect(await manager.getArtifactContent("0", 1024)).toBe("renamed payload");
	});

	for (const replaceDirectory of [false, true]) {
		it(`returns ${replaceDirectory ? "null" : "owned bytes"} when the directory is ${replaceDirectory ? "replaced" : "unchanged"} during lookup`, async () => {
			const manager = inMemory();
			const ownerDir = tempDir.join("lookup-owner");
			const artifacts = new ArtifactManager(ownerDir);
			manager.adoptArtifactManager(artifacts);
			const ownedContent = '{"owner":"original"}';
			const id = await manager.saveArtifact(ownedContent, "mcp");
			if (id === undefined) throw new Error("Expected disk artifact ID");
			const lookupEntered = Promise.withResolvers<void>();
			const releaseLookup = Promise.withResolvers<void>();
			const listFiles = artifacts.listFiles.bind(artifacts);
			vi.spyOn(artifacts, "listFiles").mockImplementation(async () => {
				lookupEntered.resolve();
				await releaseLookup.promise;
				return listFiles();
			});
			const reading = manager.getArtifactContent(id, 1024);
			try {
				await withTimeout(lookupEntered.promise, 2_000, "Owned artifact never reached lookup");
				if (replaceDirectory) {
					await fs.promises.rename(ownerDir, tempDir.join("displaced-lookup-owner"));
					await fs.promises.mkdir(ownerDir);
					await Bun.write(path.join(ownerDir, `${id}.mcp.log`), '{"owner":"replacement"}');
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
		const original = new ArtifactManager(artifactDir);
		manager.adoptArtifactManager(original);
		const id = await manager.saveArtifact('{"owner":"old"}', "mcp");
		if (id === undefined) throw new Error("Expected disk artifact ID");
		const ready = Promise.withResolvers<void>();
		manager.adoptArtifactManager(new ArtifactManager(artifactDir, ready.promise));
		const reading = manager.getArtifactContent(id, 1024);
		await manager.newSession();
		const replacementId = await manager.saveArtifact('{"owner":"new"}', "mcp");
		if (replacementId === undefined) throw new Error("Expected replacement artifact ID");
		ready.resolve();
		expect(await reading).toBeNull();
		expect(JSON.parse((await manager.getArtifactContent(replacementId, 1024))!)).toEqual({ owner: "new" });
	});

	for (const transition of ["switch", "release", "adopt", "directory"] as const) {
		it(`does not return old-owner bytes when ${transition} happens during the file-close await`, async () => {
			const manager = inMemory();
			const ownerDir = tempDir.join("closing-owner");
			manager.adoptArtifactManager(new ArtifactManager(ownerDir));
			const id = await manager.saveArtifact('{"owner":"old","route":"/private"}', "mcp");
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
					manager.adoptArtifactManager(new ArtifactManager(tempDir.join("replacement-owner")));
				} else {
					await fs.promises.rename(ownerDir, tempDir.join("displaced-owner"));
					await fs.promises.mkdir(ownerDir);
					await Bun.write(path.join(ownerDir, `${id}.mcp.log`), "replacement namespace");
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
