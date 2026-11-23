/**
 * A remote (`http`/`sse`) MCP server that was connected and then lost comes
 * back on its own schedule — a redeploy, a laptop waking. The session keeps its
 * link to the MCP host through the outage, and the host reaches the server
 * again on the next request.
 *
 * Contracts defended here:
 * - a tool call on a lost server fails promptly with a diagnostic instead of
 *   waiting for the server to return;
 * - once the server is back, the next tool call reaches it with no reconnect
 *   command and no user action, on a new server session;
 * - a reconnect that never replaced the live connection (a declined auth
 *   challenge) leaves a working server connected and usable.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { disposeLocalMcpHost } from "@oh-my-pi/pi-coding-agent/mcp/host/local";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import type { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { type FlakyHttpMcpServer, startFlakyHttpMcpServer } from "./fixtures/flaky-http-mcp";

const GUARD_MS = 5_000;
const QUIET_MS = 320;
const noop = () => {};
const noCtx = {} as Parameters<MCPTool["execute"]>[3];

describe("MCP lost remote server", () => {
	let workDir: string;
	let manager: MCPManager | undefined;
	let flaky: FlakyHttpMcpServer | undefined;

	afterEach(async () => {
		await manager?.disconnectAll();
		flaky?.stop();
		manager = undefined;
		flaky = undefined;
		await disposeLocalMcpHost();
		if (workDir) removeSyncWithRetries(workDir);
	});

	async function connected() {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lost-remote-"));
		flaky = startFlakyHttpMcpServer();
		manager = new MCPManager(workDir);
		const statuses: McpConnectionStatusEvent["type"][] = [];
		manager.addConnectionStatusListener(event => statuses.push(event.type));
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: GUARD_MS };
		await manager.connectServers({ flaky: config }, {});
		// connectServers returns after a short non-blocking window; a loaded machine can leave the
		// server connected with `tools/list` still in flight. Settle startup before reading tools.
		expect((await manager.waitForStartup(0)).connected).toEqual(["flaky"]);
		const ping = manager.getTools().find(tool => tool.mcpServerName === "flaky");
		if (!ping) throw new Error("ping tool not registered");
		return { manager, flaky, statuses, ping };
	}

	it("fails a tool call on a lost server promptly, then reaches the returned server on the next call", async () => {
		const { flaky, ping } = await connected();
		const before = await ping.execute("call-1", {}, noop, noCtx);
		expect(before.content[0]).toEqual({ type: "text", text: flaky.pong });
		const initializesBefore = flaky.initializes;

		flaky.setDown(true);
		const started = Date.now();
		const lost = await ping.execute("call-2", {}, noop, noCtx);

		expect(lost.isError).toBe(true);
		expect(lost.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("HTTP 503") });
		expect(Date.now() - started).toBeLessThan(GUARD_MS / 2);

		flaky.setDown(false);
		const back = await ping.execute("call-3", {}, noop, noCtx);

		expect(back.isError).toBeFalsy();
		// The redeployed server is a new generation, reached through a new session.
		expect(back.content[0]).toEqual({ type: "text", text: flaky.pong });
		expect(back.content[0]).not.toEqual(before.content[0]);
		expect(flaky.initializes).toBeGreaterThan(initializesBefore);
	});

	it("a declined auth challenge on a working server leaves it connected and usable", async () => {
		const { manager, flaky, statuses, ping } = await connected();
		const initializesBefore = flaky.initializes;
		manager.setAuthHandler(async () => undefined);

		expect(await manager.reconnectServer("flaky", { authChallenge: { wwwAuthenticate: ["Bearer"] } })).toBeNull();

		expect(manager.getConnectionStatus("flaky")).toBe("connected");
		expect(statuses.filter(status => status === "connected")).toHaveLength(1);
		const result = await ping.execute("call-1", {}, noop, noCtx);
		expect(result.content[0]).toEqual({ type: "text", text: flaky.pong });
		expect(flaky.initializes).toBe(initializesBefore);
	});

	it("does not retry an interactive auth refusal without another request", async () => {
		const { manager, flaky, ping } = await connected();
		flaky.setUnauthorized(true);
		const result = await ping.execute("auth-refused", {}, noop, noCtx);
		expect(result.isError).toBe(true);
		await Bun.sleep(QUIET_MS);
		expect(flaky.authRefusals).toBe(1);
	});

	it("stops retries on a formerly healthy server's permission denial and permits manual repair", async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-permission-denied-"));
		let forbidden = false;
		let denials = 0;
		const initializes = new Map<string, number>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") return new Response(null, { status: 202 });
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const pathname = new URL(request.url).pathname;
				if (pathname === "/restricted" && forbidden) {
					denials += 1;
					return new Response("tenant permission denied", {
						status: 403,
						headers: { "WWW-Authenticate": 'Bearer realm="tenant-permission"' },
					});
				}
				const body = (await request.json()) as { id?: number; method?: string };
				if (body.id === undefined) return new Response(null, { status: 202 });
				let result: unknown;
				if (body.method === "initialize") {
					initializes.set(pathname, (initializes.get(pathname) ?? 0) + 1);
					result = {
						protocolVersion: "2025-03-26",
						capabilities: { tools: {} },
						serverInfo: { name: pathname, version: "1" },
					};
				} else if (body.method === "tools/list") {
					result = { tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }] };
				} else if (body.method === "tools/call") {
					result = { content: [{ type: "text", text: `available ${pathname}` }] };
				} else {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32601, message: "Method not found" },
					});
				}
				return Response.json({ jsonrpc: "2.0", id: body.id, result });
			},
		});
		manager = new MCPManager(workDir);
		const authorize = vi.fn(async () => undefined);
		manager.setAuthHandler(authorize);
		try {
			await manager.connectServers(
				{
					restricted: { type: "http", url: `${server.url}restricted`, oauth: { clientId: "test-client" } },
					healthy: { type: "http", url: `${server.url}healthy` },
				},
				{},
				undefined,
				0,
			);
			await manager.waitForStartup(0);
			expect(manager.getConnectionStatus("restricted")).toBe("connected");
			const healthyConnection = manager.getConnection("healthy");
			const restrictedConnection = manager.getConnection("restricted");
			const healthyInitializes = initializes.get("/healthy");
			const restrictedInitializes = initializes.get("/restricted");
			forbidden = true;

			await expect(manager.callTool("restricted", "ping")).rejects.toMatchObject({
				failure: "http_status",
				code: 403,
			});
			// Fake timers cannot drive real fetch I/O; wait beyond every retry deadline to prove the schedule stopped.
			await Bun.sleep(QUIET_MS);

			expect(denials).toBe(1);
			expect(manager.getConnection("restricted")).toBe(restrictedConnection);
			expect(manager.getPendingAuthServers()).toEqual([]);
			expect(authorize).not.toHaveBeenCalled();
			expect(manager.getConnection("healthy")).toBe(healthyConnection);
			expect((await manager.callTool("healthy", "ping")).content).toEqual([
				{ type: "text", text: "available /healthy" },
			]);

			forbidden = false;
			await Bun.sleep(QUIET_MS);
			expect(denials).toBe(1);
			expect(initializes.get("/restricted")).toBe(restrictedInitializes);
			expect(await manager.reconnectServer("restricted", { manual: true })).not.toBeNull();
			expect((await manager.callTool("restricted", "ping")).content).toEqual([
				{ type: "text", text: "available /restricted" },
			]);
			expect(initializes.get("/healthy")).toBe(healthyInitializes);
			expect(authorize).not.toHaveBeenCalled();
		} finally {
			await manager.disconnectAll();
			server.stop(true);
		}
	});

	it("does not schedule a server that never connected", async () => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-lost-remote-"));
		flaky = startFlakyHttpMcpServer();
		flaky.setDown(true);
		manager = new MCPManager(workDir);
		const config: MCPHttpServerConfig = { type: "http", url: flaky.url, timeout: GUARD_MS };
		await manager.connectServers({ flaky: config }, {});
		expect((await manager.waitForStartup(0)).failed.map(failure => failure.name)).toEqual(["flaky"]);
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");

		// The explicit paths that reach the ladder for a never-connected server.
		expect(await manager.reconnectServer("flaky")).toBeNull();
		expect(await manager.reconnectServer("flaky", { manual: true })).toBeNull();

		flaky.setDown(false);
		await Bun.sleep(QUIET_MS); // negative contract, see above

		expect(flaky.initializes).toBe(0);
		expect(manager.getConnectionStatus("flaky")).toBe("disconnected");
	});
});
