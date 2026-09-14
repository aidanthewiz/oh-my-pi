/**
 * MCP startup must remain non-interactive. A signed-out integration records its
 * challenge during discovery and authorizes only when that integration is used.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
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

function installMcpFetch(authUrls: Set<string>, authHeaders = new Map<string, string>()) {
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

			if (body.method === "initialize" && authUrls.has(url) && !failedInitializations.has(url)) {
				failedInitializations.add(url);
				const wwwAuthenticate = authHeaders.get(url);
				return new Response(JSON.stringify({ error: "invalid_token" }), {
					status: 401,
					headers: {
						"Content-Type": "application/json",
						...(wwwAuthenticate ? { "WWW-Authenticate": wwwAuthenticate } : {}),
					},
				});
			}

			if (body.method === "initialize") {
				return jsonResponse({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: url, version: "test" },
					},
				});
			}
			if (body.method === "tools/list") {
				return jsonResponse({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
			}
			return new Response(null, { status: 202 });
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
	return { requests, fetchSpy };
}

function httpConfig(url: string, enabled?: boolean): MCPHttpServerConfig {
	return { type: "http", url, ...(enabled === undefined ? {} : { enabled }) };
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

	test("surfaces cached static tools when signed-out discovery fails", async () => {
		const cachedTools: MCPToolDefinition[] = [{ name: "lookup", inputSchema: { type: "object", properties: {} } }];
		const toolCache = {
			get: async () => cachedTools,
			set: async () => {},
		} as unknown as MCPToolCache;
		const manager = new MCPManager(process.cwd(), toolCache);
		const config = httpConfig(SENTRY_URL);
		const { requests } = installMcpFetch(new Set([SENTRY_URL]));

		try {
			const result = await manager.connectServers({ sentry: config }, {});

			expect(result.errors.has("sentry")).toBe(false);
			expect(result.tools.map(tool => tool.name)).toEqual(["mcp__sentry_lookup"]);
			expect(requests.filter(request => request.body.method === "initialize")).toHaveLength(0);
		} finally {
			await manager.disconnectAll();
		}
	});

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

	test("does not re-prompt after the first-use authorization is declined", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(SENTRY_URL);
		installMcpFetch(new Set([SENTRY_URL]));
		const handler = vi.fn(async () => undefined);
		manager.setAuthHandler(handler);

		try {
			await manager.connectServers({ sentry: config }, {});

			await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected: sentry");
			await expect(manager.waitForConnection("sentry")).rejects.toThrow("MCP server not connected: sentry");
			expect(handler).toHaveBeenCalledTimes(1);
		} finally {
			await manager.disconnectAll();
		}
	});

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
