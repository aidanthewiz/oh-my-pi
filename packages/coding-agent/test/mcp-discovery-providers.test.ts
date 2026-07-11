/**
 * `mcp.discoveryProviders` — MCP-scoped provider allowlist.
 *
 * Unlike `disabledProviders` (whole-provider: context files, skills, commands,
 * hooks, AND MCP), this option filters ONLY which providers contribute MCP
 * servers. Empty/omitted = all providers (upstream behavior).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("mcp.discoveryProviders allowlist", () => {
	let tempHome = "";
	let projectDir = "";
	let agentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-providers-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-providers-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-providers-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);

		// Native user-scope server (provider id "native", level "user").
		await fs.writeFile(
			path.join(agentDir, "mcp.json"),
			JSON.stringify({ mcpServers: { "native-server": { command: "native-cmd" } } }),
		);
		// Project-root fallback server (provider id "mcp-json", level "project").
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "project-server": { command: "project-cmd" } } }),
		);
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("allowlist [native] excludes mcp-json project servers", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["native"] });
		expect(configs["native-server"]).toBeDefined();
		expect(configs["project-server"]).toBeUndefined();
	});

	test("empty allowlist keeps upstream behavior (all providers)", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: [] });
		expect(configs["native-server"]).toBeDefined();
		expect(configs["project-server"]).toBeDefined();
	});

	test("omitted allowlist keeps upstream behavior (all providers)", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir);
		expect(configs["native-server"]).toBeDefined();
		expect(configs["project-server"]).toBeDefined();
	});

	test("enableProjectConfig=false filters project entries independently of the allowlist", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, { enableProjectConfig: false });
		expect(configs["native-server"]).toBeDefined();
		expect(configs["project-server"]).toBeUndefined();
	});
});
