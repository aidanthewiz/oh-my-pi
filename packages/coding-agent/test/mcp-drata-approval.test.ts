import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { MCPTool, DeferredMCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveApproval, sessionApprovalScope } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { Settings } from "../src/config/settings";

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

	test("keeps a cached catalog behind confirmation before connecting", () => {
		let connections = 0;
		const tool = new DeferredMCPTool(serverName, { ...definition, annotations: undefined }, async () => {
			connections++;
			throw new Error("No connection is needed to resolve approval");
		});
		expect(resolveApproval(tool, { id: 42 }, "always-ask-cached").policy).toBe("prompt");
		expect(resolveApproval(tool, { id: 42 }, "yolo").policy).toBe("prompt");
		expect(connections).toBe(0);
	});

	test("requires per-call consent for unknown tools despite cached grants and an exact allow policy", () => {
		const tool = new DeferredMCPTool(serverName, { ...definition, name: "future_operation_17" }, async () => {
			throw new Error("Approval must not connect");
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

	test("preserves the Drata policy through virtual-device write routing", () => {
		const tool = liveTool();
		const state: XdevState = {
			tools: new Map([[tool.name, tool as unknown as AgentTool]]),
			mountedNames: new Set([tool.name]),
			builtInNames: new Set(),
			isActive: () => false,
			resolve: name => resolveXdevTool(state, name),
		};
		const write = new WriteTool({ cwd: ".", settings: Settings.isolated({}), xdev: state } as ToolSession);
		const args = { path: `xd://${tool.name}`, content: JSON.stringify({ id: 42 }) };
		expect(resolveApproval(write, args, "yolo").policy).toBe("prompt");
		expect(resolveApproval(write, args, "yolo", { [tool.name]: "deny" }).policy).toBe("deny");
	});

	test("does not change approval for a different server with the same tool name", () => {
		const tool = liveTool("another-server");
		expect(resolveApproval(tool, { id: 42 }, "yolo").policy).toBe("allow");
	});
});
