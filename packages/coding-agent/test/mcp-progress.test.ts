import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { StdioUpstream } from "@oh-my-pi/pi-coding-agent/mcp/host/stdio-upstream";
import type { MCPToolCallResult } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { withTimeout } from "@oh-my-pi/pi-utils";
import { realDeps, stdioSpec } from "./mcp-host/upstream-support";

interface ProgressResult extends MCPToolCallResult {
	structuredContent: {
		requestId: string | number;
		_meta?: Record<string, unknown>;
		arguments: Record<string, unknown>;
	};
}

const transports: StdioUpstream[] = [];
afterEach(async () => {
	await Promise.all(transports.splice(0).map(transport => transport.close()));
});

async function connectReady(transport: StdioUpstream): Promise<void> {
	const ready = Promise.withResolvers<void>();
	transport.onNotification = method => {
		if (method === "notifications/progress-fixture-ready") ready.resolve();
	};
	transport.onClose = () => ready.reject(new Error("Progress fixture closed before readiness"));
	transport.onError = error => ready.reject(error);
	try {
		await Promise.all([transport.connect(realDeps().spawn), ready.promise]);
	} finally {
		transport.onNotification = undefined;
		transport.onClose = undefined;
		transport.onError = undefined;
	}
}

async function connect(requestIdFormat?: "string"): Promise<StdioUpstream> {
	const transport = new StdioUpstream({
		...stdioSpec(path.join(import.meta.dir, "fixtures/progress-mcp.ts")),
		requestIdFormat,
	});
	transports.push(transport);
	await connectReady(transport);
	return transport;
}

function params(args: Record<string, unknown> = {}) {
	return { name: "progress_tool", arguments: args };
}

describe("MCP stdio request progress", () => {
	it("uses the request id as token without mutating metadata or tool arguments", async () => {
		const transport = await connect();
		const args = Object.freeze({ steps: 2, delayMs: 1, _meta: { toolOwned: true } });
		const meta = Object.freeze({ trace: "keep", progressToken: "replace" });
		const request = Object.freeze({ ...params(args), _meta: meta });
		const updates: MCPProgress[] = [];
		const result = await transport.request<ProgressResult>("tools/call", request, {
			onProgress: progress => updates.push(progress),
		});

		expect(result.structuredContent?._meta).toEqual({
			trace: "keep",
			progressToken: result.structuredContent?.requestId,
		});
		expect(result.structuredContent?.arguments).toEqual(args);
		expect(meta).toEqual({ trace: "keep", progressToken: "replace" });
		expect(updates).toEqual([{ progress: 1 }, { progress: 2 }]);
	});

	it("keeps string ids as strings and replaces non-record metadata", async () => {
		const transport = await connect("string");
		const result = await transport.request<ProgressResult>(
			"tools/call",
			{ ...params({ steps: 1 }), _meta: ["not metadata"] },
			{ onProgress: () => {} },
		);
		const id = result.structuredContent?.requestId;
		expect(typeof id).toBe("string");
		expect(result.structuredContent?._meta).toEqual({ progressToken: id });
	});

	it("leaves requests without a callback free of added metadata", async () => {
		const transport = await connect();
		const result = await transport.request<ProgressResult>("tools/call", params({ steps: 0 }));
		expect(result.structuredContent).not.toHaveProperty("_meta");
		const withMeta = await transport.request<ProgressResult>("tools/call", {
			...params({ steps: 0 }),
			_meta: { trace: "untouched" },
		});
		expect(withMeta.structuredContent?._meta).toEqual({ trace: "untouched" });
	});

	it("isolates concurrent calls and still fans out matched, unknown, malformed, and late notifications", async () => {
		const transport = await connect();
		const done = Promise.withResolvers<void>();
		const notifications: unknown[] = [];
		transport.onNotification = (method, value) => {
			if (method === "notifications/progress") notifications.push(value);
			if (method === "notifications/progress-fixture-done" && notifications.length >= 9) done.resolve();
		};
		const first: MCPProgress[] = [];
		const second: MCPProgress[] = [];
		await Promise.all([
			transport.request(
				"tools/call",
				params({
					steps: [
						{ progress: 1, message: "first" },
						{ progress: 2, message: "first" },
					],
					delayMs: 1,
					includeUnknown: true,
					includeMalformed: true,
					includeLate: true,
				}),
				{ onProgress: progress => first.push(progress) },
			),
			transport.request(
				"tools/call",
				params({
					steps: [
						{ progress: 4, message: "second" },
						{ progress: 5, message: "second" },
						{ progress: 6, message: "second" },
					],
					delayMs: 1,
				}),
				{ onProgress: progress => second.push(progress) },
			),
		]);
		await withTimeout(done.promise, 300, "fixture notifications were not forwarded");

		expect(first).toEqual([
			{ progress: 1, message: "first" },
			{ progress: 2, message: "first" },
		]);
		expect(second).toEqual([
			{ progress: 4, message: "second" },
			{ progress: 5, message: "second" },
			{ progress: 6, message: "second" },
		]);
		expect(notifications).toHaveLength(9);
		expect(notifications).toContainEqual(expect.objectContaining({ progress: 1000 }));
		expect(notifications).toContainEqual(expect.objectContaining({ progress: "invalid" }));
	});

	it("drops invalid optional fields but preserves zero, negative, and fractional progress", async () => {
		const transport = await connect();
		const updates: MCPProgress[] = [];
		await transport.request(
			"tools/call",
			params({
				steps: [
					{ progress: 0, total: 0, message: "" },
					{ progress: -0.5, total: "bad", message: 4 },
					{ progress: null },
				],
			}),
			{ onProgress: progress => updates.push(progress) },
		);
		expect(updates).toEqual([{ progress: 0, total: 0, message: "" }, { progress: -0.5 }]);
	});

	it("contains callback exceptions without failing its request or a sibling", async () => {
		const transport = await connect();
		let calls = 0;
		const sibling: MCPProgress[] = [];
		const results = await Promise.all([
			transport.request("tools/call", params({ steps: 2 }), {
				onProgress: () => {
					calls++;
					throw new Error("consumer failed");
				},
			}),
			transport.request("tools/call", params({ steps: 2 }), { onProgress: progress => sibling.push(progress) }),
		]);
		expect(results).toHaveLength(2);
		expect(calls).toBe(2);
		expect(sibling).toEqual([{ progress: 1 }, { progress: 2 }]);
	});
});
