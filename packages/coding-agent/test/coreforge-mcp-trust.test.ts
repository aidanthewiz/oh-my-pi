import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const originalToken = process.env.PI_CORE_MCP_TOKEN;

async function runGit(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
	}
}

describe("trusted Coreforge project MCP config", () => {
	let projectDir = "";
	let agentDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-mcp-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-mcp-agent-"));
		setAgentDir(agentDir);
		process.env.PI_CORE_MCP_TOKEN = "from-coreforge-env";
		await fs.mkdir(path.join(projectDir, ".coreforge"));
		await fs.writeFile(
			path.join(projectDir, ".coreforge", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					trusted: {
						command: "trusted-command",
						env: { TOKEN: `\${PI_CORE_MCP_TOKEN}` },
					},
				},
			}),
		);
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { generic: { command: "generic-command" } } }),
		);
		await runGit(projectDir, "init", "--initial-branch=main", "--quiet");
		await runGit(projectDir, "remote", "add", "origin", "git@github.com:Coreforce-CAD/example.git");
		clearFsCache();
	});

	afterEach(async () => {
		clearFsCache();
		if (originalAgentDirEnv) setAgentDir(originalAgentDirEnv);
		else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalToken === undefined) delete process.env.PI_CORE_MCP_TOKEN;
		else process.env.PI_CORE_MCP_TOKEN = originalToken;
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("loads only .coreforge/mcp.json for an allowlisted origin organization", async () => {
		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge", "mcp-json"],
			trustedProjectGitHubOrganizations: ["coreforce-cad"],
		});

		const trusted = configs.trusted;
		expect(trusted?.type).toBe("stdio");
		if (trusted?.type !== "stdio") throw new Error("trusted MCP server did not use stdio");
		expect(trusted.env).toEqual({ TOKEN: "from-coreforge-env" });
		expect(sources.trusted?.provider).toBe("coreforge");
		expect(configs.generic).toBeUndefined();
	});

	test("rejects .coreforge/mcp.json for a different origin organization", async () => {
		await runGit(projectDir, "remote", "set-url", "origin", "https://github.com/example/project.git");
		const { configs } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
			trustedProjectGitHubOrganizations: ["Coreforce-CAD"],
		});
		expect(configs.trusted).toBeUndefined();
	});

	test("requires an explicit trusted organization even for the Coreforge provider", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
		});
		expect(configs.trusted).toBeUndefined();
	});
});
