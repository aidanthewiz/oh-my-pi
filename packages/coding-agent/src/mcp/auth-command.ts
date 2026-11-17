import * as readline from "node:readline";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getMCPConfigPath, getProjectDir, sanitizeText, untilAborted } from "@oh-my-pi/pi-utils";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import type { SourceMeta } from "../capability/types";
import { CF_COMMAND } from "../cli/cf-version";
import { promptLine } from "../cli/oauth-terminal";
import { Settings } from "../config/settings";
import { initializeWithSettings } from "../discovery";
import { expandEnvVarsDeepForConfigLevel } from "../discovery/helpers";
import { cfgExtensions } from "../extensibility/settings";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { openPath } from "../utils/open";
import { connectToServer, disconnectServer, listTools } from "./client";
import { loadAllMCPConfigs, resolveMCPChildCredentialPolicy, validateServerConfig } from "./config";
import { readMCPConfigFile, validateServerName } from "./config-writer";
import { MCPManager } from "./manager";
import { analyzeAuthError } from "./oauth-discovery";
import {
	lookupMcpOAuthCredential,
	lookupProjectMcpOAuthCredential,
	refreshStoredManagedMcpOAuthCredential,
} from "./oauth-credentials";
import { type FoundMcpServer, MCPOAuthCancelledError, reauthorizeMcpServer } from "./oauth-reauth";
import { cfgMcpDiscoveryProviders, cfgMcpEnableProjectConfig } from "./settings";
import type { MCPServerConfig } from "./types";

type AuthTarget = { name: string; config: MCPServerConfig; source: SourceMeta; found: FoundMcpServer };
type ExitCode = 0 | 1 | 2 | 130;

class McpRefreshUnavailableError extends Error {}

function message(error: unknown): string {
	return sanitizeText(error instanceof Error ? error.message : String(error));
}

function authRemedy(name: string, action = "auth"): string {
	return `${CF_COMMAND} mcp ${action} ${JSON.stringify(name)}`;
}

function credentialFor(target: AuthTarget, storage: AuthStorage) {
	return target.source.level === "project"
		? lookupProjectMcpOAuthCredential(storage, target.config)
		: lookupMcpOAuthCredential(storage, target.config);
}

function needsAuthentication(error: unknown, config: MCPServerConfig): boolean {
	if (error instanceof McpRefreshUnavailableError) return false;
	const failure = error instanceof Error ? error : new Error(message(error));
	const status = AIError.status(failure);
	if (status === 403 && !/\berror\s*=\s*"insufficient_scope"/i.test(failure.message)) return false;
	return analyzeAuthError(failure, "url" in config ? config.url : undefined).requiresAuth;
}

async function findTarget(name: string, config: MCPServerConfig, source: SourceMeta, cwd: string): Promise<AuthTarget> {
	const writableSource =
		source.provider === "native" ||
		source.provider === "mcp-json" ||
		(source.provider === "coreforge" && source.level !== "project");
	const rawConfig =
		source.path && (writableSource || source.provider === "mcp-managed" || source.provider === "coreforge")
			? (await readMCPConfigFile(source.path)).mcpServers?.[name]
			: undefined;
	return {
		name,
		config,
		source,
		found: {
			config: rawConfig ?? config,
			filePath: writableSource && rawConfig && source.path ? source.path : getMCPConfigPath("user", cwd),
			scope: writableSource && source.level === "project" ? "project" : "user",
			sourceLevel: source.level,
			source,
			profileIdentity: getActiveProfile() ?? "default",
			discovered: !writableSource || !rawConfig,
		},
	};
}

async function verifyConnection(target: AuthTarget, manager: MCPManager, signal: AbortSignal): Promise<void> {
	const config = await manager.prepareConfig(target.config, { sourceLevel: target.source.level, signal });
	const connection = await connectToServer(target.name, config, {
		signal,
		...resolveMCPChildCredentialPolicy(target.name, config, target.source),
	});
	try {
		await listTools(connection, { signal });
		signal.throwIfAborted();
	} finally {
		await disconnectServer(connection);
	}
}

async function verifyExistingGrant(
	target: AuthTarget,
	manager: MCPManager,
	storage: AuthStorage,
	signal: AbortSignal,
): Promise<void> {
	try {
		await verifyConnection(target, manager, signal);
	} catch (error) {
		signal.throwIfAborted();
		const credential = credentialFor(target, storage);
		if (!credential || !(error instanceof Error) || AIError.status(error) !== 401) throw error;
		let refreshFailure: unknown;
		const refreshed = await untilAborted(signal, () =>
			refreshStoredManagedMcpOAuthCredential(storage, credential.credentialId, {
				serverUrl: "url" in target.config ? target.config.url : undefined,
				auth: target.source.level === "project" ? undefined : target.config.auth,
				forceRefresh: true,
				keepCredentialOnRefreshFailure: true,
				onRefreshFailure: failure => {
					refreshFailure = failure;
				},
			}),
		);
		if (!refreshed.removed && refreshFailure !== undefined) {
			throw new McpRefreshUnavailableError(
				`OAuth refresh temporarily failed: ${message(refreshFailure)}. Retry after restoring the authorization service.`,
			);
		}
		if (!refreshed.refreshed) throw error;
		await verifyConnection(target, manager, signal);
	}
}

