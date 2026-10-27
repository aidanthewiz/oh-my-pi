import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { type IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
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
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

function session(manager?: AsyncJobManager, agentId = "Main", launch = false): ToolSession {
	return {
		cwd: process.cwd(),
		settings: Settings.isolated({ "launch.enabled": launch }),
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
	const sockets = new Set<IpcConnection>();
	const lists: Array<{ id: string; socket: IpcConnection }> = [];
	let released = false;
	const reply = ({ id, socket }: { id: string; socket: IpcConnection }, error?: string) =>
		socket.send(
			JSON.stringify(error ? { id, ok: false, error } : { id, ok: true, result: { op: "list", daemons: [] } }),
		);
	const server = await IpcServer.listen(
		daemonBrokerEndpoint(daemonBrokerRuntimeDir(runtimeDir)),
		{ framing: "lines" },
		socket => {
			sockets.add(socket);
			socket.start(
				line => {
					const request = JSON.parse(line) as DaemonWireRequest;
					if (request.operation.op === "list") {
						if (released) reply({ id: request.id, socket });
						else lists.push({ id: request.id, socket });
						requested.resolve();
					} else {
						socket.send(
							JSON.stringify({
								id: request.id,
								ok: true,
								result: {
									op: "ping",
									projectDir: client.projectDir,
									protocolVersion: DAEMON_BROKER_PROTOCOL_VERSION,
								},
							}),
						);
					}
				},
				() => {
					sockets.delete(socket);
				},
			);
		},
	);
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
		await server.close();
	}
}

describe("wait", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
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

	test("errors for a subagent whose only running work is its parent's job on it", async () => {
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
		const waiting = new WaitTool(session(manager, "Child")).execute("child-wait", {});
		await expect(waiting).rejects.toBeInstanceOf(ToolError);
		childRun.resolve("done");
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
		test(`a queued message interrupts ${phase} service discovery and returns the message once`, async () => {
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
				expect(result.details?.waited).toMatchObject({ from: "Peer", body: "released" });
				if (phase === "before") expect(fixture.acquired()).toBe(0);
				expect(bridge.hasPending()).toBe(false);
				fixture.release();
			});
		});

		test(`a native completion interrupts ${phase} service discovery and is recovered once`, async () => {
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
					expect(result.details?.jobs).toMatchObject([
						{ id, status: "completed", resultText: "completion payload" },
					]);
					expect(manager.isJobResultConsumed(id)).toBe(true);
					expect(manager.isDeliverySuppressed(id)).toBe(true);
					if (phase === "before") expect(fixture.acquired()).toBe(0);
					injected.resolve();
					await manager.waitForAll();
					expect(await manager.drainDeliveries({ timeoutMs: 500 })).toBe(true);
					expect(delivered).toEqual([[id, "completion payload"]]);
					fixture.release();
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

	test("a broker rejection during discovery leaves owned job results available", async () => {
		await withDiscoveryClient(async fixture => {
			const manager = new AsyncJobManager({ onJobComplete: () => {} });
			const job = Promise.withResolvers<string>();
			const id = manager.register("bash", "build", async () => job.promise, { ownerId: "Main" });
			const tool = new WaitTool({ ...session(manager), cwd: fixture.cwd, settings: Settings.isolated() });
			try {
				const waiting = tool.execute("failed-discovery", {});
				await fixture.requested;
				fixture.reject();
				job.resolve("build complete");
				const result = await waiting;
				expect(result.details?.jobs?.[0]).toMatchObject({ id, status: "completed", resultText: "build complete" });
			} finally {
				job.resolve("build complete");
				await manager.dispose();
			}
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
				await expect(tool.execute("owner-scoped-discovery", {})).rejects.toBeInstanceOf(ToolError);
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
