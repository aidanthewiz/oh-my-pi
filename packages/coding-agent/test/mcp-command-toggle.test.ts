import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { readMCPConfigFile, setMcpServerEnabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { MCPDroppedServer } from "@oh-my-pi/pi-coding-agent/mcp/transforms";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import {
	getConfigRootDir,
	getMCPConfigPath,
	getProjectDir,
	removeWithRetries,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "./helpers/interactive-mode-context";

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");
const METADATA_ENV = "OMP_TEST_MCP_METADATA_URL";
const METADATA_REFERENCE = `\${OMP_TEST_MCP_METADATA_URL}`;

function setMetadataEnvironment(value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[METADATA_ENV];
		delete process.env[METADATA_ENV];
	} else {
		Bun.env[METADATA_ENV] = value;
		process.env[METADATA_ENV] = value;
	}
}

function restoreAgentDir(): void {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
		process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		Bun.env.PI_CODING_AGENT_DIR = originalAgentDir;
		return;
	}
	setAgentDir(fallbackAgentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	delete Bun.env.PI_CODING_AGENT_DIR;
}

function createController(builtinDrops = new Map<string, MCPDroppedServer>()) {
	const refreshMCPTools = vi.fn(async () => {});
	const connectServers = vi.fn(
		async (_configs: Record<string, MCPServerConfig>, _sources: Record<string, SourceMeta>) => ({
			errors: new Map<string, string>(),
			connectedServers: [],
			tools: [],
			exaApiKeys: [],
		}),
	);
	const mcpManager = createMcpManagerStub({ connectServers, getBuiltinDrops: () => builtinDrops });
	const ctx = createInteractiveModeContext({
		session: { refreshMCPTools },
		mcpManager,
	});
	const controller = new MCPCommandController(ctx);

	return { controller, mcpManager, refreshMCPTools, connectServers };
}

async function writeProjectConfig(projectDir: string, servers: Record<string, MCPServerConfig>): Promise<void> {
	await Bun.write(
		getMCPConfigPath("project", projectDir),
		`${JSON.stringify(
			{
				mcpServers: servers,
			},
			null,
			2,
		)}\n`,
	);
}

describe("/mcp enable and disable", () => {
	let projectDir = "";
	let agentDir = "";
	let originalMetadataUrl: string | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		originalMetadataUrl = Bun.env[METADATA_ENV];
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-toggle-agent-"));
		setProjectDir(projectDir);
		setAgentDir(agentDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		setMetadataEnvironment(originalMetadataUrl);
		setProjectDir(originalProjectDir);
		restoreAgentDir();
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test("disables and dashboard-reenables a user OAuth server without rewriting its metadata placeholder", async () => {
		setMetadataEnvironment("https://mcp.example.test/.well-known/oauth-protected-resource");
		const userPath = getMCPConfigPath("user", projectDir);
		const config: MCPServerConfig = {
			type: "http",
			url: "https://mcp.example.test/mcp/",
			oauth: { resourceMetadataUrl: METADATA_REFERENCE },
		};
		await Bun.write(userPath, JSON.stringify({ mcpServers: { oauthserver: config } }));
		const { controller, mcpManager } = createController();

		await controller.handle("/mcp disable oauthserver");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("oauthserver");
		const disabled = (await readMCPConfigFile(userPath)).mcpServers?.oauthserver;
		expect(disabled?.enabled).toBe(false);
		expect(disabled?.oauth?.resourceMetadataUrl).toBe(METADATA_REFERENCE);

		await setMcpServerEnabled({
			userPath,
			projectPath: getMCPConfigPath("project", projectDir),
			name: "oauthserver",
			enabled: true,
		});

		const enabled = (await readMCPConfigFile(userPath)).mcpServers?.oauthserver;
		expect(enabled?.enabled).toBe(true);
		expect(enabled?.oauth?.resourceMetadataUrl).toBe(METADATA_REFERENCE);
	});

	test("dashboard toggles retain user-source expansion for an alternate native .mcp.json", async () => {
		setMetadataEnvironment("https://mcp.example.test/.well-known/oauth-protected-resource");
		const sourcePath = path.join(agentDir, ".mcp.json");
		await Bun.write(
			sourcePath,
			JSON.stringify({
				mcpServers: {
					oauthserver: {
						type: "http",
						url: "https://mcp.example.test/mcp/",
						oauth: { resourceMetadataUrl: METADATA_REFERENCE },
					},
				},
			}),
		);
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			sourcePath,
			name: "oauthserver",
			enabled: false,
		});

		const saved = (await readMCPConfigFile(sourcePath)).mcpServers?.oauthserver;
		expect(saved?.enabled).toBe(false);
		expect(saved?.oauth?.resourceMetadataUrl).toBe(METADATA_REFERENCE);
	});

	test.each(["https://user:synthetic@example.test/metadata", "file:///tmp/metadata.json", "not-a-url"])(
		"rejects an unsafe resolved user metadata URL %s without changing enabled state",
		async metadataUrl => {
			setMetadataEnvironment(metadataUrl);
			const userPath = getMCPConfigPath("user", projectDir);
			const definition = JSON.stringify({
				mcpServers: {
					oauthserver: {
						type: "http",
						url: "https://mcp.example.test/mcp/",
						enabled: true,
						oauth: { resourceMetadataUrl: METADATA_REFERENCE },
					},
				},
			});
			await Bun.write(userPath, definition);
			await expect(
				setMcpServerEnabled({
					userPath,
					projectPath: getMCPConfigPath("project", projectDir),
					name: "oauthserver",
					enabled: false,
				}),
			).rejects.toThrow("oauth.resourceMetadataUrl");
			expect(await Bun.file(userPath).text()).toBe(definition);
		},
	);

	test.each([
		{
			label: "unavailable project variable",
			expression: METADATA_REFERENCE,
			ambient: "https://private.example.test/metadata",
			accepted: false,
		},
		{
			label: "safe project default",
			expression: `\${OMP_TEST_MCP_METADATA_URL:-https://public.example.test/metadata}`,
			ambient: "https://user:synthetic@example.test/metadata",
			accepted: true,
		},
		{
			label: "unsafe project default",
			expression: `\${OMP_TEST_MCP_METADATA_URL:-https://user:synthetic@example.test/metadata}`,
			ambient: "https://private.example.test/metadata",
			accepted: false,
		},
	])("validates $label without inheriting restricted process values", async ({ expression, ambient, accepted }) => {
		setMetadataEnvironment(ambient);
		const projectPath = getMCPConfigPath("project", projectDir);
		const definition = JSON.stringify({
			mcpServers: {
				oauthserver: {
					type: "http",
					url: "https://mcp.example.test/mcp/",
					enabled: true,
					oauth: { resourceMetadataUrl: expression },
				},
			},
		});
		await Bun.write(projectPath, definition);
		const toggle = setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath,
			name: "oauthserver",
			enabled: false,
		});
		if (!accepted) {
			await expect(toggle).rejects.toThrow("oauth.resourceMetadataUrl");
			expect(await Bun.file(projectPath).text()).toBe(definition);
			return;
		}
		await toggle;
		const saved = (await readMCPConfigFile(projectPath)).mcpServers?.oauthserver;
		expect(saved?.enabled).toBe(false);
		expect(saved?.oauth?.resourceMetadataUrl).toBe(expression);
	});

	test("disabling one configured server does not reload other MCP servers", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one" },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, refreshMCPTools } = createController();

		await controller.handle("/mcp disable mcp1");

		expect(mcpManager.disconnectServer).toHaveBeenCalledWith("mcp1");
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(mcpManager.connectServers).not.toHaveBeenCalled();
	});

	test("enabling one configured server connects only that MCP server", async () => {
		await writeProjectConfig(projectDir, {
			mcp1: { type: "stdio", command: "mcp-one", enabled: false },
			mcp2: { type: "stdio", command: "mcp-two" },
		});
		const { controller, mcpManager, connectServers } = createController();

		await controller.handle("/mcp enable mcp1");

		expect(mcpManager.disconnectAll).not.toHaveBeenCalled();
		expect(mcpManager.discoverAndConnect).not.toHaveBeenCalled();
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(Object.keys(configs)).toEqual(["mcp1"]);
		expect(configs.mcp1).toEqual({ type: "stdio", command: "mcp-one", enabled: true });
	});

	test("enabling a server a built-in transform dropped records the enable and connects it", async () => {
		// Codex's config is another tool's file: the enable can only live in the
		// user allowlist, and that entry is what keeps the next discovery from
		// dropping the server again.
		const codexConfig = path.join(projectDir, ".codex", "config.toml");
		await Bun.write(codexConfig, '[mcp_servers.codex_js]\ncommand = "/opt/codex/cua_node/bin/node_repl"\n');
		const source: SourceMeta = {
			provider: "codex",
			providerName: "OpenAI Codex",
			path: codexConfig,
			level: "project",
		};
		const { controller, connectServers } = createController(
			new Map([["codex_js", { reason: "eval already runs JavaScript", source }]]),
		);

		await controller.handle("/mcp enable codex_js");

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers).toEqual(["codex_js"]);
		expect(connectServers).toHaveBeenCalledTimes(1);
		const [configs] = connectServers.mock.calls[0]!;
		expect(configs.codex_js).toMatchObject({ type: "stdio", command: "/opt/codex/cua_node/bin/node_repl" });
	});
});
