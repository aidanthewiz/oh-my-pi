import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
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

describe("deferred isolation cleanup", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		await Promise.all(tempRoots.splice(0).map(tempRoot => fs.rm(tempRoot, { force: true, recursive: true })));
	});

	it("keeps the worktree until deferred child cleanup settles", async () => {
		const cleanupGate = Promise.withResolvers<void>();
		const cleanupFinished = Promise.withResolvers<void>();
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-cleanup-"));
		tempRoots.push(artifactsDir);
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			return result({ exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" });
		});
		vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
			cleanupFinished.resolve();
		});

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredCleanup",
			},
			context: { repoRoot: "/repo", baseline: baseline("/repo") },
			preferredBackend: undefined,
			agentId: "DeferredCleanup",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => result({ exitCode: 1, error: String(error) }),
		});

		await Promise.resolve();
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		const outcome = await run;

		expect(outcome.exitCode).toBe(1);
		await cleanupFinished.promise;
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("captures completed work when deferred cleanup changes the result to failure", async () => {
		const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-deferred-"));
		tempRoots.push(repoRoot);
		const isolationDir = path.join(repoRoot, "isolated");
		const artifactsDir = path.join(repoRoot, "artifacts");
		await fs.mkdir(artifactsDir, { recursive: true });
		const cleanupGate = Promise.withResolvers<void>();
		const cleanupFinished = Promise.withResolvers<void>();
		const subprocessStarted = Promise.withResolvers<void>();
		const subprocessResult = Promise.withResolvers<SingleResult>();
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";
		const initial = baseline(repoRoot);

		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: isolationDir,
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			subprocessStarted.resolve();
			return subprocessResult.promise;
		});
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
			cleanupFinished.resolve();
		});

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: repoRoot,
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredFailure",
			},
			context: { repoRoot, baseline: initial },
			preferredBackend: undefined,
			agentId: "DeferredFailure",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => result({ id: "DeferredFailure", exitCode: 1, error: String(error) }),
		});
		await subprocessStarted.promise;
		subprocessResult.resolve(
			result({ id: "DeferredFailure", exitCode: 1, aborted: true, error: "cleanup exceeded its deadline" }),
		);
		await Promise.resolve();
		expect(captureSpy).not.toHaveBeenCalled();
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		const outcome = await run;

		const patchPath = path.join(artifactsDir, "DeferredFailure.patch");
		expect(outcome.exitCode).toBe(1);
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(captureSpy).toHaveBeenCalledWith(isolationDir, initial);
		await cleanupFinished.promise;
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});

	it("captures a successful yield after deferred child cleanup", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-defer-ok-"));
		tempRoots.push(artifactsDir);
		const rootPatch = "diff --git a/task.txt b/task.txt\n--- a/task.txt\n+++ b/task.txt\n@@ -1 +1 @@\n-old\n+new\n";
		const cleanupGate = Promise.withResolvers<void>();
		const subprocessStarted = Promise.withResolvers<void>();
		const subprocessResult = Promise.withResolvers<SingleResult>();
		const initial = baseline("/repo");
		vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue({
			mergedDir: "/repo/isolated",
			backend: natives.IsoBackendKind.Rcopy,
			fellBack: false,
			fallbackReason: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(options => {
			options.onCleanupDeferred?.(cleanupGate.promise);
			subprocessStarted.resolve();
			return subprocessResult.promise;
		});
		const captureSpy = vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({
			rootPatch,
			nestedPatches: [],
		});
		const cleanupSpy = vi.spyOn(worktreeModule, "cleanupIsolation").mockResolvedValue();

		const run = runIsolatedSubprocess({
			baseOptions: {
				cwd: "/repo",
				agent: { name: "task", description: "Task agent", systemPrompt: "test", source: "bundled" },
				task: "Do work",
				index: 0,
				id: "DeferredSuccess",
			},
			context: { repoRoot: "/repo", baseline: initial },
			preferredBackend: undefined,
			agentId: "DeferredSuccess",
			mergeMode: "patch",
			artifactsDir,
			buildFailureResult: error => result({ id: "DeferredSuccess", exitCode: 1, error: String(error) }),
		});

		await subprocessStarted.promise;
		subprocessResult.resolve(result({ id: "DeferredSuccess", exitCode: 0 }));
		await Promise.resolve();
		expect(captureSpy).not.toHaveBeenCalled();
		expect(cleanupSpy).not.toHaveBeenCalled();
		cleanupGate.resolve();
		const outcome = await run;

		const patchPath = path.join(artifactsDir, "DeferredSuccess.patch");
		expect(outcome.exitCode).toBe(0);
		expect(outcome.patchPath).toBe(patchPath);
		expect(await Bun.file(patchPath).text()).toBe(rootPatch);
		expect(captureSpy).toHaveBeenCalledWith("/repo/isolated", initial);
		await Promise.resolve();
		await Promise.resolve();
		expect(cleanupSpy).toHaveBeenCalledTimes(1);
	});
});
