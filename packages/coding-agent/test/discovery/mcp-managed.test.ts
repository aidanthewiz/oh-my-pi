/**
 * Managed MCP definitions provider (`<agentDir>/mcp.managed.json`).
 *
 * Ownership split under test: the managed file carries org DEFINITIONS
 * (priority 110 — wins name collisions against every other source), while
 * user STATE in the user-owned mcp.json (disabledServers / enabledServers /
 * per-server enabled toggles) still decides what actually connects.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

async function writeManagedFile(agentDir: string, body: string): Promise<void> {
	await fs.writeFile(path.join(agentDir, "mcp.managed.json"), body);
}

async function writeUserMcpJson(agentDir: string, body: unknown): Promise<void> {
	await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(body, null, 2));
}

async function loadManaged(cwd: string): Promise<{ items: MCPServer[]; warnings: string[] }> {
	clearFsCache();
	const result = await loadCapability<MCPServer>(mcpCapability.id, { cwd, providers: ["mcp-managed"] });
	return { items: result.items, warnings: result.warnings ?? [] };
}

describe("mcp-managed provider", () => {
	let tempHome = "";
	let projectDir = "";
	let agentDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-managed-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-managed-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-managed-agent-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(agentDir);
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

	test("contributes servers with Coreforge Managed provenance", async () => {
		await writeManagedFile(
			agentDir,
			JSON.stringify({
				mcpServers: { "managed-x": { type: "stdio", command: "managed-cmd", args: ["--flag"] } },
			}),
		);

		const { items } = await loadManaged(projectDir);
		const server = items.find(s => s.name === "managed-x");
		expect(server).toBeDefined();
		expect(server?.command).toBe("managed-cmd");
		expect(server?._source.providerName).toBe("Coreforge Managed");
		expect(server?._source.path).toBe(path.join(agentDir, "mcp.managed.json"));
	});

	test("managed definition wins a same-name collision against the user mcp.json", async () => {
		await writeManagedFile(agentDir, JSON.stringify({ mcpServers: { github: { command: "managed-github" } } }));
		await writeUserMcpJson(agentDir, { mcpServers: { github: { command: "user-github" } } });

		clearFsCache();
		const result = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: projectDir,
			providers: ["mcp-managed", "native"],
		});
		const github = result.items.find(s => s.name === "github");
		expect(github?.command).toBe("managed-github");
		expect(github?._source.providerName).toBe("Coreforge Managed");
	});

	test("user disabledServers denylist hides a managed server", async () => {
		await writeManagedFile(agentDir, JSON.stringify({ mcpServers: { "managed-x": { command: "managed-cmd" } } }));
		await writeUserMcpJson(agentDir, { mcpServers: {}, disabledServers: ["managed-x"] });

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["mcp-managed", "native"] });
		expect(configs["managed-x"]).toBeUndefined();
	});

	test("user enabledServers allowlist force-enables a managed enabled:false entry", async () => {
		await writeManagedFile(
			agentDir,
			JSON.stringify({ mcpServers: { "managed-y": { command: "managed-cmd", enabled: false } } }),
		);
		await writeUserMcpJson(agentDir, { mcpServers: {}, enabledServers: ["managed-y"] });

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["mcp-managed", "native"] });
		expect(configs["managed-y"]).toBeDefined();
	});

	test("managed enabled:false without user allowlist stays excluded from runtime configs", async () => {
		await writeManagedFile(
			agentDir,
			JSON.stringify({ mcpServers: { "managed-z": { command: "managed-cmd", enabled: false } } }),
		);

		clearFsCache();
		const { configs } = await loadAllMCPConfigs(projectDir, { discoveryProviders: ["mcp-managed"] });
		expect(configs["managed-z"]).toBeUndefined();
	});

	test("absent file yields zero items and zero warnings", async () => {
		const { items, warnings } = await loadManaged(projectDir);
		expect(items).toEqual([]);
		expect(warnings).toEqual([]);
	});

	test("malformed JSON yields one warning and zero items", async () => {
		await writeManagedFile(agentDir, "{ not json");
		const { items, warnings } = await loadManaged(projectDir);
		expect(items).toEqual([]);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("mcp.managed.json");
	});

	test("expands ${VAR} placeholders in env values", async () => {
		process.env.OMP_TEST_MANAGED_TOKEN = "secret-token";
		try {
			await writeManagedFile(
				agentDir,
				JSON.stringify({
					mcpServers: {
						"env-server": { command: "cmd", env: { TOKEN: "${OMP_TEST_MANAGED_TOKEN}" } },
					},
				}),
			);
			const { items } = await loadManaged(projectDir);
			expect(items.find(s => s.name === "env-server")?.env?.TOKEN).toBe("secret-token");
		} finally {
			delete process.env.OMP_TEST_MANAGED_TOKEN;
		}
	});
});
