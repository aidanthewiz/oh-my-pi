#!/usr/bin/env bun
/**
 * Local-only MCP timing fixture. It never reads credentials or performs I/O
 * beyond its journal file and stdio transport.
 */
import * as fs from "node:fs/promises";
import * as readline from "node:readline";

export const FAKE_AWS_TOOL_NAME = "get_caller_identity";
export const FAKE_AWS_TOOL_RESULT = "FAKE_AWS_AUTHENTICATED_CALL_COMPLETED";
export const STARTUP_DELAY_MS = 450;

type FixtureMode = "delayed" | "fail";

type JsonRpcRequest = {
	jsonrpc: "2.0";
	id?: string | number;
	method: string;
};

const [mode, journalPath] = process.argv.slice(2) as [FixtureMode | undefined, string | undefined];

async function record(name: string): Promise<void> {
	if (!journalPath) return;
	await fs.appendFile(journalPath, `${JSON.stringify({ name, at: Date.now() })}\n`);
}

function resultFor(method: string): Record<string, unknown> {
	switch (method) {
		case "initialize":
			return {
				protocolVersion: "2025-11-25",
				serverInfo: { name: "delayed-failing-aws-fixture", version: "1.0.0" },
				capabilities: { tools: {} },
			};
		case "tools/list":
			return {
				tools: [
					{
						name: FAKE_AWS_TOOL_NAME,
						description: "Completes a credential-free local fake AWS authentication call.",
						inputSchema: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			};
		case "tools/call":
			return { content: [{ type: "text", text: FAKE_AWS_TOOL_RESULT }], isError: false };
		default:
			return {};
	}
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
	if (request.id === undefined || request.id === null) return;

	if (request.method === "initialize") {
		await record("initialize_received");
		// This subprocess deliberately uses wall-clock latency so the parent can
		// observe a real stdio startup race; fake timers cannot control child I/O.
		await Bun.sleep(STARTUP_DELAY_MS);
		if (mode === "fail") {
			await record("initialize_failed");
			process.stdout.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: request.id,
					error: { code: -32000, message: "intentional delayed MCP startup failure" },
				})}\n`,
			);
			return;
		}
	}

	if (request.method === "tools/call") {
		await record("fake_aws_auth_started");
		// Preserve distinct fake-auth start and completion timestamps without
		// touching credentials, a network, or a browser.
		await Bun.sleep(5);
		await record("fake_aws_auth_completed");
	}

	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: resultFor(request.method) })}\n`);
}

async function start(): Promise<void> {
	if ((mode !== "delayed" && mode !== "fail") || !journalPath) {
		throw new Error("Usage: delayed-failing-aws-mcp.ts <delayed|fail> <journal-path>");
	}
	await record("process_started");
	const input = readline.createInterface({ input: process.stdin });
	input.on("line", line => {
		let request: JsonRpcRequest;
		try {
			request = JSON.parse(line) as JsonRpcRequest;
		} catch {
			return;
		}
		void handleRequest(request);
	});
	input.on("close", () => process.exit(0));
}

if (import.meta.main) void start();
