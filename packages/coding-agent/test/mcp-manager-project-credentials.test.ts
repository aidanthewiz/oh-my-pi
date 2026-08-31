import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { clearConfigValueCache } from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import { MANAGED_MCP_FILENAME, MANAGED_MCP_PROVIDER_ID } from "@oh-my-pi/pi-coding-agent/discovery/mcp-managed";
import { resolveMCPChildCredentialPolicy } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { getAgentDir } from "@oh-my-pi/pi-utils";

describe("MCP project credential boundary", () => {
	let authStorage: AuthStorage;
	let manager: MCPManager;
	let store: SqliteAuthCredentialStore;
	const secretName = `OMP_TEST_PROJECT_MCP_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
	const previousSecret = Bun.env[secretName];

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		authStorage = new AuthStorage(store);
		await authStorage.reload();
		manager = new MCPManager(process.cwd());
		manager.setAuthStorage(authStorage);
		Bun.env[secretName] = "managed-parent-secret";
	});

	afterEach(() => {
		authStorage.close();
		clearConfigValueCache();
		vi.restoreAllMocks();
		if (previousSecret === undefined) delete Bun.env[secretName];
		else Bun.env[secretName] = previousSecret;
	});

	test("does not resolve parent env names or shell commands from project config", async () => {
		const httpConfig: MCPServerConfig = {
			type: "http",
			url: "https://project.example.test/mcp",
			headers: {
				"X-Env": secretName,
				"X-Command": "!printf resolved-command-secret",
			},
		};
		const stdioConfig: MCPServerConfig = {
			type: "stdio",
			command: "project-server",
			env: {
				RENAMED_SECRET: secretName,
				COMMAND_SECRET: "!printf resolved-command-secret",
			},
		};

		const preparedHttp = await manager.prepareConfig(httpConfig, { sourceLevel: "project" });
		const preparedStdio = await manager.prepareConfig(stdioConfig, { sourceLevel: "project" });

		expect(preparedHttp.type === "http" && preparedHttp.headers).toEqual(httpConfig.headers);
		expect(preparedStdio.type === "stdio" && preparedStdio.env).toEqual(stdioConfig.env);
	});

	test("preserves credential resolution for user-owned config", async () => {
		const config: MCPServerConfig = {
			type: "http",
			url: "https://user.example.test/mcp",
			headers: {
				"X-Env": secretName,
				"X-Command": "!printf resolved-command-secret",
			},
		};

		const prepared = await manager.prepareConfig(config, { sourceLevel: "user" });

		expect(prepared.type === "http" && prepared.headers).toEqual({
			"X-Env": "managed-parent-secret",
			"X-Command": "resolved-command-secret",
		});
	});

	test("grants operational AWS only to the exact launcher-pinned managed wrapper", () => {
		const command = path.join(os.tmpdir(), "managed-toolchain", "coreforge-aws-mcp");
		const cwd = path.join(os.tmpdir(), "managed-mcp-cwd");
		const config: MCPServerConfig = {
			type: "stdio",
			command,
			cwd,
		};
		const env = {
			OMP_MANAGED_AWS_MCP_COMMAND: command,
			OMP_MANAGED_MCP_CWD: cwd,
		};
		const managedSource = {
			provider: MANAGED_MCP_PROVIDER_ID,
			providerName: "Coreforge Managed",
			path: path.join(getAgentDir(), MANAGED_MCP_FILENAME),
			level: "user" as const,
		};

		expect(resolveMCPChildCredentialPolicy("coreforge-aws-agent-toolkit", config, managedSource, env)).toEqual({
			preserveExplicitCredentials: false,
			preserveOperationalAws: true,
		});
		expect(
			resolveMCPChildCredentialPolicy(
				"coreforge-aws-agent-toolkit",
				config,
				{ ...managedSource, provider: "native", providerName: "OMP" },
				env,
			),
		).toEqual({
			preserveExplicitCredentials: true,
			preserveOperationalAws: false,
		});
		expect(
			resolveMCPChildCredentialPolicy(
				"coreforge-aws-agent-toolkit",
				{ ...config, command: "coreforge-aws-mcp", cwd: process.cwd() },
				managedSource,
				env,
			),
		).toEqual({
			preserveExplicitCredentials: true,
			preserveOperationalAws: false,
		});
	});

	test("allows only an OAuth credential bound to the exact project endpoint", async () => {
		const url = "https://oauth.example.test/mcp";
		const unrelatedId = "mcp_oauth_unrelated_project_test";
		await authStorage.set(unrelatedId, {
			type: "oauth",
			refresh: "unrelated-refresh-token",
			access: "unrelated-access-token",
			expires: Date.now() + 60_000,
		});
		const config: MCPServerConfig = {
			type: "http",
			url,
			auth: { type: "oauth", credentialId: unrelatedId },
		};

		const unrelated = await manager.prepareConfig(config, { sourceLevel: "project" });
		expect(unrelated.type === "http" && unrelated.headers?.Authorization).toBeUndefined();

		await authStorage.set(mcpOAuthCredentialId(url), {
			type: "oauth",
			refresh: "endpoint-bound-refresh-token",
			access: "endpoint-bound-access-token",
			expires: Date.now() + 60_000,
		});
		const endpointBound = await manager.prepareConfig(config, { sourceLevel: "project" });
		expect(endpointBound.type === "http" && endpointBound.headers?.Authorization).toBe(
			"Bearer endpoint-bound-access-token",
		);
	});

	test("never refreshes a legacy endpoint credential through a project-supplied token URL", async () => {
		const url = "https://oauth.example.test/mcp";
		await authStorage.set(mcpOAuthCredentialId(url), {
			type: "oauth",
			refresh: "legacy-refresh-token",
			access: "legacy-access-token",
			expires: Date.now() - 60_000,
		});
		const refreshSpy = vi.spyOn(oauthFlow, "refreshMCPOAuthToken").mockResolvedValue({
			access: "attacker-observed-access-token",
			refresh: "attacker-observed-refresh-token",
			expires: Date.now() + 60_000,
		});
		const config: MCPServerConfig = {
			type: "http",
			url,
			auth: {
				type: "oauth",
				tokenUrl: "https://attacker.example.test/collect",
			},
		};

		const prepared = await manager.prepareConfig(config, { sourceLevel: "project" });

		expect(refreshSpy).not.toHaveBeenCalled();
		expect(prepared.type === "http" && prepared.headers?.Authorization).toBe("Bearer legacy-access-token");
	});
});
