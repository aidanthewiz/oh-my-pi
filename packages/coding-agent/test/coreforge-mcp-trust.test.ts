import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPProjectTrustRequest } from "@oh-my-pi/pi-coding-agent/mcp/project-trust";
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

async function writeCoreforgeConfig(projectDir: string, command = "trusted-command"): Promise<void> {
	await fs.writeFile(
		path.join(projectDir, ".coreforge", "mcp.json"),
		JSON.stringify({
			mcpServers: {
				trusted: {
					command,
					env: { TOKEN: `\${PI_CORE_MCP_TOKEN}` },
				},
			},
		}),
	);
}

describe("Coreforge project MCP config", () => {
	let projectDir = "";
	let agentDir = "";

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-mcp-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-mcp-agent-"));
		setAgentDir(agentDir);
		process.env.PI_CORE_MCP_TOKEN = "from-coreforge-env";
		await fs.mkdir(path.join(projectDir, ".coreforge"));
		await writeCoreforgeConfig(projectDir);
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

	test("does not trust repository MCP commands from mutable origin metadata", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge", "mcp-json"],
		});

		expect(configs.trusted).toBeUndefined();
		expect(configs.generic).toBeUndefined();
	});

	test("persists approval for the canonical checkout and exact config bytes", async () => {
		const requests: MCPProjectTrustRequest[] = [];
		const first = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge", "mcp-json"],
			requestProjectTrust: async request => {
				requests.push(request);
				return true;
			},
		});

		expect(first.configs.trusted?.type).toBe("stdio");
		expect(first.configs.generic).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.projectRoot).toBe(await fs.realpath(projectDir));
		expect(requests[0]?.configPath).toBe(path.join(await fs.realpath(projectDir), ".coreforge", "mcp.json"));
		expect(requests[0]?.configSha256).toMatch(/^[0-9a-f]{64}$/);

		clearFsCache();
		const second = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge", "mcp-json"],
		});
		expect(second.configs.trusted?.type).toBe("stdio");
		expect(second.configs.generic).toBeUndefined();

		const store = JSON.parse(await fs.readFile(path.join(agentDir, "mcp-project-trust.json"), "utf8"));
		expect(store).toEqual({
			version: 1,
			entries: [{ projectRoot: await fs.realpath(projectDir), configSha256: requests[0]?.configSha256 }],
		});
	});

	test("requires approval again after the project config changes", async () => {
		let approvedDigest = "";
		await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
			requestProjectTrust: async request => {
				approvedDigest = request.configSha256;
				return true;
			},
		});

		await writeCoreforgeConfig(projectDir, "changed-command");
		clearFsCache();
		const withoutApproval = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
		});
		expect(withoutApproval.configs.trusted).toBeUndefined();

		let changedDigest = "";
		const declined = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
			requestProjectTrust: async request => {
				changedDigest = request.configSha256;
				return false;
			},
		});
		expect(changedDigest).not.toBe(approvedDigest);
		expect(declined.configs.trusted).toBeUndefined();

		const reapproved = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
			requestProjectTrust: async () => true,
		});
		const trusted = reapproved.configs.trusted;
		expect(trusted?.type).toBe("stdio");
		if (trusted?.type !== "stdio") throw new Error("trusted MCP server did not use stdio");
		expect(trusted.command).toBe("changed-command");

		clearFsCache();
		const persisted = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
		});
		expect(persisted.configs.trusted?.type).toBe("stdio");
	});

	test("does not load config bytes changed while approval is pending", async () => {
		const { configs } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: false,
			discoveryProviders: ["coreforge"],
			requestProjectTrust: async () => {
				await writeCoreforgeConfig(projectDir, "swapped-command");
				clearFsCache();
				return true;
			},
		});

		expect(configs.trusted).toBeUndefined();
	});

	test("loads .coreforge/mcp.json when general project config is enabled", async () => {
		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			enableProjectConfig: true,
			discoveryProviders: ["coreforge"],
		});

		const trusted = configs.trusted;
		expect(trusted?.type).toBe("stdio");
		if (trusted?.type !== "stdio") throw new Error("trusted MCP server did not use stdio");
		expect(trusted.env).toEqual({ TOKEN: `\${PI_CORE_MCP_TOKEN}` });
		expect(sources.trusted?.provider).toBe("coreforge");
		expect(configs.generic).toBeUndefined();
	});
});
