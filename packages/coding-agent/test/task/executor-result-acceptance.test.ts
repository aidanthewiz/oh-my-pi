/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetRegisteredArtifactDirsForTests } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	artifactFileGeneration,
	serializeStructuredArtifactSidecar,
} from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import {
	attachIrcWakeTurnMonitor,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import * as completionProbeModule from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { CompletionProbeOptions } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

async function writeBoundAcceptedSidecar(artifactsDir: string, serializedData: string): Promise<string> {
	const primary = path.join(artifactsDir, `${AGENT_ID}.md`);
	const generation = artifactFileGeneration(await fs.stat(primary, { bigint: true }));
	const envelope = serializeStructuredArtifactSidecar(serializedData, generation);
	await Bun.write(path.join(artifactsDir, `${AGENT_ID}.json`), envelope);
	return envelope;
}

function assistantStopMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

interface SessionHarness {
	session: AgentSession;
	/** Resolves when the executor has dispatched the session's prompt. */
	promptEntered: Promise<void>;
	/** Emit a successful terminal `yield` tool result through the session event stream. */
	emitTerminalYield: (data: unknown) => void;
	/** End an assistant message carrying `text` and no tool calls. */
	emitAssistantText: (text: string, stop?: Pick<AssistantMessage, "stopReason" | "errorMessage">) => void;
	abortEntered: Promise<void>;
	/** End an assistant message carrying `content`, tool calls included. */
	emitAssistantContent: (content: AssistantMessage["content"]) => void;
	/** End the agent loop with every assistant message emitted so far. */
	emitAgentEnd: () => void;
	/** Finish a `toolName` call whose result is `text`. */
	emitToolResult: (toolName: string, text: string) => void;
	/** The observer factory installed by {@link attachIrcWakeTurnMonitor}, if any. */
	wakeObserver: () =>
		| ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined)
		| undefined;
}

/**
 * Minimal session that satisfies the executor's run surface. `prompt` submits a
 * terminal `yield` (so `runSubprocess` / `runSubagentFollowUpTurn` settle), and
 * `subscribeRunState` never fires — the run-state mirror omits `idle`, which is
 * exactly the leak the acceptance boundary must cover.
 */
function createHarness(options?: { hangPrompt?: boolean; asyncJobManager?: AsyncJobManager }): SessionHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const messages: AssistantMessage[] = [];
	const promptEntered = Promise.withResolvers<void>();
	const hangingPrompt = Promise.withResolvers<void>();
	const abortEntered = Promise.withResolvers<void>();
	let yieldSeq = 0;
	let toolSeq = 0;
	let disposed = false;
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantContent = (
		content: AssistantMessage["content"],
		stop?: Pick<AssistantMessage, "stopReason" | "errorMessage">,
	) => {
		const message = { ...assistantStopMessage(content), ...stop };
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
	};
	const emitAssistantText = (text: string, stop?: Pick<AssistantMessage, "stopReason" | "errorMessage">) =>
		emitAssistantContent([{ type: "text", text }], stop);
	const emitAgentEnd = () => emit({ type: "agent_end", messages: [...messages] } as AgentSessionEvent);
	const emitToolResult = (toolName: string, text: string) => {
		toolSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `${toolName}-${toolSeq}`,
			toolName,
			result: { content: [{ type: "text", text }] },
		} as AgentSessionEvent);
	};
	const emitTerminalYield = (data: unknown) => {
		yieldSeq += 1;
		emit({
			type: "tool_execution_end",
			toolCallId: `yield-${yieldSeq}`,
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
		} as AgentSessionEvent);
	};
	const session = {
		get isDisposed() {
			return disposed;
		},
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: SessionManager.inMemory(),
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		getMountedXdevToolNames: () => [],
		getToolByName: () => undefined,
		setActiveToolsByName: async () => {},
		setWorkPoolYieldItems: () => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptEntered.resolve();
			if (options?.hangPrompt) {
				await hangingPrompt.promise;
				return true;
			}
			emitAssistantText("submitting");
			emitTerminalYield({ report: text });
			return true;
		},
		waitForIdle: async () => {},
		isAdvisorActive: () => false,
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => messages[messages.length - 1],
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		waitForRunEnd: async () => {},
		abort: async () => {
			abortEntered.resolve();
		},
		dispose: async () => {
			disposed = true;
		},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		hasIrcInterrupts: () => false,
		holdIrcWakes: () => () => {},
		hasQueuedIrcFrom: () => false,
		subscribeRunState: () => () => {},
		isParentIrcSteer: () => false,
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		abortEntered: abortEntered.promise,
		emitTerminalYield,
		emitAssistantText,
		emitAssistantContent,
		emitAgentEnd,
		emitToolResult,
		wakeObserver: () => wakeObserver,
	};
}

function registerRunning(session: AgentSession) {
	return AgentRegistry.global().register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		session,
		status: "running",
	});
}

