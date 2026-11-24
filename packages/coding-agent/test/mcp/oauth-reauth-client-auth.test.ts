import { afterEach, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import {
	clearMcpClientAuthSurface,
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	persistMcpOAuthResult,
	reconnectMcpManagerServer,
	resolveMcpOAuthEndpointsFromServer,
	type FoundMcpServer,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { updateMCPServer, writeMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPAuthConfig, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getAgentDir, getMCPConfigPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const staleAuth: MCPAuthConfig = {
	type: "oauth",
	credentialId: "mcp_oauth:profile:old",
	tokenUrl: "https://auth.example.com/token",
};

function asHttpServerConfig(
	config: MCPServerConfig,
): MCPServerConfig & { url: string; headers?: Record<string, string> } {
	if (config.type !== "http" && config.type !== "sse") {
		throw new Error(`expected an http/sse config, got ${config.type ?? "stdio"}`);
	}
	return config;
}

function selectedManagerConfig(config: MCPServerConfig): FoundMcpServer {
	return { config, scope: "user", filePath: path.join(os.tmpdir(), "mcp.json"), discovered: true };
}

describe("clearMcpClientAuthSurface", () => {
	test("strips every Authorization header spelling and the auth block, keeping the rest", () => {
		const config: MCPServerConfig = {
			type: "http",
			url: "https://mcp.example.com/mcp",
			headers: {
				Authorization: "Bearer stale-token",
				authorization: "Bearer also-stale",
				"X-Custom": "keep",
			},
			auth: staleAuth,
		};
		const cleaned = asHttpServerConfig(clearMcpClientAuthSurface(config));
		// Every casing of the bearer header is gone; unrelated headers survive.
		expect(Object.keys(cleaned.headers ?? {})).toEqual(["X-Custom"]);
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.url).toBe("https://mcp.example.com/mcp");
		// The input definition is not mutated in place.
		const original = asHttpServerConfig(config);
		expect(original.auth).toBe(staleAuth);
		expect(Object.keys(original.headers ?? {})).toContain("Authorization");
	});

	test("drops the auth block from stdio definitions without touching the rest", () => {
		const config: MCPServerConfig = {
			type: "stdio",
			command: "some-server",
			args: ["--stdio"],
			auth: staleAuth,
		};
		const cleaned = clearMcpClientAuthSurface(config);
		if (cleaned.type !== "stdio") throw new Error(`expected a stdio config, got ${cleaned.type}`);
		expect(cleaned.auth).toBeUndefined();
		expect(cleaned.command).toBe("some-server");
		expect(cleaned.args).toEqual(["--stdio"]);
	});
});

/** Minimal fake of the manager surface {@link reconnectMcpManagerServer} uses. */
class FakeReconnectManager {
	readonly configs = new Map<string, MCPServerConfig>();
	readonly updated: Array<{ name: string; config: MCPServerConfig }> = [];
	readonly reconnected: Array<{ name: string; manual?: boolean }> = [];
	readonly order: string[] = [];
	pending: Promise<unknown> | undefined;
	status: "connected" | "connecting" | "disconnected" = "connected";
	source: FoundMcpServer["source"];
	/** What the manual reconnect yields: a connection, or null when it failed. */
	outcome: object | null = {};

	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.configs.get(name);
	}
	getSource(_name: string): FoundMcpServer["source"] {
		return this.source;
	}
	updateServerConfig(name: string, config: MCPServerConfig): Promise<unknown> | undefined {
		this.order.push("update");
		this.updated.push({ name, config });
		this.configs.set(name, config);
		return this.pending;
	}
	async reconnectServer(name: string, options?: { manual?: boolean }): Promise<object | null> {
		this.reconnected.push({ name, manual: options?.manual });
		this.order.push("reconnect");
		return this.outcome;
	}
	getConnectionStatus(_name: string): "connected" | "connecting" | "disconnected" {
		return this.status;
	}
}

describe("reconnectMcpManagerServer", () => {
	test("awaits the superseded reconnect, then starts a fresh manual attempt and reports status", async () => {
		const manager = new FakeReconnectManager();
		// The manager entry carries the client's auth surface — the definition
		// a reauth of this server refreshes.
		manager.configs.set("client-server", {
			type: "http",
			url: "https://acp.example.com/mcp",
			headers: { Authorization: "Bearer client-token" },
			auth: staleAuth,
		});
		const release = Promise.withResolvers<void>();
		manager.pending = release.promise.then(() => {
			manager.order.push("pending-settled");
		});
		const selected = manager.configs.get("client-server")!;
		const committed = clearMcpClientAuthSurface(selected);

		const call = reconnectMcpManagerServer(
			manager as unknown as MCPManager,
			"client-server",
			selectedManagerConfig(selected),
			committed,
		);
		// The old automatic attempt is still settling: no reconnect started yet.
		expect(manager.reconnected).toEqual([]);
		release.resolve();
		expect(await call).toBe("connected");
		// The pending attempt settled before the manual one started.
		expect(manager.order).toEqual(["update", "pending-settled", "reconnect"]);
		expect(manager.reconnected).toEqual([{ name: "client-server", manual: true }]);
		// The installed definition has the client auth surface cleared.
		const installed = manager.updated[0]!.config;
		expect(asHttpServerConfig(installed).url).toBe("https://acp.example.com/mcp");
		expect(Object.keys(asHttpServerConfig(installed).headers ?? {})).toEqual([]);
		expect(installed.auth).toBeUndefined();
	});

	test("never reports a failed reconnect as connected, whatever the entry's status says", async () => {
		const manager = new FakeReconnectManager();
		manager.configs.set("client-server", { type: "http", url: "https://acp.example.com/mcp" });
		const selected: MCPServerConfig = { type: "http", url: "https://acp.example.com/mcp" };
		manager.outcome = null;

		expect(
			await reconnectMcpManagerServer(
				manager as unknown as MCPManager,
				"client-server",
				selectedManagerConfig(selected),
				selected,
			),
		).toBe("disconnected");
		manager.status = "connecting";
		expect(
			await reconnectMcpManagerServer(
				manager as unknown as MCPManager,
				"client-server",
				selectedManagerConfig(selected),
				selected,
			),
		).toBe("connecting");
	});

	test("refuses a manager entry that is not the reauthorized definition", async () => {
		const manager = new FakeReconnectManager();
		// ACP client declares `foo` at URL B while the reauthorized config-file
		// `foo` lives at URL A: reconnecting the manager entry would strip the
		// client bearer and reconnect an unrelated server.
		manager.configs.set("foo", {
			type: "http",
			url: "https://b.example.com/mcp",
			headers: { Authorization: "Bearer client-token" },
		});
		const selected: MCPServerConfig = { type: "http", url: "https://a.example.com/mcp" };

		expect(
			await reconnectMcpManagerServer(
				manager as unknown as MCPManager,
				"foo",
				selectedManagerConfig(selected),
				selected,
			),
		).toBeUndefined();
		expect(manager.updated).toEqual([]);
		expect(manager.reconnected).toEqual([]);
	});

	test("reconnects discovered env-expanded definitions with each committed credential", async () => {
		const authorizations: Array<string | null> = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const body = (await request.json()) as { id?: number; method?: string };
				if (body.id === undefined) return new Response(null, { status: 202 });
				const authorization = request.headers.get("authorization");
				authorizations.push(authorization);
				const marker =
					authorization === "Bearer initial-token"
						? "initial"
						: authorization === "Bearer first-token"
							? "first"
							: authorization === "Bearer second-token"
								? "second"
								: undefined;
				if (!marker) return new Response("unexpected credential", { status: 401 });
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "env-fixture", version: "0.0.0" },
							}
						: { tools: [{ name: marker, inputSchema: { type: "object" } }] };
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-env-reconnect-"));
		const manager = new MCPManager(root);
		const authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		manager.setAuthStorage(authStorage);
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(root, "agent"));
		const file = getMCPConfigPath("user", root);
		const initial: MCPServerConfig = {
			type: "http",
			url: "http://${MCP_HOST}/mcp",
			oauth: { clientId: "initial-client" },
			auth: { ...staleAuth, credentialId: "mcp_oauth:synthetic-initial" },
		};
		const originalBunHost = Bun.env.MCP_HOST;
		const originalProcessHost = process.env.MCP_HOST;
		Bun.env.MCP_HOST = `127.0.0.1:${server.port}`;
		process.env.MCP_HOST = `127.0.0.1:${server.port}`;
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await writeMCPConfigFile(file, { mcpServers: { envserver: initial } });
			for (const value of ["initial", "first", "second"]) {
				await authStorage.credentials.set(`mcp_oauth:synthetic-${value}`, {
					type: "oauth",
					access: `${value}-token`,
					refresh: "unused-refresh",
					expires: Date.now() + 600_000,
				});
			}
			await manager.discoverAndConnect({ enableProjectConfig: true, filterExa: false });
			expect(manager.getTools().map(tool => tool.name)).toContain("mcp__envserver_initial");
			for (const value of ["first", "second"]) {
				const selected = await findMcpServerForAuth("envserver", root, manager);
				if (!selected) throw new Error("discovered source disappeared");
				const committed = persistMcpOAuthResult(
					clearMcpClientAuthSurface(selected.config),
					{ credentialId: `mcp_oauth:synthetic-${value}`, clientId: `${value}-client` },
					{ tokenUrl: "https://auth.example.com/token" },
				);
				await updateMCPServer(file, "envserver", committed, { expectedConfig: selected.config });
				const before = authorizations.length;
				expect(await reconnectMcpManagerServer(manager, "envserver", selected, committed)).toBe("connected");
				expect(authorizations.slice(before)).toEqual([`Bearer ${value}-token`, `Bearer ${value}-token`]);
				expect(manager.getTools().map(tool => tool.name)).toEqual([`mcp__envserver_${value}`]);
			}
			expect(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.envserver.url).toBe(initial.url);
		} finally {
			await manager.disconnectAll();
			await authStorage.close();
			setAgentDir(previousAgentDir);
			await server.stop(true);
			await removeWithRetries(root);
			if (originalBunHost === undefined) delete Bun.env.MCP_HOST;
			else Bun.env.MCP_HOST = originalBunHost;
			if (originalProcessHost === undefined) delete process.env.MCP_HOST;
			else process.env.MCP_HOST = originalProcessHost;
		}
	});

	test("refuses another client at the same endpoint without clearing its bearer", async () => {
		const manager = new FakeReconnectManager();
		const replacement: MCPServerConfig = {
			type: "http",
			url: "https://same.example/mcp",
			oauth: { clientId: "replacement-client" },
			headers: { Authorization: "Bearer replacement" },
		};
		manager.configs.set("server", replacement);
		expect(
			await reconnectMcpManagerServer(
				manager as unknown as MCPManager,
				"server",
				selectedManagerConfig({ ...replacement, oauth: { clientId: "original-client" } }),
				replacement,
			),
		).toBeUndefined();
		expect(manager.getServerConfig("server")).toBe(replacement);
		expect(manager.reconnected).toEqual([]);
	});

	test("does not reconnect a definition replaced while an old attempt drains", async () => {
		const manager = new FakeReconnectManager();
		const selected: MCPServerConfig = { type: "http", url: "https://same.example/mcp" };
		manager.configs.set("server", selected);
		const pending = Promise.withResolvers<void>();
		manager.pending = pending.promise;
		const reconnect = reconnectMcpManagerServer(
			manager as unknown as MCPManager,
			"server",
			selectedManagerConfig(selected),
			selected,
		);
		const replacement: MCPServerConfig = { ...selected, oauth: { clientId: "new-account" } };
		manager.configs.set("server", replacement);
		pending.resolve();
		await expect(reconnect).rejects.toBeInstanceOf(MCPOAuthCancelledError);
		expect(manager.getServerConfig("server")).toBe(replacement);
		expect(manager.reconnected).toEqual([]);
	});

	test("does not reconnect after host cancellation while an old attempt drains", async () => {
		const manager = new FakeReconnectManager();
		const selected: MCPServerConfig = { type: "http", url: "https://same.example/mcp" };
		manager.configs.set("server", selected);
		const pending = Promise.withResolvers<void>();
		manager.pending = pending.promise;
		const abort = new AbortController();
		const reconnect = reconnectMcpManagerServer(
			manager as unknown as MCPManager,
			"server",
			selectedManagerConfig(selected),
			selected,
			{
				signal: abort.signal,
			},
		);
		abort.abort();
		pending.resolve();
		await expect(reconnect).rejects.toBeInstanceOf(MCPOAuthCancelledError);
		expect(manager.reconnected).toEqual([]);
	});

	test("does not bind an identical definition owned by another source", async () => {
		const manager = new FakeReconnectManager();
		const config: MCPServerConfig = { type: "http", url: "https://same.example/mcp" };
		manager.configs.set("server", config);
		manager.source = { provider: "acp", providerName: "ACP", path: "acp://original", level: "user" };
		const selected = {
			...selectedManagerConfig(config),
			source: { ...manager.source, provider: "omp", path: "/synthetic/project/mcp.json" },
		};
		expect(
			await reconnectMcpManagerServer(manager as unknown as MCPManager, "server", selected, config),
		).toBeUndefined();
		expect(manager.getServerConfig("server")).toBe(config);
		expect(manager.reconnected).toEqual([]);
	});

	test("terminates a freshly initialized remote session when its reconnect owner becomes invalid", async () => {
		const initializing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const terminated = Promise.withResolvers<string | null>();
		let ownsReconnect = true;
		let toolLists = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") {
					terminated.resolve(request.headers.get("Mcp-Session-Id"));
					return new Response(null, { status: 204 });
				}
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const body = (await request.json()) as { id?: number; method?: string };
				if (body.method === "initialize") {
					initializing.resolve();
					await release.promise;
					return Response.json(
						{
							jsonrpc: "2.0",
							id: body.id,
							result: {
								protocolVersion: "2025-03-26",
								capabilities: { tools: {} },
								serverInfo: { name: "fixture", version: "1" },
							},
						},
						{ headers: { "Mcp-Session-Id": "abandoned-session" } },
					);
				}
				if (body.method === "tools/list") {
					toolLists++;
					return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
				}
				return body.id === undefined
					? new Response(null, { status: 202 })
					: Response.json({
							jsonrpc: "2.0",
							id: body.id,
							error: { code: -32601, message: "Method not found" },
						});
			},
		});
		const manager = new MCPManager(os.tmpdir());
		manager.updateServerConfig("server", {
			type: "http",
			url: `http://127.0.0.1:${server.port}/mcp`,
			timeout: 1_000,
		});
		const reconnect = manager
			.reconnectServer("server", {
				manual: true,
				isCurrent: () => {
					if (!ownsReconnect) throw new MCPOAuthCancelledError();
					return true;
				},
			})
			.then(
				value => value,
				error => error,
			);
		try {
			await initializing.promise;
			ownsReconnect = false;
			release.resolve();
			expect(await reconnect).toBeInstanceOf(MCPOAuthCancelledError);
			expect(await terminated.promise).toBe("abandoned-session");
			expect(toolLists).toBe(0);
			expect(manager.getConnectedServers()).toEqual([]);
			expect(manager.getTools()).toEqual([]);
		} finally {
			release.resolve();
			await manager.disconnectAll();
			await server.stop(true);
		}
	});
});

