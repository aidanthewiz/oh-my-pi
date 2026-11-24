/**
 * Regression test: MCP tool ownership must be tracked via `mcpServerName`,
 * not a `mcp__${serverName}_` tool-name prefix.
 *
 * Tool names are sanitized (server "atlassian:atlassian" mints
 * `mcp__atlassian_atlassian_*`), which breaks prefix matching two ways:
 *
 * 1. Collision: server "atlassian"'s prefix `mcp__atlassian_` also matches
 *    every `mcp__atlassian_atlassian_*` tool, so each reconnect/refresh of
 *    "atlassian" evicted the sibling server's tools and fired
 *    `onToolsChanged` with them missing — the session then steered paired
 *    unmount/mount notices into the conversation on every transport flap.
 * 2. Never-match: the raw prefix `mcp__atlassian:atlassian_` matches no
 *    sanitized tool name, so disconnecting "atlassian:atlassian" left its
 *    tools registered (and callable through a dead connection) and never
 *    notified consumers.
 *
 * Both server names here serve the identical fixture toolset, mirroring the
 * real-world duplicate-config shape (`<name>` plus imported `<source>:<name>`).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig, MCPStdioServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { MANY_TOOL_COUNT, manyToolName } from "./fixtures/many-tools-mcp";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "many-tools-mcp.ts");

const SHORT_SERVER = "atlassian";
const COLON_SERVER = "atlassian:atlassian";
/** Sanitized names minted by `createMCPToolName` for the first fixture tool. */
const SHORT_TOOL = `mcp__atlassian_${manyToolName(0)}`;
const COLON_TOOL = `mcp__atlassian_atlassian_${manyToolName(0)}`;

function fixtureConfig(): MCPStdioServerConfig {
	return { type: "stdio", command: process.execPath, args: [FIXTURE_PATH] };
}

/**
 * `connectServers` returns once its startup window (250 ms) closes, leaving a
 * slower handshake to register its tools in the background. A CPU-starved
 * runner routinely spawns the fixture past that window, so wait for both
 * servers' initial tools before exercising ownership.
 */
async function connectBoth(manager: MCPManager): Promise<void> {
	await manager.connectServers({ [SHORT_SERVER]: fixtureConfig(), [COLON_SERVER]: fixtureConfig() }, {});
	expect(await manager.waitForStartup(0)).toEqual({
		connected: [SHORT_SERVER, COLON_SERVER],
		pending: [],
		failed: [],
	});
}

