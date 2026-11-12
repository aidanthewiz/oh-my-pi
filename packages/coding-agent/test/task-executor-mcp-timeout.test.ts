import { expect, test, vi } from "bun:test";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { MCPManager } from "../src/mcp/manager";
import { MCPTool } from "../src/mcp/tool-bridge";
import { HttpTransport } from "../src/mcp/transports/http";
import type { MCPServerConnection, MCPToolDefinition } from "../src/mcp/types";
import { createMCPProxyTools } from "../src/task/executor";
import { ToolAbortError } from "../src/tools/tool-errors";

const TOOL_DEFINITION: MCPToolDefinition = {
	name: "test_tool",
	description: "A test tool",
	inputSchema: { type: "object", properties: {} },
};

/** Register a real MCPTool bound to `connection` as the sole source tool. */
function mockSourceTool(manager: MCPManager, connection: MCPServerConnection): void {
	vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(connection, TOOL_DEFINITION)]);
}

test("MCP proxy tool aborts underlying operation on caller abort", async () => {
	const arrived = Promise.withResolvers<void>();
	const disconnected = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { id } = (await request.json()) as { id: number };
			request.signal.addEventListener("abort", () => disconnected.resolve(), { once: true });
			arrived.resolve();
			await release.promise;
			return Response.json({ jsonrpc: "2.0", id, result: { content: [] } });
		},
	});
	const config = { type: "http" as const, url: `http://127.0.0.1:${server.port}/mcp`, timeout: 5_000 };
	const transport = new HttpTransport(config);
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, {
		name: "test-server",
		config,
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	});
	try {
		await transport.connect();
		const [proxy] = createMCPProxyTools(manager, "child");
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		const caller = new AbortController();
		const pending = proxy.execute("call_1", {}, undefined, {} as CustomToolContext, caller.signal);
		void pending.catch(() => undefined);
		await arrived.promise;
		caller.abort();
		await expect(pending).rejects.toBeInstanceOf(ToolAbortError);
		await disconnected.promise;
	} finally {
		release.resolve();
		await transport.close();
		server.stop(true);
		vi.restoreAllMocks();
	}
});

test.each([180_000, 0])("MCP proxy honors a transport deadline of %i beyond 60s", async timeout => {
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			const { id } = (await request.json()) as { id: number };
			arrived.resolve();
			await release.promise;
			return Response.json({
				jsonrpc: "2.0",
				id,
				result: {
					content: [{ type: "text", text: "Queued report completed" }],
				},
			});
		},
	});
	const config = { type: "http" as const, url: `http://127.0.0.1:${server.port}/mcp`, timeout };
	const transport = new HttpTransport(config);
	const manager = new MCPManager(process.cwd());
	mockSourceTool(manager, {
		name: "test-server",
		config,
		transport,
		serverInfo: { name: "test", version: "1" },
		capabilities: {},
	});
	try {
		await transport.connect();
		const [proxy] = createMCPProxyTools(manager, "child");
		if (!proxy?.execute) throw new Error("Tool execute method missing");
		vi.useFakeTimers();
		const resultPromise = proxy.execute("queued-report", {}, undefined, {} as CustomToolContext);
		await arrived.promise;
		// Advance the actual proxy/transport timers while the socket is held open.
		// The former independent 60s watchdog discarded this server's answer.
		vi.advanceTimersByTime(61_000);
		release.resolve();
		const result = await resultPromise;
		expect(result.content).toEqual([{ type: "text", text: "Queued report completed" }]);
		expect(result.isError).not.toBe(true);
	} finally {
		vi.useRealTimers();
		release.resolve();
		await transport.close();
		server.stop(true);
		vi.restoreAllMocks();
	}
});
