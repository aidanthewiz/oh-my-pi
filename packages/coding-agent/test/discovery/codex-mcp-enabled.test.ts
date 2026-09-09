/**
 * Regression: the Codex MCP importer must honor Codex's own per-server
 * `enabled` flag from `~/.codex/config.toml`.
 *
 * `extractMCPServersFromToml` previously dropped the field, so a server Codex
 * itself had disabled (`enabled = false`) was imported as enabled and OMP
 * spawned it at startup (observed live: Codex's disabled computer-use server
 * failing with ENOENT every session).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

async function writeCodexConfig(home: string, toml: string): Promise<void> {
	const codexDir = path.join(home, ".codex");
	await fs.mkdir(codexDir, { recursive: true });
	await fs.writeFile(path.join(codexDir, "config.toml"), toml);
}

async function loadCodexServers(cwd: string): Promise<MCPServer[]> {
	clearFsCache();
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["codex"] });
	return result.items;
}

describe("codex MCP importer honors per-server enabled flag", () => {
	let tempHome = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-enabled-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-codex-enabled-project-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
	});

	test("enabled = false is imported as disabled and excluded from runtime configs", async () => {
		await writeCodexConfig(
			tempHome,
			`
[mcp_servers.computer-use]
command = "./disabled-server"
args = ["mcp"]
enabled = false
`,
		);

		const servers = await loadCodexServers(projectDir);
		const item = servers.find(s => s.name === "computer-use");
		expect(item).toBeDefined();
		expect(item?.enabled).toBe(false);

		// Runtime loading (what MCPManager connects) must skip it entirely.
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["codex"] });
		expect(configs["computer-use"]).toBeUndefined();
	});

	test("enabled = true uses the enabled default and is included", async () => {
		await writeCodexConfig(
			tempHome,
			`
[mcp_servers.node-repl]
command = "node-repl"
enabled = true
`,
		);

		const servers = await loadCodexServers(projectDir);
		expect(servers.find(s => s.name === "node-repl")?.enabled).toBeUndefined();

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["codex"] });
		expect(configs["node-repl"]).toBeDefined();
	});

	test("absent enabled field keeps the unchanged default (included)", async () => {
		await writeCodexConfig(
			tempHome,
			`
[mcp_servers.plain]
command = "plain-server"
`,
		);

		const servers = await loadCodexServers(projectDir);
		const item = servers.find(s => s.name === "plain");
		expect(item).toBeDefined();
		expect(item?.enabled).toBeUndefined();

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["codex"] });
		expect(configs.plain).toBeDefined();
	});
});
