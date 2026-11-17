/**
 * MCP startup remains non-interactive while cached tools are available before
 * background discovery populates the remaining server catalogs.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig, MCPServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { MCPOAuthCancelledError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPToolCache } from "@oh-my-pi/pi-coding-agent/mcp/tool-cache";

type RequestRecord = {
	url: string;
	method: string;
	headers: Headers;
	body: { method?: string; id?: string | number };
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function installMcpFetch(
	authUrls: Set<string>,
	authHeaders = new Map<string, string>(),
	requireAuthHeader = false,
	options?: {
		initialize?: Promise<void>;
		catalogs?: boolean;
		failTools?: boolean;
		authStatus?: number;
		authMethod?: "initialize" | "tools/list";
		tools?: MCPToolDefinition[];
	},
) {
	const requests: RequestRecord[] = [];
	const failedInitializations = new Set<string>();
	const fetchImpl = Object.assign(
		async (input: string | Request | URL, init?: RequestInit | BunFetchRequestInit) => {
			const url = String(input);
			const rawBody = typeof init?.body === "string" ? init.body : undefined;
			const body = rawBody ? (JSON.parse(rawBody) as RequestRecord["body"]) : {};
			requests.push({
				url,
				method: init?.method ?? "GET",
				headers: new Headers(init?.headers),
				body,
			});

			if (
				body.method === (options?.authMethod ?? "initialize") &&
				authUrls.has(url) &&
				(requireAuthHeader
					? new Headers(init?.headers).get("authorization") !== "Bearer fresh-token"
					: !failedInitializations.has(url))
			) {
				failedInitializations.add(url);
				const wwwAuthenticate = authHeaders.get(url);
				return new Response(JSON.stringify({ error: "invalid_token" }), {
					status: options?.authStatus ?? 401,
					headers: {
						"Content-Type": "application/json",
						...(wwwAuthenticate ? { "WWW-Authenticate": wwwAuthenticate } : {}),
					},
				});
			}

			if (body.method === "initialize") {
				await options?.initialize;
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: options?.catalogs ? { tools: {}, resources: {}, prompts: {} } : { tools: {} },
						serverInfo: { name: url, version: "test" },
						...(options?.catalogs ? { instructions: "catalog guidance" } : {}),
					},
				});
			}
			if (body.method === "tools/list") {
				if (options?.failTools) {
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32603, message: "tool catalog unavailable" },
					});
				}
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: options?.tools ?? [] } });
			}
			if (body.method === "resources/list") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: { resources: [{ uri: "test://guide", name: "guide" }] },
				});
			}
			if (body.method === "resources/templates/list") {
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { resourceTemplates: [] } });
			}
			if (body.method === "prompts/list") {
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { prompts: [{ name: "review" }] } });
			}
			if (body.method === "tools/call") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: { content: [{ type: "text", text: `Result from ${url}` }] },
				});
			}
			return new Response(null, { status: 202 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
	return { requests, fetchSpy };
}

function httpConfig(url: string, enabled?: boolean): MCPHttpServerConfig {
	return { type: "http", url, oauth: { clientName: "test" }, ...(enabled === undefined ? {} : { enabled }) };
}

const ROOTLY_URL = "https://mcp.rootly.test/mcp-codemode";
const SENTRY_URL = "https://mcp.sentry.test/mcp";

describe("MCP startup OAuth", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("does not open browser authorization during a signed-out server's background discovery", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(SENTRY_URL);
		const { requests } = installMcpFetch(
			new Set([SENTRY_URL]),
			new Map([[SENTRY_URL, 'Bearer realm="https://auth.test"']]),
		);
		const handler = vi.fn(async () => ({
			...config,
			headers: { Authorization: "Bearer fresh-token" },
		}));
		manager.setAuthHandler(handler);

		try {
			const result = await manager.connectServers({ sentry: config }, {});

			expect(result.errors.get("sentry")).toContain("HTTP 401");
			expect(result.errors.get("sentry")).toContain("/mcp reauth sentry");
			expect(handler).not.toHaveBeenCalled();
			expect(requests.filter(request => request.body.method === "initialize")).toHaveLength(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	test.each(["initialize", "tools/list"] as const)(
		"recovers a cold %s sign-in failure without reconnecting healthy sibling tools",
		async authMethod => {
			const manager = new MCPManager(process.cwd());
			const config: MCPHttpServerConfig = { type: "http", url: SENTRY_URL };
			const { requests } = installMcpFetch(
				new Set([SENTRY_URL]),
				new Map([
					[SENTRY_URL, 'Bearer resource_metadata="https://auth.test/.well-known/oauth-protected-resource"'],
				]),
				true,
				{ authMethod, tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] },
			);
			const handler = vi.fn(async () => ({ ...config, headers: { Authorization: "Bearer fresh-token" } }));
			manager.setAuthHandler(handler);
			const events: McpConnectionStatusEvent[] = [];

			try {
				await manager.connectServers(
					{ sentry: config, rootly: httpConfig(ROOTLY_URL) },
					{},
					event => events.push(event),
					0,
				);
				await manager.waitForStartup(0);
				const before = manager.getConnectionStatusSnapshot();
				expect(before.failedServers).toEqual([
					expect.objectContaining({ serverName: "sentry", authRequired: true, authDeferred: false }),
				]);
				expect(before.connectedServers).toEqual(["rootly"]);
				expect(events.find(event => event.type === "failed" && event.serverName === "sentry")).toMatchObject({
					authRequired: true,
				});
				expect(manager.getPendingAuthServers()).toEqual(["sentry"]);
				expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__rootly_lookup"]);
				expect((await manager.callTool("rootly", "lookup")).content).toEqual([
					{ type: "text", text: `Result from ${ROOTLY_URL}` },
				]);
				expect(handler).not.toHaveBeenCalled();
				const healthyConnection = manager.getConnection("rootly");
				const liveSnapshots: string[][] = [];
				const unsubscribe = manager.addConnectionStatusListener(() => {
					liveSnapshots.push([...manager.getConnectionStatusSnapshot().connectedServers]);
				});

				const recovered = await manager.authenticateServer("sentry");
				unsubscribe();

				expect(recovered?.tools?.map(tool => tool.name)).toEqual(["lookup"]);
				expect(handler).toHaveBeenCalledTimes(1);
				expect(manager.getConnection("rootly")).toBe(healthyConnection);
				expect(
					requests.filter(request => request.url === ROOTLY_URL && request.body.method === "initialize"),
				).toHaveLength(1);
				expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__rootly_lookup", "mcp__sentry_lookup"]);
				expect(manager.getPendingAuthServers()).toEqual([]);
				expect(manager.getConnectionStatusSnapshot().failedServers).toEqual([]);
				expect(new Set(liveSnapshots.at(-1))).toEqual(new Set(["sentry", "rootly"]));
				expect(before.failedServers[0]?.authRequired).toBe(true);
			} finally {
				await manager.disconnectAll();
			}
			expect(manager.getConnectionStatusSnapshot()).toEqual({
				pendingServers: [],
				connectedServers: [],
				failedServers: [],
			});
		},
	);

	test.each([
		{ status: 401, configured: false, challenge: undefined, pendingAuth: false },
		{ status: 403, configured: true, challenge: 'Bearer realm="tenant-permission"', pendingAuth: false },
		{
			status: 403,
			configured: false,
			challenge: 'Bearer error="insufficient_scope", scope="read"',
			pendingAuth: true,
		},
	])("classifies HTTP $status with challenge $challenge without blind sign-in retries", async row => {
		const manager = new MCPManager(process.cwd());
		const config: MCPHttpServerConfig = row.configured ? httpConfig(SENTRY_URL) : { type: "http", url: SENTRY_URL };
		installMcpFetch(new Set([SENTRY_URL]), row.challenge ? new Map([[SENTRY_URL, row.challenge]]) : new Map(), true, {
			authStatus: row.status,
		});
		const handler = vi.fn(async () => config);
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ sentry: config }, {}, undefined, 0);
			await manager.waitForStartup(0);
			expect(manager.getPendingAuthServers()).toEqual(row.pendingAuth ? ["sentry"] : []);
			expect(manager.getConnectionStatusSnapshot().failedServers[0]?.authRequired === true).toBe(row.pendingAuth);
			expect(handler).not.toHaveBeenCalled();
		} finally {
			await manager.disconnectAll();
		}
	});

	test("Not now suppresses first-use sign-in but permits a later explicit retry", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(SENTRY_URL);
		installMcpFetch(new Set([SENTRY_URL]), new Map(), true);
		const handler = vi.fn(async () => ({ ...config, headers: { Authorization: "Bearer fresh-token" } }));
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ sentry: config }, {}, undefined, 0);
			await manager.waitForStartup(0);
			manager.deferAuthentication("sentry");
			await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected");
			await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected");
			expect(handler).not.toHaveBeenCalled();
			expect(manager.getConnectionStatusSnapshot().failedServers[0]).toMatchObject({
				authRequired: true,
				authDeferred: true,
			});
			expect(manager.getServerConfig("sentry")?.enabled).not.toBe(false);
			expect(await manager.authenticateServer("sentry")).not.toBeNull();
			expect(handler).toHaveBeenCalledTimes(1);
			expect(manager.getPendingAuthServers()).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("disconnecting one active sign-in cancels its owner without cancelling a queued sibling", async () => {
		const manager = new MCPManager(process.cwd());
		const configs: Record<string, MCPServerConfig> = {
			sentry: httpConfig(SENTRY_URL),
			rootly: httpConfig(ROOTLY_URL),
		};
		installMcpFetch(new Set([SENTRY_URL, ROOTLY_URL]), new Map(), true);
		const entered = Promise.withResolvers<void>();
		manager.setAuthHandler(async (name, _challenge, context) => {
			if (name === "sentry") {
				const cancelled = Promise.withResolvers<never>();
				context?.signal.addEventListener("abort", () => cancelled.reject(new MCPOAuthCancelledError()), {
					once: true,
				});
				entered.resolve();
				return await cancelled.promise;
			}
			return { ...configs[name], headers: { Authorization: "Bearer fresh-token" } } as MCPHttpServerConfig;
		});

		try {
			await manager.connectServers(configs, {}, undefined, 0);
			await manager.waitForStartup(0);
			const first = manager.authenticateServer("sentry");
			const firstCancelled = first.catch(error => error);
			await entered.promise;
			const sibling = manager.authenticateServer("rootly");
			await manager.disconnectServer("sentry");
			expect(await firstCancelled).toBeInstanceOf(MCPOAuthCancelledError);
			expect((await sibling)?.name).toBe("rootly");
			expect(manager.getPendingAuthServers()).toEqual([]);
			expect(manager.getConnectionStatusSnapshot().connectedServers).toEqual(["rootly"]);
			expect(manager.getConnectionStatusSnapshot().failedServers).toEqual([]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("keeps cached tools when signed-out background discovery fails without opening authorization", async () => {
		const cachedTools: MCPToolDefinition[] = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
		const toolCache = {
			get: async () => cachedTools,
			set: async () => {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), toolCache);
		const config = httpConfig(SENTRY_URL);
		const { requests } = installMcpFetch(new Set([SENTRY_URL]));
		const handler = vi.fn(async () => ({ ...config, headers: { Authorization: "Bearer fresh-token" } }));
		manager.setAuthHandler(handler);

		try {
			const result = await manager.connectServers({ sentry: config }, {});
			expect(result.errors.has("sentry")).toBe(false);
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__sentry_lookup"]);
			await manager.waitForPendingConnections();
			expect(requests.filter(request => request.body.method === "initialize")).toHaveLength(1);
			expect(handler).not.toHaveBeenCalled();
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__sentry_lookup"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("loads prompts and resources behind cached tools without waiting for initialization", async () => {
		const gate = Promise.withResolvers<void>();
		const cachedTools: MCPToolDefinition[] = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
		const toolCache = {
			get: async () => cachedTools,
			set: async () => {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), toolCache);
		installMcpFetch(new Set(), new Map(), false, { initialize: gate.promise, catalogs: true });
		const kinds = new Set<string>();
		const catalogsReady = Promise.withResolvers<void>();
		manager.addCatalogChangeListener(event => {
			kinds.add(event.kind);
			if (kinds.has("resources") && kinds.has("prompts")) catalogsReady.resolve();
		});

		try {
			const result = await manager.connectServers({ catalog: httpConfig(SENTRY_URL) }, {});
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__catalog_lookup"]);
			expect(manager.getServerResources("catalog")).toBeUndefined();
			expect(manager.getServerPrompts("catalog")).toBeUndefined();

			gate.resolve();
			await catalogsReady.promise;
			expect(manager.getConnection("catalog")?.instructions).toBe("catalog guidance");
			expect(manager.getServerResources("catalog")?.resources.map(item => item.uri)).toEqual(["test://guide"]);
			expect(manager.getServerPrompts("catalog")?.map(item => item.name)).toEqual(["review"]);
		} finally {
			gate.resolve();
			await manager.disconnectAll();
		}
	}, 15_000);

	test("retains cached tools when background tools/list fails", async () => {
		const cachedTools: MCPToolDefinition[] = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
		const toolCache = {
			get: async () => cachedTools,
			set: async () => {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), toolCache);
		const { requests } = installMcpFetch(new Set(), new Map(), false, { failTools: true });

		try {
			const result = await manager.connectServers({ catalog: httpConfig(SENTRY_URL) }, {});
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__catalog_lookup"]);
			await manager.waitForPendingConnections();
			expect(requests.some(request => request.body.method === "tools/list")).toBe(true);
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__catalog_lookup"]);
			expect(manager.getServerPrompts("catalog")).toBeUndefined();
		} finally {
			await manager.disconnectAll();
		}
	});

	test("authorizes cached tools on first use when the server still requires credentials", async () => {
		const cachedTools: MCPToolDefinition[] = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
		const toolCache = {
			get: async () => cachedTools,
			set: async () => {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), toolCache);
		const config = httpConfig(SENTRY_URL);
		const { requests } = installMcpFetch(new Set([SENTRY_URL]), new Map(), true);
		const handler = vi.fn(async () => ({
			...config,
			headers: { Authorization: "Bearer fresh-token" },
		}));
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ sentry: config }, {});
			await manager.waitForPendingConnections();
			expect(requests.filter(request => request.body.method === "initialize")).toHaveLength(1);
			expect(handler).not.toHaveBeenCalled();

			await manager.waitForConnection("sentry");
			expect(handler).toHaveBeenCalledTimes(1);
			const initializations = requests.filter(request => request.body.method === "initialize");
			expect(initializations).toHaveLength(2);
			expect(initializations[1].headers.get("authorization")).toBe("Bearer fresh-token");
		} finally {
			await manager.disconnectAll();
		}
	}, 15_000);

	test("authorizes only when an affected integration first needs its server", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(ROOTLY_URL);
		installMcpFetch(new Set([ROOTLY_URL]));
		const refreshedConfig: MCPHttpServerConfig = {
			...config,
			headers: { Authorization: "Bearer fresh-token" },
		};
		const handler = vi.fn(async () => refreshedConfig);
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ rootly: config }, {});
			expect(handler).not.toHaveBeenCalled();

			await Promise.all([manager.waitForConnection("rootly"), manager.waitForConnection("rootly")]);
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	test.each([{ outcome: "declined" }, { outcome: "cancelled" }])(
		"retains $outcome sign-in until an explicit retry",
		async ({ outcome }) => {
			const manager = new MCPManager(process.cwd());
			const config = httpConfig(SENTRY_URL);
			installMcpFetch(new Set([SENTRY_URL]), new Map(), true);
			const handler = vi.fn(async (): Promise<MCPServerConfig | undefined> => ({
				...config,
				headers: { Authorization: "Bearer fresh-token" },
			}));
			handler.mockImplementationOnce(async () => {
				if (outcome === "cancelled") throw new MCPOAuthCancelledError();
				return undefined;
			});
			manager.setAuthHandler(handler);

			try {
				await manager.connectServers({ sentry: config }, {}, undefined, 0);
				await manager.waitForStartup(0);
				if (outcome === "cancelled") {
					await expect(manager.waitForConnection("sentry")).rejects.toBeInstanceOf(MCPOAuthCancelledError);
				} else {
					await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected: sentry");
				}
				await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected: sentry");
				expect(handler).toHaveBeenCalledTimes(1);
				expect(manager.getConnectionStatusSnapshot().failedServers[0]).toMatchObject({
					authRequired: true,
					authDeferred: true,
				});
				expect(manager.getServerConfig("sentry")?.enabled).not.toBe(false);
				expect((await manager.authenticateServer("sentry"))?.name).toBe("sentry");
				expect(handler).toHaveBeenCalledTimes(2);
				expect(manager.getPendingAuthServers()).toEqual([]);
			} finally {
				await manager.disconnectAll();
			}
		},
	);

	test("does not retry a failed first-use authorization until manual reconnect", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(SENTRY_URL);
		installMcpFetch(new Set([SENTRY_URL]));
		const handler = vi.fn(async () => {
			throw new Error("browser authorization unavailable");
		});
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ sentry: config }, {});

			await expect(manager.waitForConnection("sentry")).rejects.toThrow("browser authorization unavailable");
			await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected: sentry");
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			await manager.disconnectAll();
		}
	});

	test("does not start OAuth for a disabled server", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(ROOTLY_URL, false);
		installMcpFetch(new Set([ROOTLY_URL]));
		const handler = vi.fn(async () => config);
		manager.setAuthHandler(handler);

		try {
			const result = await manager.connectServers({ rootly: config }, {});

			expect(handler).not.toHaveBeenCalled();
			expect(result.errors.get("rootly")).toContain("HTTP 401");
		} finally {
			await manager.disconnectAll();
		}
	});
});
