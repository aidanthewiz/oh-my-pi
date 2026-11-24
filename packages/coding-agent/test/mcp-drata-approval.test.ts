import { describe, expect, test } from "bun:test";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { resolveApproval, sessionApprovalScope } from "@oh-my-pi/pi-coding-agent/tools/approval";

const serverName = "coreforge-drata-mcp";
const definition: MCPToolDefinition = {
	name: "update_control",
	inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
	annotations: { readOnlyHint: true },
};

function liveTool(name = serverName): MCPTool {
	return new MCPTool({ name } as MCPServerConnection, definition);
}

describe("managed Drata approval", () => {
	test("requires confirmation despite a read-only annotation, yolo mode, or an exact allow policy", () => {
		const tool = liveTool();
		expect(resolveApproval(tool, { id: 42 }, "yolo", { [tool.name]: "allow" })).toMatchObject({
			policy: "prompt",
			tier: "write",
		});
		expect(resolveApproval(tool, { id: 42 }, "yolo", { [tool.name]: "deny" }).policy).toBe("deny");
	});

	test("requires confirmation without inspecting the connection", () => {
		let connections = 0;
		const tool = new MCPTool(
			{
				name: serverName,
				transport: {
					get connected() {
						connections++;
						throw new Error("Approval must not inspect the connection");
					},
				},
			} as unknown as MCPServerConnection,
			{ ...definition, annotations: undefined },
		);
		expect(resolveApproval(tool, { id: 42 }, "always-ask-cached").policy).toBe("prompt");
		expect(resolveApproval(tool, { id: 42 }, "yolo").policy).toBe("prompt");
		expect(connections).toBe(0);
	});

	test("requires per-call consent for unknown tools despite cached grants and an exact allow policy", () => {
		const tool = new MCPTool({ name: serverName } as MCPServerConnection, {
			...definition,
			name: "future_operation_17",
		});
		const resolved = resolveApproval(
			tool,
			{ id: 42 },
			"always-ask-cached",
			{ [tool.name]: "allow" },
			{ present: keys => new Set(keys) },
		);
		expect(resolved.policy).toBe("prompt");
		expect(sessionApprovalScope(resolved, tool.name)).toBeUndefined();
	});

	test("does not change approval for a different server with the same tool name", () => {
		const tool = liveTool("another-server");
		expect(resolveApproval(tool, { id: 42 }, "yolo").policy).toBe("allow");
	});
});
