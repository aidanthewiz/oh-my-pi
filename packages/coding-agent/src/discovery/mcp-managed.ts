/**
 * Managed MCP Provider
 *
 * Discovers org-managed MCP server definitions from `<agentDir>/mcp.managed.json`.
 * The file is a read-only distribution artifact (symlinked/copied into the
 * profile by an installer, e.g. Coreforge); the engine never writes it.
 *
 * Ownership split: this file carries DEFINITIONS only. User STATE stays in the
 * user-owned `mcp.json` — the `disabledServers` denylist, the `enabledServers`
 * allowlist, and per-server `enabled` toggles written by `/mcp enable|disable`
 * all apply on top (see `loadAllMCPConfigs`). `disabledServers`/`enabledServers`
 * keys inside this file are intentionally ignored.
 *
 * Priority: 110 — above native (100) so a managed definition wins name
 * collisions against every other source; the user state filters above still
 * run post-dedup, so users keep control over what actually connects.
 */
import * as path from "node:path";
import { getAgentDir, logger, tryParseJson } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { createSourceMeta, expandEnvVarsDeep } from "./helpers";

const PROVIDER_ID = "mcp-managed";
const DISPLAY_NAME = "Coreforge Managed";
export const MANAGED_MCP_FILENAME = "mcp.managed.json";

/** Same wire shape as mcp.json's `mcpServers` map (state keys ignored). */
interface ManagedMCPConfigFile {
	mcpServers?: Record<
		string,
		{
			enabled?: boolean;
			timeout?: number;
			command?: string;
			args?: string[];
			env?: Record<string, string>;
			cwd?: string;
			url?: string;
			headers?: Record<string, string>;
			auth?: {
				type: "oauth" | "apikey";
				credentialId?: string;
				tokenUrl?: string;
				clientId?: string;
				clientSecret?: string;
			};
			type?: "stdio" | "sse" | "http";
			oauth?: {
				clientId?: string;
				clientSecret?: string;
				redirectUri?: string;
				callbackPort?: number;
				callbackPath?: string;
				prompt?: string;
			};
		}
	>;
}

function transformManagedConfig(config: ManagedMCPConfigFile, source: SourceMeta): MCPServer[] {
	const servers: MCPServer[] = [];

	if (config.mcpServers) {
		for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
			// Runtime type validation for file-controlled JSON values
			let enabled: boolean | undefined;
			if (serverConfig.enabled !== undefined) {
				if (typeof serverConfig.enabled === "boolean") {
					enabled = serverConfig.enabled;
				} else {
					logger.warn("Managed MCP server has invalid 'enabled' value, ignoring", {
						name,
						value: serverConfig.enabled,
					});
				}
			}

			let timeout: number | undefined;
			if (serverConfig.timeout !== undefined) {
				if (
					typeof serverConfig.timeout === "number" &&
					Number.isFinite(serverConfig.timeout) &&
					serverConfig.timeout >= 0
				) {
					timeout = serverConfig.timeout;
				} else {
					logger.warn("Managed MCP server has invalid 'timeout' value, ignoring", {
						name,
						value: serverConfig.timeout,
					});
				}
			}

			const server: MCPServer = {
				name,
				enabled,
				timeout,
				command: serverConfig.command,
				args: serverConfig.args,
				env: serverConfig.env,
				cwd: serverConfig.cwd,
				url: serverConfig.url,
				headers: serverConfig.headers,
				auth: serverConfig.auth,
				oauth: serverConfig.oauth,
				transport: serverConfig.type,
				_source: source,
			};

			// Expand ${VAR} / ${VAR:-default} placeholders
			if (server.command) server.command = expandEnvVarsDeep(server.command);
			if (server.args) server.args = expandEnvVarsDeep(server.args);
			if (server.env) server.env = expandEnvVarsDeep(server.env);
			if (server.cwd) server.cwd = expandEnvVarsDeep(server.cwd);
			if (server.url) server.url = expandEnvVarsDeep(server.url);
			if (server.headers) server.headers = expandEnvVarsDeep(server.headers);
			if (server.auth) server.auth = expandEnvVarsDeep(server.auth);
			if (server.oauth) server.oauth = expandEnvVarsDeep(server.oauth);
			servers.push(server);
		}
	}

	return servers;
}

async function load(_ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const warnings: string[] = [];
	const items: MCPServer[] = [];

	// Profile-scoped like the native user config: getAgentDir() points at the
	// active profile's agent directory, not the literal home.
	const filePath = path.join(getAgentDir(), MANAGED_MCP_FILENAME);
	const content = await readFile(filePath);
	if (content === null) {
		// Missing file = feature unused; byte-identical upstream behavior.
		return { items, warnings: undefined };
	}

	const config = tryParseJson<ManagedMCPConfigFile>(content);
	if (!config) {
		warnings.push(`Failed to parse JSON in ${filePath}`);
		return { items, warnings };
	}

	const source = createSourceMeta(PROVIDER_ID, filePath, "user");
	items.push(...transformManagedConfig(config, source));

	return { items, warnings: warnings.length > 0 ? warnings : undefined };
}

// Register provider — above native (100) so managed definitions win name
// collisions; user disable/enable state still applies post-dedup.
registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Org-managed MCP server definitions from <agentDir>/mcp.managed.json",
	priority: 110,
	load,
});
