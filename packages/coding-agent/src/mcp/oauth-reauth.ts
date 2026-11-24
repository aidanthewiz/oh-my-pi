/**
 * UI-agnostic MCP OAuth reauthorization engine.
 *
 * Both the interactive `McpCommandController` and the shared ACP/text
 * `/mcp` dispatcher drive `/mcp reauth` through this module so the flow can
 * never drift between clients: server lookup precedence (project over user —
 * matching runtime discovery's first-wins enumeration — plus standalone
 * `mcp.json`/`.mcp.json` fallbacks), the anonymous connection
 * probe, endpoint discovery, client-credential assembly (configured >
 * persisted > stored > metadata-advertised, DCR preferred), the browser flow
 * itself, and the persistence policy (url-keyed credential row, `auth` block
 * pointer, only user-supplied secrets written back) live here exactly once.
 * Callers supply only presentation: how the authorization URL and progress are
 * shown, and (TUI only) where manual code input comes from.
 */
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getMCPConfigPath, getProjectDir, toError } from "@oh-my-pi/pi-utils";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import type { OAuthController } from "@oh-my-pi/pi-ai/oauth/types";
import { expandEnvVarsDeepForConfigLevel } from "../discovery/helpers";
import type { SourceMeta } from "../capability/types";
import { COREFORGE_MCP_PROVIDER_ID } from "../discovery/coreforge";
import { MANAGED_MCP_PROVIDER_ID } from "../discovery/mcp-managed";
import { connectToServer, disconnectServer } from "./client";
import { readMCPConfigFile, updateMCPServer } from "./config-writer";
import { loadAllMCPConfigs, resolveMCPChildCredentialPolicy } from "./config";
import { MCPManager } from "./manager";
import {
	analyzeAuthError,
	discoverOAuthEndpoints,
	fetchResourceMetadataScopes,
	type OAuthEndpoints,
	preserveOAuthDiscoveryHints,
	validateOAuthResourceMetadataUrl,
} from "./oauth-discovery";
import {
	hasMcpAuthorizationHeader,
	lookupMcpOAuthCredentialForServer,
	lookupProjectMcpOAuthCredential,
	removeManagedMcpOAuthCredential,
} from "./oauth-credentials";
import {
	MCPOAuthClientIdRequiredError,
	MCPOAuthFlow,
	type MCPStoredOAuthCredential,
	mcpOAuthCredentialId,
} from "./oauth-flow";
import type { AuthStorage } from "../session/auth-storage";
import type { MCPAuthChallenge, MCPAuthConfig, MCPServerConfig } from "./types";

export function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
	onTimeout?: () => void,
): Promise<T> {
	const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => {
		onTimeout?.();
		reject(new Error(message));
	}, timeoutMs);
	return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * Reject as soon as `signal` aborts, even when `promise` cannot observe it
 * (e.g. an in-flight `fetch` before the flow's own callback wait starts).
 * `promise` stays observed, so its later rejection is never unhandled.
 */
export function raceAbortSignal<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	createError: () => Error,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) {
		void promise.catch(() => {});
		return Promise.reject(createError());
	}

	const aborted = Promise.withResolvers<never>();
	const onAbort = (): void => aborted.reject(createError());
	signal.addEventListener("abort", onAbort, { once: true });
	return Promise.race([promise, aborted.promise]).finally(() => {
		signal.removeEventListener("abort", onAbort);
	});
}

type ActiveMCPOAuthFlow = {
	cancel: (reason: string) => void;
	completion: Promise<void>;
	complete: () => void;
};

type MCPOAuthFlowCoordinator = {
	active?: ActiveMCPOAuthFlow;
	transition: Promise<void>;
};

const mcpOAuthFlowCoordinators = new WeakMap<object, MCPOAuthFlowCoordinator>();
const MCP_OAUTH_SUPERSEDED_REASON = "MCP OAuth flow superseded by a new login";
/** Default single-flight key for hosts without a stable manual-input owner (ACP/RPC/text). */
const defaultMcpOAuthFlowOwner: object = {};

/**
 * Serialize MCP OAuth ownership across invocations: a new flow cancels the
 * active one, and concurrent starters queue behind the running transition.
 * The interactive TUI keys this on its manual-input manager (stable for the
 * session while command controllers are per-command); other hosts share the
 * module-level owner.
 */
async function claimMCPOAuthFlow(
	owner: object,
	cancel: (reason: string) => void,
	signal?: AbortSignal,
): Promise<{ release: () => void }> {
	let coordinator = mcpOAuthFlowCoordinators.get(owner);
	if (!coordinator) {
		coordinator = { transition: Promise.resolve() };
		mcpOAuthFlowCoordinators.set(owner, coordinator);
	}

	const precedingTransition = coordinator.transition;
	const transition = Promise.withResolvers<void>();
	coordinator.transition = transition.promise;
	await precedingTransition;

	try {
		if (signal?.aborted) throw new MCPOAuthCancelledError();
		const active = coordinator.active;
		if (active) {
			active.cancel(MCP_OAUTH_SUPERSEDED_REASON);
			await active.completion;
		}
		if (signal?.aborted) throw new MCPOAuthCancelledError();

		const completion = Promise.withResolvers<void>();
		const flow: ActiveMCPOAuthFlow = {
			cancel,
			completion: completion.promise,
			complete: () => completion.resolve(),
		};
		coordinator.active = flow;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				if (coordinator.active === flow) coordinator.active = undefined;
				flow.complete();
			},
		};
	} finally {
		transition.resolve();
	}
}

export interface OAuthFlowResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

/**
 * Thrown when the user (or a caller-supplied {@link AbortSignal}) cancels the
 * in-flight flow. Distinct from network/timeout failures so callers can
 * surface a neutral "cancelled" status instead of an error banner.
 */
export class MCPOAuthCancelledError extends Error {
	constructor(message = "OAuth flow cancelled") {
		super(message);
		this.name = "MCPOAuthCancelledError";
	}
}

/**
 * User-actionable refusal (stdio transport, disabled server, anonymous
 * server, …): the message is the guidance itself, so non-interactive callers
 * surface it verbatim instead of wrapping it in a failure prefix.
 */
