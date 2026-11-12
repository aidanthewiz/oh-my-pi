import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { connectToServer, disconnectServer, listTools } from "@oh-my-pi/pi-coding-agent/mcp/client";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createMCPToolName, dispatchMCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { AgentRegistry, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(label = "tenant-a", toolsGate?: Promise<void>) {
	let failCalls = 0;
	let protocolError = false;
	let connectionCount = 0;
	let nextInitialization: { entered: () => void; wait: Promise<void> } | undefined;
	const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
	const initialized = Promise.withResolvers<void>();
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const rpc = (await request.json()) as {
				id?: number | string;
				method: string;
				params: { name: string; arguments?: Record<string, unknown> };
			};
			if (rpc.id === undefined) return new Response(null, { status: 202 });
			let result: unknown;
			if (rpc.method === "initialize") {
				connectionCount++;
				const held = nextInitialization;
				nextInitialization = undefined;
				held?.entered();
				if (held) await held.wait;
				initialized.resolve();
				result = {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "synthetic", version: "1" },
					capabilities: { tools: {} },
				};
			} else if (rpc.method === "tools/list") {
				if (toolsGate) await toolsGate;
				result = {
					tools: [
						{ name: "get_task", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
						{ name: "create_task", inputSchema: { type: "object" } },
						{ name: "idempotent_task", inputSchema: { type: "object" }, annotations: { idempotentHint: true } },
					],
				};
			} else if (rpc.method === "tools/call") {
				calls.push(rpc.params);
				if (failCalls-- > 0) return new Response("upstream unavailable", { status: 503 });
				if (protocolError)
					return Response.json({
						jsonrpc: "2.0",
						id: rpc.id,
						error: {
							code: -32042,
							message: "rejected Bearer secret-value",
							data: { client_secret: "secret-value", reason: "conflict", traceId: "synthetic-trace" },
						},
					});
				result = {
					content: [{ type: "text", text: `${label}: secret-value` }],
					structuredContent: { tenant: label, secret: "secret-value" },
					_meta: { private: "secret-value" },
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
		toolsGate ? 1 : 0,
	);
	await initialized.promise;
	if (!toolsGate) {
		await loading;
		await manager.waitForStartup(0);
	}
	return {
		manager,
		calls,
		loading,
		connectionCount: () => connectionCount,
		failNext: () => {
			failCalls = 1;
		},
		protocolFailure: () => {
			protocolError = true;
		},
		holdNextInitialization(wait: Promise<void>) {
			const entered = Promise.withResolvers<void>();
			nextInitialization = { entered: entered.resolve, wait };
			return entered.promise;
		},
	};
}

async function session(
	manager?: MCPManager,
	extension?: ExtensionFactory,
	settings = Settings.isolated(),
	agentRegistry = new AgentRegistry(),
): Promise<AgentSession> {
	const dir = TempDir.createSync("extension-mcp-");
	cleanup.push(() => dir.removeSync());
	const authStorage = createInMemoryAuthStorage();
	cleanup.push(() => authStorage.close());
	const created = await createAgentSession({
		cwd: dir.path(),
		agentDir: dir.path(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(dir.path(), "models.yml")),
		settings,
		agentRegistry,
		sessionManager: SessionManager.inMemory(),
		disableExtensionDiscovery: true,
		extensions: extension ? [extension] : [],
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		enableMCP: manager !== undefined,
		mcpManager: manager,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: ["read"],
	});
	cleanup.push(() => created.session.dispose());
	return created.session;
}

async function pinSyntheticAccount(s: AgentSession): Promise<void> {
	const auth = s.modelRegistry.authStorage;
	await auth.credentials.set("synthetic-owner", [
		{
			type: "oauth",
			access: "synthetic-access",
			refresh: "synthetic-refresh",
			expires: Date.now() + 60_000,
			accountId: "synthetic-owner-b",
		},
	]);
	const [account] = auth.oauth.accounts("synthetic-owner", s.sessionId);
	if (!account || !auth.sessions.pin("synthetic-owner", s.sessionId, account.credentialId)) {
		throw new Error("Synthetic account could not become active");
	}
}

describe("session-owned extension MCP", () => {
	for (const policy of ["allow", "deny"] as const) {
		it(`keeps Drata host calls behind native consent with an exact ${policy} policy under default yolo`, async () => {
			const manager = new MCPManager(process.cwd());
			const dispatch = spyOn(manager, "callTool").mockResolvedValue({
				content: [{ type: "text", text: "mutated" }],
			});
			const serverName = "coreforge-drata-mcp";
			const toolName = "create_task";
			let hooks = 0;
			const s = await session(
				manager,
				pi => {
					pi.on("tool_call", () => {
						hooks++;
					});
				},
				Settings.isolated({ "tools.approval": { [createMCPToolName(serverName, toolName)]: policy } }),
			);
			await expect(
				s
					.extensionRunner!.createContext()
					.mcp!.callTool(serverName, toolName, { controlId: 17 }, { retry: "never" }),
			).rejects.toThrow(policy === "deny" ? "blocked by user policy" : "requires approval");
			expect(dispatch).not.toHaveBeenCalled();
			expect(hooks).toBe(policy === "deny" ? 0 : 1);
		});
	}

	it("retains default-yolo dispatch for another host server with the same raw tool name", async () => {
		const f = await fixture();
		const s = await session(f.manager);
		await s.extensionRunner!.createContext().mcp!.callTool("minions", "create_task", { title: "synthetic task" });
		expect(f.calls).toEqual([{ name: "create_task", arguments: { title: "synthetic task" } }]);
	});

	it("keeps host-only catalogs hidden after refresh and reconnect while permitting calls", async () => {
		const { manager, calls } = await fixture();
		expect(manager.getConnectedServers()).toEqual(["minions"]);
		expect(manager.getTools()).toEqual([]);
		await manager.refreshServerTools("minions");
		await manager.reconnectServer("minions", { manual: true });
		expect(manager.getTools()).toEqual([]);
		const result = await manager.callTool("minions", "get_task", {}, { retry: "read" });
		expect(result.structuredContent?.tenant).toBe("tenant-a");
		expect(calls).toHaveLength(1);
	});

	it("reconnects a known closed transport before dispatching an unreplayable mutation", async () => {
		const f = await fixture();
		await f.manager.getConnection("minions")!.transport.close();
		const result = await f.manager.callTool("minions", "create_task", {}, { retry: "never" });
		expect(result.structuredContent?.tenant).toBe("tenant-a");
		expect(f.calls).toEqual([{ name: "create_task", arguments: {} }]);
		expect(f.manager.getTools()).toEqual([]);
	});

	it("never replays a failed unknown mutation, but explicitly safe reads recover once", async () => {
		const f = await fixture();
		f.failNext();
		await expect(f.manager.callTool("minions", "create_task", {}, { retry: "never" })).rejects.toThrow();
		expect(f.calls.map(call => call.name)).toEqual(["create_task"]);
		f.failNext();
		await expect(f.manager.callTool("minions", "create_task")).rejects.toThrow();
		expect(f.calls.map(call => call.name)).toEqual(["create_task", "create_task"]);
		f.failNext();
		const read = await f.manager.callTool("minions", "get_task", {}, { retry: "read" });
		expect(read.structuredContent?.tenant).toBe("tenant-a");
		expect(f.calls.map(call => call.name)).toEqual(["create_task", "create_task", "get_task", "get_task"]);
	});

	it("recovers annotated safe calls by default but obeys an explicit never-replay contract", async () => {
		const f = await fixture();
		for (const name of ["get_task", "idempotent_task"]) {
			f.failNext();
			const result = await f.manager.callTool("minions", name);
			expect(result.structuredContent?.tenant).toBe("tenant-a");
			f.failNext();
			await expect(f.manager.callTool("minions", name, {}, { retry: "never" })).rejects.toThrow();
		}
		expect(f.calls.map(call => call.name)).toEqual([
			"get_task",
			"get_task",
			"get_task",
			"idempotent_task",
			"idempotent_task",
			"idempotent_task",
		]);
	});

	it("does not reconnect or dispatch when a user disables a pending server", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await fixture("tenant-a", gate.promise);
		const pending = f.manager.callTool("minions", "create_task", {}, { retry: "never" });
		const rejected = pending.catch(error => error);
		const initializationsBeforeDisable = f.connectionCount();
		const disconnecting = f.manager.disconnectServer("minions");
		gate.resolve();
		const [failure] = await Promise.all([rejected, disconnecting, f.loading]);
		expect(failure).toBeInstanceOf(Error);
		expect(f.calls).toEqual([]);
		expect(f.connectionCount()).toBe(initializationsBeforeDisable);
		expect(f.manager.getConnectedServers()).toEqual([]);
		await expect(f.manager.callTool("minions", "create_task", {}, { retry: "never" })).rejects.toThrow("not enabled");
	});

	it("cannot dispatch a mutation after cancellation while waiting for discovery", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await fixture("tenant-a", gate.promise);
		const controller = new AbortController();
		const pending = f.manager.callTool("minions", "create_task", {}, { retry: "never", signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toThrow();
		gate.resolve();
		await f.loading;
		await f.manager.waitForStartup(1000);
		expect(f.calls).toEqual([]);
	});

	it("cannot replace the outer tool cancellation with a fresh explicit MCP signal", async () => {
		const f = await fixture();
		const s = await session(f.manager);
		const controller = new AbortController();
		const ctx = s.extensionRunner!.createContext(undefined, { toolName: "read", signal: controller.signal });
		controller.abort();
		await expect(
			ctx.mcp!.callTool("minions", "create_task", {}, { retry: "never", signal: new AbortController().signal }),
		).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});

	it("uses only the owning manager even after another session changes the singleton", async () => {
		const a = await fixture("tenant-a");
		const b = await fixture("tenant-b");
		const first = await session(a.manager);
		await session(b.manager);
		const result = await first
			.extensionRunner!.createContext()
			.mcp!.callTool("minions", "get_task", {}, { retry: "read" });
		expect(result.structuredContent?.tenant).toBe("tenant-a");
		expect(b.calls).toEqual([]);
		const disabled = await session();
		await expect(disabled.extensionRunner!.createContext().mcp!.callTool("minions", "create_task")).rejects.toThrow(
			"disabled",
		);
	});

	it("rejects a retained context when another session replaces its registry owner", async () => {
		const a = await fixture("tenant-a");
		const b = await fixture("tenant-b");
		const registry = new AgentRegistry();
		const first = await session(a.manager, undefined, Settings.isolated(), registry);
		const mcp = first.extensionRunner!.createContext().mcp!;
		await session(b.manager, undefined, Settings.isolated(), registry);
		await expect(mcp.callTool("minions", "create_task")).rejects.toThrow("owner changed");
		expect(a.calls).toEqual([]);
		expect(b.calls).toEqual([]);
	});

	it("rejects a retained context after its session is disposed", async () => {
		const f = await fixture();
		const s = await session(f.manager);
		const mcp = s.extensionRunner!.createContext().mcp!;
		await s.dispose();
		await expect(mcp.callTool("minions", "create_task")).rejects.toThrow("owner changed");
		expect(f.calls).toEqual([]);
	});

	it("does not dispatch after a new provider account becomes active during a policy hook", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const s = await session(f.manager, pi => {
			pi.on("tool_call", async event => {
				if (event.mcpServerName !== "minions") return;
				entered.resolve();
				await release.promise;
			});
		});
		const pending = s.extensionRunner!.createContext().mcp!.callTool("minions", "create_task");
		const outcome = pending.catch(error => error);
		await entered.promise;
		try {
			await pinSyntheticAccount(s);
		} finally {
			release.resolve();
		}
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		expect(f.calls).toEqual([]);
	});

	it("does not dispatch under a credential source adopted while discovery is pending", async () => {
		const gate = Promise.withResolvers<void>();
		const f = await fixture("tenant-a", gate.promise);
		const s = await session(f.manager);
		const waiting = Promise.withResolvers<void>();
		const waitForConnection = f.manager.waitForConnection.bind(f.manager);
		const observeWait = spyOn(f.manager, "waitForConnection").mockImplementation((...args) => {
			waiting.resolve();
			return waitForConnection(...args);
		});
		cleanup.push(() => observeWait.mockRestore());
		const pending = s.extensionRunner!.createContext().mcp!.callTool("minions", "create_task");
		const outcome = pending.catch(error => error);
		await waiting.promise;
		try {
			await s.modelRegistry.authStorage.replaceStore(new SqliteAuthCredentialStore(new Database(":memory:")), {
				sourceIdentity: "synthetic-replacement-source",
			});
		} finally {
			gate.resolve();
		}
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		await f.loading;
		expect(f.calls).toEqual([]);
	});

	it("does not dispatch after an account changes while a closed connection is reconnecting", async () => {
		const f = await fixture();
		const s = await session(f.manager);
		await f.manager.getConnection("minions")!.transport.close();
		const gate = Promise.withResolvers<void>();
		const reconnecting = f.holdNextInitialization(gate.promise);
		const pending = s.extensionRunner!.createContext().mcp!.callTool("minions", "create_task");
		const outcome = pending.catch(error => error);
		await reconnecting;
		try {
			await pinSyntheticAccount(s);
		} finally {
			gate.resolve();
		}
		expect(await outcome).toMatchObject({ message: "MCP call owner changed" });
		expect(f.calls).toEqual([]);
	});

	it("withholds results when a result hook changes the active account without repeating the mutation", async () => {
		const f = await fixture();
		const s = await session(f.manager, pi => {
			pi.on("tool_result", async event => {
				if (event.mcpServerName === "minions") await pinSyntheticAccount(s);
			});
		});
		await expect(
			s.extensionRunner!.createContext().mcp!.callTool("minions", "create_task", {}, { retry: "never" }),
		).rejects.toThrow("owner changed");
		expect(f.calls).toEqual([{ name: "create_task", arguments: {} }]);
	});

	for (const policy of ["deny", "prompt"] as const) {
		it(`does not dispatch host-only calls when session policy is ${policy} without approval UI`, async () => {
			const f = await fixture();
			let callHooks = 0;
			const s = await session(
				f.manager,
				pi => {
					pi.on("tool_call", () => {
						callHooks++;
					});
				},
				Settings.isolated({ "tools.approval": { mcp__minions_create_task: policy } }),
			);
			const untrustedOptions = {
				retry: "never" as const,
				context: { autoApprove: true, xdevApproved: true, hasUI: true, ui: { confirm: async () => true } },
			};
			await expect(
				s
					.extensionRunner!.createContext()
					.mcp!.callTool("minions", "create_task", { title: "synthetic" }, untrustedOptions),
			).rejects.toThrow();
			expect(f.calls).toEqual([]);
			expect(callHooks).toBe(policy === "deny" ? 0 : 1);
		});
	}

	it("prompts for final hook-replaced input and dispatches only after approval", async () => {
		const f = await fixture();
		let callHooks = 0;
		let resultHooks = 0;
		const s = await session(
			f.manager,
			pi => {
				pi.on("tool_call", event => {
					if (event.mcpServerName !== "minions") return;
					callHooks++;
					return { input: { title: "final synthetic title" } };
				});
				pi.on("tool_result", event => {
					if (event.mcpServerName === "minions") resultHooks++;
				});
			},
			Settings.isolated({ "tools.approval": { mcp__minions_create_task: "prompt" } }),
		);
		const runner = s.extensionRunner!;
		const prompted = Promise.withResolvers<string>();
		const choice = Promise.withResolvers<string>();
		const hasUI = spyOn(runner, "hasUI").mockReturnValue(true);
		const getUI = spyOn(runner, "getUIContext").mockReturnValue({
			...runner.getUIContext(),
			select: async title => {
				prompted.resolve(title);
				return choice.promise;
			},
		});
		cleanup.push(() => {
			hasUI.mockRestore();
			getUI.mockRestore();
		});
		const pending = runner.createContext().mcp!.callTool("minions", "create_task", { title: "original title" });
		// A dispatch from the old bypass must fail this test instead of leaving a pending prompt wait.
		const outcome = await Promise.race([
			prompted.promise.then(title => ({ title })),
			pending.then(() => ({ title: undefined })),
		]);
		if (outcome.title === undefined) {
			choice.resolve("Deny");
			throw new Error("MCP call dispatched without final-input approval");
		}
		expect(outcome.title).toContain("final synthetic title");
		expect(outcome.title).not.toContain("original title");
		expect(f.calls).toEqual([]);
		choice.resolve("Approve");
		await pending;
		expect(f.calls).toEqual([{ name: "create_task", arguments: { title: "final synthetic title" } }]);
		expect(callHooks).toBe(1);
		expect(resultHooks).toBe(1);
	});

	it("honors call blocks, input replacement, and result redaction across all channels", async () => {
		const f = await fixture();
		const s = await session(f.manager, pi => {
			pi.on("tool_call", event => {
				if (event.mcpServerName !== "minions") return;
				if (event.mcpToolName === "create_task") return { block: true, reason: "read-only review" };
				return { input: { key: "SYN-123" } };
			});
			pi.on("tool_result", event =>
				event.mcpServerName === "minions"
					? { content: [{ type: "text", text: "redacted" }], isError: true }
					: undefined,
			);
		});
		const api = s.extensionRunner!.createContext().mcp!;
		await expect(api.callTool("minions", "create_task", {}, { retry: "never" })).rejects.toThrow("read-only review");
		const result = await api.callTool("minions", "get_task", {}, { retry: "read" });
		expect(f.calls).toEqual([{ name: "get_task", arguments: { key: "SYN-123" } }]);
		expect(result).toEqual({ content: [{ type: "text", text: "redacted" }], isError: true });
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});

	it("checks cancellation again after a pending call policy hook", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const s = await session(f.manager, pi => {
			pi.on("tool_call", async event => {
				if (event.mcpServerName !== "minions") return;
				entered.resolve();
				await release.promise;
			});
		});
		const controller = new AbortController();
		const pending = s.extensionRunner!.createContext().mcp!.callTool(
			"minions",
			"create_task",
			{},
			{
				retry: "never",
				signal: controller.signal,
			},
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		await expect(pending).rejects.toThrow();
		expect(f.calls).toEqual([]);
	});

	it("drains an admitted result policy hook before cancellation settles the call", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let completed = false;
		const s = await session(f.manager, pi => {
			pi.on("tool_result", async event => {
				if (event.mcpServerName !== "minions") return;
				entered.resolve();
				await release.promise;
				completed = true;
			});
		});
		cleanup.push(() => release.resolve());
		const controller = new AbortController();
		let settled = false;
		const pending = s
			.extensionRunner!.createContext()
			.mcp!.callTool("minions", "create_task", {}, { retry: "never", signal: controller.signal });
		const outcome = pending
			.catch(error => error)
			.finally(() => {
				settled = true;
			});
		await entered.promise;
		controller.abort();
		await setImmediate();
		expect(settled).toBe(false);
		expect(completed).toBe(false);
		release.resolve();
		expect(await outcome).toBeInstanceOf(Error);
		expect(completed).toBe(true);
		expect(f.calls).toEqual([{ name: "create_task", arguments: {} }]);
	});

	it("does not leak original structured data after in-place content redaction", async () => {
		const f = await fixture();
		const s = await session(f.manager, pi => {
			pi.on("tool_result", event => {
				if (event.mcpServerName !== "minions") return;
				event.content.splice(0, event.content.length, { type: "text", text: "redacted in place" });
			});
		});
		const result = await s
			.extensionRunner!.createContext()
			.mcp!.callTool("minions", "get_task", {}, { retry: "read" });
		expect(result.content).toEqual([{ type: "text", text: "redacted in place" }]);
		expect(result.structuredContent).toBeUndefined();
		expect(result._meta).toBeUndefined();
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});

	for (const inPlace of [true, false]) {
		it(`drops unchanged secret channels when ${inPlace ? "in-place" : "returned"} redaction changes unrelated details`, async () => {
			const f = await fixture();
			const s = await session(f.manager, pi => {
				pi.on("tool_result", event => {
					if (event.mcpServerName !== "minions") return;
					const content = [{ type: "text" as const, text: "safe subset" }];
					if (inPlace) {
						event.content.splice(0, event.content.length, ...content);
						(event.details as Record<string, unknown>).display = "safe";
						return;
					}
					return { content, details: { ...(event.details as object), display: "safe" } };
				});
			});
			const result = await s.extensionRunner!.createContext().mcp!.callTool("minions", "get_task", {});
			expect(result.content).toEqual([{ type: "text", text: "safe subset" }]);
			expect(result.structuredContent).toBeUndefined();
			expect(result._meta).toBeUndefined();
			expect(JSON.stringify(result)).not.toContain("secret-value");
		});
	}

	for (const channel of ["structuredContent", "mcpMeta"] as const) {
		it(`authorizes only the explicitly replaced ${channel} channel after redaction`, async () => {
			const f = await fixture();
			const s = await session(f.manager, pi => {
				pi.on("tool_result", event =>
					event.mcpServerName === "minions"
						? {
								content: [{ type: "text", text: "safe subset" }],
								details: { ...(event.details as object), [channel]: { safe: true } },
							}
						: undefined,
				);
			});
			const result = await s.extensionRunner!.createContext().mcp!.callTool("minions", "get_task", {});
			expect(result.structuredContent).toEqual(channel === "structuredContent" ? { safe: true } : undefined);
			expect(result._meta).toEqual(channel === "mcpMeta" ? { safe: true } : undefined);
			expect(JSON.stringify(result)).not.toContain("secret-value");
		});
	}

	it("returns explicit safe structured and metadata replacements", async () => {
		const f = await fixture();
		const s = await session(f.manager, pi => {
			pi.on("tool_result", event =>
				event.mcpServerName === "minions"
					? {
							content: [{ type: "text", text: "allowed subset" }],
							details: { structuredContent: { key: "SYN-123" }, mcpMeta: { redacted: true } },
						}
					: undefined,
			);
		});
		const result = await s
			.extensionRunner!.createContext()
			.mcp!.callTool("minions", "get_task", {}, { retry: "read" });
		expect(result.structuredContent).toEqual({ key: "SYN-123" });
		expect(result._meta).toEqual({ redacted: true });
		expect(JSON.stringify(result)).not.toContain("secret-value");
	});

	it("preserves bounded protocol diagnostics without exposing secrets", async () => {
		const f = await fixture();
		f.protocolFailure();
		const s = await session(f.manager);
		const result = await s
			.extensionRunner!.createContext()
			.mcp!.callTool("minions", "get_task", {}, { retry: "read" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent?.error).toMatchObject({
			code: -32042,
			failure: "json_rpc",
			traceId: "synthetic-trace",
		});
		expect(JSON.stringify(result)).not.toContain("secret-value");
		expect(f.calls).toHaveLength(1);
		expect(s.extensionRunner!.createContext().ui.supportsCustomUI).not.toBe(true);
	});
});

describe("MCP authentication replay contracts", () => {
	for (const scenario of [
		{ label: "explicit never mutation", retry: "never", hint: false, read: false },
		{ label: "explicit never overrides readonly metadata", retry: "never", hint: true, read: false },
		{ label: "default unknown mutation", retry: undefined, hint: false, read: false },
		{ label: "annotated safe read", retry: undefined, hint: true, read: true },
		{ label: "explicit safe read", retry: "read", hint: false, read: true },
	] as const) {
		it(`honors the authentication replay contract for ${scenario.label}`, async () => {
			const effects: string[] = [];
			let attempts = 0;
			let reconnects = 0;
			const definition = {
				name: scenario.read ? "get_state" : "create_record",
				inputSchema: { type: "object" as const },
				annotations: scenario.hint ? { readOnlyHint: true } : undefined,
			};
			const server = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				async fetch(request) {
					if (request.method !== "POST") return new Response(null, { status: 405 });
					const rpc = (await request.json()) as { id?: number; method: string };
					if (rpc.id === undefined) return new Response(null, { status: 202 });
					let result: unknown = {};
					if (rpc.method === "initialize") {
						result = {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "synthetic-auth", version: "1" },
						};
					} else if (rpc.method === "tools/list") {
						result = { tools: [definition] };
					} else if (rpc.method === "tools/call") {
						attempts++;
						if (!scenario.read) effects.push("synthetic-record");
						result =
							attempts === 1
								? {
										isError: true,
										content: [{ type: "text", text: "Authentication challenge after partial processing" }],
										structuredContent: { recordId: "synthetic-record", applied: !scenario.read },
										_meta: {
											"mcp/www_authenticate": ['Bearer realm="synthetic"'],
											receipt: "partial-receipt",
										},
									}
								: {
										content: [{ type: "text", text: "Recovered synthetic state" }],
										structuredContent: { state: "synthetic-state" },
									};
					}
					return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
				},
			});
			cleanup.push(() => server.stop(true));
			const config = { type: "http" as const, url: server.url.href };
			let connection = await connectToServer("synthetic-auth", config);
			cleanup.push(() => disconnectServer(connection));
			const [tool] = await listTools(connection);
			if (!tool) throw new Error("Synthetic authentication server exposed no tool");
			const attempt = await dispatchMCPTool(
				connection,
				tool,
				{},
				async () => {
					reconnects++;
					await disconnectServer(connection);
					connection = await connectToServer("synthetic-auth", config);
					return connection;
				},
				{ retry: scenario.retry },
			);
			if (scenario.read) {
				expect(attempt.result.isError).not.toBe(true);
				expect(attempt.result.structuredContent?.state).toBe("synthetic-state");
				expect(attempts).toBe(2);
				expect(reconnects).toBe(1);
				expect(effects).toEqual([]);
			} else {
				expect(effects).toEqual(["synthetic-record"]);
				expect(attempts).toBe(1);
				expect(reconnects).toBe(0);
				expect(attempt.result.isError).toBe(true);
				expect(attempt.result.structuredContent?.recordId).toBe("synthetic-record");
				expect(attempt.result._meta?.receipt).toBe("partial-receipt");
				expect(attempt.result._meta?.["mcp/www_authenticate"]).toEqual(['Bearer realm="synthetic"']);
			}
		});
	}
});
