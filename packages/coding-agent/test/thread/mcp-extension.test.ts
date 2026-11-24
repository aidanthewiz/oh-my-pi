import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { isRecord, Snowflake, TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { MCPManager } from "../../src/mcp/manager";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { agentsThreadService } from "../../src/thread/services/agents";
import { authService } from "../../src/thread/services/auth";
import { identityThreadService } from "../../src/thread/services/identity";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import { cfgToolsApproval } from "../../src/tools/settings";
import type { McpExtensionHooks, McpExtensionProbe } from "../fixtures/mcp-extension-worker";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { startServiceWorker } from "../helpers/service-worker";

const cleanup: Array<() => void | Promise<void>> = [];
const gates: Array<() => void> = [];
afterEach(async () => {
	for (const release of gates.splice(0)) release();
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
	MCPManager.resetForTests();
});

async function connector(
	label = "tenant-a",
	holdTools?: Promise<void>,
	holdCall?: Promise<void>,
	failInitialInitialization = false,
) {
	const toolsEntered = Promise.withResolvers<void>();
	const callEntered = Promise.withResolvers<void>();
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const initializations: Array<string | null> = [];
	let failNext = false;
	let protocolFailure = false;
	let initializationUnavailable = failInitialInitialization;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const rpc: unknown = await request.json();
			if (!isRecord(rpc)) return new Response(null, { status: 400 });
			if (rpc.id === undefined) return new Response(null, { status: 202 });
			let result: unknown;
			if (rpc.method === "initialize") {
				initializations.push(request.headers.get("authorization"));
				if (initializationUnavailable) {
					initializationUnavailable = false;
					return new Response("synthetic startup unavailable", { status: 503 });
				}
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "synthetic-extension", version: "1" },
					capabilities: { tools: {} },
				};
			} else if (rpc.method === "tools/list") {
				toolsEntered.resolve();
				if (holdTools) await holdTools;
				result = {
					tools: [
						{ name: "get_task", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
						{ name: "create_task", inputSchema: { type: "object" } },
					],
				};
			} else if (rpc.method === "tools/call") {
				const params = isRecord(rpc.params) ? rpc.params : {};
				if (typeof params.name !== "string") return new Response(null, { status: 400 });
				calls.push({ name: params.name, args: isRecord(params.arguments) ? params.arguments : {} });
				callEntered.resolve();
				if (holdCall) await holdCall;
				if (failNext) {
					failNext = false;
					return new Response("uncertain dispatch", { status: 503 });
				}
				if (protocolFailure) {
					return Response.json({
						jsonrpc: "2.0",
						id: rpc.id,
						error: {
							code: -32042,
							message: "rejected Bearer synthetic-secret",
							data: { client_secret: "synthetic-secret", traceId: "synthetic-trace" },
						},
					});
				}
				result = {
					content: [{ type: "text", text: `${label}: private result` }],
					structuredContent: { tenant: label, private: "secret" },
					_meta: { private: "secret" },
				};
			} else result = {};
			return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
		},
	});
	cleanup.push(() => server.stop(true));
	const manager = new MCPManager(process.cwd());
	cleanup.push(() => manager.disconnectAll());
	const loading = manager.connectServers(
		{ minions: { type: "http", url: server.url.href, exposeTools: false } },
		{},
		undefined,
		holdTools ? 1 : 0,
	);
	if (!failInitialInitialization) await toolsEntered.promise;
	if (!holdTools) {
		await loading;
		await manager.waitForStartup(0);
	}
	return {
		manager,
		calls,
		initializations,
		loading,
		callEntered: callEntered.promise,
		failNext: () => {
			failNext = true;
		},
		protocolFailure: () => {
			protocolFailure = true;
		},
	};
}

async function workerSession(manager: MCPManager, hooks?: McpExtensionHooks) {
	const dir = TempDir.createSync("mcp-extension-bridge-");
	cleanup.push(() => dir.removeSync());
	const auth = createInMemoryAuthStorage();
	cleanup.push(() => auth.close());
	const registry = new ModelRegistry(auth, path.join(dir.path(), "models.yml"));
	const settings = Settings.isolated({
		"tools.approvalMode": "yolo",
		"tools.approval": { mcp__minions_create_task: "allow" },
	});
	const worker = await startServiceWorker<McpExtensionProbe>(
		new URL("../fixtures/mcp-extension-worker.ts", import.meta.url),
		[identityThreadService, settingsThreadService, authService, agentsThreadService, integrationsThreadService],
	);
	cleanup.push(() => worker.stop());
	const id = `mcp-${Snowflake.next()}`;
	const child = await worker.probe.open(manager, registry, settings, dir.path(), id, hooks);
	cleanup.push(async () => {
		if (!worker.peer.link.closed) await child.dispose();
		const ref = AgentRegistry.global().get(id);
		if (ref && (ref.session === child.owner || ref.session === null)) AgentRegistry.global().unregister(id, ref);
	});
	return { child, worker, auth, settings, id };
}