export class McpReauthRefusalError extends Error {}

export interface FoundMcpServer {
	filePath: string;
	scope: "user" | "project";
	config: MCPServerConfig;
	profileIdentity?: string;
	sourceLevel?: SourceMeta["level"];
	source?: SourceMeta;
	/** Live-manager entry that lives in no writable config file; writes go to user scope. */
	discovered: boolean;
	/**
	 * The manager entry belongs to an ACP-isolated session: the client declared
	 * this server at `session/new` and re-declares it (headers included) every
	 * session, so its definition is session-owned — never a candidate for
	 * user-config write-back.
	 */
	acpOwned?: boolean;
}

/**
 * Resolve a server for an auth/test operation. Project wins over user on a
 * name collision — runtime discovery enumerates project paths first and
 * deduplicates first-wins, so the project entry is the server actually
 * invoked — then falls back to standalone `mcp.json` / `.mcp.json` (the
 * mcp-json discovery paths), then to runtime-discovered servers (`/mcp list`
 * surfaces marketplace/Claude-Code-plugin entries that live in no writable
 * config). For a discovered server, persisted changes are written into the
 * user config under the same namespaced name; the native provider
 * (priority 100) shadows lower-priority discovered entries after the next reload.
 *
 * Managed and trusted Coreforge project sources remain authoritative over writable user shadows.
 *
 * `preferManager` flips the first step — but only for ACP-isolated managers:
 * ACP declares servers at `session/new` (source `provider: "acp"`), and
 * isolation means the manager entry is the server actually active while a
 * same-named file entry is inert. Print/RPC managers enumerate the same files
 * the lookup below reads, and their entries are env-expanded copies with
 * synthesized user-config paths — preferring them would shadow the real
 * project/user source, serialize expanded `${...}` placeholders, and write
 * fresh bindings to the wrong file.
 */
export async function findMcpServerForAuth(
	name: string,
	cwd: string = getProjectDir(),
	mcpManager?: MCPManager,
	options?: { preferManager?: boolean; enableProjectConfig?: boolean },
): Promise<FoundMcpServer | null> {
	const profileIdentity = getActiveProfile() ?? "default";
	if (options?.preferManager) {
		const managerConfig = mcpManager?.getServerConfig(name);
		const managerSource = mcpManager?.getSource(name);
		if (managerConfig && managerSource?.provider === "acp") {
			return {
				filePath: getMCPConfigPath("user", cwd),
				scope: "user",
				config: managerConfig,
				sourceLevel: managerSource.level,
				source: managerSource,
				discovered: true,
				acpOwned: true,
				profileIdentity,
			};
		}
	}
	const userPath = getMCPConfigPath("user", cwd);
	const projectPath = getMCPConfigPath("project", cwd);

	// Project files stay excluded unless the loader verifies the selected Coreforge source below.
	const enableProjectConfig = options?.enableProjectConfig ?? true;
	const [userConfig, projectConfig] = await Promise.all([
		readMCPConfigFile(userPath),
		enableProjectConfig ? readMCPConfigFile(projectPath) : Promise.resolve(null),
	]);
	if ((getActiveProfile() ?? "default") !== profileIdentity) throw new MCPOAuthCancelledError();

	const runtimeSource = mcpManager?.getSource(name);
	if (
		runtimeSource &&
		(runtimeSource.provider === MANAGED_MCP_PROVIDER_ID ||
			(runtimeSource.provider === COREFORGE_MCP_PROVIDER_ID && runtimeSource.level === "project"))
	) {
		const selected = await loadAllMCPConfigs(cwd, {
			enableProjectConfig,
			discoveryProviders: [runtimeSource.provider],
			filterExa: false,
		});
		if ((getActiveProfile() ?? "default") !== profileIdentity) throw new MCPOAuthCancelledError();
		const selectedSource = selected.sources[name];
		const selectedConfig = selected.configs[name];
		if (
			!selectedSource ||
			!selectedConfig ||
			selectedSource.provider !== runtimeSource.provider ||
			selectedSource.path !== runtimeSource.path ||
			selectedSource.level !== runtimeSource.level ||
			selectedSource.contentSha256 !== runtimeSource.contentSha256 ||
			!matchingManagerServerConfig(mcpManager, name, selectedConfig)
		)
			return null;
		return {
			filePath: userPath,
			scope: "user",
			profileIdentity,
			sourceLevel: runtimeSource.level,
			source: runtimeSource,
			config: selectedConfig,
			discovered: true,
		};
	}

	// Project wins over user on a name collision: runtime discovery enumerates
	// project paths first and deduplicates first-wins, so the project entry is
	// the server users actually invoke. Refreshing the user shadow instead
	// would report success while the active project server keeps its stale
	// credential after the next reload.
	if (enableProjectConfig && projectConfig?.mcpServers?.[name]) {
		return {
			filePath: projectPath,
			scope: "project",
			profileIdentity,
			sourceLevel: "project",
			source: { provider: "native", providerName: "OMP", path: projectPath, level: "project" },
			config: projectConfig.mcpServers[name],
			discovered: false,
		};
	}
	if (userConfig.mcpServers?.[name]) {
		return {
			filePath: userPath,
			scope: "user",
			profileIdentity,
			sourceLevel: "user",
			source: { provider: "native", providerName: "OMP", path: userPath, level: "user" },
			config: userConfig.mcpServers[name],
			discovered: false,
		};
	}

	// Standalone fallback files match the discovery paths used by the
	// mcp-json provider; precedence is preserved by iteration order. Both are
	// project-level sources, so the same `enableProjectConfig` opt-out applies.
	const standalonePaths = enableProjectConfig ? [path.join(cwd, "mcp.json"), path.join(cwd, ".mcp.json")] : [];
	const fallbackConfigs = await Promise.all(
		standalonePaths.map(async fallbackPath => {
			try {
				return await readMCPConfigFile(fallbackPath);
			} catch {
				// Malformed JSON in a standalone file — skip and continue lookup.
				return null;
			}
		}),
	);
	if ((getActiveProfile() ?? "default") !== profileIdentity) throw new MCPOAuthCancelledError();
	for (const [index, fallbackConfig] of fallbackConfigs.entries()) {
		const config = fallbackConfig?.mcpServers?.[name];
		if (config) {
			return {
				filePath: standalonePaths[index]!,
				scope: "project",
				profileIdentity,
				sourceLevel: "project",
				source: { provider: "mcp-json", providerName: "MCP", path: standalonePaths[index]!, level: "project" },
				config,
				discovered: false,
			};
		}
	}

	const config = mcpManager?.getServerConfig(name);
	const source = mcpManager?.getSource(name);
	if (!config || !source) return null;

	if (!enableProjectConfig && source.level === "project") return null;
	return {
		filePath: userPath,
		scope: "user",
		profileIdentity,
		sourceLevel: source.level,
		source,
		config,
		discovered: true,
	};
}