describe("MCPManager.updateServerConfig", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("returns the in-flight reconnection so a fresh attempt can supersede it", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-manager-update-"));
		// Drive a real reconnect: the connect hangs until released, then fails;
		// the attempt aborts on the identity check once the definition is
		// replaced (no retry ladder is walked on that path).
		const connectCalls: Array<{ name: string; url: string | undefined }> = [];
		const blocker = Promise.withResolvers<never>();
		const reachedConnect = Promise.withResolvers<void>();
		vi.spyOn(mcpClient, "connectToServer").mockImplementation(((name: string, config: MCPServerConfig) => {
			connectCalls.push({ name, url: config.type === "http" || config.type === "sse" ? config.url : undefined });
			reachedConnect.resolve();
			return blocker.promise;
		}) as never);
		try {
			const manager = new MCPManager(cwd);
			const oldConfig: MCPServerConfig = {
				type: "http",
				url: "https://mcp.example.com/mcp",
				headers: { Authorization: "Bearer old-token" },
				auth: staleAuth,
			};
			const newConfig = clearMcpClientAuthSurface(oldConfig);
			expect(manager.updateServerConfig("envserver", oldConfig)).toBeUndefined();
			const inFlight = manager.reconnectServer("envserver");
			// The automatic attempt captured the old definition; the async
			// reconnect chain signals when it reaches connectToServer.
			await reachedConnect.promise;
			expect(connectCalls).toEqual([{ name: "envserver", url: "https://mcp.example.com/mcp" }]);
			// …so replacing it hands the caller the dying promise to await.
			const pending = manager.updateServerConfig("envserver", newConfig);
			expect(pending).toBeInstanceOf(Promise);

			blocker.reject(new Error("connect failed"));
			expect(await pending).toBeNull();
			expect(await inFlight).toBeNull();
			// The stored definition is the fresh one the next auth resolution reads.
			expect(manager.getServerConfig("envserver")).toBe(newConfig);
			expect(Object.keys(asHttpServerConfig(newConfig).headers ?? {})).toEqual([]);
		} finally {
			await removeWithRetries(cwd);
		}
	});
});