describe("session-owned extension MCP across workers", () => {
	it("uses its captured connector and applies final input and result policy on all channels", async () => {
		const a = await connector();
		const b = await connector("tenant-b");
		const { child } = await workerSession(a.manager, { replaceInput: { key: "SYN-123" }, redact: true });
		MCPManager.setInstance(b.manager);
		const result = await child.call("minions", "get_task", { key: "original" });
		expect(a.calls).toEqual([{ name: "get_task", args: { key: "SYN-123" } }]);
		expect(b.calls).toEqual([]);
		expect(result).toEqual({ content: [{ type: "text", text: "redacted by owning extension" }], isError: false });
		expect(a.manager.getTools()).toEqual([]);
	}, 20_000);

	it("honors a child-only deny policy without changing its main-backed parent settings", async () => {
		const f = await connector();
		const { child, settings } = await workerSession(f.manager);
		await child.setApproval("deny");
		const [denied] = await Promise.allSettled([child.call("minions", "create_task")]);
		expect(denied.status).toBe("rejected");
		if (denied.status === "rejected") expect(denied.reason.message).toContain("blocked by user policy");
		expect(f.calls).toEqual([]);
		expect(cfgToolsApproval.get(settings)).toEqual({ mcp__minions_create_task: "allow" });
		await child.setApproval("allow");
		const result = await child.call("minions", "create_task", { title: "approved child task" });
		expect(result.structuredContent).toMatchObject({ tenant: "tenant-a" });
		expect(f.calls).toEqual([{ name: "create_task", args: { title: "approved child task" } }]);
	}, 20_000);

	it("rejects a main-retired registry owner even when the worker asserts that it is current", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await connector("tenant-a", gate.promise);
		gates.push(() => gate.resolve());
		const { child, id } = await workerSession(f.manager);
		const waiting = Promise.withResolvers<void>();
		const wait = f.manager.waitForConnection.bind(f.manager);
		f.manager.waitForConnection = (...args) => {
			waiting.resolve();
			return wait(...args);
		};
		const pending = child.uncheckedCall("minions", "create_task", { retry: "never" });
		const outcome = pending.catch(error => error);
		await waiting.promise;
		const ref = AgentRegistry.global().get(id);
		if (!ref) throw new Error("worker session was not registered");
		AgentRegistry.global().unregister(id, ref);
		gate.resolve();
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		await f.loading;
		expect(f.calls).toEqual([]);
	}, 20_000);

	for (const ownership of ["current", "disposed", "unregistered"] as const) {
		it(`refuses context-free retained worker manager calls when the owner is ${ownership} while local calls remain usable`, async () => {
			const f = await connector();
			const { child, id } = await workerSession(f.manager);
			const admitted = await child.call("minions", "get_task", { owner: "worker" });
			expect(admitted.structuredContent).toMatchObject({ tenant: "tenant-a" });
			if (ownership === "disposed") await child.dispose();
			else if (ownership === "unregistered") {
				const ref = AgentRegistry.global().get(id);
				if (!ref) throw new Error("worker session was not registered");
				AgentRegistry.global().unregister(id, ref);
			}
			const outcome = await child
				.contextFreeCall("minions", "create_task", { owner: "unowned" })
				.catch(error => error);
			expect(f.calls).toEqual([{ name: "get_task", args: { owner: "worker" } }]);
			expect(outcome).toBeInstanceOf(Error);
			const local = await f.manager.callTool("minions", "get_task", { owner: "main" }, { retry: "never" });
			expect(local.structuredContent).toMatchObject({ tenant: "tenant-a" });
		}, 20_000);
	}

	for (const recovery of ["current", "retired", "parent"] as const) {
		const retired = recovery !== "current";
		const parentOwned = recovery === "parent";
		const name = parentOwned
			? "preserves an independently owned parent reconnect after a joining worker owner retires"
			: `${retired ? "refuses a retired" : "reconnects a current"} worker owner after pending credentials finish refreshing`;
		it(
			name,
			async () => {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				gates.push(() => release.resolve());
				const tokens = Bun.serve({
					port: 0,
					hostname: "127.0.0.1",
					async fetch(request) {
						if (request.method !== "POST") return new Response(null, { status: 405 });
						entered.resolve();
						await release.promise;
						return Response.json({
							access_token: "synthetic-renewed-access",
							refresh_token: "synthetic-renewed-refresh",
							token_type: "Bearer",
							expires_in: 3600,
						});
					},
				});
				cleanup.push(() => tokens.stop(true));
				const f = await connector("tenant-a", undefined, undefined, !parentOwned);
				expect(f.manager.getConnectedServers()).toEqual(parentOwned ? ["minions"] : []);
				const initializationCount = f.initializations.length;
				const { child, auth, id } = await workerSession(f.manager);
				f.manager.setAuthStorage(auth);
				const credentialId = "mcp_oauth_synthetic_reconnect";
				await auth.credentials.set(credentialId, {
					type: "oauth",
					access: "synthetic-expired-access",
					refresh: "synthetic-expired-refresh",
					expires: Date.now() - 60_000,
				});
				const config = f.manager.getServerConfig("minions");
				if (config?.type !== "http") throw new Error("synthetic HTTP server was not configured");
				f.manager.updateServerConfig("minions", {
					...config,
					auth: { type: "oauth", credentialId, tokenUrl: tokens.url.href },
				});
				const joined = Promise.withResolvers<void>();
				const wait = f.manager.waitForConnection.bind(f.manager);
				f.manager.waitForConnection = (...args) => {
					const pending = wait(...args);
					joined.resolve();
					return pending;
				};
				const parentReconnect = parentOwned ? f.manager.reconnectServer("minions") : undefined;
				if (parentOwned) await entered.promise;
				const outcome = child.uncheckedCall("minions", "create_task", { retry: "never" }).catch(error => error);
				await Promise.race([
					joined.promise,
					outcome.then(result => {
						if (result instanceof Error) throw result;
						throw new Error("Worker call completed before joining the held reconnect");
					}),
				]);
				await entered.promise;
				if (retired) {
					const ref = AgentRegistry.global().get(id);
					if (!ref) throw new Error("worker session was not registered");
					AgentRegistry.global().unregister(id, ref);
				}
				release.resolve();
				const result = await outcome;
				if (parentOwned) expect((await parentReconnect)?.transport.connected).toBe(true);
				await f.manager.waitForPendingConnections();
				expect([...new Set(f.initializations.slice(initializationCount))]).toEqual(
					retired && !parentOwned ? [] : [`Bearer ${"synthetic-renewed-access"}`],
				);
				expect(f.manager.getConnectedServers()).toEqual(retired && !parentOwned ? [] : ["minions"]);
				expect(f.calls).toEqual(retired ? [] : [{ name: "create_task", args: {} }]);
				if (retired) expect(result).toBeInstanceOf(Error);
				else expect(result.structuredContent).toMatchObject({ tenant: "tenant-a" });
				expect(auth.credentials.get(credentialId)).toMatchObject({
					type: "oauth",
					access: "synthetic-renewed-access",
					refresh: "synthetic-renewed-refresh",
				});
			},
			20_000,
		);
	}

	it("refuses a retired worker's queued OAuth authentication while an admitted owner completes", async () => {
		const occupiedEntered = Promise.withResolvers<void>();
		const approveOccupied = Promise.withResolvers<void>();
		const childQueued = Promise.withResolvers<void>();
		gates.push(() => approveOccupied.resolve());
		const authenticated: string[] = [];
		const authorizedInitializations: string[] = [];
		const calls: string[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const rpc: unknown = await request.json();
				if (!isRecord(rpc)) return new Response(null, { status: 400 });
				if (rpc.id === undefined) return new Response(null, { status: 202 });
				const name = new URL(request.url).pathname.slice(1);
				if (request.headers.get("authorization") !== "Bearer synthetic-approved") {
					return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="fixture"' } });
				}
				let result: unknown;
				if (rpc.method === "initialize") {
					authorizedInitializations.push(name);
					result = {
						protocolVersion: "2025-11-25",
						serverInfo: { name: "synthetic-queued-oauth", version: "1" },
						capabilities: { tools: {} },
					};
				} else if (rpc.method === "tools/list") {
					result = {
						tools: [
							{ name: "get_task", inputSchema: { type: "object" } },
							{ name: "create_task", inputSchema: { type: "object" } },
						],
					};
				} else if (rpc.method === "tools/call") {
					calls.push(name);
					result = {
						content: [{ type: "text", text: "approved owner completed" }],
						structuredContent: { receipt: name },
					};
				} else result = {};
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
			},
		});
		cleanup.push(() => server.stop(true));
		const manager = new MCPManager(process.cwd());
		cleanup.push(() => manager.disconnectAll());
		await manager.connectServers(
			{
				occupied: { type: "http", url: new URL("occupied", server.url).href, exposeTools: false },
				minions: { type: "http", url: new URL("minions", server.url).href, exposeTools: false },
			},
			{},
			undefined,
			0,
		);
		await manager.waitForPendingConnections();
		manager.setAuthHandler(async name => {
			authenticated.push(name);
			if (name === "occupied") {
				occupiedEntered.resolve();
				await approveOccupied.promise;
			}
			const config = manager.getServerConfig(name);
			if (config?.type !== "http") throw new Error("synthetic HTTP server was not configured");
			return { ...config, headers: { Authorization: "Bearer synthetic-approved" } };
		});
		manager.setAuthQueueHandler(event => {
			if (event.type === "queued" && event.serverName === "minions") childQueued.resolve();
		});
		const { child, id } = await workerSession(manager);
		const admitted = manager.reconnectServer("occupied", {
			authChallenge: { wwwAuthenticate: ['Bearer realm="fixture"'] },
		});
		await occupiedEntered.promise;
		const retired = child.uncheckedCall("minions", "create_task", { retry: "never" }).catch(error => error);
		await childQueued.promise;
		const ref = AgentRegistry.global().get(id);
		if (!ref) throw new Error("worker session was not registered");
		AgentRegistry.global().unregister(id, ref);
		approveOccupied.resolve();
		expect(await admitted).not.toBeNull();
		const completed = await manager.callTool("occupied", "get_task", {}, { retry: "never" });
		expect(completed.structuredContent).toMatchObject({ receipt: "occupied" });
		const outcome = await retired;
		expect(authenticated).toEqual(["occupied"]);
		expect([...new Set(authorizedInitializations)]).toEqual(["occupied"]);
		expect(calls).toEqual(["occupied"]);
		expect(outcome).toBeInstanceOf(Error);
	}, 20_000);

	it("rejects a worker-disposed session before a pending catalog permits dispatch", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await connector("tenant-a", gate.promise);
		gates.push(() => gate.resolve());
		const { child } = await workerSession(f.manager);
		const waiting = Promise.withResolvers<void>();
		const wait = f.manager.waitForConnection.bind(f.manager);
		f.manager.waitForConnection = (...args) => {
			waiting.resolve();
			return wait(...args);
		};
		const pending = child.call("minions", "create_task");
		const outcome = pending.catch(error => error);
		await waiting.promise;
		await child.dispose();
		gate.resolve();
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		await f.loading;
		expect(f.calls).toEqual([]);
	}, 20_000);

	it("rechecks the worker's own settings overlay after discovery before main dispatch", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await connector("tenant-a", gate.promise);
		gates.push(() => gate.resolve());
		const { child, settings } = await workerSession(f.manager);
		const waiting = Promise.withResolvers<void>();
		const wait = f.manager.waitForConnection.bind(f.manager);
		f.manager.waitForConnection = (...args) => {
			waiting.resolve();
			return wait(...args);
		};
		const pending = child.call("minions", "create_task", {}, { retry: "never" });
		const outcome = pending.catch(error => error);
		await waiting.promise;
		await child.setApproval("deny");
		gate.resolve();
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		expect(cfgToolsApproval.get(settings)).toEqual({ mcp__minions_create_task: "allow" });
		await f.loading;
		expect(f.calls).toEqual([]);
	}, 20_000);

	for (const change of ["source", "account", "settings"] as const) {
		it(`rechecks actual main ${change} authority after discovery without trusting a worker boolean`, async () => {
			const gate = Promise.withResolvers<void>();
			const f = await connector("tenant-a", gate.promise);
			gates.push(() => gate.resolve());
			const { child, auth, settings } = await workerSession(f.manager);
			const waiting = Promise.withResolvers<void>();
			const wait = f.manager.waitForConnection.bind(f.manager);
			f.manager.waitForConnection = (...args) => {
				waiting.resolve();
				return wait(...args);
			};
			const pending = child.uncheckedCall("minions", "create_task", { retry: "never" });
			const outcome = pending.catch(error => error);
			await waiting.promise;
			try {
				if (change === "source") {
					await auth.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")), {
						sourceIdentity: "synthetic-replacement-source",
					});
				} else if (change === "account") {
					await auth.credentials.set("synthetic-owner", [
						{
							type: "oauth",
							access: "synthetic",
							refresh: "synthetic",
							expires: Date.now() + 60_000,
							accountId: "synthetic-owner-b",
						},
					]);
					const [account] = auth.oauth.accounts("synthetic-owner", child.owner.sessionManager.getSessionId());
					if (
						!account ||
						!auth.sessions.pin("synthetic-owner", child.owner.sessionManager.getSessionId(), account.credentialId)
					) {
						throw new Error("synthetic account was not pinned");
					}
				} else cfgToolsApproval.override(settings, { mcp__minions_create_task: "deny" });
			} finally {
				gate.resolve();
			}
			expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
			await f.loading;
			expect(f.calls).toEqual([]);
		}, 20_000);
	}

	it("drains an admitted result hook after cancellation instead of abandoning its completion", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		gates.push(() => release.resolve());
		const f = await connector();
		const { child } = await workerSession(f.manager, {
			result: { entered: entered.resolve, release: release.promise },
		});
		const controller = new AbortController();
		let settled = false;
		const pending = child.call("minions", "create_task", {}, { retry: "never", signal: controller.signal });
		const outcome = pending
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		await entered.promise;
		controller.abort();
		expect(await child.hooksCompleted()).toBe(0);
		expect(settled).toBe(false);
		release.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(await child.hooksCompleted()).toBe(1);
		expect(f.calls).toEqual([{ name: "create_task", args: {} }]);
	}, 20_000);

	it("retains actual completion after a dispatched call loses its result receipt and never replays it", async () => {
		const release = Promise.withResolvers<void>();
		const f = await connector("tenant-a", undefined, release.promise);
		gates.push(() => release.resolve());
		const { child, worker } = await workerSession(f.manager);
		let held = 0;
		const released = Promise.withResolvers<void>();
		worker.peer.retain = () => {
			held++;
			return () => {
				held--;
				released.resolve();
			};
		};
		const pending = child.call("minions", "create_task", {}, { retry: "never" });
		const outcome = pending.catch(error => error);
		await f.callEntered;
		worker.peer.link.close("lost synthetic receipt");
		expect(await outcome).toMatchObject({ name: "RpcClosedError" });
		expect(held).toBe(1);
		expect(f.calls).toEqual([{ name: "create_task", args: {} }]);
		release.resolve();
		await released.promise;
		expect(held).toBe(0);
		expect(f.calls).toEqual([{ name: "create_task", args: {} }]);
	}, 20_000);

	it("preserves bounded remote protocol diagnostics without releasing credential-shaped data", async () => {
		const f = await connector();
		const { child } = await workerSession(f.manager);
		f.protocolFailure();
		const result = await child.call("minions", "get_task", {}, { retry: "read" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toMatchObject({
			error: {
				code: -32042,
				failure: "json_rpc",
				traceId: "synthetic-trace",
			},
		});
		expect(JSON.stringify(result)).not.toContain("synthetic-secret");
		expect(f.calls).toEqual([{ name: "get_task", args: {} }]);
	}, 20_000);

	it("keeps uncertain mutations unreplayable while an explicitly safe read can recover", async () => {
		const f = await connector();
		const { child } = await workerSession(f.manager);
		f.failNext();
		const failed = await child.call("minions", "create_task", {}, { retry: "never" });
		expect(failed.isError).toBe(true);
		expect(f.calls).toEqual([{ name: "create_task", args: {} }]);
		f.failNext();
		const recovered = await child.call("minions", "get_task", {}, { retry: "read" });
		expect(recovered.structuredContent).toMatchObject({ tenant: "tenant-a" });
		expect(f.calls).toEqual([
			{ name: "create_task", args: {} },
			{ name: "get_task", args: {} },
			{ name: "get_task", args: {} },
		]);
	}, 20_000);
});