/** Strip the `auth` block so a probe or flow starts from the raw server config. */
export function stripMcpOAuthAuth(config: MCPServerConfig): MCPServerConfig {
	const next = { ...config } as MCPServerConfig & { auth?: MCPAuthConfig };
	delete next.auth;
	return next;
}

/**
 * Drop a server definition's client-supplied auth surface so the next
 * `MCPManager` auth resolution picks up the fresh url-keyed credential row a
 * reauth just wrote: while an `Authorization` header is present the manager
 * disables the url-keyed credential fallback, and a stale `auth` block
 * answers first — either would keep the expired credential in charge of the
 * reconnect.
 */
export function clearMcpClientAuthSurface(config: MCPServerConfig): MCPServerConfig {
	const next = stripMcpOAuthAuth(config);
	if (next.type === "stdio" || !("url" in next) || !next.headers) return next;
	const headers: Record<string, string> = { ...next.headers };
	for (const header of Object.keys(headers)) {
		if (header.toLowerCase() === "authorization") delete headers[header];
	}
	return { ...next, headers };
}

function matchingMcpDefinition(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	const prototype = Object.getPrototypeOf(left);
	if (prototype !== Object.getPrototypeOf(right)) return false;
	if (prototype !== Object.prototype && prototype !== null) return isDeepStrictEqual(left, right);
	for (const key of Reflect.ownKeys(left)) {
		const rightValue = Object.hasOwn(right, key) ? Reflect.get(right, key) : undefined;
		if (!matchingMcpDefinition(Reflect.get(left, key), rightValue)) return false;
	}
	for (const key of Reflect.ownKeys(right)) {
		if (!Object.hasOwn(left, key) && Reflect.get(right, key) !== undefined) return false;
	}
	return true;
}

/** Match complete raw or source-level expanded definitions, including routing and client identity. */
export function matchingManagerServerConfig(
	manager: MCPManager | undefined,
	name: string,
	selected: MCPServerConfig,
): MCPServerConfig | undefined {
	const hasCommand = "command" in selected && selected.command;
	const hasUrl = "url" in selected && selected.url;
	const transport = selected.type ?? (hasCommand ? "stdio" : hasUrl ? "http" : "stdio");
	const managerConfig = manager?.getServerConfig(name);
	if (!managerConfig || managerConfig.type !== transport) return undefined;
	const runtimeSelected =
		selected.type === transport ? selected : ({ ...selected, type: transport } as MCPServerConfig);
	const level = manager?.getSource(name)?.level === "project" ? "project" : "user";
	const expanded = expandEnvVarsDeepForConfigLevel(runtimeSelected, level);
	return matchingMcpDefinition(managerConfig, runtimeSelected) || matchingMcpDefinition(managerConfig, expanded)
		? managerConfig
		: undefined;
}

/** Reconnect the original source with the configuration committed by its completed authorization. */
export async function reconnectMcpManagerServer(
	manager: MCPManager | undefined,
	name: string,
	selected: FoundMcpServer,
	committedConfig: MCPServerConfig,
	options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
): Promise<"connected" | "connecting" | "disconnected" | undefined> {
	if (!manager) return undefined;
	assertMcpOAuthCurrent(options);
	const selectedSource = selected.source;
	const source = manager.getSource(name);
	if (
		(source === undefined) !== (selectedSource === undefined) ||
		(source &&
			selectedSource &&
			(source.provider !== selectedSource.provider ||
				source.path !== selectedSource.path ||
				source.level !== selectedSource.level))
	)
		return undefined;
	const managerConfig = matchingManagerServerConfig(manager, name, selected.config);
	if (!managerConfig) return undefined;
	const generation = manager.lifecycleGeneration;
	const profileIdentity = selected.profileIdentity ?? getActiveProfile() ?? "default";
	const level = (selected.sourceLevel ?? selected.scope) === "project" ? "project" : "user";
	const updated = expandEnvVarsDeepForConfigLevel(committedConfig, level);
	const assertCurrent = (): void => {
		assertMcpOAuthCurrent(options);
		if (
			(getActiveProfile() ?? "default") !== profileIdentity ||
			manager.lifecycleGeneration !== generation ||
			manager.getSource(name) !== source ||
			manager.getServerConfig(name) !== updated
		)
			throw new MCPOAuthCancelledError("MCP server owner changed");
	};
	const pending = manager.updateServerConfig(name, updated);
	if (pending) await pending;
	assertCurrent();
	const connection = await manager.reconnectServer(name, {
		manual: true,
		signal: options.signal,
		isCurrent: () => {
			assertCurrent();
			return true;
		},
	});
	assertCurrent();
	const state = manager.getConnectionStatus(name);
	return connection || state !== "connected" ? state : "disconnected";
}

/**
 * Throwaway connection used to probe a server's auth requirements. Uses the
 * host's manager when available (its `prepareConfig` honors live state),
 * else a temporary manager bound to the caller's auth storage.
 */
