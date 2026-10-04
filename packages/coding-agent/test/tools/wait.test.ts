import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as net from "node:net";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TOOL_INTERRUPT_ABORT_REASON } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { IrcBridge, type IrcBridgeHost } from "@oh-my-pi/pi-coding-agent/session/irc-bridge";
import * as brokerClients from "../../src/launch/client";
import { daemonBrokerEndpoint, daemonBrokerRuntimeDir } from "../../src/launch/paths";
import { DAEMON_BROKER_PROTOCOL_VERSION, type DaemonWireRequest } from "../../src/launch/protocol";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WaitTool } from "@oh-my-pi/pi-coding-agent/tools/wait";
import { ToolAbortError } from "../../src/tools/tool-errors";

function session(manager?: AsyncJobManager, agentId = "Main"): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => agentId,
	} as unknown as ToolSession;
}

async function withDiscoveryClient(
	run: (fixture: {
		cwd: string;
		requested: Promise<void>;
		release: () => void;
		reject: () => void;
		acquired: () => number;
	}) => Promise<void>,
	acquisitionGate?: Promise<void>,
): Promise<void> {
	using tempDir = TempDir.createSync("omp-wait-");
	const runtimeDir = path.join(tempDir.path(), "run");
	const client = await brokerClients.createDaemonBrokerClient(tempDir.path(), { runtimeDir });
	const requested = Promise.withResolvers<void>();
	const sockets = new Set<net.Socket>();
	const lists: Array<{ id: string; socket: net.Socket }> = [];
	let released = false;
	const reply = ({ id, socket }: { id: string; socket: net.Socket }, error?: string) =>
		socket.write(
			`${JSON.stringify(
				error ? { id, ok: false, error } : { id, ok: true, result: { op: "list", daemons: [] } },
			)}\n`,
		);
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", chunk => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const request = JSON.parse(buffer.slice(0, newline)) as DaemonWireRequest;
				buffer = buffer.slice(newline + 1);
				if (request.operation.op === "list") {
					if (released) reply({ id: request.id, socket });
					else lists.push({ id: request.id, socket });
					requested.resolve();
				} else {
					socket.write(
						`${JSON.stringify({
							id: request.id,
							ok: true,
							result: {
								op: "ping",
								projectDir: client.projectDir,
								protocolVersion: DAEMON_BROKER_PROTOCOL_VERSION,
							},
						})}\n`,
					);
				}
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(daemonBrokerEndpoint(client.projectDir, daemonBrokerRuntimeDir(runtimeDir)), resolve);
	});
	let acquisitions = 0;
	const acquisition = vi.spyOn(brokerClients, "daemonClientForProject").mockImplementation(async () => {
		acquisitions++;
		if (acquisitionGate) await acquisitionGate;
		return client;
	});
	try {
		await run({
			cwd: client.projectDir,
			requested: requested.promise,
			release: () => {
				released = true;
				for (const pending of lists.splice(0)) reply(pending);
			},
			reject: () => {
				for (const pending of lists.splice(0)) reply(pending, "Synthetic discovery rejection");
			},
			acquired: () => acquisitions,
		});
	} finally {
		acquisition.mockRestore();
		client.close();
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
	}
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a settling job is recovered once, suppressing its async duplicate", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise, resolve } = Promise.withResolvers<string>();
		const id = manager.register("bash", "build", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-1", {});
		resolve("build complete");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
		expect(manager.isJobResultConsumed(id)).toBe(true);
		expect(manager.isDeliverySuppressed(id)).toBe(true);
	});

	test("returns immediately when no job, running peer, or owned service can wake it", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Idle",
			displayName: "Idle",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const result = await new WaitTool(session()).execute("wait-2", {});
		expect(result.details).toMatchObject({ op: "wait", jobs: [] });
		expect(result.useless).toBe(true);
	});

	test("an interrupted wait leaves later job completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted", {}, controller.signal);
		controller.abort();
		await expect(waiting).rejects.toBeInstanceOf(ToolAbortError);
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	test("a message interrupt returns a non-error result and leaves the completion auto-deliverable", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_id, text) => {
			delivered.push(text);
		});
		const { promise, resolve } = Promise.withResolvers<string>();
		manager.register("bash", "still running", async () => promise, { ownerId: "Main" });
		const controller = new AbortController();
		const waiting = new WaitTool(session(manager)).execute("interrupted-by-message", {}, controller.signal);
		controller.abort(TOOL_INTERRUPT_ABORT_REASON);
		const result = await waiting;
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ op: "wait", interrupted: true });
		resolve("finished afterward");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 500 });
		expect(delivered).toEqual(["finished afterward"]);
	});

	for (const phase of ["before", "during"] as const) {
		test(`a queued message interrupts ${phase} service discovery without consuming the message`, async () => {
			await withDiscoveryClient(async fixture => {
				const registry = AgentRegistry.global();
				const bridge = new IrcBridge({
					isDisposed: () => false,
					isStreaming: () => true,
					emitSessionEvent: async () => {},
				} as unknown as IrcBridgeHost);
				registry.register({
					id: "Main",
					displayName: "Main",
					kind: "main",
					session: {
						isStreaming: true,
						deliverIrcMessage: bridge.deliver.bind(bridge),
						drainPendingIrcInboxMessages: bridge.drainInboxMessages.bind(bridge),
					} as never,
				});
				registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
				const tool = new WaitTool({ ...session(), cwd: fixture.cwd, settings: Settings.isolated() });
				const controller = new AbortController();
				const interrupt = async () => {
					const receipt = await IrcBus.global().send(
						{ from: "Peer", to: "Main", body: "released" },
						{ suppressRelay: true },
					);
					expect(receipt.outcome).toBe("injected");
					expect(bridge.hasInterrupts()).toBe(true);
					controller.abort(TOOL_INTERRUPT_ABORT_REASON);
				};
				if (phase === "before") {
					await interrupt();
					expect(controller.signal.aborted).toBe(true);
				}
				const waiting = tool.execute("message-discovery", {}, controller.signal);
				if (phase === "during") {
					await fixture.requested;
					await interrupt();
				}
				const result = await waiting;
				expect(result.isError).toBeUndefined();
				expect(result.details).toMatchObject({ op: "wait", jobs: [], interrupted: true });
				expect(result.useless).toBe(true);
				if (phase === "before") expect(fixture.acquired()).toBe(0);
				expect((await tool.execute("queued-message", {})).details?.waited).toMatchObject({
					from: "Peer",
					body: "released",
				});
				expect(bridge.hasPending()).toBe(false);
				fixture.release();
				const next = await tool.execute("after-message", {});
				expect(next.details).toMatchObject({ op: "wait", jobs: [] });
				expect(next.details?.waited).toBeUndefined();
			});
		});

		test(`a native completion interrupts ${phase} service discovery and auto-delivers once`, async () => {
			await withDiscoveryClient(async fixture => {
				const manager = new AsyncJobManager({});
				const controller = new AbortController();
				const job = Promise.withResolvers<string>();
				const entered = Promise.withResolvers<void>();
				const injected = Promise.withResolvers<void>();
				const delivered: Array<[string, string]> = [];
				manager.registerDeliverySink("Main", async (id, text) => {
					controller.abort(TOOL_INTERRUPT_ABORT_REASON);
					entered.resolve();
					await injected.promise;
					delivered.push([id, text]);
				});
				const id = manager.register("task", "CompletedPeer", async () => job.promise, { ownerId: "Main" });
				const tool = new WaitTool({ ...session(manager), cwd: fixture.cwd, settings: Settings.isolated() });
				try {
					if (phase === "before") {
						job.resolve("completion payload");
						await entered.promise;
						expect(controller.signal.aborted).toBe(true);
					}
					const waiting = tool.execute("completion-discovery", {}, controller.signal);
					if (phase === "during") {
						await fixture.requested;
						job.resolve("completion payload");
						await entered.promise;
					}
					const result = await waiting;
					expect(result.isError).toBeUndefined();
					expect(result.details).toMatchObject({ op: "wait", jobs: [], interrupted: true });
					expect(manager.isJobResultConsumed(id)).toBe(false);
					expect(manager.isDeliverySuppressed(id)).toBe(false);
					if (phase === "before") expect(fixture.acquired()).toBe(0);
					injected.resolve();
					await manager.waitForAll();
					expect(await manager.drainDeliveries({ timeoutMs: 500 })).toBe(true);
					expect(delivered).toEqual([[id, "completion payload"]]);
					expect(manager.isJobResultConsumed(id)).toBe(true);
					fixture.release();
					expect((await tool.execute("after-completion", {})).details?.jobs).toEqual([]);
					expect(await manager.drainDeliveries({ timeoutMs: 500 })).toBe(true);
					expect(delivered).toEqual([[id, "completion payload"]]);
				} finally {
					job.resolve("completion payload");
					injected.resolve();
					await manager.dispose();
				}
			});
		});

		test(`user cancellation ${phase} service discovery remains cancellation`, async () => {
			await withDiscoveryClient(async fixture => {
				const controller = new AbortController();
				const reason = new Error("synthetic user stop");
				const tool = new WaitTool({ ...session(), cwd: fixture.cwd, settings: Settings.isolated() });
				if (phase === "before") controller.abort(reason);
				const waiting = tool.execute("cancel-discovery", {}, controller.signal);
				if (phase === "during") {
					await fixture.requested;
					controller.abort(reason);
				}
				const error = await waiting.then(
					() => undefined,
					error => error,
				);
				expect(error).toBeInstanceOf(ToolAbortError);
				expect(error.cause).toBe(reason);
				if (phase === "before") expect(fixture.acquired()).toBe(0);
			});
		});
	}

	for (const interrupt of [true, false]) {
		test(`${interrupt ? "interruption" : "cancellation"} wakes discovery before client acquisition settles`, async () => {
			const acquisition = Promise.withResolvers<void>();
			try {
				await withDiscoveryClient(async fixture => {
					const tool = new WaitTool({ ...session(), cwd: fixture.cwd, settings: Settings.isolated() });
					const controller = new AbortController();
					const waiting = tool.execute("pending-client", {}, controller.signal);
					expect(fixture.acquired()).toBe(1);
					controller.abort(interrupt ? TOOL_INTERRUPT_ABORT_REASON : new Error("synthetic user stop"));
					if (interrupt) {
						expect((await waiting).details).toMatchObject({ op: "wait", interrupted: true, jobs: [] });
					} else {
						await expect(waiting).rejects.toBeInstanceOf(ToolAbortError);
					}
				}, acquisition.promise);
			} finally {
				acquisition.resolve();
			}
		});
	}

	test("a broker rejection during discovery propagates as an error", async () => {
		await withDiscoveryClient(async fixture => {
			const tool = new WaitTool({ ...session(), cwd: fixture.cwd, settings: Settings.isolated() });
			const controller = new AbortController();
			const waiting = tool.execute("failed-discovery", {}, controller.signal);
			await fixture.requested;
			fixture.reject();
			await expect(waiting).rejects.toBeInstanceOf(brokerClients.DaemonBrokerRejectedError);
			expect(controller.signal.aborted).toBe(false);
		});
	});

	test("discovery does not expose or consume another owner's pending completion", async () => {
		await withDiscoveryClient(async fixture => {
			const manager = new AsyncJobManager({});
			const entered = Promise.withResolvers<void>();
			const injected = Promise.withResolvers<void>();
			const delivered: Array<[string, string]> = [];
			manager.registerDeliverySink("Other", async (id, text) => {
				entered.resolve();
				await injected.promise;
				delivered.push([id, text]);
			});
			const id = manager.register("task", "OtherPeer", async () => "private completion", { ownerId: "Other" });
			try {
				await entered.promise;
				fixture.release();
				const tool = new WaitTool({ ...session(manager), cwd: fixture.cwd, settings: Settings.isolated() });
				expect((await tool.execute("owner-scoped-discovery", {})).details?.jobs).toEqual([]);
				expect(manager.isJobResultConsumed(id)).toBe(false);
				expect(manager.isDeliverySuppressed(id)).toBe(false);
				injected.resolve();
				expect(await manager.drainDeliveries({ timeoutMs: 500 })).toBe(true);
				expect(delivered).toEqual([[id, "private completion"]]);
			} finally {
				injected.resolve();
				await manager.dispose();
			}
		});
	});

	test("returns a settled job whose delivery has not reached the transcript yet", async () => {
		const manager = new AsyncJobManager({});
		// The owner's sink parks the result like a yield-queue receipt awaiting injection.
		const injected = Promise.withResolvers<void>();
		const sinkEntered = Promise.withResolvers<string>();
		manager.registerDeliverySink("Main", async (_id, text) => {
			sinkEntered.resolve(text);
			await injected.promise;
		});
		const id = manager.register("task", "EchoPeer", async () => "received=kestrel42", {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		expect(await sinkEntered.promise).toBe("received=kestrel42");

		const result = await new WaitTool(session(manager)).execute("wait-undelivered", {});
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "received=kestrel42" });
		expect(manager.isDeliverySuppressed(id)).toBe(true);
		injected.resolve();
	});

	test("blocks on a peer's completion job registered after the wait started", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("wait-peer-yield", {});
		// The peer's yield is accepted mid-turn: its completion job exists before the ref goes idle.
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		finalized.resolve("followup-done");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "followup-done" });
	});

	test("a message-only wait hands the turn back on a growing window while its parent streams", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		registry.register({
			id: "Sibling",
			displayName: "Sibling",
			kind: "sub",
			parentId: "Main",
			session: null,
			status: "idle",
		});
		const tool = new WaitTool(session(undefined, "Child"));
		const waitOut = async (ms: number) => {
			let settled = false;
			const waiting = tool.execute("message-window", {}).then(result => {
				settled = true;
				return result;
			});
			vi.advanceTimersByTime(ms - 1);
			await Promise.resolve();
			expect(settled).toBe(false);
			vi.advanceTimersByTime(1);
			const result = await waiting;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			// Nobody is blocked on this agent's result, so no owner is singled out.
			expect(text).not.toContain("agent://Main");
			expect(result.useless).toBe(true);
		};
		await waitOut(5_000);
		await waitOut(10_000);
		await waitOut(30_000);
		// Stepping away from the wait loop restarts the ladder at its floor.
		vi.advanceTimersByTime(60_000);
		await waitOut(5_000);
	});

	test("an owned job that appears mid-wait is not cut off by the message window", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "EchoPeer",
			displayName: "EchoPeer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const waiting = new WaitTool(session(manager)).execute("message-then-job", {});
		vi.advanceTimersByTime(1_000);
		const finalized = Promise.withResolvers<string>();
		const id = manager.register("task", "EchoPeer", async () => finalized.promise, {
			ownerId: "Main",
			agentId: "EchoPeer",
		});
		registry.setStatus("EchoPeer", "idle");
		await Promise.resolve();
		// Past the top message rung: only the job-wait cap may end this wait.
		vi.advanceTimersByTime(300_000);
		finalized.resolve("late result");
		const result = await waiting;
		expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "late result" });
	});

	test("points a message-only wait at an owner blocked in wait on its result, not at a delivery watch", async () => {
		vi.useFakeTimers();
		const registry = AgentRegistry.global();
		const streaming = { isStreaming: true } as never;
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: streaming, status: "running" });
		registry.register({
			id: "Child",
			displayName: "Child",
			kind: "sub",
			parentId: "Main",
			session: streaming,
			status: "running",
		});
		// Subagents share the process job manager with their owner.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const childRun = Promise.withResolvers<string>();
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
		const childWaitText = async () => {
			const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
			vi.advanceTimersByTime(5_000);
			const result = await waiting;
			return result.content[0]?.type === "text" ? result.content[0].text : "";
		};
		// A workpool watches each member turn to suppress auto-delivery while its owner keeps working.
		manager.watchJobs(["Child"]);
		expect(await childWaitText()).not.toContain("agent://Main");
		const parentWait = new WaitTool(session(manager, "Main")).execute("parent-wait", {});
		const text = await childWaitText();
		expect(text).toContain("agent://Main");
		childRun.resolve("migration API ready");
		expect((await parentWait).details?.jobs?.[0]).toMatchObject({ id: "Child", status: "completed" });
	});

	test("returns an incoming peer message without any background jobs", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({
			id: "Peer",
			displayName: "Peer",
			kind: "sub",
			parentId: "Main",
			session: { isStreaming: true } as never,
			status: "running",
		});
		const waiting = new WaitTool(session()).execute("message-only", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "shared file released" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "shared file released" });
	});

	test("returns an incoming peer message while the watched job remains live", async () => {
		const registry = AgentRegistry.global();
		registry.register({ id: "Main", displayName: "Main", kind: "main", session: null });
		registry.register({ id: "Peer", displayName: "Peer", kind: "sub", parentId: "Main", session: null });
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise } = Promise.withResolvers<string>();
		const id = manager.register("bash", "unfinished", async () => promise, { ownerId: "Main" });
		const waiting = new WaitTool(session(manager)).execute("wait-3", {});
		await IrcBus.global().send({ from: "Peer", to: "Main", body: "the file is yours" });
		const result = await waiting;
		expect(result.details?.waited).toMatchObject({ from: "Peer", body: "the file is yours" });
		expect(manager.getJob(id)?.status).toBe("running");
		manager.cancel(id);
	});
});