describe("MCP OAuth persistence and discovery boundaries", () => {
	test.each([false, true])(
		"never sends a supplied bearer on the anonymous initialization probe (tool challenge: %s)",
		async toolChallenge => {
			const requests: Array<{ path: string; method: string; authorization: string | null; custom: string | null }> =
				[];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					let method = request.method;
					if (method === "POST") {
						const body: unknown = await request.json();
						method =
							body && typeof body === "object" && "method" in body && typeof body.method === "string"
								? body.method
								: "";
					}
					requests.push({
						path: new URL(request.url).pathname,
						method,
						authorization: request.headers.get("authorization"),
						custom: request.headers.get("x-routing"),
					});
					return Response.json(
						{
							authorization_url: "https://auth.example/authorize",
							token_url: "https://auth.example/token",
						},
						{ status: 401 },
					);
				},
			});
			const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
			try {
				const endpoints = await resolveMcpOAuthEndpointsFromServer(
					{
						type: "http",
						url: `http://127.0.0.1:${server.port}/mcp`,
						auth: staleAuth,
						headers: { aUtHoRiZaTiOn: "Bearer must-not-leave", "X-Routing": "tenant-a" },
					},
					{
						authStorage: storage,
						sourceLevel: "user",
						authChallenge: toolChallenge ? { wwwAuthenticate: ['Bearer scope="read"'] } : undefined,
					},
				);
				expect(requests.find(request => request.path === "/mcp")).toMatchObject({
					authorization: null,
					custom: "tenant-a",
				});
				for (const request of requests) {
					expect(request.authorization).toBeNull();
					if (request.path === "/mcp") expect(request.custom).toBe("tenant-a");
				}
				expect(endpoints.tokenUrl).toBe("https://auth.example/token");
				expect(endpoints.authorizationUrl).toBe("https://auth.example/authorize");
				if (toolChallenge) expect(endpoints.scopes).toBe("read");
			} finally {
				await server.stop(true);
				await storage.close();
			}
		},
	);

	test("does not overwrite a source replaced while authorization was in progress", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reauth-config-"));
		const file = path.join(root, "mcp.json");
		const original: MCPServerConfig = {
			type: "http",
			url: "https://same.example/mcp",
			oauth: { clientId: "original" },
		};
		const replacement: MCPServerConfig = { ...original, oauth: { clientId: "replacement" } };
		try {
			await writeMCPConfigFile(file, { mcpServers: { server: replacement } });
			await expect(
				updateMCPServer(
					file,
					"server",
					{ ...original, auth: staleAuth },
					{
						expectedConfig: original,
					},
				),
			).rejects.toThrow("changed during authentication");
			expect(JSON.parse(await fs.readFile(file, "utf8")).mcpServers.server).toEqual(replacement);
		} finally {
			await removeWithRetries(root);
		}
	});

	test("refuses cancellation after write admission without publishing an auth binding", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reauth-cancel-config-"));
		const file = path.join(root, "mcp.json");
		const original: MCPServerConfig = { type: "http", url: "https://same.example/mcp" };
		const abort = new AbortController();
		try {
			await writeMCPConfigFile(file, { mcpServers: { server: original } });
			const previous = await fs.readFile(file, "utf8");
			const writing = updateMCPServer(
				file,
				"server",
				{ ...original, auth: staleAuth },
				{
					expectedConfig: original,
					assertCurrent: () => {
						if (abort.signal.aborted) throw new MCPOAuthCancelledError();
					},
				},
			);
			abort.abort();
			await expect(writing).rejects.toBeInstanceOf(MCPOAuthCancelledError);
			expect(await fs.readFile(file, "utf8")).toBe(previous);
		} finally {
			await removeWithRetries(root);
		}
	});
});
