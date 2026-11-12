import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { RpcClosedError } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import { SubagentWorker } from "../../src/thread/subagent-worker";
import type { AgentsProbe, AgentsProbeGlobals } from "../fixtures/agents-bridge-worker";

const cleanups: Array<() => unknown> = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

async function startWorker(): Promise<{ worker: SubagentWorker; probe: AgentsProbe }> {
	const probe = Promise.withResolvers<AgentsProbe>();
	const probeService: ThreadService = {
		name: "agents-probe",
		globals: (): AgentsProbeGlobals => ({ ready: received => probe.resolve(received) }),
	};
	const worker = new SubagentWorker({
		entry: new URL("../fixtures/agents-bridge-worker.ts", import.meta.url),
		services: [identityThreadService, agentsThreadService, probeService],
		initTimeoutMs: 60_000,
	});
	cleanups.push(() => worker.terminate("test end"));
	await worker.ready;
	return { worker, probe: await probe.promise };
}

/**
 * Poll a condition fed by another thread (mirror patches, worker-side state).
 * There is no in-process clock to fake across a real worker; this waits on the
 * condition itself, never a guessed duration.
 */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await Bun.sleep(10);
	}
}

function liveRef(id: string): AgentRef {
	const ref = AgentRegistry.global().get(id);
	if (!ref) throw new Error(`no ref ${id}`);
	return ref;
}

function mirrorOf(session: AgentSessionHandle | null | undefined): RemoteAgentSession {
	if (!(session instanceof RemoteAgentSession)) throw new Error("expected a worker session mirror");
	return session;
}

async function mainSession(id: string): Promise<AgentSession> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled model missing");
	const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const authStorage = await AuthStorage.create(":memory:");
	authStorage.keys.setRuntime("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(authStorage),
		agentId: id,
	});
	cleanups.push(async () => {
		await session.dispose();
		await authStorage.close();
	});
	return session;
}

