import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

describe("parseArgs — MCP escape-hatch flags", () => {
	it("parses --no-mcp as a boolean flag", () => {
		const result = parseArgs(["--no-mcp"]);
		expect(result.noMcp).toBe(true);
	});

	it("parses --mcp-project-config as a boolean flag", () => {
		const result = parseArgs(["--mcp-project-config"]);
		expect(result.mcpProjectConfig).toBe(true);
	});

	it("defaults all three to undefined when not provided", () => {
		const result = parseArgs([]);
		expect(result.noMcp).toBeUndefined();
		expect(result.mcpProjectConfig).toBeUndefined();
		expect(result.mcpProviders).toBeUndefined();
	});

	it("splits --mcp-providers on commas and trims entries", () => {
		const result = parseArgs(["--mcp-providers", "codex, native ,mcp-json,"]);
		expect(result.mcpProviders).toEqual(["codex", "native", "mcp-json"]);
	});

	it("supports --mcp-providers=value form", () => {
		const result = parseArgs(["--mcp-providers=native,codex"]);
		expect(result.mcpProviders).toEqual(["native", "codex"]);
	});

	it("does not consume a following flag after the boolean forms", () => {
		const result = parseArgs(["--no-mcp", "--mcp-project-config", "--model", "opus", "hello"]);
		expect(result.noMcp).toBe(true);
		expect(result.mcpProjectConfig).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual(["hello"]);
	});
});

describe("profile bootstrap — MCP flags are value-less", () => {
	// VALUELESS_FLAGS regression: a boolean launch flag missing from the table
	// makes `--<flag> --profile X` stop selecting the profile (the bootstrap
	// would treat `--profile` as the flag's value).
	it("--no-mcp --profile x still selects profile x", () => {
		const result = extractProfileFlags(["--no-mcp", "--profile", "x"]);
		expect(result.profile).toBe("x");
		expect(result.argv).toEqual(["--no-mcp"]);
	});

	it("--mcp-project-config --profile x still selects profile x", () => {
		const result = extractProfileFlags(["--mcp-project-config", "--profile", "x"]);
		expect(result.profile).toBe("x");
		expect(result.argv).toEqual(["--mcp-project-config"]);
	});

	it("--mcp-providers consumes its value, then profile still applies", () => {
		const result = extractProfileFlags(["--mcp-providers", "codex,native", "--profile", "x"]);
		expect(result.profile).toBe("x");
		expect(result.argv).toEqual(["--mcp-providers", "codex,native"]);
	});
});
