import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { nativeWorkspace, runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import { writeIsolationOwner } from "@oh-my-pi/pi-coding-agent/task/isolation-ownership";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

function result(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id: "DeferredCleanup",
		agent: "task",
		agentSource: "bundled",
		task: "Do nested work",
		assignment: "Do nested work",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
		...overrides,
	};
}

const tempRoots: string[] = [];

const baseline = (repoRoot: string) => ({
	root: {
		repoRoot,
		headCommit: "base",
		staged: "",
		unstaged: "",
		untracked: [],
		untrackedPatch: "",
	},
	nested: [],
});

const realCleanupIsolation = worktreeModule.cleanupIsolation;

async function createIsolationFixture(id: string) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-deferred-"));
	tempRoots.push(root);
	const repoRoot = path.join(root, "repo");
	const baseDir = path.join(root, "workspace");
	const isolationDir = path.join(baseDir, "m");
	const artifactsDir = path.join(root, "artifacts");
	await Promise.all([fs.mkdir(repoRoot), fs.mkdir(isolationDir, { recursive: true }), fs.mkdir(artifactsDir)]);
	const taskPath = path.join(isolationDir, "task.txt");
	await fs.writeFile(taskPath, "protected task data");
	await writeIsolationOwner(baseDir, id);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
		mergedDir: isolationDir,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktreeModule, "captureIsolationBaseline").mockResolvedValue(baseline(repoRoot));
	const cleanupFinished = Promise.withResolvers<void>();
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(handle => {
		const completion = realCleanupIsolation(handle);
		cleanupFinished.resolve(completion);
		return completion;
	});
	return { repoRoot, baseDir, artifactsDir, taskPath, cleanupFinished: cleanupFinished.promise };
}

describe("deferred isolation cleanup", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("keeps the worktree until deferred child cleanup settles", async () => {
		const fixture = await createIsolationFixture("DeferredCleanup");
		const cleanupGate = Promise.withResolvers<void>();
		const subprocessReturned = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" });
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: fixture.repoRoot,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredCleanup",
				keepAlive: false,
			},
			context: { repoRoot: fixture.repoRoot },
			openWorkspace: nativeWorkspace(undefined),
			agentId: "DeferredCleanup",
			mergeMode: "patch",
			artifactsDir: fixture.artifactsDir,
			buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
			onSubprocessResult: () => subprocessReturned.resolve(),
		});

		try {
			await subprocessReturned.promise;
			expect(await fs.readFile(fixture.taskPath, "utf8")).toBe("protected task data");
		} finally {
			cleanupGate.resolve();
			await run;
			await fixture.cleanupFinished;
		}

		const outcome = await run;
		expect(outcome.exitCode).toBe(1);
		const removal = await fs.stat(fixture.baseDir).then(
			() => null,
			(error: unknown) => error,
		);
		expect(removal).toMatchObject({ code: "ENOENT" });
	});

	it("captures completed work when deferred cleanup changes the result to failure", async () => {
		const fixture = await createIsolationFixture("DeferredFailure");
		const cleanupGate = Promise.withResolvers<void>();
		const subprocessStarted = Promise.withResolvers<void>();
		const subprocessReturned = Promise.withResolvers<void>();
		const subprocessResult = Promise.withResolvers<SingleResult>();
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";

		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			subprocessStarted.resolve();
			return subprocessResult.promise;
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const patchPath = path.join(fixture.artifactsDir, "DeferredFailure.patch");

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: fixture.repoRoot,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredFailure",
				keepAlive: false,
			},
			context: { repoRoot: fixture.repoRoot },
			openWorkspace: nativeWorkspace(undefined),
			agentId: "DeferredFailure",
			mergeMode: "patch",
			artifactsDir: fixture.artifactsDir,
			buildFailureResult: error => result({ id: "DeferredFailure", exitCode: 1, error: String(error) }),
			onSubprocessResult: () => subprocessReturned.resolve(),
		});
		await subprocessStarted.promise;
		subprocessResult.resolve(
			result({ id: "DeferredFailure", exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" }),
		);
		try {
			await subprocessReturned.promise;
			expect(await Bun.file(patchPath).exists()).toBe(false);
			expect(await fs.readFile(fixture.taskPath, "utf8")).toBe("protected task data");
		} finally {
			cleanupGate.resolve();
			await run;
			await fixture.cleanupFinished;
		}

		const outcome = await run;
		expect(outcome.exitCode).toBe(1);
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		const removal = await fs.stat(fixture.baseDir).then(
			() => null,
			(error: unknown) => error,
		);
		expect(removal).toMatchObject({ code: "ENOENT" });
	});

	it("captures a successful yield after deferred child cleanup", async () => {
		const fixture = await createIsolationFixture("DeferredSuccess");
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";
		const cleanupGate = Promise.withResolvers<void>();
		const subprocessStarted = Promise.withResolvers<void>();
		const subprocessReturned = Promise.withResolvers<void>();
		const subprocessResult = Promise.withResolvers<SingleResult>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			subprocessStarted.resolve();
			return subprocessResult.promise;
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const patchPath = path.join(fixture.artifactsDir, "DeferredSuccess.patch");

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: fixture.repoRoot,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredSuccess",
				keepAlive: false,
			},
			context: { repoRoot: fixture.repoRoot },
			openWorkspace: nativeWorkspace(undefined),
			agentId: "DeferredSuccess",
			mergeMode: "patch",
			artifactsDir: fixture.artifactsDir,
			buildFailureResult: error => result({ id: "DeferredSuccess", exitCode: 1, error: String(error) }),
			onSubprocessResult: () => subprocessReturned.resolve(),
		});

		await subprocessStarted.promise;
		subprocessResult.resolve(result({ id: "DeferredSuccess", exitCode: 0 }));
		try {
			await subprocessReturned.promise;
			expect(await Bun.file(patchPath).exists()).toBe(false);
			expect(await fs.readFile(fixture.taskPath, "utf8")).toBe("protected task data");
		} finally {
			cleanupGate.resolve();
			await run;
			await fixture.cleanupFinished;
		}

		const outcome = await run;
		expect(outcome.exitCode).toBe(0);
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		const removal = await fs.stat(fixture.baseDir).then(
			() => null,
			(error: unknown) => error,
		);
		expect(removal).toMatchObject({ code: "ENOENT" });
	});
});
