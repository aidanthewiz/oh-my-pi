import { expect, test, vi } from "bun:test";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { HostLink } from "@oh-my-pi/pi-coding-agent/mcp/link";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMCPProxyTools } from "@oh-my-pi/pi-coding-agent/task/executor";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { FakeHost, REMOTE_SPEC } from "./mcp-host/link-fake-host";
import { connectToServer, disconnectServer } from "../src/mcp";

const TOOL_DEFINITION: MCPToolDefinition = {
	name: "test_tool",
	description: "A test tool",
	inputSchema: { type: "object", properties: {} },
};

/** Register a real MCPTool bound to `connection` as the sole source tool. */
function mockSourceTool(manager: MCPManager, connection: MCPServerConnection): void {
	vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(connection, TOOL_DEFINITION)]);
}

test("MCP proxy tool cancels the hosted HTTP operation on caller abort", async () => {
	const arrived = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let activeRequest: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (request.method !== "POST") return new Response(null, { status: 405 });
			const message = (await request.json()) as { id?: unknown; method?: string; params?: { requestId?: unknown } };
			if (message.method === "notifications/cancelled" && message.params?.requestId === activeRequest) {
				cancelled.resolve();
			}
			if (message.id === undefined) return new Response(null, { status: 202 });
			if (message.method === "initialize")
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2024-11-05",
						capabilities: { tools: {} },
						serverInfo: { name: "fixture", version: "1" },
					},
				});
			if (message.method === "tools/list")
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					result: { tools: [TOOL_DEFINITION] },
				});
			if (message.method !== "tools/call")
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					error: { code: -32601, message: "Method not found" },
				});
			activeRequest = message.id;
			request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			arrived.resolve();
			await release.promise;
			return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [] } });
		},
	});
	let connection: MCPServerConnection | undefined;
	try {
		connection = await connectToServer(
			"test-server",
			{
				type: "http",
				url: `http://127.0.0.1:${server.port}/mcp`,
				timeout: 5_000,
			},
			{ idleMs: 0 },
		);
		const manager = new MCPManager(process.cwd());
		mockSourceTool(manager, connection);
		const [proxy] = createMCPProxyTools(manager, "child");
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		const caller = new AbortController();
		const pending = proxy.execute("call_1", {}, undefined, {} as CustomToolContext, caller.signal);
		void pending.catch(() => undefined);
		await arrived.promise;
		caller.abort();
		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
		await cancelled.promise;
	} finally {
		release.resolve();
		if (connection) await disconnectServer(connection);
		server.stop(true);
		vi.restoreAllMocks();
	}
});

test.each([180_000, 0])("MCP proxy honors a link deadline of %i beyond 60s", async timeout => {
	// The link owns the deadline; an environment override would replace both rows' values.
	const savedTimeout = Bun.env.OMP_MCP_TIMEOUT_MS;
	delete Bun.env.OMP_MCP_TIMEOUT_MS;
	const host = new FakeHost();
	const link = new HostLink({
		name: "test-server",
		spec: REMOTE_SPEC,
		instance: "manager-1",
		roots: () => [],
		idleMs: 1_000,
		timeout,
		access: host,
	});
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, {
		name: "test-server",
		config: { type: "http", url: REMOTE_SPEC.url, timeout },
		transport: link,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	});
	try {
		await link.connect();
		const [proxy] = createMCPProxyTools(manager, "child");
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		vi.useFakeTimers();
		const resultPromise = proxy.execute("queued-report", {}, undefined, {} as CustomToolContext);
		const call = await host.tunnel.next("tools/call");
		// Advance the proxy's and the link's timers while the host holds the call.
		// The former independent 60s watchdog discarded this server's answer.
		vi.advanceTimersByTime(61_000);
		host.tunnel.push({
			id: call.id,
			result: { resultType: "complete", content: [{ type: "text", text: "Queued report completed" }] },
		});
		const result = await resultPromise;
		expect(result.content).toEqual([{ type: "text", text: "Queued report completed" }]);
		expect(result.isError).not.toBe(true);
	} finally {
		vi.useRealTimers();
		await link.close();
		vi.restoreAllMocks();
		if (savedTimeout === undefined) delete Bun.env.OMP_MCP_TIMEOUT_MS;
		else Bun.env.OMP_MCP_TIMEOUT_MS = savedTimeout;
	}
});