export async function probeMcpConnection(
	config: MCPServerConfig,
	options: {
		oauth?: boolean;
		authStorage: AuthStorage;
		mcpManager?: MCPManager;
		cwd?: string;
		sourceLevel?: SourceMeta["level"];
		source?: SourceMeta;
		signal?: AbortSignal;
	},
): Promise<void> {
	assertMcpOAuthCurrent(options);
	let resolvedConfig: MCPServerConfig;
	if (options.mcpManager) {
		resolvedConfig = await options.mcpManager.prepareConfig(config, options);
	} else {
		const tempManager = new MCPManager(options.cwd ?? getProjectDir());
		tempManager.setAuthStorage(options.authStorage);
		resolvedConfig = await tempManager.prepareConfig(config, options);
	}

	assertMcpOAuthCurrent(options);
	const connection = await connectToServer(`mcp_probe_${Date.now()}`, resolvedConfig, {
		live: true,
		signal: options.signal,
		...resolveMCPChildCredentialPolicy(
			"mcp_probe",
			resolvedConfig,
			options.source ?? {
				provider: "native",
				providerName: "OMP",
				level: options.sourceLevel ?? "project",
				path: "",
			},
		),
	});
	try {
		assertMcpOAuthCurrent(options);
	} finally {
		await disconnectServer(connection);
	}
}

/**
 * Resolve the OAuth endpoints a reauth needs from the server itself:
 * probe anonymously first (nothing destructive has happened yet), then either
 * take discovery metadata (a clean `initialize` is only weak evidence per the
 * MCP spec, so honor the explicit reauth when the server advertises OAuth) or
 * analyze the auth failure and discover from it. A tool-level challenge
 * overrides the clean probe result.
 */
