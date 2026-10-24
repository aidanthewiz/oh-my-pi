/**
 * Acceptance-boundary contract (#11079): a subagent whose terminal `yield` was
 * accepted must leave `running` and carry its run lifecycle milestones without
 * any parent message or extra poll — on the initial run, on a follow-up turn,
 * and on an autonomous IRC wake turn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	attachIrcWakeTurnMonitor,
	runSubagentFollowUpTurn,
	runSubprocess,
} from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import * as completionProbeModule from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { CompletionProbeOptions } from "@oh-my-pi/pi-coding-agent/task/completion-probe";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const AGENT_ID = "accepted-result";

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

function assistantStopMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	let wakeObserver: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
	const emit = (event: AgentSessionEvent) => {
		// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
		for (const listener of [...listeners]) listener(event);
	};
	const emitAssistantText = (text: string, stop?: Pick<AssistantMessage, "stopReason" | "errorMessage">) => {
		const message = { ...assistantStopMessage(text), ...stop };
		messages.push(message);
		emit({ type: "message_end", message } as AgentSessionEvent);
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
		state: { messages },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
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
		hasPendingAsyncWork: () => false,
		getAsyncJobSnapshot: () => ({ running: [], recent: [] }),
		settleAsyncWork: async () => {},
		abort: async () => {
			abortEntered.resolve();
		},
		dispose: async () => {},
		setIrcWakeTurnObserver: (
			observer: ((records: AgentMessage[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined,
		) => {
			wakeObserver = observer;
		},
		trackIrcReply: () => {},
		subscribeRunState: () => () => {},
		asyncJobManager: options?.asyncJobManager,
	};
	return {
		session: session as unknown as AgentSession,
		promptEntered: promptEntered.promise,
		abortEntered: abortEntered.promise,
		emitTerminalYield,
		emitAssistantText,
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
				probe?.onEstimate(42, 0.1);
				harness.emitTerminalYield({ report: "submitted" });
				probe?.onEstimate(15, 0.3);
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

	it("blocks the parent's wait on a turn its message woke and returns the turn's answer once", async () => {
		const manager = new AsyncJobManager({});
		const harness = createHarness({ asyncJobManager: manager });
		const ircReplies: string[] = [];
		const asyncReplies: string[] = [];
		manager.registerDeliverySink("Parent", (_id, text) => {
			asyncReplies.push(text);
		});
		AgentRegistry.global().register({
			id: "Parent",
			displayName: "Parent",
			kind: "main",
			session: {
				deliverIrcMessage: async (message: { body: string }) => {
					ircReplies.push(message.body);
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
			let settled = false;
			const waiting = new WaitTool(parent).execute("parent-wait", {}).then(result => {
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
			expect(ircReplies).toEqual([]);
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
});
