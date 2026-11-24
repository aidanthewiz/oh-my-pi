import { describe, expect, it } from "bun:test";
import {
	type McpStdioSpec,
	mcpIdentity,
	mcpPublicIdentity,
	mcpUnitKey,
} from "@oh-my-pi/pi-coding-agent/mcp/host/contract";

function spec(spawnEnv: Record<string, string>): McpStdioSpec {
	return { transport: "stdio", command: "synthetic-mcp", args: [], cwd: "/", env: {}, spawnEnv, timeoutMs: 0 };
}

describe("operational AWS MCP authority", () => {
	it.each([
		"OMP_OPERATIONAL_AWS_REGION",
		"OMP_OPERATIONAL_AWS_EXECUTABLE",
		"OMP_OPERATIONAL_AWS_SESSION_MANAGER_PLUGIN",
		"OMP_OPERATIONAL_AWS_HOME_DIRECTORY",
		"OMP_OPERATIONAL_AWS_PROFILES",
	])("isolates process and cache ownership when %s changes", name => {
		const first = spec({ [name]: "synthetic-a" });
		const second = spec({ [name]: "synthetic-b" });
		expect(mcpIdentity(first)).not.toBe(mcpIdentity(second));
		expect(mcpPublicIdentity(first)).not.toBe(mcpPublicIdentity(second));
		expect(mcpUnitKey(first, "modern", "one")).not.toBe(mcpUnitKey(second, "modern", "two"));
	});

	it("still shares modern processes across incidental shell changes", () => {
		const first = spec({ OMP_OPERATIONAL_AWS_REGION: "synthetic-region", TERM: "xterm", PATH: "/one" });
		const second = spec({ OMP_OPERATIONAL_AWS_REGION: "synthetic-region", TERM: "dumb", PATH: "/two" });
		expect(mcpUnitKey(first, "modern", "one")).toBe(mcpUnitKey(second, "modern", "two"));
		expect(mcpUnitKey(first, "legacy", "one")).not.toBe(mcpUnitKey(second, "legacy", "two"));
	});
});