describe("agent bridging across subagent workers", () => {
	it("mirrors a real worker-homed AgentSession on main: streaming, run state, events, messages", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { gated: true });
		const ref = liveRef("W1");
		const remote = mirrorOf(ref.session);
		expect(remote.instanceKey).toBe(key);
		expect(remote.home).toBe(worker.threadId);
		expect(key.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(worker.load).toBe(1);

		const runStates: string[] = [];
		remote.subscribeRunState(state => runStates.push(state));
		const events: string[] = [];
		remote.subscribe(event => events.push(event.type));

		const prompting = remote.prompt("hello from main");
		await waitFor(() => remote.isStreaming && ref.status === "running");
		expect(remote.runStartedAt).toBeNumber();

		await probe.openGate();
		expect(await prompting).toBe(true);
		await waitFor(() => !remote.isStreaming && ref.status === "idle");
		const roles = remote.messages.map(message => message.role);
		expect(roles).toContain("user");
		expect(roles).toContain("assistant");
		expect(remote.agent.state.messages).toBe(remote.messages);
		expect(remote.getSessionStats().assistantMessages).toBeGreaterThan(0);
		expect(runStates).toEqual(["running", "idle"]);
		expect(events).toContain("agent_end");
	});

	it("waits through a held turn and its queued follow-up before reporting idle", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", { gated: true });
		const remote = mirrorOf(liveRef("W1").session);
		const prompting = remote.prompt("first question");
		await waitFor(() => remote.isStreaming);
		await remote.prompt("second question", { streamingBehavior: "followUp" });

		let idleSettled = false;
		const idle = remote.waitForIdle().then(() => {
			idleSettled = true;
		});
		await probe.threadId();
		expect(idleSettled).toBe(false);

		await probe.openGate();
		await idle;
		await prompting;
		expect(
			remote.messages.flatMap(message =>
				message.role !== "user"
					? []
					: [
							typeof message.content === "string"
								? message.content
								: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join(""),
						],
			),
		).toEqual(["first question", "second question"]);
		expect(remote.messages.filter(message => message.role === "assistant")).toHaveLength(2);
		expect(remote.lifecycleState?.phase).toBe("idle");
	});

	it("republishes the message mirror after a history rewrite that keeps both endpoints", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);
		await probe.prompt("W1", "first");
		await probe.prompt("W1", "second");
		await waitFor(() => remote.messages.length >= 4);

		// Pruning rebuilds the runtime history with new interior content but the same first/last objects.
		await probe.rewriteInterior("W1", "pruned");
		await probe.prompt("W1", "third");

		await waitFor(() => remote.messages.length >= 6);
		const interior = remote.messages[1];
		expect(interior?.role === "assistant" ? interior.content : undefined).toEqual([{ type: "text", text: "pruned" }]);
	});

	it("fails a worker's registry CAS against a stale main ref generation", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const before = await probe.grab("W1");
		const registry = AgentRegistry.global();
		const replaced = registry.register({
			id: "W1",
			displayName: "W1",
			kind: "sub",
			session: liveRef("W1").session,
			status: "idle",
		});
		expect(replaced.generation).not.toBe(before);

		expect(await probe.cas("W1", "running")).toEqual({ grabbed: false, fresh: true, canonical: true });
		expect(registry.get("W1")?.status).toBe("running");
		expect(await probe.manages()).toBe(true);
	});

	it("lets a worker read a main-homed session through one canonical peer handle", async () => {
		const { probe } = await startWorker();
		const main = await mainSession("Main");
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			session: main,
			status: "running",
		});

		const report = await probe.peer("Main");
		expect(report).toEqual({
			isPeer: true,
			key: main.instanceKey,
			isStreaming: false,
			messageCount: 0,
			sessionFile: undefined,
			canonical: true,
			casBySession: true,
		});
		expect(liveRef("Main").status).toBe("idle");

		await probe.peerSubscribe("Main");
		expect(await probe.peerPrompt("Main", "hello from a worker")).toEqual({ accepted: true });
		expect(main.messages.map(message => message.role)).toContain("assistant");
		await waitFor(async () => {
			const seen = await probe.peerSeen();
			return seen.events.includes("agent_end") && seen.runStates.includes("idle");
		});
		expect((await probe.peerSeen()).runStates).toEqual(["running", "idle"]);
	});

	it("delivers an IRC message from main into a worker-homed session", async () => {
		const { probe } = await startWorker();
		await probe.open("W1", {});
		const remote = mirrorOf(liveRef("W1").session);

		const receipt = await IrcBus.global().send({ from: "Main", to: "W1", body: "ping from main" });
		expect(["injected", "woken"]).toContain(receipt.outcome);
		await waitFor(async () => (await probe.localCustomTypes("W1")).includes("irc:incoming"));
		await waitFor(() =>
			remote.messages.some(message => message.role === "custom" && message.customType === "irc:incoming"),
		);
	});

	it("does not buffer another copy when a worker loses its delivery receipt after injection", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("ReceiptLost", { gated: true });
		const remote = mirrorOf(liveRef("ReceiptLost").session);
		const held = await probe.holdDeliveryReceipt("ReceiptLost");
		const bus = IrcBus.global();
		const sending = bus.send({ from: "Main", to: "ReceiptLost", body: "inject exactly once" });
		const admission = await held.admitted;
		expect(admission.outcome).toBe("woken");
		await waitFor(() => remote.isStreaming);
		await waitFor(async () => (await held.incoming()).entries.length > 0);
		const expectedIncoming = {
			sessionKey: key,
			messages: [{ id: admission.messageId, from: "Main", message: "inject exactly once" }],
			entries: [{ id: admission.messageId, from: "Main", message: "inject exactly once" }],
		};
		expect(await held.incoming()).toEqual(expectedIncoming);

		await probe.openGate();
		await remote.waitForIdle();
		expect(await held.incoming()).toEqual(expectedIncoming);

		worker.link.close("transport disconnected after injection");
		const receipt = await sending;
		expect(receipt.outcome).toBe("failed");
		expect(receipt.error).toMatch(/unknown/i);
		expect(bus.unreadCount("ReceiptLost")).toBe(0);
		expect(bus.take("ReceiptLost")).toBeUndefined();
	});

	it("cancels worker delivery during revival without injecting it after revival completes", async () => {
		const { probe } = await startWorker();
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const target = await mainSession("Parked");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		cleanups.push(release.resolve);
		const ref = registry.register({
			id: "Parked",
			displayName: "Parked",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/agents-bridge-cancelled.jsonl",
			status: "parked",
		});
		lifecycle.adopt(
			"Parked",
			{
				idleTtlMs: 0,
				revive: async () => {
					entered.resolve();
					await release.promise;
					return target;
				},
			},
			ref,
		);
		const controller = new AbortController();
		const sending = probe.send({ from: "Main", to: "Parked", body: "cancelled message" }, controller.signal);
		await entered.promise;
		try {
			controller.abort(new Error("cancel revival delivery"));
			expect((await sending).outcome).toBe("failed");
		} finally {
			release.resolve();
		}
		await lifecycle.ensureLive("Parked");
		expect(
			target.messages.filter(message => message.role === "custom" && message.customType === "irc:incoming"),
		).toEqual([]);
		expect(IrcBus.global().unreadCount("Parked")).toBe(0);
		expect(IrcBus.global().sentSince("Main", "Parked", 0)).toBe(false);
	});

	it("commits worker reply credit once and rejects a retired owner run or generation", async () => {
		const { probe } = await startWorker();
		await probe.open("Owner", {});
		await probe.open("Child", {});
		const bus = IrcBus.global();
		const first = await bus.send({ from: "Owner", to: "Child", body: "first question" });
		expect(first.outcome).not.toBe("failed");
		const credit = await probe.captureReply("Child", "Owner");
		await probe.commitReply(credit);
		expect(bus.unansweredSends("Owner", 0)).toEqual([]);

		await bus.send({ from: "Owner", to: "Child", body: "second question" });
		await probe.commitReply(credit);
		expect(bus.unansweredSends("Owner", 0).map(send => send.to)).toEqual(["Child"]);

		const priorRun = await probe.captureReply("Child", "Owner");
		await probe.prompt("Owner", "start a different owner run");
		await bus.send({ from: "Owner", to: "Child", body: "new run's question" });
		await probe.commitReply(priorRun);
		expect(bus.unansweredSends("Owner", 0).map(send => send.to)).toEqual(["Child"]);

		const retired = await probe.captureReply("Child", "Owner");
		const owner = liveRef("Owner");
		AgentRegistry.global().register({
			id: "Owner",
			displayName: "Owner",
			kind: "sub",
			session: owner.session,
			status: "idle",
		});
		await bus.send({ from: "Owner", to: "Child", body: "new owner's question" });
		await probe.commitReply(retired);
		expect(bus.unansweredSends("Owner", 0).map(send => send.to)).toEqual(["Child"]);
	});

	it("detaches refs and rejects in-flight commands when the worker dies", async () => {
		const { worker, probe } = await startWorker();
		await probe.open("Parked", { sessionFile: "/tmp/agents-bridge-parked.jsonl", gated: true });
		await probe.open("Lost", {});
		await probe.adopt("Parked");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("Parked"));
		const parked = liveRef("Parked");
		const lost = liveRef("Lost");
		const remote = mirrorOf(parked.session);

		const pendingRejection = remote.prompt("never answered").then(
			() => undefined,
			(error: unknown) => error,
		);
		await waitFor(() => remote.isStreaming);
		const idleRejection = remote.waitForIdle().then(
			() => undefined,
			(error: unknown) => error,
		);
		worker.terminate("killed by test");

		const promptError = await pendingRejection;
		expect(promptError).toBeInstanceOf(RpcClosedError);
		expect(promptError).toMatchObject({ message: expect.stringContaining(worker.threadId) });
		expect(remote.closed).toBe(true);
		const idleError = await idleRejection;
		expect(idleError).toBeInstanceOf(RpcClosedError);
		expect(idleError).toMatchObject({ message: expect.stringContaining(worker.threadId) });
		expect(remote.isDisposed).toBe(true);
		expect(parked.session).toBeNull();
		expect(parked.status).toBe("parked");
		expect(lost.session).toBeNull();
		expect(lost.status).toBe("aborted");
		// The adoption (and its release hook) survives; only the dead worker's warm reviver is gone.
		expect(lifecycle.has("Parked")).toBe(true);
		await expect(lifecycle.ensureLive("Parked")).rejects.toThrow("no reviver registered");
		await expect(remote.prompt("again")).rejects.toThrow(worker.threadId);
		await remote.dispose();
	});

	it("parks a worker-homed session and warm-revives it through the worker's reviver", async () => {
		const { worker, probe } = await startWorker();
		const key = await probe.open("W1", { sessionFile: "/tmp/agents-bridge-revive.jsonl" });
		await probe.adopt("W1");
		const lifecycle = AgentLifecycleManager.global();
		await waitFor(() => lifecycle.has("W1"));
		const ref = liveRef("W1");
		const first = mirrorOf(ref.session);

		await lifecycle.park("W1");
		expect(ref.status).toBe("parked");
		expect(ref.session).toBeNull();
		expect(first.closed).toBe(true);
		expect(await probe.disposed(key)).toBe(true);

		const revived = mirrorOf(await lifecycle.ensureLive("W1"));
		expect(revived).not.toBe(first);
		expect(revived.instanceKey.startsWith(`${worker.threadId}:`)).toBe(true);
		expect(liveRef("W1").session).toBe(revived);
		expect(liveRef("W1").status).toBe("idle");
		expect(worker.load).toBe(1);
	});
});
