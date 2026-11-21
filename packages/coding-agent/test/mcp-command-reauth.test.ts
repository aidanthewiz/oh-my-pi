import { Database } from "bun:sqlite";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/oauth/types";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { findMcpServerForAuth } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "@oh-my-pi/pi-coding-agent/mcp/settings";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPHttpServerConfig, MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
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
import {
	createInteractiveModeContext,
	createMcpManagerStub,
	type McpManagerOverrides,
} from "./helpers/interactive-mode-context";

const RAW_SERVER_URL = `https://\${MCP_HOST}/mcp`;
const EXPANDED_SERVER_URL = "https://mcp.example.com/mcp";
const AUTH_ERROR = new Error(
	'HTTP 401: {"authorization_url":"https://auth.example.com/authorize","token_url":"https://auth.example.com/token"}',
);

type TestConfigFile = {
	mcpServers?: Record<string, MCPServerConfig>;
};

const originalProjectDir = getProjectDir();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreEnvValue(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		delete process.env[name];
		return;
	}
	Bun.env[name] = value;
	process.env[name] = value;
}
/**
 * Resolve when the controller installs its `editor.onEscape` hook.
 *
 * The hook is installed part-way through an async flow, so a test that needs
 * it has to wait. Polling to a wall-clock deadline would make that wait a
 * timing budget rather than a synchronisation point: on a loaded runner the
 * deadline can expire before correct code has installed the hook, and the
 * assertion then fails on a value that was merely late. Intercepting the
 * assignment bounds the wait by the event it is actually waiting for, leaving
 * `bun test --timeout` as the only backstop for a genuine hang.
 */
function whenEscapeInstalled(editor: { onEscape?: (() => void) | undefined }): Promise<void> {
	const installed = Promise.withResolvers<void>();
	let current = editor.onEscape;
	if (typeof current === "function") installed.resolve();
	Object.defineProperty(editor, "onEscape", {
		configurable: true,
		enumerable: true,
		get: () => current,
		set: (value: (() => void) | undefined) => {
			current = value;
			if (typeof value === "function") installed.resolve();
		},
	});
	return installed.promise;
}

function createController(authStorage: AuthStorage, mcpManagerOverrides: McpManagerOverrides = {}) {
	const prepareConfig = vi.fn(async (config: MCPServerConfig) => config);
	const mcpManager = createMcpManagerStub({ prepareConfig, ...mcpManagerOverrides });
	const ctx = createInteractiveModeContext({
		session: { modelRegistry: { authStorage } },
		mcpManager,
	});
	const controller = new MCPCommandController(ctx);
	const { showError, showStatus, present, editor, oauthManualInput } = ctx;

	return { controller, ctx, showError, showStatus, present, editor, oauthManualInput, prepareConfig, mcpManager };
}