async function flushMicrotasks(): Promise<void> {
	for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("runSubprocess result acceptance", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	it("terminalizes the ref and stamps the run lifecycle when the yield is accepted", async () => {
		const harness = createHarness();
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			captureOwnerCurrent:
				({ allowParked = false } = {}) =>
				() =>
					!harness.session.isDisposed &&
					AgentRegistry.global().get(AGENT_ID) === ref &&
					ref.session === harness.session &&
					ref.status !== "aborted" &&
					(allowParked || ref.status !== "parked"),
			captureOwnerLifetimeCurrent: () => () =>
				!harness.session.isDisposed &&
				AgentRegistry.global().get(AGENT_ID) === ref &&
				ref.session === harness.session &&
				ref.status !== "aborted",
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do the work",
			index: 0,
			id: AGENT_ID,
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
		expect(AgentRegistry.global().staleAcceptedRuns()).toEqual([]);
		// Launch milestone is the registration timestamp the acceptance must not move.
		expect(settled?.createdAt).toBe(ref.createdAt);
	});

	it("settles the owning task job when Agent Hub tombstones a running subagent", async () => {
		const harness = createHarness({ hangPrompt: true });
		const ref = registerRunning(harness.session);
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue({
			session: harness.session,
			captureOwnerCurrent:
				({ allowParked = false } = {}) =>
				() =>
					!harness.session.isDisposed &&
					AgentRegistry.global().get(AGENT_ID) === ref &&
					ref.session === harness.session &&
					ref.status !== "aborted" &&
					(allowParked || ref.status !== "parked"),
			captureOwnerLifetimeCurrent: () => () =>
				!harness.session.isDisposed &&
				AgentRegistry.global().get(AGENT_ID) === ref &&
				ref.session === harness.session &&
				ref.status !== "aborted",
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} as CreateAgentSessionResult);
		const delivered = Promise.withResolvers<{ id: string; text: string }>();
		const manager = new AsyncJobManager({
			onJobComplete: (id, text) => delivered.resolve({ id, text }),
		});
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: baseAgent,
				task: "do the work",
				index: 0,
				id: AGENT_ID,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});

		try {
			await harness.promptEntered;
			await harness.session.abort();
			await AgentLifecycleManager.global().release(AGENT_ID, ref, { tombstone: true });

			const job = manager.getJob(jobId);
			expect(job).toBeDefined();
			await flushMicrotasks();
			const settlement = job!.status === "running" ? ("still-running" as const) : ("settled" as const);
			if (settlement === "still-running") manager.cancel(jobId);
			await job!.promise;

			expect(settlement).toBe("settled");
			expect(job!.status).toBe("failed");
			expect(await delivered.promise).toMatchObject({ id: jobId });
		} finally {
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("settles a retired task before another publication lease is released", async () => {
		using tmp = TempDir.createSync("@omp-test-task-publication-retirement-");
		const artifactsDir = tmp.path();
		const primary = path.join(artifactsDir, `${AGENT_ID}.md`);
		await Bun.write(primary, "Previously accepted complete result");
		const sidecar = await writeBoundAcceptedSidecar(artifactsDir, '{"accepted":true}');
		const harness = createHarness();
		const promptStarted = Promise.withResolvers<void>();
		const continuePrompt = Promise.withResolvers<void>();
		const prompt = harness.session.prompt.bind(harness.session);
		harness.session.prompt = async (text, options) => {
			promptStarted.resolve();
			await continuePrompt.promise;
			return prompt(text, options);
		};
		const ref = registerRunning(harness.session);
		const manager = new AsyncJobManager({});
		let callerSignal: AbortSignal | undefined;
		const jobId = manager.register("task", AGENT_ID, async ({ signal }) => {
			callerSignal = signal;
			const result = await runSubagentFollowUpTurn({
				agent: baseAgent,
				message: "publish a complete result",
				id: AGENT_ID,
				artifactsDir,
				signal,
			});
			if (result.exitCode !== 0) throw new Error(result.abortReason ?? result.error ?? "Task failed");
			return result.output;
		});
		const waiting = Promise.withResolvers<void>();
		let holderHeld = false;
		let holder: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const wait = scheduler.wait.bind(scheduler);
		vi.spyOn(scheduler, "wait").mockImplementation((delay, options) => {
			if (delay === 25 && holderHeld) waiting.resolve();
			return wait(delay, options);
		});
		try {
			expect(
				await Promise.race([
					promptStarted.promise.then(() => true),
					manager.getJob(jobId)!.promise.then(() => false),
				]),
			).toBe(true);
			holder = Bun.spawn(
				[
					process.execPath,
					"--no-env-file",
					"--eval",
					`import { withArtifactPublicationLock } from ${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/artifact-publication"))};
await withArtifactPublicationLock(async () => {
	console.log("lease-held");
	await Bun.stdin.text();
});`,
				],
				{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			const output = holder.stdout.getReader();
			const ready = await output.read();
			output.releaseLock();
			expect(new TextDecoder().decode(ready.value)).toBe("lease-held\n");
			holderHeld = true;
			continuePrompt.resolve();
			await waiting.promise;
			await harness.session.abort();
			await AgentLifecycleManager.global().release(AGENT_ID, ref, { tombstone: true });
			const job = manager.getJob(jobId)!;
			const settledBeforeRelease = await Promise.race([
				job.promise.then(() => true),
				new Promise<boolean>(resolve => {
					timeout = setTimeout(() => resolve(false), 2000);
				}),
			]);
			expect(settledBeforeRelease).toBe(true);
			expect(callerSignal?.aborted).toBe(false);
			expect(job.status).toBe("failed");
			expect(holderHeld).toBe(true);
			expect(holder.exitCode).toBeNull();
			expect(await Bun.file(primary).text()).toBe("Previously accepted complete result");
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(sidecar);
		} finally {
			clearTimeout(timeout);
			continuePrompt.resolve();
			holder?.stdin.end();
			if (holder) await holder.exited;
			manager.cancel(jobId);
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("terminalizes an existing ref on a follow-up turn whose run-state mirror omits idle", async () => {
		const harness = createHarness();
		registerRunning(harness.session);

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
		});

		expect(result.exitCode).toBe(0);
		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	for (const enabled of [false, true]) {
		it(`keeps accepted yield presentation probe-gated (${enabled}) without settling unfinished work`, async () => {
			const harness = createHarness();
			registerRunning(harness.session);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let probe: CompletionProbeOptions | undefined;
			vi.spyOn(completionProbeModule, "startCompletionProbe").mockImplementation(options => {
				probe = options;
			});
			harness.session.prompt = async () => {
				entered.resolve();
				await release.promise;
				return true;
			};
			const progress: AgentProgress[] = [];
			let settled = false;
			const run = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: baseAgent,
				message: "continue",
				completionProbe: enabled,
				onProgress: update => progress.push({ ...update }),
			});
			void run.then(() => {
				settled = true;
			});
			try {
				await entered.promise;
				probe?.onEstimate({ percent: 42 }, 0.1);
				harness.emitTerminalYield({ report: "submitted" });
				probe?.onEstimate({ percent: 15 }, 0.3);
				expect(progress.at(-1)?.completionPercent).toBe(enabled ? 99 : undefined);
				expect(progress.at(-1)?.cost).toBeCloseTo(enabled ? 0.4 : 0);
				await Promise.resolve();
				expect(settled).toBe(false);
				release.resolve();
				expect((await run).exitCode).toBe(0);
				expect(probe !== undefined).toBe(enabled);
			} finally {
				release.resolve();
				await run;
			}
		});
	}

	it("terminalizes the ref when an autonomous wake turn's yield is accepted", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		expect(observer).toBeDefined();

		const finish = observer?.([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "wake",
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		expect(finish).toBeDefined();
		harness.emitTerminalYield({ report: "answered while woken" });
		await finish?.(undefined);

		const settled = AgentRegistry.global().get(AGENT_ID);
		expect(settled?.status).not.toBe("running");
		expect(settled?.lifecycle?.responseAt).toBeNumber();
		expect(settled?.lifecycle?.acceptedAt).toBeNumber();
		expect(settled?.lifecycle?.terminalAt).toBeNumber();
	});

	it("delivers every yield of a woken agent to its parent as a job completion", async () => {
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			for (const report of ["followup-done", "broadcast-ok"]) {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "follow up",
						display: false,
						details: { id: `msg-${report}`, from: "Parent", message: "follow up" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				harness.emitTerminalYield({ report });
				// Pending from acceptance until finalization: the parent's `wait` can block on it.
				expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
				await finish?.(undefined);
				await manager.waitForAll();
				await manager.drainDeliveries({ timeoutMs: 1000 });
			}

			expect(delivered).toHaveLength(2);
			expect(delivered[0]).toContain("followup-done");
			expect(delivered[1]).toContain("broadcast-ok");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it("reads the latest message-result completion after an IRC wake instead of the first result", async () => {
		const tempDir = TempDir.createSync("@omp-latest-agent-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_id, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, {
			id: AGENT_ID,
			agent: baseAgent,
			artifactsDir,
		});
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const reader = new ReadTool({
			cwd: artifactsDir,
			hasUI: false,
			getArtifactsDir: () => artifactsDir,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		});

		try {
			// A completed first run left a structured payload on disk.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), '{"reports":[{"verdict":"round-1"}]}');
			await writeBoundAcceptedSidecar(artifactsDir, '{"reports":[{"verdict":"round-1"}]}');
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "review the revised patch",
					display: false,
					details: { id: "msg-revised", from: "Parent", message: "review the revised patch" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText('{"reports":[{"verdict":"round-2"}]}');
			await finish?.(undefined);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("round-2");
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).exists()).toBe(false);
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe('{"reports":[{"verdict":"round-2"}]}');
			const read = await reader.execute("latest-result", { path: `agent://${AGENT_ID}` });
			expect(read.content).toEqual(
				expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("round-2") })]),
			);
			expect(JSON.stringify(read.content)).not.toContain("round-1");
			// The previous structured sidecar must not shadow the new message result.
			const extracted = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}/reports/0/verdict`);
			expect(extracted.content).toBe("round-2");
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			InternalUrlRouter.resetForTests();
			resetRegisteredArtifactDirsForTests();
			tempDir.removeSync();
		}
	});

	it("relays a peer-only plain answer without publishing an owner result or replacing its accepted artifact", async () => {
		const tempDir = TempDir.createSync("@omp-peer-agent-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		const relayed: Record<string, string[]> = { Parent: [], OtherAgent: [] };
		manager.registerDeliverySink("Parent", (_id, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		for (const id of ["Parent", "OtherAgent"]) {
			AgentRegistry.global().register({
				id,
				displayName: id,
				kind: "main",
				status: "running",
				session: {
					sessionManager: SessionManager.inMemory(),
					deliverIrcMessage: async (message: { body: string }) => {
						relayed[id].push(message.body);
						return "injected";
					},
				} as unknown as AgentSession,
			});
		}
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';
		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			const acceptedSidecar = await writeBoundAcceptedSidecar(artifactsDir, accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "is line 42 fine?",
					display: false,
					details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			expect(manager.getAllJobs()).toEqual([]);
			harness.emitAssistantText("line 42 is fine");
			await finish?.(undefined);
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(delivered).toEqual([]);
			expect(relayed.Parent).toEqual([]);
			expect(relayed.OtherAgent).toHaveLength(1);
			expect(relayed.OtherAgent[0]).toContain("line 42 is fine");
			expect(manager.getAllJobs()).toEqual([]);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(acceptedSidecar);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("publishes an explicit plain follow-up and removes its previous structured sidecar", async () => {
		const tempDir = TempDir.createSync("@omp-explicit-plain-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		registerRunning(harness.session);
		const report = '{"report":"explicit revised verdict"}';
		vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			harness.emitAssistantText(report);
			return true;
		});
		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), '{"report":"old"}');
			await writeBoundAcceptedSidecar(artifactsDir, '{"report":"old"}');
			const result = await runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: baseAgent,
				message: "review the revision",
				artifactsDir,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe(report);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(report);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).exists()).toBe(false);
		} finally {
			tempDir.removeSync();
		}
	});

	it("delivers a user-resumed message result when all execution slots are occupied", async () => {
		const tempDir = TempDir.createSync("@omp-user-resumed-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const blocker = Promise.withResolvers<string>();
		manager.register("bash", "busy", () => blocker.promise, { ownerId: "Other" });
		expect(manager.atCapacity).toBe(true);
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_jobId, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			// The initial run died on a provider error before reporting.
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), "");
			const finish = observer([
				{
					role: "user",
					content: "credits are back, finish the report",
					attribution: "user",
					timestamp: Date.now(),
				},
			]);
			harness.emitAssistantText("## Report\nroot cause found");
			await finish?.(undefined);
			expect(manager.atCapacity).toBe(true);
			await manager.drainDeliveries({ timeoutMs: 1000 });
			AgentRegistry.global().setStatus(AGENT_ID, "idle");

			const resolved = await InternalUrlRouter.instance().resolve(`agent://${AGENT_ID}`);
			expect(resolved.content).toBe("## Report\nroot cause found");
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toContain("root cause found");
		} finally {
			InternalUrlRouter.resetForTests();
			blocker.resolve("finished");
			resetRegisteredArtifactDirsForTests();
			await manager.waitForAll();
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("does not publish a focused result through a replaced registry generation sharing its session", async () => {
		const tempDir = TempDir.createSync("@omp-stale-focused-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const delivered: string[] = [];
		manager.registerDeliverySink("Parent", (_id, text) => {
			delivered.push(text);
		});
		const harness = createHarness({ asyncJobManager: manager });
		const registry = AgentRegistry.global();
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';
		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			const acceptedSidecar = await writeBoundAcceptedSidecar(artifactsDir, accepted);
			const finish = observer([{ role: "user", content: "go on", attribution: "user", timestamp: Date.now() }]);
			harness.emitAssistantText("stale report");
			const replacement = registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "running",
			});
			await finish?.();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(acceptedSidecar);
			expect(delivered).toEqual([]);
			expect(replacement.status).toBe("running");
			expect(replacement.lifecycle?.acceptedAt).toBeUndefined();
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("keeps the accepted artifact and sidecar when the parent cancels its wake job before finalization", async () => {
		const tempDir = TempDir.createSync("@omp-cancelled-wake-result-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			const acceptedSidecar = await writeBoundAcceptedSidecar(artifactsDir, accepted);
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "recheck",
					display: false,
					details: { id: "msg-owner", from: "Parent", message: "recheck" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitAssistantText("cancelled answer");
			expect(manager.cancel(AGENT_ID)).toBe(true);
			await finish?.(undefined);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(acceptedSidecar);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("gives a turn the owner woke a job whose widget reads the turn's tool calls and whose progress wait reads", async () => {
		const tempDir = TempDir.createSync("@omp-wake-job-widget-");
		const artifactsDir = tempDir.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		harness.session.sessionManager.getArtifactsDir = () => artifactsDir;
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "label every bash output",
					display: false,
					details: { id: "msg-owner", from: "Parent", message: "label every bash output" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			harness.emitToolResult("bash", "BENCH tok_s_stream=171");
			const inputs = manager.getJob(AGENT_ID)?.widgetInputs;
			const [tools] = inputs?.sources() ?? [];
			expect(tools?.id).toBe("tools");
			expect(tools?.read(0)).toMatchObject({ open: true });
			expect(tools?.read(0).text).toContain("BENCH tok_s_stream=171");
			expect(inputs?.brief()).toMatchObject({ kind: "task", task: "label every bash output" });

			harness.emitAssistantText("labelled");
			await finish?.(undefined);
			const details = manager.getJob(AGENT_ID)?.latestDetails;
			expect(details?.progress).toMatchObject([{ id: AGENT_ID, status: "completed" }]);
			expect(tools?.read(0).open).toBe(false);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
			tempDir.removeSync();
		}
	});

	it("does not offer a successor generation as the resume target of an old cancelled result", async () => {
		const harness = createHarness();
		registerRunning(harness.session);
		const registry = AgentRegistry.global();
		const owner = registry.get(AGENT_ID)!;
		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "continue",
			signal: AbortSignal.abort("cancelled"),
		});
		registry.setStatus(AGENT_ID, "idle", owner);
		expect(formatTaskResultSummary(result, { totalDurationMs: result.durationMs })).toContain(
			`write agent://${AGENT_ID}`,
		);
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			session: createHarness().session,
			status: "idle",
		});
		expect(formatTaskResultSummary(result, { totalDurationMs: result.durationMs })).not.toContain(
			`write agent://${AGENT_ID}`,
		);
	});

	it("does not replay the previous accepted report when a wake produced no new assistant message", async () => {
		const body = await peerWakeRelay(() => {}, "PRIOR_ACCEPTED_REPORT");
		expect(body).not.toContain("PRIOR_ACCEPTED_REPORT");
		expect(body).toContain("produced no output");
	});

	it("keeps the accepted artifact and sidecar when an unstructured follow-up starts aborted", async () => {
		const tempDir = TempDir.createSync("@omp-aborted-agent-result-");
		const artifactsDir = tempDir.path();
		const harness = createHarness();
		registerRunning(harness.session);
		vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			harness.emitAssistantText("cancelled replacement");
			return true;
		});
		const accepted = '{"report":"accepted verdict"}';

		try {
			await Bun.write(path.join(artifactsDir, `${AGENT_ID}.md`), accepted);
			const acceptedSidecar = await writeBoundAcceptedSidecar(artifactsDir, accepted);
			const result = await runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: baseAgent,
				message: "continue",
				artifactsDir,
				signal: AbortSignal.abort("cancelled"),
			});
			expect(result.aborted).toBe(true);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe(accepted);
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.json`)).text()).toBe(acceptedSidecar);
		} finally {
			tempDir.removeSync();
		}
	});

	it.each([true, false])(
		"reports an IRC-only wake accurately to the parent (already messaged: %s)",
		async alreadyMessaged => {
			const manager = new AsyncJobManager({});
			const harness = createHarness({ asyncJobManager: manager });
			const registry = AgentRegistry.global();
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "main",
				session: createHarness().session,
				status: "running",
			});
			registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "idle",
			});
			attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");
			const parent = {
				cwd: "/tmp",
				settings: Settings.isolated({ "launch.enabled": false }),
				agentRegistry: registry,
				asyncJobManager: manager,
				getAgentId: () => "Parent",
			} as unknown as ToolSession;

			try {
				const finish = observer([
					{
						role: "custom",
						customType: "irc:incoming",
						content: "report your findings",
						display: false,
						details: { id: "msg-report", from: "Parent", message: "report your findings" },
						attribution: "agent",
						timestamp: Date.now(),
					} as unknown as AgentMessage,
				]);
				if (alreadyMessaged) {
					const bus = IrcBus.global();
					const reply = bus.wait("Parent", { from: AGENT_ID }, 1000);
					const receipt = await bus.send({ from: AGENT_ID, to: "Parent", body: "Found the cause." });
					expect(receipt.outcome).not.toBe("failed");
					expect((await reply)?.body).toBe("Found the cause.");
				}
				const waiting = new WaitTool(parent).execute("parent-wait", {});
				// No yield or assistant prose: only the optional IRC message above.
				await finish?.(undefined);
				const result = await waiting;
				const job = result.details?.jobs?.[0];
				expect(job?.status).toBe("completed");
				expect(job?.resultText).toContain(`history://${AGENT_ID}`);
				if (alreadyMessaged) {
					expect(job?.resultText).not.toContain("produced no output");
					expect(job?.resultText).toContain(`${AGENT_ID} sent a message during this turn`);
				} else {
					expect(job?.resultText).toContain("produced no output");
				}
			} finally {
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);

	it("blocks the parent's wait on a turn its message woke and returns the turn's answer once", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		const inbox: IrcMessage[] = [];
		const asyncReplies: string[] = [];
		manager.registerDeliverySink("Parent", (_id, text) => {
			asyncReplies.push(text);
		});
		AgentRegistry.global().register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: {
				sessionManager: SessionManager.inMemory(),
				hasIrcInterrupts: () => inbox.length > 0,
				deliverIrcMessage: async (message: IrcMessage) => {
					inbox.push(message);
					return "injected";
				},
			} as unknown as AgentSession,
			status: "running",
		});
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const finish = observer([
				{
					role: "custom",
					customType: "irc:incoming",
					content: "fix the mask path too",
					display: false,
					details: { id: "msg-mask", from: "Parent", message: "fix the mask path too" },
					attribution: "agent",
					timestamp: Date.now(),
				} as unknown as AgentMessage,
			]);
			expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
			const receipt = await IrcBus.global().send({ from: "Peer", to: "Parent", body: "review the parser too" });
			expect(receipt.outcome).not.toBe("failed");
			const waitTool = new WaitTool(parent);
			const interrupted = await waitTool.execute("queued-mail-wait", {});
			expect(interrupted.details).toMatchObject({ interrupted: true, jobs: [] });
			expect(inbox.splice(0)).toMatchObject([{ from: "Peer", to: "Parent", body: "review the parser too" }]);
			expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
			let settled = false;
			const waiting = waitTool.execute("parent-wait", {}).then(result => {
				settled = true;
				return result;
			});
			await flushMicrotasks();
			expect(settled).toBe(false);
			harness.emitAssistantText("mask path fixed too");
			await finish?.(undefined);

			const result = await waiting;
			expect(result.details?.jobs).toMatchObject([
				{ id: AGENT_ID, status: "completed", resultText: "mask path fixed too" },
			]);
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(inbox).toEqual([]);
			expect(asyncReplies).toEqual([]);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	describe("IRC wake job ownership", () => {
		let manager: AsyncJobManager;
		let harness: SessionHarness;
		let deliveries: Array<{
			id: string;
			text: string;
			structured: AsyncJob["structured"];
			ownerId: string | undefined;
		}>;
		let ircReplies: Record<string, string[]>;

		beforeEach(() => {
			deliveries = [];
			ircReplies = { Parent: [], Peer: [] };
			manager = new AsyncJobManager({});
			manager.registerDeliverySink("Parent", (id, text, job) => {
				deliveries.push({ id, text, structured: job?.structured, ownerId: job?.ownerId });
			});
			harness = createHarness({ asyncJobManager: manager });
			for (const id of ["Parent", "Peer"]) {
				AgentRegistry.global().register({
					id,
					displayName: id,
					kind: "main",
					session: {
						sessionManager: SessionManager.inMemory(),
						deliverIrcMessage: async (message: { body: string }) => {
							ircReplies[id].push(message.body);
							return "injected";
						},
					} as unknown as AgentSession,
					status: "running",
				});
			}
			AgentRegistry.global().register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: harness.session,
				status: "idle",
			});
			attachIrcWakeTurnMonitor(harness.session, {
				id: AGENT_ID,
				agent: baseAgent,
				outputSchema: {
					type: "object",
					properties: { report: { type: "string" } },
					required: ["report"],
					additionalProperties: false,
				},
				outputSchemaSource: "caller",
				outputSchemaMode: "strict",
			});
		});

		afterEach(async () => {
			await manager.dispose({ timeoutMs: 1000 });
		});

		function wakeFrom(...senders: string[]) {
			const observer = harness.wakeObserver();
			if (!observer) throw new Error("wake-turn observer was not registered");
			const finish = observer(
				senders.map((from, index) => ({
					role: "custom",
					customType: "irc:incoming",
					content: "follow up",
					display: false,
					details: { id: `msg-${index}`, from, message: "follow up" },
					attribution: "agent",
					timestamp: Date.now(),
				})) as unknown as AgentMessage[],
			);
			if (!finish) throw new Error("wake turn did not start");
			return finish;
		}

		it("delivers one structured outcome to the owner and one relay per other waking peer", async () => {
			const finish = wakeFrom("Parent", "Parent", "Peer", "Peer");
			harness.emitTerminalYield({ report: "owned structured result" });
			expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
			expect(manager.getRunningJobs({ ownerId: "Peer" })).toEqual([]);
			await finish();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });

			expect(deliveries).toMatchObject([
				{
					id: AGENT_ID,
					ownerId: "Parent",
					structured: {
						source: "caller",
						mode: "strict",
						status: "valid",
						data: { report: "owned structured result" },
					},
				},
			]);
			expect(deliveries).toHaveLength(1);
			expect(ircReplies.Parent).toEqual([]);
			expect(ircReplies.Peer).toHaveLength(1);
		});

		it("keeps a peer-only conversational turn jobless and replies only to its waker", async () => {
			const finish = wakeFrom("Peer");
			expect(manager.getAllJobs()).toEqual([]);
			harness.emitAssistantText("peer answer");
			await finish();
			expect(manager.getAllJobs()).toEqual([]);
			expect(deliveries).toEqual([]);
			expect(ircReplies).toEqual({ Parent: [], Peer: ["peer answer"] });
		});

		it("registers a peer-woken yield for the parent only at acceptance", async () => {
			const finish = wakeFrom("Peer");
			expect(manager.getAllJobs()).toEqual([]);
			harness.emitTerminalYield({ report: "peer request completed" });
			expect(manager.getRunningJobs({ ownerId: "Parent" }).map(job => job.agentId)).toEqual([AGENT_ID]);
			await finish();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(deliveries.map(delivery => delivery.structured?.data)).toEqual([{ report: "peer request completed" }]);
			expect(ircReplies.Parent).toEqual([]);
			expect(ircReplies.Peer).toHaveLength(1);
		});

		it("aborts the represented turn but keeps cancellation owned until finalization", async () => {
			const finish = wakeFrom("Parent");
			const job = manager.getRunningJobs({ ownerId: "Parent" })[0];
			expect(job?.agentId).toBe(AGENT_ID);
			if (!job) throw new Error("parent wake did not register its job");
			expect(manager.cancel(job.id, { ownerId: "Peer" })).toBe(false);
			expect(manager.cancel(job.id, { ownerId: "Parent" })).toBe(true);
			await harness.abortEntered;
			let reaped = false;
			const reaping = manager.waitForOwnerJobs("Parent").then(result => {
				reaped = true;
				return result;
			});
			await flushMicrotasks();
			expect(reaped).toBe(false);
			expect(job.endTime).toBeUndefined();
			const reap = await manager.cancelAndReapOwnerJobs("Parent", Date.now() - 1);
			expect(reap.settled).toBe(false);
			expect(reap.pendingJobIds).toEqual([job.id]);

			// A transport need not produce an "aborted" assistant frame after cancellation.
			harness.emitAssistantText("partial answer");
			await finish();
			expect(await reaping).toBe(true);
			await reap.completion;
			expect(job.status).toBe("cancelled");
			expect(job.errorText).toContain("cancelled");
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(deliveries).toEqual([]);
			expect(ircReplies.Parent).toEqual([]);
		});

		it("rejects a failed parent wake instead of delivering a successful answer", async () => {
			const finish = wakeFrom("Parent", "Peer");
			harness.emitAssistantText("", { stopReason: "error", errorMessage: "synthetic provider failure" });
			await finish();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(manager.getJob(AGENT_ID)?.status).toBe("failed");
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0].text).toContain("synthetic provider failure");
			expect(ircReplies.Parent).toEqual([]);
			expect(ircReplies.Peer).toHaveLength(1);
			expect(ircReplies.Peer[0]).toContain("synthetic provider failure");
		});

		it("retains structured failure data without duplicating the owner outcome", async () => {
			const finish = wakeFrom("Parent");
			harness.emitTerminalYield({ wrong: true });
			await finish();
			await manager.waitForAll();
			await manager.drainDeliveries({ timeoutMs: 1000 });
			expect(manager.getJob(AGENT_ID)?.status).toBe("failed");
			expect(deliveries.map(delivery => delivery.structured)).toMatchObject([
				{ status: "invalid", data: { wrong: true } },
			]);
			expect(deliveries).toHaveLength(1);
			expect(ircReplies.Parent).toEqual([]);
		});

		it("keeps the parent relay when no owner job could register", async () => {
			await manager.dispose({ timeoutMs: 1000 });
			const finish = wakeFrom("Parent");
			harness.emitAssistantText("reply despite unavailable manager");
			await finish();
			expect(deliveries).toEqual([]);
			expect(ircReplies.Parent).toEqual(["reply despite unavailable manager"]);
		});
	});

	it("owes the parent no reply once the wake job its message started has delivered the turn's answer", async () => {
		using tmp = TempDir.createSync("@omp-accepted-wake-reply-");
		const artifactsDir = tmp.path();
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		AgentRegistry.global().register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: createHarness().session,
			status: "running",
		});
		AgentRegistry.global().register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent, artifactsDir });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");
		// The parent's message reaches the idle child through the real bus and bridge, as a live send would.
		let finish: ((error?: unknown) => void | Promise<void>) | undefined;
		const bridge = new IrcBridge({
			isDisposed: () => false,
			isStreaming: () => false,
			planModeEnabled: () => false,
			emitSessionEvent: async () => {},
			wakeForIrc: (records: AgentMessage[]) => {
				finish = observer(records);
			},
		} as unknown as IrcBridgeHost);
		Object.assign(harness.session, { deliverIrcMessage: (msg: IrcMessage) => bridge.deliver(msg) });
		const parent = {
			cwd: "/tmp",
			settings: Settings.isolated({ "launch.enabled": false }),
			agentRegistry: AgentRegistry.global(),
			asyncJobManager: manager,
			getAgentId: () => "Parent",
		} as unknown as ToolSession;

		try {
			const receipt = await IrcBus.global().send({ from: "Parent", to: AGENT_ID, body: "fix the mask path too" });
			expect(receipt.outcome).toBe("woken");
			expect(
				IrcBus.global()
					.unansweredSends("Parent", 0)
					.map(sent => sent.to),
			).toEqual([AGENT_ID]);
			const waiting = new WaitTool(parent).execute("parent-wait", {});
			harness.emitAssistantText("mask path fixed too");
			expect(
				IrcBus.global()
					.unansweredSends("Parent", 0)
					.map(sent => sent.to),
			).toEqual([AGENT_ID]);
			await finish?.(undefined);
			const job = (await waiting).details?.jobs?.[0];
			expect(job).toMatchObject({ id: AGENT_ID, status: "completed" });
			expect(job?.resultText).toContain("mask path fixed too");
			expect(await Bun.file(path.join(artifactsDir, `${AGENT_ID}.md`)).text()).toBe("mask path fixed too");

			expect(IrcBus.global().unansweredSends("Parent", 0)).toEqual([]);
		} finally {
			await manager.dispose({ timeoutMs: 1000 });
		}
	});

	it.each(["completed", "failed", "cancelled"] as const)(
		"does not answer a successor child's question when an unqualified old job is %s",
		async outcome => {
			const registry = AgentRegistry.global();
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "main",
				session: createHarness().session,
				status: "running",
			});
			registry.register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: "Parent",
				session: createHarness().session,
				status: "running",
			});
			const manager = new AsyncJobManager({});
			const release = Promise.withResolvers<void>();
			const jobId = manager.register(
				"task",
				"old generation",
				async () => {
					await release.promise;
					if (outcome === "failed") throw new Error("old generation failed");
					return "old generation report";
				},
				{ ownerId: "Parent", agentId: AGENT_ID },
			);
			try {
				const replacement = createHarness();
				Object.assign(replacement.session, { deliverIrcMessage: async () => "injected" });
				registry.register({
					id: AGENT_ID,
					displayName: AGENT_ID,
					kind: "sub",
					parentId: "Parent",
					session: replacement.session,
					status: "running",
				});
				await IrcBus.global().send({ from: "Parent", to: AGENT_ID, body: "question for the successor" });
				if (outcome === "cancelled") manager.cancel(jobId, { ownerId: "Parent" });
				release.resolve();
				await manager.getJob(jobId)!.promise;
				expect(
					IrcBus.global()
						.unansweredSends("Parent", 0)
						.map(sent => sent.to),
				).toEqual([AGENT_ID]);
			} finally {
				release.resolve();
				await manager.dispose({ timeoutMs: 1000 });
			}
		},
	);

	it("does not acknowledge a new parent's question with an accepted prior-parent result", async () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: createHarness().session,
			status: "running",
		});
		const harness = createHarness();
		Object.assign(harness.session, { deliverIrcMessage: async () => "injected" });
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			harness.emitAssistantText("original accepted report");
			entered.resolve();
			await release.promise;
			return true;
		});
		const run = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: baseAgent,
			message: "original parent request",
		});
		try {
			await entered.promise;
			registry.register({
				id: "Parent",
				displayName: "Parent",
				kind: "main",
				session: createHarness().session,
				status: "running",
			});
			await IrcBus.global().send({ from: "Parent", to: AGENT_ID, body: "new parent question" });
			release.resolve();
			const result = await run;
			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("original accepted report");
			expect(
				IrcBus.global()
					.unansweredSends("Parent", 0)
					.map(sent => sent.to),
			).toEqual([AGENT_ID]);
		} finally {
			release.resolve();
			await run;
		}
	});

	/** Wake an idle agent from a peer, play `turn`, and return the relay body the peer receives. */
	async function peerWakeRelay(
		turn: (harness: SessionHarness) => void,
		previousReport?: string,
	): Promise<string | undefined> {
		const harness = createHarness();
		const registry = AgentRegistry.global();
		registry.register({
			id: "OtherAgent",
			displayName: "OtherAgent",
			kind: "sub",
			session: createHarness().session,
			status: "running",
		});
		registry.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Parent",
			session: harness.session,
			status: "idle",
		});
		if (previousReport) harness.emitAssistantText(previousReport);
		attachIrcWakeTurnMonitor(harness.session, { id: AGENT_ID, agent: baseAgent });
		const observer = harness.wakeObserver();
		if (!observer) throw new Error("wake-turn observer was not registered");

		const finish = observer([
			{
				role: "custom",
				customType: "irc:incoming",
				content: "is line 42 fine?",
				display: false,
				details: { id: "msg-peer", from: "OtherAgent", message: "is line 42 fine?" },
				attribution: "agent",
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		]);
		const relay = IrcBus.global().wait("OtherAgent", { from: AGENT_ID }, 1000);
		turn(harness);
		harness.emitAgentEnd();
		await finish?.(undefined);
		return (await relay)?.body;
	}

	it("relays only a woken agent's final report, not the narration before its tool calls", async () => {
		const body = await peerWakeRelay(harness => {
			harness.emitAssistantContent([
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
			]);
			harness.emitAssistantText("Answer.");
		});
		expect(body).toBe("Answer.");
	});

	it("does not relay narration that preceded a woken agent's last Cursor-resolved call", async () => {
		const body = await peerWakeRelay(harness => {
			const resolvedCall: ToolCall & CursorExecResolvedCarrier = {
				type: "toolCall",
				id: "exec-1",
				name: "bash",
				arguments: { command: "bun test" },
			};
			resolvedCall[kCursorExecResolved] = true;
			harness.emitAssistantContent([{ type: "text", text: "Running the tests." }, resolvedCall]);
		});
		expect(body).not.toContain("Running the tests.");
		expect(body).toContain("produced no output");
	});
});