export async function resolveMcpOAuthEndpointsFromServer(
	config: MCPServerConfig,
	opts: {
		authChallenge?: MCPAuthChallenge;
		signal?: AbortSignal;
		authStorage: AuthStorage;
		mcpManager?: MCPManager;
		cwd?: string;
		sourceLevel?: SourceMeta["level"];
		source?: SourceMeta;
	},
): Promise<OAuthEndpoints> {
	// Stdio servers manage credentials inside the child process; OMP's OAuth
	// flow only applies to http/sse transports. Without this guard the
	// unauthenticated preflight below spawns the child, which happily reuses
	// its own cached tokens (e.g. mcp-remote's machine-wide ~/.mcp-auth) and
	// produces the misleading "reauthorization is not required".
	if (config.type !== "http" && config.type !== "sse") {
		const remoteUrl = config.args?.find(arg => /^https?:\/\//.test(arg));
		const httpHint = `{ "type": "http", "url": ${JSON.stringify(remoteUrl ?? "<remote url>")} }`;
		const usesMcpRemote = [config.command, ...(config.args ?? [])].some(part => part?.includes("mcp-remote"));
		throw new McpReauthRefusalError(
			usesMcpRemote
				? `this server proxies OAuth through mcp-remote, which caches tokens machine-wide in ~/.mcp-auth (shared across every OMP profile). Clear ~/.mcp-auth to force a fresh login, or replace the proxy with ${httpHint} so OMP manages OAuth per profile.`
				: `stdio servers manage their own credentials, so OMP has no OAuth to reauthorize. If the service supports OAuth over HTTP, configure it as ${httpHint} instead.`,
		);
	}
	const metadataError = validateOAuthResourceMetadataUrl(config.oauth?.resourceMetadataUrl);
	if (metadataError) throw new Error(metadataError);
	const configuredMetadataUrl =
		config.oauth?.resourceMetadataUrl === undefined ? undefined : new URL(config.oauth.resourceMetadataUrl).href;

	let connectionSucceeded = false;
	let connectionError: Error | undefined;
	try {
		await probeMcpConnection(clearMcpClientAuthSurface(config), {
			oauth: false,
			authStorage: opts.authStorage,
			mcpManager: opts.mcpManager,
			cwd: opts.cwd,
			sourceLevel: opts.sourceLevel,
			source: opts.source,
			signal: opts.signal,
		});
		connectionSucceeded = true;
	} catch (error) {
		connectionError = toError(error);
		assertMcpOAuthCurrent(opts);
	}

	if (connectionSucceeded && !opts.authChallenge) {
		const discovered =
			"url" in config && config.url
				? await discoverOAuthEndpoints(config.url, undefined, configuredMetadataUrl, {
						signal: opts.signal,
						requireResourceMetadata: configuredMetadataUrl !== undefined,
					})
				: null;
		if (!discovered) {
			if (configuredMetadataUrl !== undefined) {
				throw new Error("Could not discover OAuth endpoints from configured resource metadata.");
			}
			throw new McpReauthRefusalError("Server connection succeeded without OAuth; reauthorization is not required.");
		}
		return discovered;
	}

	// Tool calls can carry richer RFC 6750/RFC 9728 hints than the original
	// connection error. Feed those hints through the same analyzer so
	// resource_metadata and scope reach protected-resource discovery.
	const authError = opts.authChallenge
		? new Error(`${connectionError?.message ?? "HTTP 401"}\n${opts.authChallenge.wwwAuthenticate.join("\n")}`)
		: connectionError!;
	if (opts.authChallenge && connectionError) preserveOAuthDiscoveryHints(authError, connectionError);
	const authResult = analyzeAuthError(authError, "url" in config ? config.url : undefined);
	const resourceMetadataUrl = configuredMetadataUrl ?? authResult.resourceMetadataUrl;
	let oauth = !configuredMetadataUrl && authResult.authType === "oauth" ? (authResult.oauth ?? null) : null;

	if (!oauth && (config.type === "http" || config.type === "sse") && config.url) {
		oauth = await discoverOAuthEndpoints(config.url, authResult.authServerUrl, resourceMetadataUrl, {
			protectedScopes: authResult.scopes,
			signal: opts.signal,
			requireResourceMetadata: configuredMetadataUrl !== undefined,
		});
	}
	if (oauth && config.oauth?.scope === undefined && !oauth.scopes && resourceMetadataUrl) {
		// JSON-error-body endpoints may omit scopes advertised by the resource.
		const scopes = await fetchResourceMetadataScopes(resourceMetadataUrl, { signal: opts.signal });
		if (scopes) oauth = { ...oauth, scopes };
	}

	if (!oauth) {
		throw new Error("Could not discover OAuth endpoints from server response.");
	}

	return oauth;
}

export type McpOAuthFlowPresentation = Pick<OAuthController, "onAuth" | "onProgress" | "onManualCodeInput"> & {
	onFlowComplete?: () => void;
	/**
	 * Release the manual-input claim taken by {@link onManualCodeInput}. The
	 * engine calls this in its `finally` *before* the single-flight claim
	 * releases, so a superseding flow (which wakes on the single-flight
	 * completion) observes the pending manual input already gone instead of
	 * refusing to start.
	 */
	releaseManualInput?: () => void;
};

export interface McpOAuthFlowRunOptions extends McpOAuthFlowPresentation {
	authUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
	clientName?: string;
	scopes: string;
	overrideScopes?: boolean;
	serverUrl?: string;
	registrationUrl?: string;
	issuerUrl?: string;
	resource?: string;
	stripSameOriginResource?: boolean;
	callbackPort?: number;
	callbackPath?: string;
	redirectUri?: string;
	prompt?: string;
	authStorage: AuthStorage;
	/**
	 * External cancellation: host abort, Esc, or a wizard's controller. Aborts
	 * the in-flight flow and throws {@link MCPOAuthCancelledError}.
	 */
	signal?: AbortSignal;
	isCurrent?: () => boolean;
	/** Retains single-flight ownership through dependent configuration persistence. */
	commitConfig?: (result: OAuthFlowResult, signal: AbortSignal) => Promise<void>;
	/** Single-flight lifecycle key; defaults to a module-level owner. */
	flowOwner?: object;
	/** Busy manual-input provider name, to fail fast before starting the flow. */
	pendingInput?: () => string | undefined;
	/**
	 * Fires once the flow's single-flight claim resolves, before any browser
	 * work starts. Hosts that install UI around the flow (the TUI's Esc hook)
	 * do it here, not before the claim: a flow superseded while queued must
	 * install — and later restore — nothing, or it resurrects a dead
	 * predecessor's UI over the live default.
	 */
	onClaimed?: () => void;
}

function assertMcpOAuthCurrent(opts: { signal?: AbortSignal; isCurrent?: () => boolean }): void {
	if (opts.signal?.aborted || opts.isCurrent?.() === false) throw new MCPOAuthCancelledError();
}

/**
 * Run one MCP OAuth browser flow and persist its credential row.
 * Normalizes the client secret (`""` means "none" so a DCR-issued secret
 * reaches the token exchange), races the login against the abort signal, and
 * tears the flow down on the 5-minute deadline.
 */
export async function runMcpOAuthFlow(opts: McpOAuthFlowRunOptions): Promise<OAuthFlowResult> {
	const profileIdentity = getActiveProfile() ?? "default";
	const credentialId = opts.serverUrl
		? mcpOAuthCredentialId(opts.serverUrl)
		: `mcp_oauth_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
	const credentialPool = opts.authStorage.credentials;
	const credentialGeneration = credentialPool.generation;
	const assertCurrent = (): void => {
		assertMcpOAuthCurrent(opts);
		if (
			(getActiveProfile() ?? "default") !== profileIdentity ||
			opts.authStorage.isClosed ||
			opts.authStorage.credentials !== credentialPool ||
			credentialPool.generation !== credentialGeneration
		)
			throw new MCPOAuthCancelledError();
	};
	assertCurrent();
	let parsedAuthUrl: URL;
	try {
		parsedAuthUrl = new URL(opts.authUrl);
		new URL(opts.tokenUrl);
	} catch {
		throw new Error(
			`Invalid OAuth URLs. Please check:\n  Authorization URL: ${opts.authUrl}\n  Token URL: ${opts.tokenUrl}`,
		);
	}

	const resolvedClientId = opts.clientId.trim() || parsedAuthUrl.searchParams.get("client_id")?.trim() || undefined;
	const resolvedClientSecret = opts.clientSecret.trim() || undefined;

	const oauthTimeout = new AbortController();
	// Esc, external aborts, and a replacement MCP flow route through here;
	// the timeout path sets its own reason and leaves this flag false so the
	// catch can distinguish cancellation (status) from deadline failure.
	let cancellationRequested = false;
	const requestCancellation = (reason: string): void => {
		cancellationRequested = true;
		if (!oauthTimeout.signal.aborted) oauthTimeout.abort(reason);
	};
	const flowClaim = await claimMCPOAuthFlow(
		opts.flowOwner ?? defaultMcpOAuthFlowOwner,
		requestCancellation,
		opts.signal,
	);
	const externalSignal = opts.signal;
	const onExternalAbort = (): void => {
		const reason = externalSignal?.reason;
		requestCancellation(typeof reason === "string" ? reason : "MCP OAuth flow cancelled by user");
	};
	if (externalSignal?.aborted) {
		onExternalAbort();
	} else {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
	}
	let loginCompletion: Promise<unknown> | undefined;
	try {
		assertCurrent();
		opts.onClaimed?.();
		const pendingProvider = opts.pendingInput?.();
		if (pendingProvider) {
			throw new Error(
				`OAuth login already in progress for ${pendingProvider}. Complete or cancel it before starting MCP OAuth.`,
			);
		}
		// Create OAuth flow
		const flow = new MCPOAuthFlow(
			{
				authorizationUrl: opts.authUrl,
				clientName: opts.clientName,
				tokenUrl: opts.tokenUrl,
				registrationUrl: opts.registrationUrl,
				issuerUrl: opts.issuerUrl,
				clientId: resolvedClientId,
				clientSecret: resolvedClientSecret,
				scopes: opts.scopes || undefined,
				overrideScopes: opts.overrideScopes,
				prompt: opts.prompt,
				redirectUri: opts.redirectUri,
				callbackPort: opts.callbackPort,
				callbackPath: opts.callbackPath,
				resource: opts.resource,
				stripSameOriginResource: opts.stripSameOriginResource,
			},
			{
				onAuth: opts.onAuth,
				onProgress: opts.onProgress,
				onManualCodeInput: opts.onManualCodeInput,
				signal: oauthTimeout.signal,
			},
		);

		const createAbortError = (): Error => {
			const reason = String(oauthTimeout.signal.reason ?? "MCP OAuth flow aborted");
			return cancellationRequested ? new MCPOAuthCancelledError() : new Error(reason);
		};
		if (oauthTimeout.signal.aborted) throw createAbortError();

		// Execute OAuth flow with 5 minute timeout. Race the login itself
		// against the abort signal because Esc/external abort may fire before
		// MCPOAuthFlow reaches OAuthCallbackFlow.#waitForCallback, where the
		// underlying callback server normally observes the signal.
		const login = flow.login();
		loginCompletion = login;
		const credentials = await withTimeout(
			raceAbortSignal(login, oauthTimeout.signal, createAbortError),
			5 * 60 * 1000,
			"OAuth flow timed out after 5 minutes",
			() => oauthTimeout.abort("MCP OAuth flow timed out"),
		);
		assertCurrent();

		// Embed refresh material so the credential is self-contained: token
		// refresh must work for configs that carry no auth block at all.
		const oauthCredential: MCPStoredOAuthCredential = {
			type: "oauth",
			...credentials,
			tokenUrl: opts.tokenUrl,
			issuerUrl: opts.issuerUrl,
			clientId: flow.resolvedClientId?.trim() || resolvedClientId,
			clientSecret: flow.registeredClientSecret ?? resolvedClientSecret,
			resource: flow.resource,
			authorizationUrl: flow.authorizationUrl,
			scope: flow.grantedScope,
		};

		assertCurrent();
		if (oauthTimeout.signal.aborted) throw createAbortError();
		await credentialPool.set(credentialId, oauthCredential, {
			assertCurrent: () => {
				assertCurrent();
				if (oauthTimeout.signal.aborted) throw createAbortError();
			},
		});
		assertMcpOAuthCurrent(opts);
		if (
			(getActiveProfile() ?? "default") !== profileIdentity ||
			opts.authStorage.isClosed ||
			opts.authStorage.credentials !== credentialPool
		)
			throw new MCPOAuthCancelledError();
		const result = {
			credentialId,
			clientId: flow.resolvedClientId,
			resource: flow.resource,
		};
		await opts.commitConfig?.(result, oauthTimeout.signal);
		assertMcpOAuthCurrent(opts);
		if (oauthTimeout.signal.aborted) throw createAbortError();
		opts.onFlowComplete?.();
		return result;
	} catch (error) {
		// Esc, an external abort, or a newer MCP flow are neutral
		// cancellations. The timeout path also aborts the controller but does
		// not set this flag, so it remains a surfaced error.
		if (cancellationRequested || error instanceof MCPOAuthCancelledError) {
			throw new MCPOAuthCancelledError();
		}

		// Already a complete diagnostic; its "HTTP 403" must not hit the generic remap below.
		if (error instanceof MCPOAuthClientIdRequiredError) throw error;

		const errorMsg = error instanceof Error ? error.message : String(error);

		// Provide helpful error messages based on failure type
		if (errorMsg.includes("timeout") || errorMsg.includes("timed out")) {
			throw new Error("OAuth flow timed out. Please try again.");
		} else if (errorMsg.includes("403") || errorMsg.includes("unauthorized")) {
			throw new Error("OAuth authorization failed. Please check your client credentials.");
		} else if (errorMsg.includes("invalid_grant")) {
			throw new Error("OAuth authorization code is invalid or expired. Please try again.");
		} else if (errorMsg.includes("ECONNREFUSED") || errorMsg.includes("fetch failed")) {
			throw new Error("Could not connect to OAuth server. Please check the URLs and your network connection.");
		} else {
			throw new Error(`OAuth authentication failed: ${errorMsg}`);
		}
	} finally {
		opts.releaseManualInput?.();
		externalSignal?.removeEventListener("abort", onExternalAbort);
		if (oauthTimeout.signal.aborted && loginCompletion) {
			// Cancelled callers return promptly; the original login retains its single-flight claim until settlement.
			void loginCompletion.then(flowClaim.release, flowClaim.release);
		} else {
			flowClaim.release();
		}
	}
}

/**
 * Fold a completed OAuth flow back into a server config. Owns the persistence
 * policy in one place: the auth block records the credential pointer plus
 * refresh material, the oauth block echoes the client id for pre-auth reuse,
 * and only a user-supplied client secret is ever written — DCR-issued secrets
 * stay embedded in the stored credential so they cannot leak into (possibly
 * shared/committed) config files.
 */
export function persistMcpOAuthResult(
	config: MCPServerConfig,
	result: OAuthFlowResult,
	opts: {
		tokenUrl: string;
		resource?: string;
		stripSameOriginResource?: boolean;
		clientId?: string;
		persistOAuthClientId?: boolean;
		userClientSecret?: string;
	},
): MCPServerConfig {
	const clientId = result.clientId?.trim() || opts.clientId?.trim() || config.oauth?.clientId?.trim();
	const oauthClientId = opts.persistOAuthClientId === false ? undefined : clientId;
	const resource =
		result.resource ?? (opts.stripSameOriginResource ? undefined : opts.resource) ?? config.auth?.resource;
	return {
		...config,
		auth: {
			type: "oauth",
			credentialId: result.credentialId,
			tokenUrl: opts.tokenUrl,
			clientId,
			clientSecret: opts.userClientSecret,
			resource,
		},
		oauth: {
			...config.oauth,
			clientId: oauthClientId,
		},
	};
}

export interface McpReauthOptions extends McpOAuthFlowPresentation {
	authStorage: AuthStorage;
	/** Effective selection from the existing config loader, including user enable/disable overrides. */
	effectiveEnabled?: boolean;
	/** Effective transport inferred by discovery without changing the raw source definition. */
	effectiveTransport?: MCPServerConfig["type"];
	/** Host cancellation; wired before the anonymous probe so the whole reauth is abortable. */
	signal?: AbortSignal;
	isCurrent?: () => boolean;
	/** Tool-level `_meta["mcp/www_authenticate"]` challenge that triggered an auto-reauth. */
	authChallenge?: MCPAuthChallenge;
	/** Host's live manager, used to prepare the anonymous probe config. */
	mcpManager?: MCPManager;
	cwd?: string;
	/** Suppresses the "Reauthorizing…" notice (auto-reauth on a 401 challenge). */
	silent?: boolean;
	/** Presentation for the pre-flow notice. */
	onReauthorizing?: () => void;
	flowOwner?: object;
	pendingInput?: () => string | undefined;
	/**
	 * Fires once the flow's single-flight claim resolves (see
	 * {@link McpOAuthFlowRunOptions.onClaimed}); hosts install flow UI here so
	 * a superseded flow installs — and restores — nothing.
	 */
	onClaimed?: () => void;
}

export interface McpReauthOutcome {
	/** Config with the fresh auth block (or the stripped base when no write-back was needed). */
	config: MCPServerConfig;
	/** Whether the server definition was written back to its config file. */
	persisted: boolean;
	oauth: OAuthEndpoints;
	credentialId: string;
}

/**
 * Reauthorize one configured MCP server end to end: strip the auth block,
 * resolve OAuth endpoints from the server, assemble client credentials
 * (configured > persisted > stored > metadata-advertised, with DCR preferred
 * whenever the authorization server offers it), run the browser flow, GC the
 * superseded credential row, and write the config back under the TUI's
 * persistence policy. Definition-only entries resolve through the url-keyed
 * credential binding alone, so a committed project mcp.json stays clean.
 *
 * Throws {@link McpReauthRefusalError} for actionable refusals (stdio
 * transport, disabled server, anonymous server) and
 * {@link MCPOAuthCancelledError} when the host aborts mid-flow.
 */
export async function reauthorizeMcpServer(
	name: string,
	found: FoundMcpServer,
	opts: McpReauthOptions,
): Promise<McpReauthOutcome> {
	const { authStorage } = opts;
	const profileIdentity = found.profileIdentity ?? getActiveProfile() ?? "default";
	const cwd = opts.cwd ?? getProjectDir();
	const credentialPool = authStorage.credentials;
	let credentialGeneration = credentialPool.generation;
	const managerConfig = opts.mcpManager?.getServerConfig(name);
	const managerSource = opts.mcpManager?.getSource(name);
	const managerGeneration = opts.mcpManager?.lifecycleGeneration;
	const assertOwner = (): void => {
		assertMcpOAuthCurrent(opts);
		if (
			(getActiveProfile() ?? "default") !== profileIdentity ||
			authStorage.isClosed ||
			authStorage.credentials !== credentialPool ||
			(opts.mcpManager &&
				(opts.mcpManager.lifecycleGeneration !== managerGeneration ||
					opts.mcpManager.getServerConfig(name) !== managerConfig ||
					opts.mcpManager.getSource(name) !== managerSource))
		)
			throw new MCPOAuthCancelledError();
	};
	const assertCurrent = (): void => {
		assertOwner();
		if (credentialPool.generation !== credentialGeneration) throw new MCPOAuthCancelledError();
	};
	assertCurrent();
	if ((opts.effectiveEnabled ?? found.config.enabled) === false) {
		throw new McpReauthRefusalError(`Server "${name}" is disabled. Run /mcp enable ${name} first.`);
	}

	const currentAuth = found.config.auth;
	const baseConfig = stripMcpOAuthAuth(found.config);
	const configLevel = (found.sourceLevel ?? found.scope) === "project" ? "project" : "user";
	const expandedBaseConfig = expandEnvVarsDeepForConfigLevel(baseConfig, configLevel);
	const runtimeBaseConfig = opts.effectiveTransport
		? ({ ...expandedBaseConfig, type: opts.effectiveTransport } as MCPServerConfig)
		: expandedBaseConfig;
	const immutableManagedSource = found.source?.provider === MANAGED_MCP_PROVIDER_ID;
	if (
		found.acpOwned !== true &&
		(immutableManagedSource || (found.discovered && configLevel === "project")) &&
		(currentAuth?.type === "apikey" || hasMcpAuthorizationHeader(runtimeBaseConfig))
	) {
		throw new McpReauthRefusalError(
			immutableManagedSource
				? `Server "${name}" supplies explicit managed authentication. Update its managed credential or environment; browser sign-in cannot replace read-only managed credentials.`
				: `Server "${name}" supplies explicit project authentication. Update its source and approve it again; browser sign-in cannot replace immutable project credentials.`,
		);
	}
	// Resolve endpoints first: this fails fast for stdio transports and
	// probes http/sse with { oauth: false }, so nothing destructive has
	// happened yet if the server turns out not to need (or support) OAuth.
	// Use the same env-expanded config shape runtime discovery passes to
	// MCPManager; the raw file value may contain `${...}` placeholders.
	const oauth = await resolveMcpOAuthEndpointsFromServer(runtimeBaseConfig, {
		authChallenge: opts.authChallenge,
		signal: opts.signal,
		authStorage,
		mcpManager: opts.mcpManager,
		cwd,
		sourceLevel: found.sourceLevel ?? found.scope,
		source: found.source,
	});
	assertCurrent();
	const serverUrl =
		runtimeBaseConfig.type === "http" || runtimeBaseConfig.type === "sse" ? runtimeBaseConfig.url : undefined;
	// Client credentials drive the token exchange, so they must come from the
	// env-expanded runtime config; `found.config`/`currentAuth` may still hold
	// `${...}` placeholders (the wizard writes the secret to auth.clientSecret).
	// DCR secrets are embedded in the stored credential and never echoed back
	// into config files.
	const runtimeAuth = currentAuth ? expandEnvVarsDeepForConfigLevel(currentAuth, configLevel) : undefined;
	const configuredClientId = runtimeBaseConfig.oauth?.clientId?.trim() || undefined;
	const configuredClientSecret = runtimeBaseConfig.oauth?.clientSecret;
	const candidateCredential = (
		configLevel === "project"
			? lookupProjectMcpOAuthCredential(authStorage, runtimeBaseConfig)
			: lookupMcpOAuthCredentialForServer(authStorage, currentAuth, serverUrl)
	)?.credential;
	const existingCredential =
		candidateCredential?.tokenUrl === oauth.tokenUrl &&
		candidateCredential.authorizationUrl === oauth.authorizationUrl &&
		candidateCredential.issuerUrl === oauth.issuerUrl &&
		candidateCredential.resource === (oauth.resource ?? serverUrl)
			? candidateCredential
			: undefined;
	const persistedClientId =
		runtimeAuth?.tokenUrl === oauth.tokenUrl ? runtimeAuth.clientId?.trim() || undefined : undefined;
	const storedClientId = existingCredential?.clientId?.trim() || undefined;
	const discoveredClientId = oauth.clientId?.trim() || undefined;
	// A metadata-advertised client is only a fallback. Prefer DCR when the
	// authorization server explicitly offers it, while retaining configured
	// and previously registered client credentials above.
	const ephemeralRegistration = runtimeBaseConfig.oauth?.callbackPort === 0 && !discoveredClientId;
	const flowClientId = ephemeralRegistration
		? ""
		: (configuredClientId ??
			persistedClientId ??
			storedClientId ??
			(oauth.registrationUrl ? undefined : discoveredClientId) ??
			"");
	const storedClientSecret = storedClientId === flowClientId ? existingCredential?.clientSecret : undefined;
	const flowClientSecret = ephemeralRegistration
		? ""
		: ((configuredClientId === flowClientId ? configuredClientSecret?.trim() || undefined : undefined) ??
			(persistedClientId === flowClientId ? runtimeAuth?.clientSecret?.trim() || undefined : undefined) ??
			storedClientSecret?.trim() ??
			"");
	// Persisted separately below: keep the raw `${...}` placeholder in the file
	// rather than writing the resolved secret back to (possibly shared) config.
	const userClientSecret =
		(configuredClientId === flowClientId ? found.config.oauth?.clientSecret?.trim() || undefined : undefined) ??
		(persistedClientId === flowClientId ? currentAuth?.clientSecret?.trim() || undefined : undefined);
	const hasConfiguredOnlySecret = configuredClientId === undefined && configuredClientSecret !== undefined;

	if (!opts.silent) opts.onReauthorizing?.();

	const currentAuthResource = runtimeAuth?.resource;
	const oauthResource =
		oauth.resource ?? currentAuthResource ?? ("url" in runtimeBaseConfig ? runtimeBaseConfig.url : undefined);
	const oauthResourceIsFallback = !oauth.resource && !currentAuthResource;

	let outcome: McpReauthOutcome | undefined;
	const commitConfig = async (oauthResult: OAuthFlowResult, signal: AbortSignal): Promise<void> => {
		const assertCommitCurrent = (): void => {
			assertCurrent();
			if (signal.aborted) throw new MCPOAuthCancelledError();
		};
		credentialGeneration = credentialPool.generation;
		assertCommitCurrent();
		const hadClientBearerHeader = hasMcpAuthorizationHeader(found.config);
		const urlKeyedId = serverUrl ? mcpOAuthCredentialId(serverUrl) : undefined;
		const shouldPersist =
			found.acpOwned !== true &&
			!(found.discovered && configLevel === "project") &&
			(currentAuth !== undefined || hadClientBearerHeader || oauthResult.credentialId !== urlKeyedId);
		const updatedConfig = shouldPersist
			? persistMcpOAuthResult(clearMcpClientAuthSurface(baseConfig), oauthResult, {
					tokenUrl: oauth.tokenUrl,
					clientId: oauth.clientId,
					persistOAuthClientId: !hasConfiguredOnlySecret,
					userClientSecret,
					resource: oauthResource,
					stripSameOriginResource: oauthResourceIsFallback,
				})
			: clearMcpClientAuthSurface(baseConfig);
		if (shouldPersist) {
			await updateMCPServer(found.filePath, name, updatedConfig, {
				expectedConfig: found.discovered ? undefined : found.config,
				assertCurrent: assertCommitCurrent,
				sourceLevel: configLevel,
			});
		}
		assertCommitCurrent();
		if (
			configLevel === "user" &&
			currentAuth?.type === "oauth" &&
			currentAuth.credentialId !== oauthResult.credentialId
		) {
			await removeManagedMcpOAuthCredential(authStorage, currentAuth.credentialId);
		}
		outcome = { config: updatedConfig, persisted: shouldPersist, oauth, credentialId: oauthResult.credentialId };
	};
	await runMcpOAuthFlow({
		authUrl: oauth.authorizationUrl,
		tokenUrl: oauth.tokenUrl,
		clientId: flowClientId,
		clientName: runtimeBaseConfig.oauth?.clientName,
		clientSecret: flowClientSecret,
		scopes: runtimeBaseConfig.oauth?.scope ?? oauth.scopes ?? "",
		overrideScopes: runtimeBaseConfig.oauth?.scope !== undefined,
		callbackPort: runtimeBaseConfig.oauth?.callbackPort,
		callbackPath: runtimeBaseConfig.oauth?.callbackPath,
		redirectUri: runtimeBaseConfig.oauth?.redirectUri,
		prompt: runtimeBaseConfig.oauth?.prompt,
		registrationUrl: oauth.registrationUrl,
		issuerUrl: oauth.issuerUrl,
		serverUrl,
		resource: oauthResource,
		stripSameOriginResource: oauthResourceIsFallback,
		authStorage,
		signal: opts.signal,
		isCurrent: () => {
			assertOwner();
			return true;
		},
		flowOwner: opts.flowOwner,
		pendingInput: opts.pendingInput,
		onClaimed: opts.onClaimed,
		onAuth: opts.onAuth,
		onProgress: opts.onProgress,
		onManualCodeInput: opts.onManualCodeInput,
		onFlowComplete: opts.onFlowComplete,
		releaseManualInput: opts.releaseManualInput,
		commitConfig,
	});

	if (!outcome) throw new Error("MCP OAuth persistence did not complete");
	return outcome;
}