describe("/mcp auth commands", () => {
	let projectDir = "";
	let agentDir = "";
	let configPath = "";
	let originalMcpHost: string | undefined;
	// Track every in-memory auth store so afterEach can close the underlying
	// bun:sqlite Database. Leaked Database handles are JSDestructibleObjects that
	// JSC otherwise finalizes during an arbitrary later GC sweep — under
	// `bun test --parallel` that sweep can run mid-suite on the shared VM and
	// trip a Bun GC crash (SIGABRT "Pure virtual function called").
	const openAuthStores: AuthStorage[] = [];
	function freshAuthStorage(): AuthStorage {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		openAuthStores.push(storage);
		return storage;
	}

	test("does not persist a completed login into a replacement session", async () => {
		const authStorage = freshAuthStorage();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<OAuthCredentials>();
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(async () => {
			entered.resolve();
			return await release.promise;
		});
		const { controller, ctx } = createController(authStorage);
		const previous = await Bun.file(configPath).text();
		const reauth = controller.handle("/mcp reauth envserver");
		await entered.promise;
		ctx.session = { ...ctx.session, sessionId: "replacement-session" } as typeof ctx.session;
		release.resolve({ access: "stale-session-access", refresh: "stale-refresh", expires: Date.now() + 3_600_000 });
		await reauth;
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		expect(await Bun.file(configPath).text()).toBe(previous);
	});

	test("Esc cancels the anonymous probe before any browser login can start", async () => {
		const authStorage = freshAuthStorage();
		const entered = Promise.withResolvers<void>();
		let observedSignal: AbortSignal | undefined;
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((_name, _config, options) => {
			observedSignal = options?.signal;
			entered.resolve();
			return new Promise<never>((_resolve, reject) => {
				observedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
					once: true,
				});
			});
		});
		const login = vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login");
		const { controller, ctx } = createController(authStorage);
		const previous = await Bun.file(configPath).text();
		const reauth = controller.handle("/mcp reauth envserver");
		await entered.promise;
		const escape = [...ctx.mcpTestEscapeHandlers][0];
		if (!escape) throw new Error("MCP preflight has no cancellation owner");
		escape();
		await reauth;
		expect(observedSignal?.aborted).toBe(true);
		expect(login).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		expect(await Bun.file(configPath).text()).toBe(previous);
	});

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-project-"));
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-reauth-agent-"));
		originalMcpHost = Bun.env.MCP_HOST;
		Bun.env.MCP_HOST = "mcp.example.com";
		process.env.MCP_HOST = "mcp.example.com";
		setProjectDir(projectDir);
		setAgentDir(agentDir);
		configPath = getMCPConfigPath("user", projectDir);
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
							oauth: { clientName: "Coreforge" },
						},
					},
				},
				null,
				2,
			)}\n`,
		);
	});

	afterEach(async () => {
		while (openAuthStores.length > 0) await openAuthStores.pop()?.close();
		vi.restoreAllMocks();
		restoreEnvValue("MCP_HOST", originalMcpHost);
		setProjectDir(originalProjectDir);
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await removeWithRetries(projectDir);
		await removeWithRetries(agentDir);
	});

	test.each([
		{
			scenario: "a default-enabled URL-only user",
			project: false,
			invalidation: "none",
			inferred: true,
			defaultEnabled: true,
		},
		{
			scenario: "a default-enabled URL-only user through direct reauth",
			project: false,
			invalidation: "none",
			inferred: true,
			defaultEnabled: true,
			direct: true,
		},
		{
			scenario: "a denylisted default-enabled URL-only user",
			project: false,
			invalidation: "disabled",
			inferred: true,
			defaultEnabled: true,
		},
		{ scenario: "user placeholders and force-enable", project: false, invalidation: "none" },
		{ scenario: "URL-only user placeholders and force-enable", project: false, invalidation: "none", inferred: true },
		{ scenario: "an approved URL-only project", project: true, invalidation: "none", inferred: true },
		{
			scenario: "an exactly approved project with general project loading disabled",
			project: true,
			invalidation: "none",
		},
		{ scenario: "a project definition changed after approval", project: true, invalidation: "changed" },
		{
			scenario: "a replacement project definition approved after startup",
			project: true,
			invalidation: "reapproved",
		},
		{ scenario: "a denylisted approved project", project: true, invalidation: "disabled" },
	] as const)("cold-cache Authenticate honors $scenario", async row => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const login = vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.method === "DELETE") return new Response(null, { status: 202 });
				if (request.method !== "POST") return new Response(null, { status: 405 });
				const body = (await request.json()) as { id?: number; method?: string };
				if (body.method === "initialize") {
					if (request.headers.get("authorization") !== "Bearer fresh-access") {
						return Response.json(
							{
								authorization_url: "https://auth.example.com/authorize",
								token_url: "https://auth.example.com/token",
							},
							{ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="test"' } },
						);
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: { tools: {} },
							serverInfo: { name: "hosted", version: "1" },
						},
					});
				}
				if (body.method === "tools/list") {
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { tools: [{ name: "lookup", inputSchema: { type: "object", properties: {} } }] },
					});
				}
				if (body.method === "tools/call") {
					if (request.headers.get("authorization") !== "Bearer fresh-access") {
						return new Response("Permission denied", { status: 403 });
					}
					return Response.json({
						jsonrpc: "2.0",
						id: body.id,
						result: { content: [{ type: "text", text: "authorized-result" }] },
					});
				}
				return new Response(null, { status: 202 });
			},
		});
		const runtimeUrl = `${server.url}mcp`;
		Bun.env.MCP_HOST = server.url.host;
		process.env.MCP_HOST = server.url.host;
		const config = {
			...("inferred" in row ? {} : { type: "http" as const }),
			url: row.project ? runtimeUrl : `http://\${MCP_HOST}/mcp`,
			...("defaultEnabled" in row ? {} : { enabled: false }),
			oauth: { clientId: "test-client" },
		};
		const sourcePath = row.project ? path.join(projectDir, ".coreforge", "mcp.json") : configPath;
		if (row.project) {
			await fs.mkdir(path.dirname(sourcePath), { recursive: true });
			await Bun.write(sourcePath, JSON.stringify({ mcpServers: { envserver: config } }));
			await Bun.write(configPath, JSON.stringify({ enabledServers: ["envserver"] }));
		} else {
			await Bun.write(
				configPath,
				JSON.stringify({
					mcpServers: { envserver: config },
					...("defaultEnabled" in row ? {} : { enabledServers: ["envserver"] }),
				}),
			);
		}
		clearFsCache();
		const loadConfigs = (cwd: string, options?: Parameters<typeof loadAllMCPConfigs>[1]) =>
			loadAllMCPConfigs(cwd, {
				...options,
				discoveryProviders: [row.project ? "coreforge" : "native"],
			});
		const { configs, sources } = await loadConfigs(projectDir, {
			enableProjectConfig: !row.project,
			requestProjectTrust: async () => true,
		});
		const manager = new MCPManager(projectDir, undefined, loadConfigs);
		manager.setAuthStorage(authStorage);
		const ctx = createInteractiveModeContext({
			session: { modelRegistry: { authStorage } },
			mcpManager: manager,
			settings: Settings.isolated(),
		});
		cfgMcpEnableProjectConfig.set(ctx.settings, !row.project);
		const controller = new MCPCommandController(ctx);
		manager.setAuthHandler((name, challenge, context) => controller.handleMCPAuthChallenge(name, challenge, context));
		vi.spyOn(ctx, "showHookSelector").mockResolvedValue("Authenticate envserver");

		try {
			await manager.connectServers(configs, sources, undefined, 0);
			await manager.waitForStartup(0);
			expect(manager.getTools()).toEqual([]);
			expect(manager.getPendingAuthServers()).toEqual(["envserver"]);
			expect(manager.getConnectionStatusSnapshot()).toMatchObject({
				connectedServers: [],
				failedServers: [{ serverName: "envserver", authRequired: true }],
			});
			expect(login).not.toHaveBeenCalled();
			if (row.invalidation === "changed" || row.invalidation === "reapproved") {
				await Bun.write(
					sourcePath,
					JSON.stringify({ mcpServers: { envserver: { ...config, oauth: { clientId: "replacement-client" } } } }),
				);
				clearFsCache();
				if (row.invalidation === "reapproved") {
					await loadAllMCPConfigs(projectDir, {
						enableProjectConfig: false,
						discoveryProviders: ["coreforge"],
						requestProjectTrust: async () => true,
					});
				}
			} else if (row.invalidation === "disabled") {
				await Bun.write(
					configPath,
					JSON.stringify({
						mcpServers: row.project ? undefined : { envserver: config },
						enabledServers: "defaultEnabled" in row ? undefined : ["envserver"],
						disabledServers: ["envserver"],
					}),
				);
			}
			const before = await Bun.file(configPath).text();
			const sourceBefore = await Bun.file(sourcePath).text();
			await controller.handle("direct" in row ? "/mcp reauth envserver" : "/mcp");
			if (row.invalidation !== "none") {
				expect(ctx.showError).toHaveBeenCalledWith(expect.stringMatching(/trusted configuration|disabled/));
				expect(ctx.showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/^Connected to MCP/));
				expect(login).not.toHaveBeenCalled();
				expect(manager.getTools()).toEqual([]);
				expect(manager.getPendingAuthServers()).toEqual(["envserver"]);
				expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(runtimeUrl))).toBeUndefined();
				expect(await Bun.file(configPath).text()).toBe(before);
				expect(await Bun.file(sourcePath).text()).toBe(sourceBefore);
				return;
			}
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(login).toHaveBeenCalledTimes(1);
			expect(manager.getPendingAuthServers()).toEqual([]);
			expect(manager.getConnectionStatusSnapshot()).toEqual({
				pendingServers: [],
				connectedServers: ["envserver"],
				failedServers: [],
			});
			if (!("defaultEnabled" in row)) expect(manager.getServerConfig("envserver")?.enabled).toBe(true);
			expect(manager.getServerConfig("envserver")).toMatchObject({ type: "http", url: runtimeUrl });
			expect(manager.getTools().map(tool => tool.name)).toEqual(["mcp__envserver_lookup"]);
			expect((await manager.callTool("envserver", "lookup")).content).toEqual([
				{ type: "text", text: "authorized-result" },
			]);
			expect(await Bun.file(configPath).text()).toBe(before);
			expect(await Bun.file(sourcePath).text()).toBe(sourceBefore);
			expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(runtimeUrl))).toMatchObject({
				access: "fresh-access",
			});
		} finally {
			clearFsCache();
			await manager.disconnectAll();
			server.stop(true);
		}
	});

	test.each([
		{ label: "source path", source: { path: "/tmp/another-owner.json" }, url: EXPANDED_SERVER_URL, disabled: [] },
		{ label: "source trust level", source: { level: "project" as const }, url: EXPANDED_SERVER_URL, disabled: [] },
		{ label: "source provider", source: { provider: "other" }, url: EXPANDED_SERVER_URL, disabled: [] },
		{ label: "routing target", source: {}, url: "https://different.example.com/mcp", disabled: [] },
		{ label: "disabled selection", source: {}, url: EXPANDED_SERVER_URL, disabled: ["envserver"] },
	])("does not authorize a raw-disabled definition through a mismatched $label", async row => {
		const raw: MCPHttpServerConfig = {
			type: "http",
			url: RAW_SERVER_URL,
			enabled: false,
			oauth: { clientName: "Coreforge" },
		};
		await Bun.write(configPath, JSON.stringify({ mcpServers: { envserver: raw }, disabledServers: row.disabled }));
		const before = await Bun.file(configPath).text();
		const authStorage = freshAuthStorage();
		const login = vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login");
		const probe = vi.spyOn(mcpClient, "connectToServer");
		const { controller, showError } = createController(authStorage, {
			getServerConfig: () => ({ ...raw, url: row.url, enabled: true }),
			getSource: () => ({ provider: "native", providerName: "OMP", path: configPath, level: "user", ...row.source }),
		});
		await controller.handle("/mcp reauth envserver");
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/disabled/i));
		expect(login).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(await Bun.file(configPath).text()).toBe(before);
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
	});

	test("does not replace immutable managed authorization through a writable user shadow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const managedPath = path.join(agentDir, "mcp.managed.json");
		const managedText = JSON.stringify({
			mcpServers: {
				envserver: { type: "http", url: RAW_SERVER_URL, headers: { Authorization: "stale-managed-token" } },
			},
		});
		await Bun.write(managedPath, managedText);
		clearFsCache();
		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			discoveryProviders: ["native", "mcp-managed"],
			enableProjectConfig: false,
		});
		const before = await Bun.file(configPath).text();
		const probe = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		const login = vi
			.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login")
			.mockRejectedValue(new Error("Unexpected consent"));
		const { controller } = createController(authStorage, {
			getServerConfig: vi.fn(() => configs.envserver),
			getSource: vi.fn(() => sources.envserver),
		});
		await controller.handle("/mcp reauth envserver");
		expect(login).not.toHaveBeenCalled();
		expect(probe).not.toHaveBeenCalled();
		expect(await Bun.file(configPath).text()).toBe(before);
		expect(await Bun.file(managedPath).text()).toBe(managedText);
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
	});

	test("reauthenticates a headerless managed server instead of its writable user shadow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const managedPath = path.join(agentDir, "mcp.managed.json");
		const managedText = JSON.stringify({
			mcpServers: { envserver: { type: "http", url: RAW_SERVER_URL } },
		});
		await Bun.write(managedPath, managedText);
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: { envserver: { type: "http", url: "https://shadow.example.com/mcp" } },
			}),
		);
		clearFsCache();
		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			discoveryProviders: ["native", "mcp-managed"],
			enableProjectConfig: false,
		});
		const before = await Bun.file(configPath).text();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "managed-access",
			refresh: "managed-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, mcpManager, showError } = createController(authStorage, {
			getServerConfig: vi.fn(() => configs.envserver),
			getSource: vi.fn(() => sources.envserver),
		});
		const selected = await findMcpServerForAuth("envserver", projectDir, mcpManager, { enableProjectConfig: false });
		expect(selected?.config).toMatchObject({ url: EXPANDED_SERVER_URL });
		await controller.handle("/mcp reauth envserver");
		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "managed-access",
		});
		expect(
			authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId("https://shadow.example.com/mcp")),
		).toBeUndefined();
		expect(await Bun.file(configPath).text()).toBe(before);
		expect(await Bun.file(managedPath).text()).toBe(managedText);
	});

	test("stores definition-only OAuth credentials under the expanded URL key", async () => {
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						"MaaS Slack": {
							type: "http",
							url: RAW_SERVER_URL,
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const connectToServer = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError, prepareConfig } = createController(authStorage);

		await controller.handle("/mcp reauth MaaS Slack");

		expect(showError).not.toHaveBeenCalled();
		expect(prepareConfig).toHaveBeenCalledWith(
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
			expect.objectContaining({ oauth: false }),
		);
		expect(connectToServer).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ url: EXPANDED_SERVER_URL }),
			expect.objectContaining({
				preserveExplicitCredentials: true,
				preserveOperationalAws: false,
			}),
		);
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
			resource: EXPANDED_SERVER_URL,
		});
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();

		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.["MaaS Slack"];
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("uses the registration endpoint discovered from a pathful issuer", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource/my-service/mcp";
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(`HTTP 401: WWW-Authenticate: Bearer resource_metadata="${resourceMetadataUrl}"`),
		);
		const registrationRequests: string[] = [];
		const registrationPayloads: Record<string, unknown>[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/my-service/mcp",
							authorization_servers: ["https://auth.example.com/auth/v1"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server/auth/v1") {
					return new Response(
						JSON.stringify({
							issuer: "https://auth.example.com/auth/v1",
							authorization_endpoint: "https://auth.example.com/auth/v1/oauth/authorize",
							token_endpoint: "https://auth.example.com/auth/v1/oauth/token",
							registration_endpoint: "https://auth.example.com/auth/v1/oauth/register",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/auth/v1/oauth/register" && init?.method === "POST") {
					registrationPayloads.push(JSON.parse(String(init.body)) as Record<string, unknown>);
					registrationRequests.push(url);
					return new Response(JSON.stringify({ client_id: "pathful-dcr-client" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					});
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				const { url } = await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback");
				expect(new URL(url).searchParams.get("client_id")).toBe("pathful-dcr-client");
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(registrationRequests).toEqual(["https://auth.example.com/auth/v1/oauth/register"]);
		expect(registrationPayloads).toEqual([expect.objectContaining({ client_name: "Coreforge" })]);
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			clientId: "pathful-dcr-client",
		});
	});

	test.each([
		{ scope: undefined, expectedScope: null },
		{ scope: "openid", expectedScope: "openid" },
	])("reauth does not request realm-wide scopes with configured scope $scope", async ({ scope, expectedScope }) => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						oauth: { clientId: "mcp-client", scope },
					},
				},
			}),
		);
		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource/mcp";
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(`HTTP 401: WWW-Authenticate: Bearer resource_metadata="${resourceMetadataUrl}"`),
		);
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return Response.json({
						resource: EXPANDED_SERVER_URL,
						authorization_servers: ["https://auth.example.com/realms/example"],
					});
				}
				if (url === "https://auth.example.com/realms/example/.well-known/openid-configuration") {
					return Response.json({
						issuer: "https://auth.example.com/realms/example",
						authorization_endpoint: "https://auth.example.com/realms/example/authorize",
						token_endpoint: "https://auth.example.com/realms/example/token",
						scopes_supported: ["openid", "offline_access", "other-client.admin"],
					});
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("test-state", "http://127.0.0.1:53192/callback")).url;
				return {
					access: "synthetic-access",
					refresh: "synthetic-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		const params = new URL(authorizationUrl).searchParams;
		expect(params.get("scope")).toBe(expectedScope);
		expect(params.get("client_id")).toBe("mcp-client");
		expect(params.get("code_challenge_method")).toBe("S256");
	});

	test("uses tool challenge resource metadata and scopes during reauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("HTTP 401: Unauthorized"));

		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource";
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/mcp",
							authorization_servers: ["https://auth.example.com"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "challenge-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback")).url;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handleMCPAuthChallenge("envserver", {
			wwwAuthenticate: [`Bearer resource_metadata="${resourceMetadataUrl}" scope="orders.read"`],
		});
		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("orders.read");
		expect(new URL(authorizationUrl).searchParams.get("resource")).toBe("https://gateway.example.com/mcp");
	});

	test("reauthorizes on a tool challenge even when the anonymous handshake succeeds", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		// Server allows the unauthenticated handshake; only tool calls are protected.
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const resourceMetadataUrl = "https://gateway.example.com/.well-known/oauth-protected-resource";
		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === resourceMetadataUrl) {
					return new Response(
						JSON.stringify({
							resource: "https://gateway.example.com/mcp",
							authorization_servers: ["https://auth.example.com"],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "challenge-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const { controller, showError } = createController(authStorage);
		await controller.handleMCPAuthChallenge("envserver", {
			wwwAuthenticate: [`Bearer resource_metadata="${resourceMetadataUrl}" scope="orders.read"`],
		});
		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "fresh-access",
		});
	});

	test("/mcp reauth acquires a credential when the handshake succeeds but tools need OAuth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		// The anonymous handshake (`initialize`) succeeds; only `tools/call` is
		// gated behind OAuth. The unauthenticated probe must not treat this as
		// proof that reauthorization is unnecessary.
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							issuer: "https://mcp.example.com",
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "advertised-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockResolvedValue({
			access: "fresh-access",
			refresh: "fresh-refresh",
			expires: Date.now() + 3_600_000,
		});

		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			tokenUrl: "https://auth.example.com/token",
		});
	});

	test("prefers dynamic registration over a metadata-advertised client", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const registrationRequests: string[] = [];
		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							registration_endpoint: "https://auth.example.com/register",
							client_id: "advertised-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/register" && init?.method === "POST") {
					registrationRequests.push(String(init.body ?? ""));
					return new Response(JSON.stringify({ client_id: "dcr-client" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(registrationRequests).toHaveLength(1);
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("dcr-client");
		expect(tokenRequest?.get("client_id")).toBe("dcr-client");
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			clientId: "dcr-client",
		});
	});

	test("does not persist a whitespace-only embedded client id", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(
			new Error(
				'HTTP 401: {"authorization_url":"https://auth.example.com/authorize?client_id=%20%09","token_url":"https://auth.example.com/token"}',
			),
		);

		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				if (String(input) === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBeNull();
		expect(tokenRequest?.has("client_id")).toBe(false);
		const savedCredential = authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL)) as
			| oauthFlow.MCPStoredOAuthCredential
			| undefined;
		expect(savedCredential).toMatchObject({ type: "oauth", access: "fresh-access" });
		expect(savedCredential?.clientId).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		expect(saved.mcpServers?.envserver?.auth?.clientId).toBeUndefined();
	});

	test("uses configured OAuth scope when endpoint metadata omits scopes", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						oauth: { scope: "configured.read configured.write" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const fetchMock = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				if (String(input) === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1:53192/callback")).url;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("configured.read configured.write");
	});

	test("uses configured OAuth client credentials as a pair when discovery advertises another client", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						auth: { type: "oauth" },
						oauth: { clientId: "configured-client", clientSecret: "configured-secret" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		let tokenRequest: URLSearchParams | undefined;
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize?client_id=embedded-client",
							token_endpoint: "https://auth.example.com/token",
							client_id: "discovered-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequest = new URLSearchParams(String(init.body ?? ""));
					return new Response(
						JSON.stringify({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("configured-client");
		expect(tokenRequest?.get("client_id")).toBe("configured-client");
		expect(tokenRequest?.get("client_secret")).toBe("configured-secret");
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		expect(saved.mcpServers?.envserver?.auth).toEqual(
			expect.objectContaining({ clientId: "configured-client", clientSecret: "configured-secret" }),
		);
		expect(saved.mcpServers?.envserver?.oauth).toEqual(
			expect.objectContaining({ clientId: "configured-client", clientSecret: "configured-secret" }),
		);
	});

	test("does not persist or reuse a configured-only OAuth secret", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await Bun.write(
			configPath,
			JSON.stringify({
				mcpServers: {
					envserver: {
						type: "http",
						url: RAW_SERVER_URL,
						auth: { type: "oauth" },
						oauth: { clientId: " \t ", clientSecret: "configured-secret" },
					},
				},
			}),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);

		const tokenRequests: URLSearchParams[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
					return new Response(
						JSON.stringify({
							authorization_endpoint: "https://auth.example.com/authorize",
							token_endpoint: "https://auth.example.com/token",
							client_id: "discovered-client",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url === "https://auth.example.com/token" && init?.method === "POST") {
					tokenRequests.push(new URLSearchParams(String(init.body ?? "")));
					return new Response(
						JSON.stringify({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		const authorizationUrls: URL[] = [];
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrls.push(new URL((await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url));
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);

		const { controller, showError } = createController(authStorage);
		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authorizationUrls[0]?.searchParams.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[0]?.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[0]?.has("client_secret")).toBe(false);
		const savedAfterFirstReauth = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedAuth = savedAfterFirstReauth.mcpServers?.envserver?.auth;
		expect(savedAuth).toEqual(expect.objectContaining({ clientId: "discovered-client" }));
		expect(savedAuth?.clientSecret).toBeUndefined();
		expect(savedAfterFirstReauth.mcpServers?.envserver?.oauth?.clientId).toBeUndefined();

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authorizationUrls[1]?.searchParams.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[1]?.get("client_id")).toBe("discovered-client");
		expect(tokenRequests[1]?.has("client_secret")).toBe(false);
		const savedAfterSecondReauth = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedAuthAfterSecondReauth = savedAfterSecondReauth.mcpServers?.envserver?.auth;
		expect(savedAuthAfterSecondReauth).toEqual(expect.objectContaining({ clientId: "discovered-client" }));
		expect(savedAuthAfterSecondReauth?.clientSecret).toBeUndefined();
		expect(savedAfterSecondReauth.mcpServers?.envserver?.oauth?.clientId).toBeUndefined();
		expect(savedAfterSecondReauth.mcpServers?.envserver?.oauth?.clientSecret).toBe("configured-secret");
		const savedCredentialAfterSecond = authStorage.credentials.get(
			oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL),
		) as oauthFlow.MCPStoredOAuthCredential | undefined;
		expect(savedCredentialAfterSecond).toMatchObject({ clientId: "discovered-client" });
		expect(savedCredentialAfterSecond?.clientSecret).toBeUndefined();
	});

	test("reuses embedded DCR client secret during reauth token exchange", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await authStorage.credentials.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://auth.example.com/token",
			authorizationUrl: "https://auth.example.com/authorize?client_id=discovered-client",
			issuerUrl: "https://mcp.example.com",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
			resource: EXPANDED_SERVER_URL,
		} as oauthFlow.MCPStoredOAuthCredential);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
					const url = String(input);
					if (url === "https://mcp.example.com/.well-known/oauth-authorization-server") {
						return new Response(
							JSON.stringify({
								issuer: "https://mcp.example.com",
								authorization_endpoint: "https://auth.example.com/authorize?client_id=discovered-client",
								token_endpoint: "https://auth.example.com/token",
								client_id: "discovered-client",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					if (url === "https://auth.example.com/token" && init?.method === "POST") {
						return new Response(
							JSON.stringify({
								access_token: "fresh-access",
								refresh_token: "fresh-refresh",
								expires_in: 3600,
								token_type: "Bearer",
							}),
							{ status: 200, headers: { "Content-Type": "application/json" } },
						);
					}
					return new Response("not found", { status: 404 });
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		vi.spyOn(mcpClient, "connectToServer").mockResolvedValue({} as never);
		vi.spyOn(mcpClient, "disconnectServer").mockResolvedValue(undefined as never);
		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://127.0.0.1/callback")).url;
				return await this.exchangeToken("authorization-code", "state", "http://127.0.0.1/callback");
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("dcr-client");
		const tokenRequestCall = fetchSpy.mock.calls.find(
			call => String(call[0]) === "https://auth.example.com/token" && call[1]?.method === "POST",
		);
		const tokenRequestBody = String(tokenRequestCall?.[1]?.body ?? "");
		const tokenRequest = new URLSearchParams(tokenRequestBody);
		expect(tokenRequest.get("client_id")).toBe("dcr-client");
		expect(tokenRequest.get("client_secret")).toBe("dcr-secret");
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			clientId: "dcr-client",
			clientSecret: "dcr-secret",
		});
	});

	test("registers a fresh client when reauth uses an OS-assigned callback port", async () => {
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const server = saved.mcpServers?.envserver;
		if (!server) throw new Error("envserver fixture missing");
		server.oauth = { ...server.oauth, callbackPort: 0 };
		await Bun.write(configPath, `${JSON.stringify(saved, null, 2)}\n`);

		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await authStorage.credentials.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: "https://auth.example.com/token",
			clientId: "old-port-client",
			clientSecret: "old-port-secret",
			resource: EXPANDED_SERVER_URL,
		} as oauthFlow.MCPStoredOAuthCredential);
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		const registrations: Record<string, unknown>[] = [];
		const fetchMock = Object.assign(
			async (input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> => {
				const url = String(input);
				if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
					return new Response(JSON.stringify({ registration_endpoint: "https://auth.example.com/register" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				if (url === "https://auth.example.com/register") {
					registrations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return new Response(JSON.stringify({ client_id: "new-port-client", client_secret: "new-port-secret" }), {
						status: 201,
						headers: { "Content-Type": "application/json" },
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

		let authorizationUrl = "";
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: oauthFlow.MCPOAuthFlow) {
				authorizationUrl = (await this.generateAuthUrl("state", "http://localhost:53193/callback")).url;
				return {
					access: "fresh-access",
					refresh: "fresh-refresh",
					expires: Date.now() + 3_600_000,
				};
			},
		);
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(registrations).toEqual([expect.objectContaining({ redirect_uris: ["http://localhost:53193/callback"] })]);
		expect(new URL(authorizationUrl).searchParams.get("client_id")).toBe("new-port-client");
		expect(authorizationUrl).not.toContain("old-port-client");
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			type: "oauth",
			access: "fresh-access",
			clientId: "new-port-client",
			clientSecret: "new-port-secret",
		});
	});

	test("Esc aborts the OAuth flow during /mcp reauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulate the real flow: login hangs waiting for the OAuth callback and
		// only resolves when the controller's signal aborts. Mirrors what
		// OAuthCallbackFlow.#waitForCallback does in production.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			const pending = Promise.withResolvers<never>();
			this.ctrl.signal?.addEventListener("abort", () => {
				pending.reject(new Error(`OAuth callback cancelled: ${String(this.ctrl.signal?.reason ?? "aborted")}`));
			});
			return pending.promise;
		});

		const { controller, showError, showStatus, editor } = createController(authStorage);

		// Gate on #handleOAuthFlow installing its editor.onEscape hook.
		const escapeInstalled = whenEscapeInstalled(editor);
		const reauthPromise = controller.handle("/mcp reauth envserver");
		await escapeInstalled;
		expect(typeof editor.onEscape).toBe("function");

		const installedEscape = editor.onEscape;
		editor.onEscape?.();

		// Cancellation must resolve the reauth promise (well under the 5-minute
		// production timeout). Awaited directly rather than raced against a 2s
		// timer: a hung flow is already a failure via `bun test --timeout`, which
		// reports the test name, whereas a wall-clock race also fails correct code
		// that merely resolved late on a loaded runner.
		await reauthPromise;

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		// onEscape must be restored to its previous value so subsequent user
		// input does not keep aborting the (now-finished) flow.
		expect(editor.onEscape).not.toBe(installedEscape);
	});

	test("reauth supersedes an unfinished MCP OAuth flow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
		let loginAttempt = 0;
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(function (this: oauthFlow.MCPOAuthFlow) {
			loginAttempt += 1;
			if (loginAttempt > 1) {
				return Promise.resolve({
					access: "replacement-access",
					refresh: "replacement-refresh",
					expires: Date.now() + 3_600_000,
				});
			}

			const manualInputPromise = this.ctrl.onManualCodeInput?.();
			void manualInputPromise?.catch(() => {});
			const pending = Promise.withResolvers<never>();
			this.ctrl.signal?.addEventListener(
				"abort",
				() => {
					pending.reject(new Error(`OAuth callback cancelled: ${String(this.ctrl.signal?.reason ?? "aborted")}`));
				},
				{ once: true },
			);
			return pending.promise;
		});

		const { controller, ctx, showError, showStatus, editor, oauthManualInput } = createController(authStorage);
		const defaultOnEscape = editor.onEscape;
		// Event-gate the claim instead of polling to a wall-clock deadline: on a
		// loaded runner the old 1s budget could expire before the flow claimed the
		// manual-input slot, and the assertion below then read `undefined` from a
		// slot that was merely late. Resolving off `tryClaimInput` itself makes the
		// wait bounded by the event it is actually waiting for.
		const claimed = Promise.withResolvers<void>();
		const tryClaimInput = oauthManualInput.tryClaimInput.bind(oauthManualInput);
		vi.spyOn(oauthManualInput, "tryClaimInput").mockImplementation(providerId => {
			const result = tryClaimInput(providerId);
			if (result) claimed.resolve();
			return result;
		});
		const firstReauth = controller.handle("/mcp reauth envserver");
		await claimed.promise;
		expect(oauthManualInput.pendingProviderId).toBe("mcp");

		const replacementReauth = new MCPCommandController(ctx).handle("/mcp reauth envserver");
		await replacementReauth;
		if (oauthManualInput.hasPending()) editor.onEscape?.();
		await firstReauth;

		expect(loginAttempt).toBe(2);
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toMatchObject({
			access: "replacement-access",
		});

		// The replacement flow restored the session's default Esc handler, not
		// the superseded flow's dead one: after both flows unwind the editor
		// keeps interrupt/cancel-compaction semantics for the session.
		expect(editor.onEscape).toBe(defaultOnEscape);
	});

	test("Esc cancels even when OAuth login has not registered its signal listener yet", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Simulates the review race: Esc aborts oauthTimeout before
		// OAuthCallbackFlow.#waitForCallback has registered its abort listener
		// (e.g. during dynamic client registration or metadata discovery).
		// The login promise itself never observes ctrl.signal; #handleOAuthFlow
		// must race it against oauthTimeout.signal.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockReturnValue(Promise.withResolvers<never>().promise);
		const { controller, showError, showStatus, editor } = createController(authStorage);

		const escapeInstalled = whenEscapeInstalled(editor);
		const reauthPromise = controller.handle("/mcp reauth envserver");
		await escapeInstalled;
		expect(typeof editor.onEscape).toBe("function");
		editor.onEscape?.();

		await reauthPromise;

		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
	});

	test("OAuth deadline still surfaces as a reauthorization error, not a cancellation", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);

		// Deadline path bypasses both the editor's Esc hook and any external
		// signal: withTimeout aborts the controller with reason "MCP OAuth flow
		// timed out" and the login promise rejects with a "timed out" message.
		// Mirror that here. Keeping the surface distinct from the user-cancel
		// flag in #handleOAuthFlow is the whole point of this regression test.
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockRejectedValue(
			new Error("OAuth flow timed out after 5 minutes"),
		);
		const { controller, showError, showStatus } = createController(authStorage);

		await controller.handle("/mcp reauth envserver");

		// Deadline must read as "failed", not "cancelled" — they have different
		// surfaces (error banner vs status line) and the user expects a clear
		// timeout message rather than thinking they pressed Esc.
		expect(showStatus).not.toHaveBeenCalledWith(expect.stringMatching(/cancel/i));
		expect(showError).toHaveBeenCalledWith(expect.stringMatching(/timed out/i));
	});

	test("clears both expanded and stale raw URL-keyed credentials on unauth", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await authStorage.credentials.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "expanded-access",
			refresh: "expanded-refresh",
			expires: Date.now() + 3_600_000,
		});
		await authStorage.credentials.set(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL), {
			type: "oauth",
			access: "raw-access",
			refresh: "raw-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError } = createController(authStorage);

		await controller.handle("/mcp unauth envserver");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(RAW_SERVER_URL))).toBeUndefined();
		const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
		const savedServer = saved.mcpServers?.envserver;
		const savedUrl = savedServer?.type === "http" || savedServer?.type === "sse" ? savedServer.url : undefined;
		expect(savedUrl).toBe(RAW_SERVER_URL);
		expect(savedServer?.auth).toBeUndefined();
	});

	test("clears url-keyed auth for discovered definition-only servers", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		await authStorage.credentials.set(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL), {
			type: "oauth",
			access: "discovered-access",
			refresh: "discovered-refresh",
			expires: Date.now() + 3_600_000,
		});
		const { controller, showError } = createController(authStorage, {
			getServerConfig: vi.fn((): MCPServerConfig => ({ type: "http", url: EXPANDED_SERVER_URL })),
			getSource: vi.fn((): SourceMeta => ({
				provider: "test",
				providerName: "Test",
				path: "/tmp/discovered.json",
				level: "project",
			})),
		});

		await controller.handle("/mcp unauth discovered");

		expect(showError).not.toHaveBeenCalled();
		expect(authStorage.credentials.get(oauthFlow.mcpOAuthCredentialId(EXPANDED_SERVER_URL))).toBeUndefined();
		const userConfigPath = getMCPConfigPath("user", projectDir);
		const userConfig = JSON.parse(
			await Bun.file(userConfigPath)
				.text()
				.catch(() => "{}"),
		) as TestConfigFile;
		expect(userConfig.mcpServers?.discovered).toBeUndefined();
	});

	test("passes env-expanded OAuth client credentials to the reauth flow", async () => {
		const authStorage = freshAuthStorage();
		await authStorage.credentials.reload();
		const originalClientId = Bun.env.MCP_OAUTH_CLIENT_ID;
		const originalClientSecret = Bun.env.MCP_OAUTH_CLIENT_SECRET;
		Bun.env.MCP_OAUTH_CLIENT_ID = "expanded-client-id";
		Bun.env.MCP_OAUTH_CLIENT_SECRET = "expanded-client-secret";
		await Bun.write(
			configPath,
			`${JSON.stringify(
				{
					mcpServers: {
						envserver: {
							type: "http",
							url: RAW_SERVER_URL,
							oauth: {
								// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
								clientId: "${MCP_OAUTH_CLIENT_ID}",
								// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
								clientSecret: "${MCP_OAUTH_CLIENT_SECRET}",
							},
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		try {
			vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(AUTH_ERROR);
			let flowClientId: string | undefined;
			let flowClientSecret: string | undefined;
			vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
				async function (this: oauthFlow.MCPOAuthFlow) {
					// MCPOAuthFlow keeps its config private; read it back to assert the
					// resolved credentials the flow will use. Structurally known shape,
					// no runtime validation is meaningful here.
					const flow = this as unknown as { config: { clientId?: string; clientSecret?: string } };
					flowClientId = flow.config.clientId;
					flowClientSecret = flow.config.clientSecret;
					return {
						access: "fresh-access",
						refresh: "fresh-refresh",
						expires: Date.now() + 3_600_000,
					};
				},
			);
			const { controller, showError } = createController(authStorage);

			await controller.handle("/mcp reauth envserver");

			expect(showError).not.toHaveBeenCalled();
			// The token exchange must receive the resolved secret, not the literal
			// `${...}` placeholder.
			expect(flowClientId).toBe("expanded-client-id");
			expect(flowClientSecret).toBe("expanded-client-secret");

			// The config file keeps the placeholder; only the flow sees the value.
			const saved = JSON.parse(await Bun.file(configPath).text()) as TestConfigFile;
			const savedServer = saved.mcpServers?.envserver;
			// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
			expect(savedServer?.oauth?.clientSecret).toBe("${MCP_OAUTH_CLIENT_SECRET}");
			// oxlint-disable-next-line no-template-curly-in-string -- test placeholder string for env expansion
			expect(savedServer?.oauth?.clientId).toBe("${MCP_OAUTH_CLIENT_ID}");
		} finally {
			restoreEnvValue("MCP_OAUTH_CLIENT_ID", originalClientId);
			restoreEnvValue("MCP_OAUTH_CLIENT_SECRET", originalClientSecret);
		}
	});
});
