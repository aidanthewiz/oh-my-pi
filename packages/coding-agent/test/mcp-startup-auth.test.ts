/**
 * Regression coverage for automatic OAuth on initial HTTP MCP connections.
 *
 * Interactive sessions already install the MCP auth handler before deferred
 * discovery starts. A 401 during initialize must use that handler, retry once,
 * and serialize concurrent flows because OAuth callbacks share a local port.
 */
import { afterEach, describe, expect, test, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	type MCPAuthChallenge,
	type MCPHttpServerConfig,
	MCPOAuthCancelledError,
} from "@oh-my-pi/pi-coding-agent/mcp/types";

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

	test("reauthorizes an enabled HTTP server after an initialize 401", async () => {
		const manager = new MCPManager(process.cwd());
		const config = httpConfig(SENTRY_URL);
		const refreshedConfig: MCPHttpServerConfig = {
			...config,
			headers: { Authorization: "Bearer fresh-token" },
		};
		const { requests } = installMcpFetch(
			new Set([SENTRY_URL]),
			new Map([[SENTRY_URL, 'Bearer realm="https://auth.test"']]),
		);
		const challenges: MCPAuthChallenge[] = [];
		manager.setAuthHandler(async (_name, challenge) => {
			challenges.push(challenge);
			return refreshedConfig;
		});

		try {
			const result = await manager.connectServers({ sentry: config }, {});

			expect(result.errors).toEqual(new Map());
			expect(result.connectedServers).toEqual(["sentry"]);
			expect(challenges).toEqual([{ wwwAuthenticate: ['Bearer realm="https://auth.test"'] }]);

			const initializeRequests = requests.filter(
				request => request.url === SENTRY_URL && request.body.method === "initialize",
			);
			expect(initializeRequests).toHaveLength(2);
			expect(initializeRequests[1]?.headers.get("Authorization")).toBe("Bearer fresh-token");
		} finally {
			await manager.disconnectAll();
		}
	});

	test("serializes concurrent startup OAuth flows", async () => {
		const manager = new MCPManager(process.cwd());
		const rootlyConfig = httpConfig(ROOTLY_URL);
		const sentryConfig = httpConfig(SENTRY_URL);
		installMcpFetch(new Set([ROOTLY_URL, SENTRY_URL]));

		let activeFlows = 0;
		let maximumConcurrentFlows = 0;
		const firstFlowStarted = Promise.withResolvers<void>();
		const releaseFirstFlow = Promise.withResolvers<void>();
		const handler = vi.fn(async (name: string, _challenge: MCPAuthChallenge) => {
			activeFlows++;
			maximumConcurrentFlows = Math.max(maximumConcurrentFlows, activeFlows);
			if (name === "rootly") {
				firstFlowStarted.resolve();
				await releaseFirstFlow.promise;
			}
			activeFlows--;
			return name === "rootly" ? rootlyConfig : sentryConfig;
		});
		manager.setAuthHandler(handler);

		try {
			const resultPromise = manager.connectServers({ rootly: rootlyConfig, sentry: sentryConfig }, {});
			await firstFlowStarted.promise;
			expect(handler).toHaveBeenCalledTimes(1);

			releaseFirstFlow.resolve();
			const result = await resultPromise;
			expect(handler).toHaveBeenCalledTimes(2);
			expect(maximumConcurrentFlows).toBe(1);
			expect(result.connectedServers).toEqual(["rootly", "sentry"]);
		} finally {
			releaseFirstFlow.resolve();
			await manager.disconnectAll();
		}
	});

	test("cancels the active OAuth flow and every queued flow", async () => {
		const manager = new MCPManager(process.cwd());
		const rootlyConfig = httpConfig(ROOTLY_URL);
		const sentryConfig = httpConfig(SENTRY_URL);
		installMcpFetch(new Set([ROOTLY_URL, SENTRY_URL]));

		const firstFlowStarted = Promise.withResolvers<void>();
		const queueEvents: Array<{ type: string; serverName: string; queue: readonly string[] }> = [];
		const statuses: Array<{ type: string; serverName?: string }> = [];
		const handler = vi.fn(async (name: string, _challenge: MCPAuthChallenge, context?: { signal: AbortSignal }) => {
			firstFlowStarted.resolve();
			await new Promise<void>((_resolve, reject) => {
				context?.signal.addEventListener("abort", () => reject(new MCPOAuthCancelledError()), { once: true });
			});
			return name === "rootly" ? rootlyConfig : sentryConfig;
		});
		manager.setAuthHandler(handler);
		manager.setAuthQueueHandler(event => queueEvents.push(event));

		try {
			const resultPromise = manager.connectServers({ rootly: rootlyConfig, sentry: sentryConfig }, {}, event =>
				statuses.push(event),
			);
			await firstFlowStarted.promise;
			manager.cancelAuthQueue();
			const result = await resultPromise;

			expect(handler).toHaveBeenCalledTimes(1);
			expect(result.connectedServers).toEqual([]);
			expect(result.errors).toEqual(new Map());
			expect(queueEvents.filter(event => event.type === "cancelled").map(event => event.serverName)).toEqual([
				"rootly",
				"sentry",
			]);
			expect(
				statuses
					.filter(event => event.type === "cancelled")
					.map(event => event.serverName)
					.sort(),
			).toEqual(["rootly", "sentry"]);
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
