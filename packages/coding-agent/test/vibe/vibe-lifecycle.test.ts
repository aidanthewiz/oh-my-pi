import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

interface WorkerHarness {
	session: AgentSession;
	isDisposed: () => boolean;
}

function deferred(): Deferred {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index++) await Promise.resolve();
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "prompt",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

function createWorker(onDispose?: () => void | Promise<void>): WorkerHarness {
	let disposed = false;
	const session = {
		isStreaming: false,
		model: undefined,
		subscribe: () => () => {},
		prompt: async () => true,
		steer: async () => {},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {
			disposed = true;
			await onDispose?.();
		},
	} as unknown as AgentSession;
	return { session, isDisposed: () => disposed };
}

function createToolSession(manager: AsyncJobManager, sessionManager?: SessionManager): ToolSession {
	return {
		cwd: sessionManager?.getCwd() ?? "/tmp",
		hasUI: false,
		settings: Settings.isolated({}),
		getSessionFile: () => sessionManager?.getSessionFile() ?? null,
		getSessionId: () => sessionManager?.getSessionId() ?? "vibe-teardown-parent",
		getAgentId: () => "Main",
		getArtifactsDir: () => sessionManager?.getArtifactsDir() ?? null,
		getSessionSpawns: () => "*",
		sessionManager,
		asyncJobManager: manager,
	} as ToolSession;
}

async function persistWorkerSession(cwd: string, artifactsDir: string, id: string): Promise<string> {
	const childSessionFile = path.join(artifactsDir, `${id}.jsonl`);
	const childManager = SessionManager.create(cwd, artifactsDir);
	await childManager.setSessionFile(childSessionFile);
	childManager.appendSessionInit({
		systemPrompt: "Persisted Vibe worker",
		task: "Keep working.",
		tools: ["read", "yield"],
		spawns: "",
	});
	await childManager.flush();
	await childManager.close();
	return childSessionFile;
}

describe("Vibe teardown lifecycle", () => {
	const managers: AsyncJobManager[] = [];
	const sessionManagers: SessionManager[] = [];
	const tempRoots: string[] = [];

	function createManager(): AsyncJobManager {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		managers.push(manager);
		return manager;
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1_000 });
		for (const manager of sessionManagers.splice(0)) await manager.close();
		for (const root of tempRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
		VibeSessionRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("bounds teardown and ignores a cancelled turn that settles late", async () => {
		const jobGate = deferred();
		const releaseGate = deferred();
		const started = deferred();
		const disposeStarted = deferred();
		const worker = createWorker(async () => {
			disposeStarted.resolve();
			await releaseGate.promise;
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: worker.session,
				status: "running",
			});
			started.resolve();
			await jobGate.promise;
			return makeResult(options.id);
		});

		const manager = createManager();
		const session = createToolSession(manager);
		const registry = VibeSessionRegistry.global();
		registry.setTeardownGraceForTesting(20);
		const { jobId } = await registry.spawn(session, {
			cli: "fast",
			name: "late-worker",
			prompt: "Ignore cancellation.",
		});
		await started.promise;

		vi.useFakeTimers();
		try {
			let killSettled = false;
			const kill = registry.kill(session, "late-worker").finally(() => {
				killSettled = true;
			});
			await disposeStarted.promise;
			await flushMicrotasks();
			expect(killSettled).toBe(false);
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			vi.advanceTimersByTime(20);

			const outcome = await kill;
			expect(killSettled).toBe(true);
			expect(outcome.cancelledTurn).toBe(true);
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			expect(AgentRegistry.global().get("late-worker")).toBeUndefined();
			expect(registry.screens(session)[0]?.state).toBe("dead");

			releaseGate.resolve();
			jobGate.resolve();
			await manager.getJob(jobId)!.promise;
			await flushMicrotasks();
			expect(manager.getJob(jobId)?.status).toBe("cancelled");
			expect(AgentRegistry.global().get("late-worker")).toBeUndefined();
			expect(registry.screens(session)[0]?.state).toBe("dead");
		} finally {
			releaseGate.resolve();
			jobGate.resolve();
			vi.useRealTimers();
		}
	});

	it("does not replace a newer same-path worker with the killed terminal ref", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vibe-teardown-"));
		tempRoots.push(root);
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const parentManager = SessionManager.create(cwd, path.join(root, "sessions"));
		sessionManagers.push(parentManager);
		parentManager.appendModeChange("vibe");
		await parentManager.flush();

		const started = deferred();
		let replacement: AgentRef | undefined;
		let replacementWorker: WorkerHarness | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (!options.artifactsDir) throw new Error("Expected persisted Vibe artifacts");
			const childSessionFile = await persistWorkerSession(options.cwd, options.artifactsDir, options.id);
			replacementWorker = createWorker();
			const oldWorker = createWorker(() => {
				replacement = AgentRegistry.global().register({
					id: options.id,
					displayName: options.id,
					kind: "sub",
					parentId: "Main",
					session: replacementWorker!.session,
					sessionFile: childSessionFile,
					status: "idle",
				});
			});
			AgentRegistry.global().register({
				id: options.id,
				displayName: options.id,
				kind: "sub",
				parentId: "Main",
				session: oldWorker.session,
				sessionFile: childSessionFile,
				status: "running",
			});
			started.resolve();
			if (!options.signal) throw new Error("Expected worker cancellation signal");
			await new Promise<void>(resolve => {
				if (options.signal!.aborted) resolve();
				else options.signal!.addEventListener("abort", () => resolve(), { once: true });
			});
			return makeResult(options.id, { aborted: true });
		});

		const manager = createManager();
		const session = createToolSession(manager, parentManager);
		const registry = VibeSessionRegistry.global();
		registry.setTeardownGraceForTesting(100);
		await registry.spawn(session, {
			cli: "fast",
			name: "same-path-replacement",
			prompt: "Keep working.",
		});
		await started.promise;

		expect((await registry.kill(session, "same-path-replacement")).cancelledTurn).toBe(true);
		expect(replacement).toBeDefined();
		expect(AgentRegistry.global().get("same-path-replacement")).toBe(replacement);
		expect(replacement).toMatchObject({ status: "idle", session: replacementWorker!.session });
		expect(replacementWorker!.isDisposed()).toBe(false);
	});
});