describe("MCP tool ownership", () => {
	let workDir: string;
	let manager: MCPManager;
	const servers: Bun.Server<undefined>[] = [];

	function loopbackConfig(label: string, toolNames: string[], toolsGate?: Promise<void>) {
		const toolsRequested = Promise.withResolvers<void>();
		let nextInitialization: { gate: Promise<void>; started: () => void } | undefined;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const rpc = (await request.json()) as { id?: number | string; method: string };
				if (rpc.id === undefined) return new Response(null, { status: 202 });
				let result: unknown;
				if (rpc.method === "initialize") {
					const pending = nextInitialization;
					nextInitialization = undefined;
					pending?.started();
					await pending?.gate;
					result = {
						protocolVersion: "2025-11-25",
						serverInfo: { name: label, version: "1" },
						capabilities: { tools: {} },
					};
				} else if (rpc.method === "tools/list") {
					toolsRequested.resolve();
					await toolsGate;
					result = {
						tools: toolNames.map(name => ({
							name,
							inputSchema: { type: "object" },
							annotations: { readOnlyHint: true },
						})),
					};
				} else if (rpc.method === "tools/call") {
					result = {
						content: [{ type: "text", text: label }],
						structuredContent: { owner: label },
					};
				} else result = {};
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
			},
		});
		servers.push(server);
		const config: MCPHttpServerConfig = { type: "http", url: server.url.href };
		return {
			config,
			toolsRequested: toolsRequested.promise,
			holdNextInitialization(gate: Promise<void>): Promise<void> {
				const started = Promise.withResolvers<void>();
				nextInitialization = { gate, started: started.resolve };
				return started.promise;
			},
		};
	}

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-ownership-"));
		manager = new MCPManager(workDir);
	});

	afterEach(async () => {
		await manager.disconnectAll();
		removeSyncWithRetries(workDir);
		for (const server of servers.splice(0)) server.stop(true);
	});

	it("refreshing one server keeps the sibling server's tools registered", async () => {
		await connectBoth(manager);
		const names = () => manager.getTools().map(t => t.name);
		expect(names()).toContain(SHORT_TOOL);
		expect(names()).toContain(COLON_TOOL);
		expect(names()).toHaveLength(MANY_TOOL_COUNT * 2);

		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(t => t.name));
		});

		// Same code path a reconnect takes: replace the named server's tools.
		await manager.refreshServerTools(SHORT_SERVER);

		expect(names()).toHaveLength(MANY_TOOL_COUNT * 2);
		expect(names()).toContain(COLON_TOOL);
		// No emitted tool list may ever lose the sibling's tools — that delta is
		// what the session surfaces to the model as unmount/mount churn.
		expect(payloads.length).toBeGreaterThan(0);
		for (const payload of payloads) {
			expect(payload).toContain(COLON_TOOL);
			expect(payload).toHaveLength(MANY_TOOL_COUNT * 2);
		}
	}, 20_000);

	it("disconnecting a server with sanitized name characters removes exactly its tools", async () => {
		await connectBoth(manager);
		const payloads: string[][] = [];
		manager.setOnToolsChanged(tools => {
			payloads.push(tools.map(t => t.name));
		});

		await manager.disconnectServer(COLON_SERVER);

		const remaining = manager.getTools();
		expect(remaining.map(t => t.name)).toContain(SHORT_TOOL);
		expect(remaining).toHaveLength(MANY_TOOL_COUNT);
		expect(remaining.every(t => t.mcpServerName === SHORT_SERVER)).toBe(true);
		// Consumers must be told the tools are gone (previously: no event, and
		// the colon-named server's tools lingered as callable zombies).
		expect(payloads.at(-1)?.some(name => name === COLON_TOOL)).toBe(false);
		expect(payloads.at(-1)).toHaveLength(MANY_TOOL_COUNT);
	}, 20_000);

	it.each([
		["retained", false],
		["retained", true],
		["refreshed", true],
		["disconnected", false],
		["disconnected", true],
		["replaced", false],
	] as const)(
		"keeps only the %s owner when startup completes (exposeTools=%s)",
		async (ownership, exposeTools) => {
			const retained = ownership === "retained" || ownership === "refreshed";
			const gate = Promise.withResolvers<void>();
			const fastTools = ["read_state"];
			const fast = loopbackConfig("original", fastTools);
			const slow = loopbackConfig("slow", ["zulu", "alpha"], gate.promise);
			const fastConnected = Promise.withResolvers<void>();
			const catalogs: string[][] = [];
			manager.setOnToolsChanged(tools => {
				catalogs.push(tools.map(tool => tool.name));
			});
			const loading = manager.connectServers(
				{ fast: { ...fast.config, exposeTools }, slow: slow.config },
				{},
				event => {
					if (event.type === "connected" && event.serverName === "fast") fastConnected.resolve();
				},
				0,
			);
			try {
				await Promise.all([fastConnected.promise, slow.toolsRequested]);
				expect(manager.getTools().map(tool => tool.name)).toEqual(exposeTools ? ["mcp__fast_read_state"] : []);
				expect((await manager.callTool("fast", "read_state")).structuredContent).toMatchObject({
					owner: "original",
				});

				if (!retained) await manager.disconnectServer("fast");
				if (ownership === "refreshed") {
					fastTools.splice(0, fastTools.length, "current_state");
					await manager.refreshServerTools("fast");
					expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__fast_current_state"]);
				}
				if (ownership === "replaced") {
					const current = loopbackConfig("current", ["current_state"]);
					await manager.connectServers({ fast: current.config }, {}, undefined, 0);
				}
				const catalogsBeforeCompletion = catalogs.length;
				gate.resolve();
				const result = await loading;
				await manager.waitForStartup(0);

				const expected = ["mcp__slow_alpha", "mcp__slow_zulu"];
				if (ownership === "retained" && exposeTools) expected.unshift("mcp__fast_read_state");
				if (ownership === "replaced" || ownership === "refreshed") expected.unshift("mcp__fast_current_state");
				expect(result.tools.map(tool => tool.name)).toEqual(expected);
				expect(manager.getTools().map(tool => tool.name)).toEqual(expected);
				for (const catalog of catalogs.slice(catalogsBeforeCompletion)) expect(catalog).toEqual(expected);
				expect(result.connectedServers).toEqual(retained ? ["fast", "slow"] : ["slow"]);

				if (ownership === "disconnected") {
					expect(manager.getConnectionStatus("fast")).toBe("disconnected");
					expect(manager.getServerConfig("fast")).toBeUndefined();
					await expect(manager.callTool("fast", "read_state")).rejects.toThrow("not enabled");
				} else {
					const toolName = ownership === "replaced" || ownership === "refreshed" ? "current_state" : "read_state";
					const result = await manager.callTool("fast", toolName);
					expect(result.structuredContent).toMatchObject({
						owner: ownership === "replaced" ? "current" : "original",
					});
					if (ownership === "replaced" || ownership === "refreshed") {
						await expect(manager.callTool("fast", "read_state")).rejects.toThrow("not found");
					}
				}
			} finally {
				gate.resolve();
				await loading;
			}
		},
		10_000,
	);

	it("does not let a disconnected reconnect replace a new owner that reuses the same config", async () => {
		const fixture = loopbackConfig("retained", ["read_state"]);
		const config = { ...fixture.config, exposeTools: false };
		await manager.connectServers({ fast: config }, {}, undefined, 0);
		const gate = Promise.withResolvers<void>();
		const reconnectStarted = fixture.holdNextInitialization(gate.promise);
		const reconnecting = manager.reconnectServer("fast", { manual: true });
		try {
			await reconnectStarted;
			await manager.disconnectServer("fast");
			const replacement = await manager.connectServers({ fast: config }, {}, undefined, 0);
			const current = manager.getConnection("fast");
			gate.resolve();

			expect(await reconnecting).toBeNull();
			expect(manager.getConnection("fast")).toBe(current);
			expect(replacement.tools).toEqual([]);
			expect(manager.getTools()).toEqual([]);
			expect((await manager.callTool("fast", "read_state")).structuredContent).toMatchObject({ owner: "retained" });
		} finally {
			gate.resolve();
			await reconnecting;
		}
	}, 10_000);

	it("does not report a disconnected startup owner after its catalog callback resumes", async () => {
		const fixture = loopbackConfig("original", ["read_state"]);
		const callbackEntered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const statuses: string[] = [];
		manager.setOnToolsChanged(async () => {
			callbackEntered.resolve();
			await gate.promise;
		});
		const loading = manager.connectServers(
			{ fast: { ...fixture.config, exposeTools: false } },
			{},
			event => statuses.push(event.type),
			0,
		);
		try {
			await callbackEntered.promise;
			const drained = manager.waitForStartup(0);
			await manager.disconnectServer("fast");
			gate.resolve();
			await Promise.all([loading, drained]);

			expect(statuses).toEqual(["connecting"]);
			expect(manager.getConnectionStatus("fast")).toBe("disconnected");
			expect(manager.getTools()).toEqual([]);
		} finally {
			gate.resolve();
			await loading;
		}
	}, 10_000);
});