async function authorize(target: AuthTarget, storage: AuthStorage, cwd: string, controller: AbortController) {
	let terminal: readline.Interface | undefined;
	const cancel = () => controller.abort(new MCPOAuthCancelledError());
	try {
		return await reauthorizeMcpServer(target.name, target.found, {
			authStorage: storage,
			effectiveEnabled: true,
			effectiveTransport: target.config.type,
			cwd,
			signal: controller.signal,
			onAuth({ url, instructions }) {
				controller.signal.throwIfAborted();
				process.stdout.write(`\n${target.name}: Open this URL to sign in:\n${url}\n`);
				if (instructions) process.stdout.write(`${sanitizeText(instructions)}\n`);
				openPath(url);
			},
			onProgress(progress) {
				process.stdout.write(`${target.name}: ${sanitizeText(progress)}\n`);
			},
			onManualCodeInput(signal) {
				terminal ??= readline.createInterface({ input: process.stdin, output: process.stdout });
				return promptLine(terminal, "Paste the authorization code or redirect URL (Esc to cancel): ", signal).catch(
					error => {
						if (!signal?.aborted && /cancelled|stdin closed/i.test(message(error))) cancel();
						throw error;
					},
				);
			},
		});
	} finally {
		terminal?.close();
	}
}

export async function runMcpAuthCommand(options: {
	action: "auth" | "reauth";
	names: string[];
	check: boolean;
}): Promise<ExitCode> {
	const cwd = getProjectDir();
	let targets: AuthTarget[];
	let settings: Settings;
	try {
		settings = await Settings.loadReadOnly({ cwd });
		initializeWithSettings(settings);
		const { configs, sources } = await loadAllMCPConfigs(cwd, {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
			discoveryProviders: cfgMcpDiscoveryProviders.get(settings),
			filterExa: true,
			filterBrowser: false,
			extensionRoots: {
				explicit: [],
				mode: "merge",
				configured: cfgExtensions.get(settings),
				configuredLevel: settings.extensionsSourceLevel(),
			},
		});
		const names = options.names.length
			? options.names
			: Object.keys(configs).filter(name => configs[name]!.type === "http" || configs[name]!.type === "sse");
		for (const name of names) {
			const nameError = validateServerName(name);
			if (nameError) throw new Error(`Invalid server name "${name}": ${nameError}`);
			const config = configs[name];
			if (!config || config.enabled === false || !sources[name]) {
				throw new Error(
					`Server "${name}" is unknown, disabled, or unavailable under the current discovery/trust settings. Select and trust it before authenticating.`,
				);
			}
			if (config.type !== "http" && config.type !== "sse") {
				throw new Error(
					`Server "${name}" uses stdio and manages credentials externally. Use its CLI authentication command.`,
				);
			}
			const errors = validateServerConfig(name, config);
			if (errors.length) throw new Error(errors.join("; "));
		}
		targets = await Promise.all(names.map(name => findTarget(name, configs[name]!, sources[name]!, cwd)));
	} catch (error) {
		process.stderr.write(`error: ${message(error)}\n`);
		return 2;
	}

	if (targets.length === 0) {
		process.stdout.write("No selected hosted MCP servers.\n");
		return 0;
	}
	const interactive = !options.check && Boolean(process.stdin.isTTY && process.stdout.isTTY);
	if (options.action === "reauth" && !interactive) {
		process.stderr.write(
			`${targets[0]!.name}: interaction-required; run ${authRemedy(targets[0]!.name, "reauth")} in an interactive terminal.\n`,
		);
		return 1;
	}

	const controller = new AbortController();
	const cancel = () => controller.abort(new MCPOAuthCancelledError());
	process.on("SIGINT", cancel);
	let storage: AuthStorage | undefined;
	const manager = new MCPManager(cwd);
	let exitCode: ExitCode = 0;
	try {
		storage = await discoverAuthStorage(undefined, { settings, cwd });
		manager.setAuthStorage(storage);
		for (const target of targets) {
			let grantSaved = false;
			try {
				controller.signal.throwIfAborted();
				if (options.action === "auth") {
					try {
						await verifyExistingGrant(target, manager, storage, controller.signal);
						process.stdout.write(
							`${target.name}: connection-verified${credentialFor(target, storage) ? "; OAuth grant accepted" : ""}.\n`,
						);
						continue;
					} catch (error) {
						controller.signal.throwIfAborted();
						if (!needsAuthentication(error, target.config)) throw error;
						if (!interactive || target.config.auth?.type === "apikey") {
							process.stderr.write(
								`${target.name}: authentication-required; ${target.config.auth?.type === "apikey" ? "configure the server's API key" : `run ${authRemedy(target.name)} in an interactive terminal`}.\n${message(error)}\n`,
							);
							exitCode = 1;
							continue;
						}
					}
				}
				const outcome = await authorize(target, storage, cwd, controller);
				grantSaved = true;
				const config = expandEnvVarsDeepForConfigLevel(
					outcome.config,
					target.source.level === "project" ? "project" : "user",
				);
				await verifyConnection(
					{ ...target, config: { ...config, type: target.config.type, enabled: true } as MCPServerConfig },
					manager,
					controller.signal,
				);
				process.stdout.write(`${target.name}: grant-saved; connection-verified.\n`);
			} catch (error) {
				if (controller.signal.aborted || error instanceof MCPOAuthCancelledError) {
					process.stderr.write(
						`${target.name}: cancelled; ${grantSaved ? "grant-saved; connection-unverified" : "authentication was not completed"}.\n`,
					);
					return 130;
				}
				process.stderr.write(
					`${target.name}: ${grantSaved ? "grant-saved; connection-unverified" : "connection-failed"}; ${message(error)}\n`,
				);
				exitCode = 1;
			}
		}
	} catch (error) {
		process.stderr.write(`error: ${message(error)}\n`);
		exitCode = controller.signal.aborted ? 130 : 1;
	} finally {
		process.off("SIGINT", cancel);
		try {
			await manager.disconnectAll();
		} finally {
			await storage?.close();
		}
	}
	return exitCode;
}
