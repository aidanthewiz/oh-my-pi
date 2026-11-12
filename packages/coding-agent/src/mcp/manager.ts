/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */
import * as path from "node:path";
import * as url from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import { invalidateCommandConfig, isCommandConfigValue, resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import {
	MCPConnectionTimeoutError,
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import {
	isBrowserMCPServer,
	type LoadMCPConfigsOptions,
	type LoadMCPConfigsResult,
	loadAllMCPConfigs,
	resolveMCPChildCredentialPolicy,
	validateServerConfig,
} from "./config";
import {
	lookupMcpOAuthCredential,
	lookupProjectMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	refreshStoredManagedMcpOAuthCredential,
} from "./oauth-credentials";
import type { MCPStoredOAuthCredential } from "./oauth-flow";
import type { MCPProjectTrustHandler } from "./project-trust";
import type { McpConnectionStatusEvent } from "./startup-events";
import { resolveMCPStartupTimeoutMs } from "./timeout";

import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import { DeferredMCPTool, dispatchMCPTool, MCPTool, type MCPToolCallObserver } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { setGeneratedHeader } from "./transports/header-policy";
import type {
	MCPAuthChallenge,
	MCPAuthHandlerContext,
	MCPCallToolOptions,
	MCPHostCallContext,
	MCPToolCallResult,
	MCPGetPromptResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
	MCPTransport,
} from "./types";
import { MCPNotificationMethods } from "./types";
import { MCPOAuthCancelledError } from "./oauth-reauth";
export type McpCatalogChangeEvent = { serverName: string; kind: "resources" | "prompts" };

export type MCPConfigLoader = (cwd: string, options?: LoadMCPConfigsOptions) => Promise<LoadMCPConfigsResult>;

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

interface MCPConnectionOwner {
	signal?: AbortSignal;
	isCurrent?: () => boolean;
}

interface MCPToolReconnectOptions extends MCPConnectionOwner {
	authChallenge?: MCPAuthChallenge;
	awsProfile?: string;
}

interface MCPAuthQueueEntry {
	id: number;
	serverName: string;
	generation: number;
	signal: AbortSignal;
}

interface AuthRefreshableMCPTransport extends MCPTransport {
	onAuthError?: () => Promise<Record<string, string> | null>;
}

function getInitialAuthChallenge(error: unknown, config: MCPServerConfig): MCPAuthChallenge | undefined {
	if (config.enabled === false || (config.type !== "http" && config.type !== "sse")) return undefined;

	const message = error instanceof Error ? error.message : String(error);
	if (!/^HTTP (?:401|403):/i.test(message)) return undefined;

	const wwwAuthenticate = message
		.match(/\[WWW-Authenticate:\s*([\s\S]*?)(?:;\s*Mcp-Auth-Server:|\]\s*$)/i)?.[1]
		?.trim();
	return { wwwAuthenticate: wwwAuthenticate ? [wwwAuthenticate] : [] };
}

function isAuthRefreshableMCPTransport(transport: MCPTransport): transport is AuthRefreshableMCPTransport {
	return "onAuthError" in transport;
}

function lookupMcpOAuthCredentialForSource(
	authStorage: AuthStorage | null | undefined,
	config: MCPServerConfig,
	sourceLevel: SourceMeta["level"] | undefined,
): MCPOAuthCredentialLookup | undefined {
	return sourceLevel === "project"
		? lookupProjectMcpOAuthCredential(authStorage, config)
		: lookupMcpOAuthCredential(authStorage, config);
}
/**
 * The `!command` values {@link MCPManager} executes when it resolves `config`:
 * remote `headers` or stdio `env`, minus the entries a literal policy keeps verbatim.
 */
function commandValues(config: MCPServerConfig): string[] {
	const values: string[] = [];
	if (config.type === "http" || config.type === "sse") {
		if (!config.headers || config.headerPolicy === "origin-locked") return values;
		for (const key in config.headers) {
			const value = config.headers[key];
			if (isCommandConfigValue(value)) values.push(value);
		}
		return values;
	}
	if (!config.env || config.envPolicy === "literal") return values;
	const literalKeys = new Set(config.envLiteralKeys);
	for (const key in config.env) {
		const value = config.env[key];
		if (!literalKeys.has(key) && isCommandConfigValue(value)) values.push(value);
	}
	return values;
}

/**
 * Drop the process-cached results of `config`'s `!command` values so the next
 * resolution runs them again — a command that mints a short-lived token
 * (e.g. an OAuth2 `client_credentials` grant) must not resend an expired one.
 */
function invalidateCommandValues(config: MCPServerConfig): void {
	for (const value of commandValues(config)) invalidateCommandConfig(value);
}

type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

/**
 * One session's view over a shared {@link MCPManager}, keyed by the session's
 * id; see {@link MCPManagerApi.getTools}. Opened with
 * {@link MCPManagerApi.openToolScope}; the owning session's view needs none.
 */
export type MCPToolScope = string;

/** Scope of the session that owns the manager. */
const OWNER_TOOL_SCOPE: MCPToolScope = "owner";

function createMcpStartupFailure(serverName: string, error: string, source?: SourceMeta): McpConnectionStatusEvent {
	return source
		? { type: "failed", serverName, error, sourcePath: source.path }
		: { type: "failed", serverName, error };
}

/**
 * Per-server reconnect-storm circuit breaker.
 *
 * `transport.onClose` (wired in {@link MCPManager.connectServers} and
 * {@link MCPManager.#connectAndWireServer}) fires `reconnectServer` on every
 * clean process exit, so a stdio MCP server that completes the
 * `initialize` + `tools/list` handshake and then exits will pull the agent
 * into a fork loop with no rate limit. That pathology shipped in issue #1592
 * (a `php`-shebang MCP fork-bombing macOS, parented directly to the agent's
 * `bun` PID via shebang exec).
 *
 * We keep the sliding window short — older crashes age out so a single
 * transient failure stays cheap — but cap the burst tightly enough that the
 * agent never spawns more than `RECONNECT_BURST_LIMIT * #doReconnect retries`
 * (≤ 25) processes per stuck server per window. Manual `/mcp reconnect`
 * resets the window so users can recover after fixing the underlying
 * misconfiguration.
 */
const RECONNECT_BURST_WINDOW_MS = 30_000;
const RECONNECT_BURST_LIMIT = 5;

/**
 * How {@link MCPManager} paces reconnects after a transport is lost.
 *
 * `ladderMs` are the sleeps between the attempts one `reconnectServer` call
 * makes before giving up; every caller that awaits a reconnect (tool calls,
 * `/mcp reconnect`, {@link MCPManager.waitForConnection}) is bounded by it.
 *
 * When the ladder fails for an `http`/`sse` server that was connected and
 * then lost, the manager keeps trying on its own: one quiet attempt after
 * `retryBaseMs`, doubling up to `retryMaxMs`, until the server answers or the
 * server is disconnected or reconfigured. A remote server that is merely
 * restarting (a redeploy, a laptop waking with the network not yet back)
 * comes back on its own schedule, and until it does the manager's resource
 * subscriptions are dead while nothing else would reconnect them: without the
 * schedule the server stays "not connected" until a tool call happens to hit
 * it or the user notices. Each scheduled attempt is a full connect — auth
 * resolution included — lasting up to the server's `timeout`; a reconnect
 * requested meanwhile shares it, and the server reads `connecting` for that
 * long. Stdio servers stop at the ladder: a process that exited is not
 * brought back by waiting, and re-spawning it on a timer is the fork storm
 * {@link RECONNECT_BURST_LIMIT} exists to stop.
 */
export interface MCPReconnectPolicy {
	readonly ladderMs: readonly number[];
	readonly retryBaseMs: number;
	readonly retryMaxMs: number;
}

const DEFAULT_RECONNECT_POLICY: MCPReconnectPolicy = {
	ladderMs: [500, 1000, 2000, 4000],
	retryBaseMs: 15_000,
	retryMaxMs: 5 * 60_000,
};

/**
 * Bounded buffer for notifications received before any listener attaches.
 * Mirrors {@link IrcBus}'s `MAILBOX_CAP` — drop-oldest on overflow. Drained
 * into the first {@link MCPManager.addNotificationListener} subscriber, then
 * cleared; subsequent frames deliver directly to attached listeners.
 */
const NOTIFICATION_BUFFER_CAP = 100;

function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}

/**
 * Stable, total ordering on MCP tools by name.
 *
 * Anthropic prompt caching keys on byte-identical tool definitions: any reorder
 * of the tools array invalidates the tools cache breakpoint and forces a full
 * prefix rebuild on the next request. MCP servers connect/reconnect at arbitrary
 * times, so the natural "insertion order" of `#tools` is non-deterministic.
 * Sorting after every mutation makes the array bytes independent of connection
 * sequence.
 */
export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}
/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Readiness of configured MCP servers after the initial tool handshake. */
export interface MCPStartupStatus {
	/** Servers whose tools have been registered and whose startup callbacks completed. */
	connected: string[];
	/** Servers still loading tools or reconnecting at the deadline. */
	pending: string[];
	/** Servers whose connection or tool handshake failed. */
	failed: Array<{ name: string; error: string }>;
}

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Requests one-time approval for repository-owned .coreforge/mcp.json */
	requestProjectTrust?: MCPProjectTrustHandler;
	/** Allowlist of discovery provider ids whose MCP servers load (empty/omitted = all providers) */
	discoveryProviders?: string[];
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
	/** Non-blocking discovery window in milliseconds; environment override wins. */
	startupTimeoutMs?: number;
}

/** Handles an MCP `WWW-Authenticate` challenge and returns refreshed config. */
export type MCPAuthHandler = (
	serverName: string,
	challenge: MCPAuthChallenge,
	context?: MCPAuthHandlerContext,
) => Promise<MCPServerConfig | undefined>;

export type MCPAuthQueueEvent =
	| { type: "queued"; serverName: string; queue: readonly string[] }
	| { type: "started"; serverName: string; queue: readonly string[] }
	| { type: "completed"; serverName: string; queue: readonly string[] }
	| { type: "cancelled"; serverName: string; queue: readonly string[] };

export type MCPAuthQueueHandler = (event: MCPAuthQueueEvent) => void;
/** Whether a handshake rejection is the teardown abort of `signal`, not a failure that preceded it. */
function isAbortedHandshake(signal: AbortSignal, error: unknown): boolean {
	return (
		signal.aborted &&
		(error === signal.reason ||
			(error instanceof Error && error.name === "AbortError" && error.cause === signal.reason))
	);
}

/**
 * Surface of an {@link MCPManager} that sessions reusing a manager (subagents, `mcp://` and
 * `skill://` handlers) use. Subagent worker threads receive a remote implementation whose calls
 * run on the main thread's manager, so connections and server processes stay single-owner.
 */
export interface MCPManagerApi {
	/**
	 * Tools `scope` sees (omitted: the owning session). A tool a server adds
	 * while a call to it runs reaches a session only once that session's own
	 * call to the server completes, so one session loading tools never rewrites
	 * another's tool list, prompt, or provider cache prefix. Tools present at
	 * connect, and tools a server adds while no call to it runs, every session sees.
	 */
	getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[];
	/**
	 * Open the view of the session `scope` names. A view opened for the first
	 * time starts from `seed`'s (default: the owner's), so a child sees what its
	 * spawner saw; reopening a view (a revived session) keeps what it was granted,
	 * so the revived session renders the tools its earlier requests were cached against.
	 */
	openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void;
	/**
	 * Attribute one tool call, by tool-call id, to `scope` until the returned
	 * callback runs. Calls not attributed belong to the owning session.
	 */
	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void;
	/** Subscribe to tool-set changes; returns an unsubscribe fn. */
	addToolsChangedListener(listener: () => void): () => void;
	/** Subscribe to every server notification frame; returns an unsubscribe fn. */
	addNotificationListener(listener: (serverName: string, method: string, params: unknown) => void): () => void;
	/** Names of currently connected servers. */
	getConnectedServers(): string[];
	/** Cached resources/templates of one server. */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined;
	/** Wait until one server's resource catalog is loaded. */
	ensureServerResources(name: string): Promise<void>;
	/** Wait for in-flight connection attempts. */
	waitForPendingConnections(): Promise<void>;
	/** Read one resource from a server. */
	readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined>;
	/** Invoke a configured server under the calling session's host authority. */
	callTool(
		serverName: string,
		toolName: string,
		args?: Record<string, unknown>,
		options?: MCPCallToolOptions,
		context?: MCPHostCallContext,
	): Promise<MCPToolCallResult>;
	/** Server-provided instructions by server name. */
	getServerInstructions(): Map<string, string>;
	/** Apply the browser-MCP filter after the built-in browser capability toggled. */
	reconcileBrowserFilter(enabled: boolean): Promise<void>;
}

/** Process-global MCP manager accessors a subagent worker installs in place of its own (empty) slot. */
export interface MCPManagerGlobal {
	instance(): MCPManagerApi | undefined;
	load(): Promise<MCPManagerApi | undefined>;
	available(): boolean;
}

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager implements MCPManagerApi {
	static #instance: MCPManager | undefined;
	static #deferred: (() => Promise<MCPManager>) | undefined;
	static #deferredLoad: Promise<MCPManager> | undefined;
	static #global: MCPManagerGlobal | undefined;

	/**
	 * Route {@link instance}/{@link load}/{@link available} to another thread's manager.
	 * Subagent worker bootstrap only: a worker never owns MCP connections.
	 */
	static installGlobal(global: MCPManagerGlobal): void {
		MCPManager.#global = global;
	}

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): MCPManagerApi | undefined {
		if (MCPManager.#global) return MCPManager.#global.instance();
		return MCPManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/**
	 * Install or clear a loader that creates the process-global instance on first {@link load}, so a
	 * one-shot host (`omp read`) starts MCP servers only when a request actually reaches them.
	 */
	static setDeferredInstance(load: (() => Promise<MCPManager>) | undefined): void {
		MCPManager.#deferred = load;
		MCPManager.#deferredLoad = undefined;
	}

	/** Whether {@link load} can yield an instance: one is installed or a deferred loader is set. */
	static available(): boolean {
		if (MCPManager.#global) return MCPManager.#global.available();
		return MCPManager.#instance !== undefined || MCPManager.#deferred !== undefined;
	}

	/** The process-global instance, running the deferred loader once if none is installed yet. */
	static async load(): Promise<MCPManagerApi | undefined> {
		if (MCPManager.#global) return MCPManager.#global.load();
		if (MCPManager.#instance) return MCPManager.#instance;
		if (!MCPManager.#deferred) return undefined;
		if (!MCPManager.#deferredLoad) {
			const pending = MCPManager.#deferred().then(manager => {
				// A loader cleared or replaced mid-load must not install its manager.
				if (MCPManager.#deferredLoad === pending) MCPManager.#instance = manager;
				return manager;
			});
			MCPManager.#deferredLoad = pending;
		}
		return MCPManager.#deferredLoad;
	}

	/** Reset the process-global instance and any deferred loader. Test-only. */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
		MCPManager.setDeferredInstance(undefined);
	}
	#connections = new Map<string, MCPServerConnection>();
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#startupUpdates = new Map<string, Promise<void>>();
	#startupServers = new Set<string>();
	#startupFailures = new Map<string, string>();
	#connectionAbortControllers = new Map<string, AbortController>();
	#pendingFirstUseConnections = new Map<string, Promise<MCPServerConnection | null>>();
	/**
	 * A 401 during background discovery records an auth challenge but never
	 * opens a browser. Deferred cached tools consume it on their first use.
	 */
	#pendingAuthChallenges = new Map<string, MCPAuthChallenge>();
	/** A declined first-use authorization remains declined until manual retry. */
	#declinedAuthServers = new Set<string>();
	#sources = new Map<string, SourceMeta>();
	#authStorage: AuthStorage | null = null;
	#authHandler?: MCPAuthHandler;
	#authHandlerQueue: Promise<void> = Promise.resolve();
	#authQueueAbortController = new AbortController();
	#authQueueGeneration = 0;
	#nextAuthQueueId = 0;
	#authQueueEntries = new Map<number, MCPAuthQueueEntry>();
	#authQueueHandler?: MCPAuthQueueHandler;
	#notificationListeners = new Set<(serverName: string, method: string, params: unknown) => void>();
	#connectionStatusListeners = new Set<(event: McpConnectionStatusEvent) => void>();
	#catalogChangeListeners = new Set<(event: McpCatalogChangeEvent) => void>();
	#toolsChangedListeners = new Set<() => void>();
	/**
	 * Notifications received before any listener attached, to be drained on
	 * the first {@link addNotificationListener} call. Bounded by
	 * {@link NOTIFICATION_BUFFER_CAP}, drop-oldest on overflow.
	 */
	#pendingNotifications: Array<{ server: string; method: string; params: unknown }> = [];
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>;
	/** In-flight owner-handler run; changes arriving while it runs coalesce into one trailing call. */
	#ownerToolsRun?: Promise<void>;
	#ownerToolsDirty = false;
	/** Per-server single-flight `tools/list` refresh with a trailing re-run flag. */
	#toolRefreshes = new Map<string, { connection: MCPServerConnection; dirty: boolean; promise: Promise<void> }>();
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	#discoverOptions: MCPDiscoverOptions | undefined;
	#browserFilterMutationTail: Promise<void> = Promise.resolve();
	/** Settles when the latest {@link MCPManager.discoverAndConnect} call does; reconciles wait on it. */
	#discoveryInFlight: Promise<unknown> = Promise.resolve();
	/**
	 * Timestamps of recent reconnectServer invocations per server, used by the
	 * crash-storm circuit breaker (see {@link RECONNECT_BURST_LIMIT}).
	 */
	#reconnectHistory = new Map<string, number[]>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;
	/** Aborts the handshakes of the current epoch; replaced on disconnectAll. */
	#connectAbort = new AbortController();
	/**
	 * Remote servers that were connected and then lost, with the backoff
	 * schedule that keeps trying to bring them back (see
	 * {@link MCPReconnectPolicy}). An entry exists from the moment a live
	 * connection is being replaced until a reconnect succeeds or the server
	 * is disconnected or reconfigured; `timer` is set while a scheduled
	 * attempt is pending.
	 */
	#lostRemoteServers = new Map<string, { timer: NodeJS.Timeout | undefined; delayMs: number }>();
	/** Views opened so far; never forgotten, so a revived session reopens its own. */
	#toolScopes = new Set<MCPToolScope>();
	/** Scope of each attributed tool call still running, by tool-call id. */
	#toolCallScopes = new Map<string, MCPToolScope>();
	/** Tool calls running per server. */
	#inFlightToolCalls = new Map<string, number>();
	/** Servers whose pending `tools/list` refresh answers a `list_changed` received during a call. */
	#callProvokedToolRefreshes = new Set<string>();
	/**
	 * Per server, tool name → scopes that see it, for tools a server added while
	 * a call to it ran. Tools absent here are visible to every scope.
	 */
	#scopedTools = new Map<string, Map<string, Set<MCPToolScope>>>();
	/** Bumped whenever any session's view of the tools may have changed; starts above a worker's empty cache (0). */
	#toolViewsRevision = 1;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
		private loadConfigs: MCPConfigLoader = loadAllMCPConfigs,
		private reconnectPolicy: MCPReconnectPolicy = DEFAULT_RECONNECT_POLICY,
	) {}

	/**
	 * Register a listener for MCP connection lifecycle events
	 * (`connecting` / `connected` / `failed`).
	 *
	 * Returns an unsubscribe function. Listener failures are isolated — a
	 * listener that throws does not prevent other listeners from firing.
	 */
	addConnectionStatusListener(listener: (event: McpConnectionStatusEvent) => void): () => void {
		this.#connectionStatusListeners.add(listener);
		return () => {
			this.#connectionStatusListeners.delete(listener);
		};
	}

	#emitConnectionStatus(event: McpConnectionStatusEvent): void {
		if (event.type === "failed" && this.#startupServers.has(event.serverName)) {
			this.#startupFailures.set(event.serverName, event.error);
		} else if (event.type === "connected") {
			this.#startupFailures.delete(event.serverName);
		}
		for (const listener of this.#connectionStatusListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.debug("MCP connection status listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener for MCP catalog refreshes (`resources` / `prompts`).
	 *
	 * Connection lifecycle stays on {@link addConnectionStatusListener}. This
	 * fires after a successful catalog refresh so `/extensions` can repaint
	 * without treating catalog load as another `connected` event.
	 *
	 * Returns an unsubscribe function. Listener failures are isolated.
	 */
	addCatalogChangeListener(listener: (event: McpCatalogChangeEvent) => void): () => void {
		this.#catalogChangeListeners.add(listener);
		return () => {
			this.#catalogChangeListeners.delete(listener);
		};
	}

	#emitCatalogChange(event: McpCatalogChangeEvent): void {
		for (const listener of this.#catalogChangeListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.debug("MCP catalog change listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener fired whenever the manager's tool set changes: a
	 * server's tools are (re)placed, a server is disconnected, or every server
	 * is dropped (`/mcp reload`). Read the new set from {@link getTools}.
	 *
	 * Unlike the single-slot {@link setOnToolsChanged} (owned by the session
	 * that created this manager), any number of sessions sharing the manager
	 * can subscribe — subagents use it to keep their MCP tools current.
	 *
	 * Returns an unsubscribe function. Listener failures are isolated.
	 */
	addToolsChangedListener(listener: () => void): () => void {
		this.#toolsChangedListeners.add(listener);
		return () => {
			this.#toolsChangedListeners.delete(listener);
		};
	}

	/**
	 * Changes whenever any session's view of the tools may have changed: a server's
	 * tools were replaced or removed, or a session was granted tools. Lets a
	 * worker skip re-fetching views that cannot have changed.
	 */
	get toolViewsRevision(): number {
		return this.#toolViewsRevision;
	}

	#emitToolsChanged(): void {
		this.#toolViewsRevision++;
		for (const listener of this.#toolsChangedListeners) {
			try {
				listener();
			} catch (error) {
				logger.debug("MCP tools changed listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener for server-initiated MCP notifications.
	 *
	 * The listener is called for every JSON-RPC notification received from any
	 * connected server, AFTER the manager's own handling of known methods
	 * (`notifications/tools/list_changed`, `notifications/resources/list_changed`,
	 * `notifications/resources/updated`, `notifications/prompts/list_changed`).
	 * For list-change methods the internal refresh promise is awaited before
	 * fanout, so listeners observe up-to-date manager and tool state. Unknown
	 * or server-custom methods are also delivered, letting consumers bridge
	 * server-initiated events into session-level behavior (e.g. an extension
	 * injecting a steer via `pi.sendMessage`).
	 *
	 * Notifications received before any listener attached are buffered
	 * (bounded FIFO, cap {@link NOTIFICATION_BUFFER_CAP}, drop-oldest) and
	 * drained into the first subscriber — matches {@link setOnPromptsChanged}'s
	 * replay-on-attach and {@link IrcBus}'s mailbox semantics.
	 *
	 * Returns an unsubscribe function; call it to remove the listener.
	 *
	 * Multiple listeners are allowed; each is invoked with independent error
	 * isolation — a listener that throws does not prevent other listeners from
	 * firing.
	 */
	addNotificationListener(listener: (serverName: string, method: string, params: unknown) => void): () => void {
		const wasEmpty = this.#notificationListeners.size === 0;
		this.#notificationListeners.add(listener);

		// Drain startup-buffered notifications into the first attaching listener.
		if (wasEmpty && this.#pendingNotifications.length > 0) {
			const pending = this.#pendingNotifications.splice(0);
			for (const frame of pending) {
				try {
					listener(frame.server, frame.method, frame.params);
				} catch (error) {
					logger.debug("MCP notification listener threw during buffered drain", {
						path: `mcp:${frame.server}`,
						method: frame.method,
						error,
					});
				}
			}
		}

		return () => {
			this.#notificationListeners.delete(listener);
		};
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 *
	 * May return a Promise; if so, {@link refreshServerTools} awaits it so that
	 * downstream consumers (e.g. `mcp_notification` listeners for
	 * `notifications/tools/list_changed`) observe not just the manager's
	 * refreshed tool set but also any session-level rebind driven by the
	 * handler (`session.refreshMCPTools`). Other callsites (initial connect,
	 * disconnect, reconnect) do not await it — their downstream chains don't
	 * need to serialize on the rebind.
	 *
	 * Calls are coalesced latest-wins: while the handler is running, further
	 * tool-set changes collapse into a single trailing call that receives the
	 * current tool list.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>): void {
		this.#onToolsChanged = handler;
	}

	/**
	 * Invoke the owner {@link setOnToolsChanged} handler, coalescing bursts.
	 * The returned promise settles once the handler has observed a tool set at
	 * least as new as the one current at call time; it rejects only when the
	 * last (newest) handler call failed.
	 */
	#notifyOwnerToolsChanged(): Promise<void> {
		if (!this.#onToolsChanged) return Promise.resolve();
		if (this.#ownerToolsRun) {
			this.#ownerToolsDirty = true;
			return this.#ownerToolsRun;
		}
		let settled = false;
		const run = (async () => {
			try {
				// A failed call must not swallow a call queued while it ran.
				let failure: unknown;
				let failed = false;
				do {
					this.#ownerToolsDirty = false;
					try {
						await this.#onToolsChanged?.(this.getTools());
						failed = false;
					} catch (error) {
						failure = error;
						failed = true;
					}
				} while (this.#ownerToolsDirty);
				if (failed) throw failure;
			} finally {
				settled = true;
				this.#ownerToolsRun = undefined;
			}
		})();
		// The first handler call starts synchronously above; a synchronous throw
		// settles the run before this line, so only publish it while pending.
		if (!settled) this.#ownerToolsRun = run;
		return run;
	}

	/**
	 * Set a callback to fire when any server's resources change.
	 */
	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		this.#onResourcesChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's prompts change.
	 */
	setOnPromptsChanged(handler: (serverName: string) => void): void {
		this.#onPromptsChanged = handler;
		// Fire immediately for servers that already have prompts loaded
		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
	}

	setNotificationsEnabled(enabled: boolean): void {
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			// Subscribe to all connected servers that support it
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		// Unsubscribe from all servers
		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
		}
		this.#subscribedResources.clear();
	}

	/**
	 * Set the auth storage for resolving OAuth credentials.
	 */
	setAuthStorage(authStorage: AuthStorage): void {
		if (this.#authStorage === authStorage) return;
		this.#epoch++;
		this.#cancelAuthQueue();
		this.#connectAbort.abort(new DOMException("MCP credential owner replaced", "AbortError"));
		this.#connectAbort = new AbortController();
		this.#authStorage = authStorage;
	}

	get lifecycleGeneration(): number {
		return this.#epoch;
	}

	/** Set the callback used to complete OAuth after an MCP auth challenge. */
	setAuthHandler(handler: MCPAuthHandler | undefined): void {
		this.#authHandler = handler;
	}

	/** Set the callback used to report serialized MCP OAuth progress. */
	setAuthQueueHandler(handler: MCPAuthQueueHandler | undefined): void {
		this.#authQueueHandler = handler;
	}

	/** Cancel the active MCP OAuth flow and every queued flow. */
	cancelAuthQueue(): void {
		if (this.#authQueueEntries.size === 0) return;
		this.#cancelAuthQueue();
	}

	#authQueueSnapshot(): string[] {
		return Array.from(this.#authQueueEntries.values(), entry => entry.serverName);
	}

	#emitAuthQueueEvent(event: MCPAuthQueueEvent): void {
		try {
			this.#authQueueHandler?.(event);
		} catch (error) {
			logger.debug("MCP auth queue handler threw", { error });
		}
	}

	#finishAuthQueueEntry(entry: MCPAuthQueueEntry, type: "completed" | "cancelled"): void {
		if (!this.#authQueueEntries.delete(entry.id)) return;
		this.#emitAuthQueueEvent({
			type,
			serverName: entry.serverName,
			queue: this.#authQueueSnapshot(),
		});
	}

	#cancelAuthQueue(): void {
		const entries = Array.from(this.#authQueueEntries.values());
		this.#authQueueGeneration++;
		this.#authQueueAbortController.abort("MCP OAuth queue cancelled");
		this.#authQueueEntries.clear();

		const remaining = entries.map(entry => entry.serverName);
		for (const entry of entries) {
			const index = remaining.indexOf(entry.serverName);
			if (index >= 0) remaining.splice(index, 1);
			this.#emitAuthQueueEvent({
				type: "cancelled",
				serverName: entry.serverName,
				queue: [...remaining],
			});
		}

		this.#authHandlerQueue = Promise.resolve();
		this.#authQueueAbortController = new AbortController();
	}

	/**
	 * Serialize OAuth flows so concurrent startup challenges cannot share a
	 * callback port.
	 */
	#runAuthHandler(
		name: string,
		challenge: MCPAuthChallenge,
		owner?: MCPConnectionOwner,
	): Promise<MCPServerConfig | undefined> {
		if (!this.#authHandler) return Promise.resolve(undefined);
		const isOwnerCurrent = () => owner?.signal?.aborted !== true && owner?.isCurrent?.() !== false;
		if (!isOwnerCurrent()) return Promise.reject(new ToolAbortError("MCP call owner changed"));

		const entry: MCPAuthQueueEntry = {
			id: ++this.#nextAuthQueueId,
			serverName: name,
			generation: this.#authQueueGeneration,
			signal: this.#authQueueAbortController.signal,
		};
		const signal = owner?.signal ? AbortSignal.any([entry.signal, owner.signal]) : entry.signal;
		const isCurrent = () => entry.generation === this.#authQueueGeneration && !signal.aborted && isOwnerCurrent();
		this.#authQueueEntries.set(entry.id, entry);
		this.#emitAuthQueueEvent({
			type: "queued",
			serverName: name,
			queue: this.#authQueueSnapshot(),
		});

		const run = async (): Promise<MCPServerConfig | undefined> => {
			if (entry.generation !== this.#authQueueGeneration || entry.signal.aborted) {
				this.#finishAuthQueueEntry(entry, "cancelled");
				throw new MCPOAuthCancelledError();
			}
			if (!isOwnerCurrent()) {
				this.#finishAuthQueueEntry(entry, "cancelled");
				throw new ToolAbortError("MCP call owner changed");
			}

			this.#emitAuthQueueEvent({
				type: "started",
				serverName: name,
				queue: this.#authQueueSnapshot(),
			});

			let cancelled = false;
			try {
				const refreshedConfig = await this.#authHandler?.(name, challenge, { signal, isCurrent });
				if (!isOwnerCurrent()) throw new ToolAbortError("MCP call owner changed");
				if (entry.generation !== this.#authQueueGeneration || entry.signal.aborted) {
					cancelled = true;
					throw new MCPOAuthCancelledError();
				}
				return refreshedConfig;
			} catch (error) {
				const ownerRetired = !isOwnerCurrent();
				cancelled =
					ownerRetired ||
					error instanceof MCPOAuthCancelledError ||
					entry.generation !== this.#authQueueGeneration ||
					entry.signal.aborted;
				if (ownerRetired) throw new ToolAbortError("MCP call owner changed");
				if (error instanceof MCPOAuthCancelledError) {
					this.#cancelAuthQueue();
				} else if (cancelled) {
					throw new MCPOAuthCancelledError();
				}
				throw error;
			} finally {
				this.#finishAuthQueueEntry(entry, cancelled ? "cancelled" : "completed");
			}
		};

		const result = this.#authHandlerQueue.then(run, run);
		this.#authHandlerQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * Discover and connect to all MCP servers from .mcp.json files.
	 * Returns tools and any connection errors.
	 */
	discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		const discovery = this.#discoverAndConnect(options);
		this.#discoveryInFlight = discovery.catch(() => undefined);
		return discovery;
	}

	async #discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		this.#discoverOptions = options ? { ...options } : undefined;
		let loadedConfigs: LoadMCPConfigsResult;
		try {
			loadedConfigs = await this.loadConfigs(this.cwd, {
				enableProjectConfig: options?.enableProjectConfig,
				requestProjectTrust: options?.requestProjectTrust,
				discoveryProviders: options?.discoveryProviders,
				filterExa: options?.filterExa,
				filterBrowser: options?.filterBrowser,
				extensionRoots: options?.extensionRoots,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#startupServers.add(".mcp.json");
			options?.onStatus?.({ type: "failed", serverName: ".mcp.json", error: message });
			this.#emitConnectionStatus({ type: "failed", serverName: ".mcp.json", error: message });
			throw error;
		}
		const { configs, exaApiKeys, sources } = loadedConfigs;
		const result = await this.connectServers(configs, sources, options?.onStatus, options?.startupTimeoutMs);
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	/**
	 * Reconcile browser-automation MCP servers with the built-in browser prelude.
	 * Calls are serialized so rapid setting toggles cannot reconnect a server
	 * after a newer enable has filtered it again.
	 */
	reconcileBrowserFilter(enabled: boolean): Promise<void> {
		const reconcile = this.#browserFilterMutationTail.then(() => this.#applyBrowserFilter(enabled));
		this.#browserFilterMutationTail = reconcile.catch(() => undefined);
		return reconcile;
	}

	/**
	 * Apply a live `mcp.enableProjectConfig` change: disconnect project-level
	 * servers when disabled (restoring any user-level server they shadowed), or
	 * connect them when enabled. Serialized with the browser-filter reconcile; a
	 * no-op before the first discovery, which reads the flag itself.
	 */
	reconcileProjectConfig(enabled: boolean): Promise<void> {
		const reconcile = this.#browserFilterMutationTail.then(() => this.#applyProjectConfig(enabled));
		this.#browserFilterMutationTail = reconcile.catch(() => undefined);
		return reconcile;
	}

	async #applyProjectConfig(enabled: boolean): Promise<void> {
		await this.#discoveryInFlight;
		const options = this.#discoverOptions;
		if (!options || (options.enableProjectConfig ?? true) === enabled) return;
		this.#discoverOptions = { ...options, enableProjectConfig: enabled };
		const loaded = await this.loadConfigs(this.cwd, {
			enableProjectConfig: enabled,
			filterExa: options.filterExa,
			filterBrowser: options.filterBrowser,
			extensionRoots: options.extensionRoots,
		});
		// Every server whose resolution depends on the flag: project-level ones
		// known now, plus project-level ones the enabled load resolves.
		const affected = new Set<string>();
		for (const name of this.getAllServerNames()) {
			if (this.getSource(name)?.level === "project") affected.add(name);
		}
		for (const name in loaded.sources) {
			if (loaded.sources[name]?.level === "project") affected.add(name);
		}
		if (affected.size === 0) return;
		await Promise.all([...affected].map(name => this.disconnectServer(name)));
		const configs: Record<string, MCPServerConfig> = {};
		const sources: Record<string, SourceMeta> = {};
		let reconnect = false;
		for (const name of affected) {
			const config = loaded.configs[name];
			if (!config) continue;
			configs[name] = config;
			reconnect = true;
			const source = loaded.sources[name];
			if (source) sources[name] = source;
		}
		if (!reconnect) return;
		await this.connectServers(configs, sources, options.onStatus, options.startupTimeoutMs);
	}

	async #applyBrowserFilter(enabled: boolean): Promise<void> {
		const options = this.#discoverOptions;
		const loaded = await this.loadConfigs(this.cwd, {
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: false,
			extensionRoots: options?.extensionRoots,
		});
		const browserConfigs: Record<string, MCPServerConfig> = {};
		const browserSources: Record<string, SourceMeta> = {};
		for (const name in loaded.configs) {
			const config = loaded.configs[name];
			if (!config || !isBrowserMCPServer(name, config)) continue;
			browserConfigs[name] = config;
			const source = loaded.sources[name];
			if (source) browserSources[name] = source;
		}

		if (!enabled) {
			await this.connectServers(browserConfigs, browserSources, options?.onStatus, options?.startupTimeoutMs);
			this.#discoverOptions = { ...options, filterBrowser: false };
			return;
		}

		const names = new Set<string>();
		for (const name in browserConfigs) names.add(name);
		for (const [name, config] of this.#serverConfigs) {
			if (isBrowserMCPServer(name, config)) names.add(name);
		}
		await Promise.all([...names].map(name => this.disconnectServer(name)));
		this.#discoverOptions = { ...options, filterBrowser: true };
	}

	/**
	 * Connect to specific MCP servers.
	 * Connections are made in parallel for faster startup.
	 *
	 * Incremental: tools for already-owned connections stay in {@link getTools}.
	 * Each newly resolved server is merged via {@link MCPManager.#replaceServerTools}.
	 * Interactive enable (`/mcp enable`, `/extensions`) can pass a single
	 * `{ [name]: config }` without wiping the rest of the registry.
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
		startupTimeoutMs?: number,
	): Promise<MCPLoadResult> {
		const reportedFailureStatuses = new Set<string>();
		const notify = (event: McpConnectionStatusEvent) => {
			if (event.type === "failed") {
				if (reportedFailureStatuses.has(event.serverName)) return;
				reportedFailureStatuses.add(event.serverName);
			}
			onStatus?.(event);
			this.#emitConnectionStatus(event);
		};
		type ConnectionTask = {
			name: string;
			cached?: MCPToolDefinition[];
			tracked: TrackedPromise<ToolLoadResult>;
			connectSignal: AbortSignal;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;
		const statusServerNames: string[] = [];
		const validationFailures: Array<{ name: string; message: string }> = [];

		// Prepare connection tasks
		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			this.#startupServers.add(name);
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			// Skip if already connected
			if (this.#connections.has(name)) {
				connectedServers.add(name);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			// Validate config
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				statusServerNames.push(name);
				const message = validationErrors.join("; ");
				errors.set(name, message);
				validationFailures.push({ name, message });
				reportedErrors.add(name);
				continue;
			}

			// Save config early so reconnection works even if the initial connect times out
			// and falls back to cached/deferred tools. A new config supersedes any
			// retry schedule still trying to bring back the old one.
			this.#forgetLostServer(name);
			this.#serverConfigs.set(name, config);
			const connectionEpoch = this.#epoch;
			const connectionAbortController = new AbortController();
			this.#connectionAbortControllers.set(name, connectionAbortController);
			const connectSignal = AbortSignal.any([this.#connectAbort.signal, connectionAbortController.signal]);
			const cached = config.enabled === false ? undefined : await this.toolCache?.get(name, config);
			connectSignal.throwIfAborted();
			if (cached?.length) {
				const source = this.#sources.get(name);
				const reconnect = (options?: { authChallenge?: MCPAuthChallenge; awsProfile?: string }) =>
					this.#reconnectServerForTool(name, options);
				this.#replaceServerTools(
					name,
					config,
					DeferredMCPTool.fromTools(
						name,
						cached,
						() => this.waitForConnection(name),
						source,
						reconnect,
						this.#observeToolCall(name),
					),
				);
				this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
			}

			statusServerNames.push(name);

			const connectionConfig = config;
			const source = sources[name];
			const sourceLevel = source?.level;
			const connectWithConfig = async (candidateConfig: MCPServerConfig): Promise<MCPServerConnection> => {
				const resolvedConfig = await this.#resolveAuthConfig(candidateConfig, {
					sourceLevel,
					signal: connectSignal,
				});
				const policy = resolveMCPChildCredentialPolicy(name, resolvedConfig, source);
				return connectToServer(name, resolvedConfig, {
					signal: connectSignal,
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
					...policy,
					awsAnonymousBootstrap: policy.preserveOperationalAws,
				});
			};
			const connectionPromise = (async () => {
				try {
					return await connectWithConfig(connectionConfig);
				} catch (error) {
					const authChallenge = getInitialAuthChallenge(error, connectionConfig);
					if (authChallenge) {
						// Startup must remain non-interactive. Remember the challenge
						// for a cached/deferred tool's first actual invocation.
						this.#pendingAuthChallenges.set(name, authChallenge);
					}
					throw error;
				}
			})().then(
				connection => {
					if (this.#epoch !== connectionEpoch || this.#pendingConnections.get(name) !== connectionPromise) {
						this.#detachConnection(name, connection);
						void disconnectServer(connection).catch(() => {});
						throw new Error(`Server "${name}" was disconnected during initial connection`);
					}
					// Store config without resolved tokens to keep cache keys stable and
					// avoid leaking rotating credentials.
					connection.config = connectionConfig;
					if (sources[name]) {
						connection._source = sources[name];
					}

					this.#pendingConnections.delete(name);
					this.#connections.set(name, connection);
					this.#serverConfigs.set(name, connectionConfig);
					this.#pendingAuthChallenges.delete(name);
					this.#declinedAuthServers.delete(name);

					this.#wireAuthRefresh(connection, connectionConfig, sourceLevel, connectSignal);

					// Re-establish connection if the transport closes (server restart,
					// network interruption).
					connection.transport.onClose = () => {
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
						this.#emitConnectionStatus({ type: "reconnecting", serverName: name });
						void this.reconnectServer(name);
					};

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				try {
					const serverTools = await listTools(connection, { signal: connectSignal });
					return { connection, serverTools };
				} catch (error) {
					// Detach and delete synchronously, then close in the background:
					// awaiting a slow HTTP close (session DELETE) here would keep
					// toolsPromise pending past the startup race, so connectServers
					// would return with no error while #pendingToolLoads stayed set
					// and future connects for this server were skipped.
					this.#detachConnection(name, connection);
					void disconnectServer(connection).catch(() => {});
					throw error;
				}
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, cached: cached ?? undefined, tracked, connectSignal });

			const startupUpdate = toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = (options?: { authChallenge?: MCPAuthChallenge; awsProfile?: string }) =>
						this.#reconnectServerForTool(name, options);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.#observeToolCall(name));
					if (!this.#replaceServerTools(name, connectionConfig, customTools, connection)) return;
					await this.#notifyOwnerToolsChanged();
					if (!this.#ownsConnection(name, connection)) return;
					void this.toolCache?.set(name, connectionConfig, serverTools);

					notify({ type: "connected", serverName: name });
					void this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					// disconnectAll aborted this handshake: torn down, not failed.
					if (isAbortedHandshake(connectSignal, error) || this.#pendingToolLoads.get(name) !== toolsPromise)
						return;
					this.#pendingToolLoads.delete(name);
					if (error instanceof MCPOAuthCancelledError) {
						onStatus?.({ type: "cancelled", serverName: name });
						return;
					}
					const message = error instanceof Error ? error.message : String(error);
					notify(createMcpStartupFailure(name, message, sources[name]));
					if (allowBackgroundLogging && !reportedErrors.has(name)) {
						logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
					}
					if (error instanceof MCPConnectionTimeoutError) {
						notify({ type: "reconnecting", serverName: name });
						const stopForwarding = onStatus
							? this.addConnectionStatusListener(event => {
									if ((event.type === "connected" || event.type === "failed") && event.serverName === name) {
										if (event.type === "failed") notify(event);
										else onStatus(event);
									}
								})
							: undefined;
						const retry = this.reconnectServer(name);
						if (stopForwarding) void retry.then(stopForwarding, stopForwarding);
						else void retry;
					}
				})
				.finally(() => {
					if (this.#startupUpdates.get(name) === startupUpdate) this.#startupUpdates.delete(name);
				});
			this.#startupUpdates.set(name, startupUpdate);
		}

		// Notify about servers we're connecting to, including configs that fail fast.
		if (statusServerNames.length > 0) {
			notify({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				notify(createMcpStartupFailure(name, message, sources[name]));
			}
		}

		const startupTasks = connectionTasks.filter(task => !task.cached?.length);
		if (startupTasks.length > 0) {
			const initialLoads = Promise.allSettled(startupTasks.map(task => task.tracked.promise));
			const windowMs = resolveMCPStartupTimeoutMs(startupTimeoutMs);
			if (windowMs === 0) await initialLoads;
			else await Promise.race([initialLoads, Bun.sleep(windowMs)]);
		}

		if (connectionTasks.length > 0) {
			// Pending tasks without cached tools used to be awaited synchronously here,
			// which gated the entire UI on the slowest server's per-request timeout
			// (issue #2100: a single unresponsive MCP server blocked startup for the
			// full 30 s `OMP_MCP_TIMEOUT_MS`). Leave them in flight — the background
			// `void toolsPromise.then(...)` chain above registers their tools and
			// fires `#onToolsChanged` once the connect finishes, or logs the failure
			// after `allowBackgroundLogging` flips below.

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const connection = task.tracked.value?.connection;
					if (connection && this.#ownsConnection(name, connection)) connectedServers.add(name);
				} else if (task.tracked.status === "rejected" && !task.cached?.length) {
					if (isAbortedHandshake(task.connectSignal, task.tracked.reason)) continue;
					if (task.tracked.reason instanceof MCPOAuthCancelledError) continue;
					const authHint = this.#pendingAuthChallenges.has(name)
						? ` Run \`/mcp reauth ${name}\` to authenticate this server.`
						: "";
					const message = `${task.tracked.reason instanceof Error ? task.tracked.reason.message : String(task.tracked.reason)}${authHint}`;
					errors.set(name, message);
					reportedErrors.add(name);
				}
			}
		}

		allowBackgroundLogging = true;

		return {
			tools: this.getTools(),
			errors,
			connectedServers: Array.from(connectedServers).filter(name => this.#connections.has(name)),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	#ownsConnection(name: string, connection: MCPServerConnection): boolean {
		return this.#connections.get(name) === connection && this.#serverConfigs.get(name) === connection.config;
	}

	/**
	 * Ownership is matched via `mcpServerName`, never a `mcp__${name}_` name
	 * prefix: tool names are lossy-sanitized, so one server's sanitized name
	 * can prefix another's (`atlassian` vs `atlassian:atlassian`) and a name
	 * with sanitized characters never prefix-matches its own tools at all.
	 */
	#replaceServerTools(
		name: string,
		config: MCPServerConfig,
		tools: CustomTool<TSchema, MCPToolDetails>[],
		connection?: MCPServerConnection,
	): boolean {
		if (this.#serverConfigs.get(name) !== config || (connection && !this.#ownsConnection(name, connection))) {
			return false;
		}
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		if (config.exposeTools !== false) this.#tools.push(...tools);
		// Stable sort by name so reconnect order does not perturb the array.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(this.#tools);
		const scoped = this.#scopedTools.get(name);
		if (scoped) {
			const present = new Set(tools.map(tool => tool.mcpToolName));
			for (const toolName of scoped.keys()) {
				if (!present.has(toolName)) scoped.delete(toolName);
			}
			if (scoped.size === 0) this.#scopedTools.delete(name);
		}
		this.#emitToolsChanged();
		return this.#serverConfigs.get(name) === config && (!connection || this.#ownsConnection(name, connection));
	}

	/**
	 * Observer for `name`'s tools. A call completes only after the tool refresh
	 * it provoked lands, then its session sees every tool the server now serves.
	 */
	#observeToolCall(name: string): MCPToolCallObserver {
		return toolCallId => this.#beginToolCall(name, this.#toolCallScopes.get(toolCallId) ?? OWNER_TOOL_SCOPE);
	}

	#beginToolCall(name: string, scope: MCPToolScope): () => Promise<void> {
		this.#inFlightToolCalls.set(name, (this.#inFlightToolCalls.get(name) ?? 0) + 1);
		return async () => {
			const remaining = (this.#inFlightToolCalls.get(name) ?? 1) - 1;
			if (remaining > 0) this.#inFlightToolCalls.set(name, remaining);
			else this.#inFlightToolCalls.delete(name);
			// A `list_changed` sent during the call already started this refresh.
			await this.#toolRefreshes.get(name)?.promise.catch(() => {});
			this.#grantServerTools(name, scope);
		};
	}

	/** Let `scope` see every tool `name` serves; notify it when that changed its view. */
	#grantServerTools(name: string, scope: MCPToolScope): void {
		const scoped = this.#scopedTools.get(name);
		if (!scoped) return;
		let granted = false;
		for (const scopes of scoped.values()) {
			if (scopes.has(scope)) continue;
			scopes.add(scope);
			granted = true;
		}
		if (!granted) return;
		this.#toolViewsRevision++;
		if (scope === OWNER_TOOL_SCOPE) {
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
		} else {
			this.#emitToolsChanged();
		}
	}

	openToolScope(scope: MCPToolScope, seed: MCPToolScope = OWNER_TOOL_SCOPE): void {
		if (this.#toolScopes.has(scope)) return;
		this.#toolScopes.add(scope);
		for (const scoped of this.#scopedTools.values()) {
			for (const scopes of scoped.values()) {
				if (scopes.has(seed)) scopes.add(scope);
			}
		}
	}

	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void {
		this.#toolCallScopes.set(toolCallId, scope);
		return () => {
			if (this.#toolCallScopes.get(toolCallId) === scope) this.#toolCallScopes.delete(toolCallId);
		};
	}

	/** Tools in `tools` that `name` does not serve yet start visible to no scope. */
	#scopeAddedTools(name: string, tools: readonly CustomTool<TSchema, MCPToolDetails>[]): void {
		const previous = new Set(this.#tools.filter(tool => tool.mcpServerName === name).map(tool => tool.mcpToolName));
		const scoped = this.#scopedTools.get(name) ?? new Map<string, Set<MCPToolScope>>();
		for (const tool of tools) {
			if (tool.mcpToolName !== undefined && !previous.has(tool.mcpToolName)) scoped.set(tool.mcpToolName, new Set());
		}
		if (scoped.size > 0) this.#scopedTools.set(name, scoped);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): Promise<void> {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		return refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	async #handleServerNotification(serverName: string, method: string, params: unknown): Promise<void> {
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		// Only trigger refresh if the connection is already stored — during the
		// initial connect handshake, notifications may arrive before
		// `#connections.set()` completes, and `refreshServer*` would no-op
		// anyway. Skipping the await in that case preserves arrival order
		// across concurrently-dispatched notifications (an awaited refresh,
		// even a no-op, yields a microtask that lets later frames overtake).
		const connectionKnown = this.#connections.has(serverName);
		let refreshPromise: Promise<void> | undefined;
		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				if (connectionKnown) {
					// A change announced during a call belongs to the sessions whose calls see it through.
					if (this.#inFlightToolCalls.has(serverName)) this.#callProvokedToolRefreshes.add(serverName);
					refreshPromise = this.#triggerNotificationRefresh(serverName, "tools");
				}
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri =
					params && typeof params === "object" && "uri" in params && typeof params.uri === "string"
						? params.uri
						: undefined;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				break;
		}

		// Await internal refresh so listeners see the manager's post-refresh
		// state (satisfies the documented "AFTER the manager's own handling"
		// contract on `addNotificationListener` — otherwise an extension acting
		// on `tools/list_changed` could hit stale `getTools()`).
		if (refreshPromise) {
			await refreshPromise;
		}

		// Buffer for late-attaching subscribers when no listener exists yet.
		if (this.#notificationListeners.size === 0) {
			this.#pendingNotifications.push({ server: serverName, method, params });
			if (this.#pendingNotifications.length > NOTIFICATION_BUFFER_CAP) {
				this.#pendingNotifications.shift();
			}
			return;
		}

		for (const listener of this.#notificationListeners) {
			try {
				listener(serverName, method, params);
			} catch (error) {
				logger.debug("MCP notification listener threw", {
					path: `mcp:${serverName}`,
					method,
					error,
				});
			}
		}
	}

	/** Handle server-to-client JSON-RPC requests (e.g. ping, roots/list). */
	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
	}

	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	getTools(scope: MCPToolScope = OWNER_TOOL_SCOPE): CustomTool<TSchema, MCPToolDetails>[] {
		if (this.#scopedTools.size === 0) return this.#tools;
		return this.#tools.filter(tool => {
			const scopes = this.#scopedTools.get(tool.mcpServerName ?? "")?.get(tool.mcpToolName ?? "");
			return scopes === undefined || scopes.has(scope);
		});
	}

	/** Invoke only this manager's configured server; never use the process singleton. */
	async callTool(
		serverName: string,
		toolName: string,
		args: Record<string, unknown> = {},
		options: MCPCallToolOptions = {},
		context?: MCPHostCallContext,
	): Promise<MCPToolCallResult> {
		const ownerSignal = context
			? this.#connectAbort.signal
			: (this.#connectionAbortControllers.get(serverName)?.signal ?? this.#connectAbort.signal);
		const signal = options.signal ? AbortSignal.any([options.signal, ownerSignal]) : ownerSignal;
		throwIfAborted(signal);
		const config = this.#serverConfigs.get(serverName);
		if (!config || config.enabled === false) {
			throw new Error(`MCP server is not enabled in this session: ${serverName}`);
		}
		const isCurrent = () =>
			!signal.aborted &&
			this.#serverConfigs.get(serverName) === config &&
			config.enabled !== false &&
			context?.mcpOwnerCurrent?.() !== false;
		const assertLocalCurrent = () => {
			throwIfAborted(signal);
			if (!isCurrent()) throw new ToolAbortError("MCP call owner changed");
		};
		const assertCurrent = async () => {
			assertLocalCurrent();
			if (context?.mcpCheckOwner) {
				await context.mcpCheckOwner();
				assertLocalCurrent();
			}
		};
		await assertCurrent();
		let connection = await untilAborted(signal, () => {
			assertLocalCurrent();
			return this.waitForConnection(serverName, signal, isCurrent);
		});
		await assertCurrent();
		if (!connection.transport.connected) {
			const reconnected = await untilAborted(signal, () => {
				assertLocalCurrent();
				return this.#reconnectServerForTool(serverName, { signal, isCurrent });
			});
			await assertCurrent();
			if (!reconnected) throw new Error(`MCP server not connected: ${serverName}`);
			connection = reconnected;
		}
		const tools =
			connection.tools ??
			(await untilAborted(signal, () => {
				assertLocalCurrent();
				return listTools(connection, { signal });
			}));
		await assertCurrent();
		const tool = tools.find(candidate => candidate.name === toolName);
		if (!tool) throw new Error(`MCP tool not found: ${serverName}/${toolName}`);
		const requestContext: MCPHostCallContext | undefined = context
			? { ...context, mcpOwnerCurrent: isCurrent }
			: undefined;
		assertLocalCurrent();
		const settle = this.#beginToolCall(serverName, OWNER_TOOL_SCOPE);
		let result: MCPToolCallResult;
		try {
			const attempt = await dispatchMCPTool(
				connection,
				tool,
				args,
				reconnectOptions => {
					assertLocalCurrent();
					return this.#reconnectServerForTool(serverName, { ...reconnectOptions, signal, isCurrent });
				},
				{ retry: options.retry, signal },
				requestContext,
			);
			result = attempt.result;
		} finally {
			await settle();
		}
		await assertCurrent();
		assertLocalCurrent();
		return result;
	}

	/**
	 * Wait for configured servers' initial tool registration, including empty tool lists.
	 * Zero disables the barrier deadline; an unresponsive server can then wait indefinitely.
	 * Tool-change callbacks are drained before returning; callers should still refresh their
	 * session with the final tool snapshot before sending a prompt.
	 */
	async waitForStartup(timeoutMs: number): Promise<MCPStartupStatus> {
		const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
		for (;;) {
			const pending = [...this.#startupUpdates.values(), ...this.#pendingReconnections.values()];
			if (pending.length === 0 || Date.now() >= deadline) break;

			const { promise, resolve } = Promise.withResolvers<void>();
			const remaining = deadline - Date.now();
			const timer = remaining === Infinity ? undefined : setTimeout(resolve, Math.min(remaining, 2_147_483_647));
			try {
				await Promise.race([Promise.allSettled(pending), promise]);
			} finally {
				clearTimeout(timer);
			}
		}

		const status: MCPStartupStatus = { connected: [], pending: [], failed: [] };
		for (const name of this.#startupServers) {
			if (
				this.#startupUpdates.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingConnections.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				status.pending.push(name);
			} else if (this.#connections.has(name)) {
				status.connected.push(name);
			} else {
				status.failed.push({
					name,
					error: this.#startupFailures.get(name) ?? "Connection closed before startup completed",
				});
			}
		}
		return status;
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	/**
	 * Get current connection status for a server.
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (this.#pendingConnections.has(name) || this.#pendingReconnections.has(name)) return "connecting";
		return "disconnected";
	}

	/**
	 * Get source metadata for a server.
	 */
	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	/**
	 * Get the preserved (pre-auth) config for a known server — whether currently
	 * connected or merely discovered (a connect was attempted but may have failed,
	 * e.g. an OAuth server that has not been authorized yet). Mirrors the
	 * reconnect lookup at {@link reconnectServer} so callers like `/mcp reauth`
	 * can recover a discovered server's config without re-reading config files.
	 */
	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.#connections.get(name)?.config ?? this.#serverConfigs.get(name);
	}

	/**
	 * Resolve a deferred tool's server on its first use. A startup challenge is
	 * authorized here, after the tool call has passed its normal approval gate.
	 */
	async #reconnectServerForTool(name: string, options?: MCPToolReconnectOptions): Promise<MCPServerConnection | null> {
		throwIfAborted(options?.signal);
		if (options?.isCurrent?.() === false) throw new ToolAbortError("MCP call owner changed");
		const existing = this.#pendingFirstUseConnections.get(name);
		if (existing) return await existing;
		const pending = this.#reconnectServerForToolInternal(name, options);
		this.#pendingFirstUseConnections.set(name, pending);
		try {
			return await pending;
		} finally {
			if (this.#pendingFirstUseConnections.get(name) === pending) this.#pendingFirstUseConnections.delete(name);
		}
	}

	async #reconnectServerForToolInternal(
		name: string,
		options?: MCPToolReconnectOptions,
	): Promise<MCPServerConnection | null> {
		if (this.#declinedAuthServers.has(name)) return null;
		const definition = this.getServerConfig(name);
		const source = this.getSource(name);
		const epoch = this.#epoch;
		const isCurrent = (): boolean =>
			options?.signal?.aborted !== true &&
			options?.isCurrent?.() !== false &&
			this.#epoch === epoch &&
			this.getServerConfig(name) === definition &&
			this.getSource(name) === source;
		if (!isCurrent()) throw new ToolAbortError("MCP call owner changed");
		if (options?.awsProfile) {
			return this.reconnectServer(name, {
				awsProfile: options.awsProfile,
				signal: options.signal,
				isCurrent: options.isCurrent,
			});
		}
		let authChallenge = options?.authChallenge ?? this.#pendingAuthChallenges.get(name);
		if (!authChallenge) {
			const connection = await this.reconnectServer(name, options);
			if (!isCurrent()) return null;
			if (connection) return connection;
			authChallenge = this.#pendingAuthChallenges.get(name);
			if (!authChallenge) return null;
		}

		try {
			const authorizedConfig = await this.#runAuthHandler(name, authChallenge, {
				signal: options?.signal,
				isCurrent,
			});
			if (!isCurrent()) return null;
			if (!authorizedConfig) {
				this.#declinedAuthServers.add(name);
				return null;
			}
			return this.reconnectServer(name, {
				authorizedConfig,
				signal: options?.signal,
				isCurrent: options?.isCurrent,
			});
		} catch (error) {
			if (isCurrent()) this.#declinedAuthServers.add(name);
			throw error;
		}
	}

	/**
	 * Replace a stored server definition in place — used when its credentials
	 * were refreshed outside the manager (e.g. `/mcp reauth` wrote a fresh
	 * url-keyed credential row and the next auth resolution must pick it up).
	 *
	 * Updates both the stored definition and any live connection's `config`
	 * ({@link reconnectServer} prefers the live connection's copy over the
	 * stored map), and forgets any lost-server retry schedule so the next
	 * reconnect uses the new definition instead of re-arming the stale one.
	 *
	 * Returns the in-flight reconnection for the server, if one was pending:
	 * it captured the old definition and aborts on its next identity check.
	 * Callers that intend to reconnect must await it first, or
	 * {@link reconnectServer} merely joins the dying attempt instead of
	 * starting a fresh one against the new definition.
	 */
	updateServerConfig(name: string, config: MCPServerConfig): Promise<MCPServerConnection | null> | undefined {
		this.#serverConfigs.set(name, config);
		const connection = this.#connections.get(name);
		if (connection) connection.config = config;
		this.#forgetLostServer(name);
		return this.#pendingReconnections.get(name);
	}

	/**
	 * Wait for a connection to complete (or fail).
	 */
	async waitForConnection(
		name: string,
		signal?: AbortSignal,
		isCurrent?: () => boolean,
	): Promise<MCPServerConnection> {
		const assertCurrent = () => {
			throwIfAborted(signal);
			if (isCurrent?.() === false) throw new ToolAbortError("MCP call owner changed");
		};
		assertCurrent();
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) {
			try {
				const connected = await pending;
				assertCurrent();
				return connected;
			} catch {
				// A deferred tool may recover interactively after non-interactive discovery fails.
			}
		}
		assertCurrent();
		const recovered = this.#connections.get(name);
		if (recovered) return recovered;
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			assertCurrent();
			if (result) return result;
		}
		assertCurrent();
		const reconnected = await this.#reconnectServerForTool(name, { signal, isCurrent });
		assertCurrent();
		if (reconnected) return reconnected;
		throw new Error(`MCP server not connected: ${name}`);
	}

	/**
	 * Wait for every in-flight connect, tool load, and reconnect to settle.
	 *
	 * One-shot callers (e.g. `omp read <mcp-resource>`) discover servers and read
	 * immediately; a server whose handshake outlasts the {@link connectServers}
	 * startup race is still tracked in {@link #pendingConnections} /
	 * {@link #pendingToolLoads} and therefore invisible to
	 * {@link getConnectedServers}. Awaiting the pending work lets those callers
	 * observe the final attached/failed state instead of racing mid-handshake.
	 * Rejections are swallowed — the caller re-reads state afterwards.
	 */
	async waitForPendingConnections(): Promise<void> {
		// A settling tool load can arm a reconnect (startup-timeout retry), so
		// drain in passes until no work remains. Bounded so a reconnect storm
		// cannot spin this forever.
		for (let pass = 0; pass < 8; pass++) {
			const pending: Promise<unknown>[] = [
				...this.#pendingConnections.values(),
				...this.#pendingToolLoads.values(),
				...this.#pendingReconnections.values(),
			];
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
		}
	}

	/**
	 * Resolve auth and shell-command substitutions in config before connecting.
	 * Pass `oauth: false` to skip OAuth credential injection (used by reauth's
	 * unauthenticated probe, which must observe the server's bare 401).
	 */
	async prepareConfig(
		config: MCPServerConfig,
		options?: { oauth?: boolean; sourceLevel?: SourceMeta["level"]; signal?: AbortSignal },
	): Promise<MCPServerConfig> {
		return this.#resolveAuthConfig(config, options);
	}

	/**
	 * Get all connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	/**
	 * Get all known server names (connected, connecting, or discovered).
	 */
	getAllServerNames(): string[] {
		return Array.from(
			new Set([
				...this.#sources.keys(),
				...this.#connections.keys(),
				...this.#pendingConnections.keys(),
				...this.#serverConfigs.keys(),
			]),
		);
	}

	/**
	 * Drop a connection from the active map and detach its lifecycle hooks.
	 *
	 * Synchronous and identity-guarded: only removes the entry when it is still
	 * the connection registered under `name`, so a stale cleanup never evicts a
	 * newer connection for the same server. Detaching `onClose` first prevents
	 * the transport's own `close()` from re-arming reconnect.
	 */
	#detachConnection(name: string, connection: MCPServerConnection): void {
		connection.transport.onClose = undefined;
		if (isAuthRefreshableMCPTransport(connection.transport)) connection.transport.onAuthError = undefined;
		if (this.#connections.get(name) === connection) {
			this.#connections.delete(name);
			if (this.#toolRefreshes.get(name)?.connection === connection) this.#toolRefreshes.delete(name);
		}
	}

	/**
	 * Detach a connection and await its transport close.
	 *
	 * Use only where blocking on the close is acceptable (owned disconnects,
	 * dispose). On reject-fast paths detach synchronously and close in the
	 * background so a slow `close()` (HTTP session DELETE) cannot delay the
	 * rejection — see the `tools/list` failure handler in `connectServers`.
	 */
	async #discardConnection(name: string, connection: MCPServerConnection): Promise<void> {
		this.#detachConnection(name, connection);
		await disconnectServer(connection);
	}

	/**
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#startupServers.delete(name);
		this.#startupFailures.delete(name);
		this.#startupUpdates.delete(name);
		this.#connectionAbortControllers.get(name)?.abort(new DOMException("MCP server disconnected", "AbortError"));
		this.#connectionAbortControllers.delete(name);
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingFirstUseConnections.delete(name);
		this.#pendingReconnections.delete(name);
		this.#pendingAuthChallenges.delete(name);
		this.#declinedAuthServers.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#reconnectHistory.delete(name);
		this.#forgetLostServer(name);
		this.#callProvokedToolRefreshes.delete(name);
		this.#scopedTools.delete(name);

		const connection = this.#connections.get(name);

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		const disconnecting = connection ? this.#discardConnection(name, connection) : undefined;

		const hadTools = this.#tools.some(t => t.mcpServerName === name);
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		if (hadTools) {
			this.#emitToolsChanged();
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
		}

		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
		await disconnecting;
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		this.#cancelAuthQueue();
		for (const controller of this.#connectionAbortControllers.values()) {
			controller.abort(new DOMException("MCP manager disconnected", "AbortError"));
		}
		this.#connectionAbortControllers.clear();
		// Invalidate any in-flight reconnection attempts that outlive this call.
		// They captured the old epoch; after increment they'll detect staleness.
		// A scheduled retry that fired during the teardown below would sample
		// the new epoch and survive it, so end every schedule first. Abort the
		// handshakes still in flight too: a stalled one would otherwise keep its
		// transport (and a stdio child) alive until its own timeout, or forever.
		this.#epoch++;
		this.#connectAbort.abort();
		this.#connectAbort = new AbortController();
		for (const name of this.#lostRemoteServers.keys()) this.#forgetLostServer(name);
		const promises = Array.from(this.#connections, ([name, connection]) => this.#discardConnection(name, connection));
		await Promise.allSettled(promises);

		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#startupUpdates.clear();
		this.#startupServers.clear();
		this.#startupFailures.clear();
		this.#pendingFirstUseConnections.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#pendingAuthChallenges.clear();
		this.#declinedAuthServers.clear();
		this.#sources.clear();
		// The next connect (`/mcp reload` rediscovery) runs every `!command` again.
		for (const config of this.#serverConfigs.values()) invalidateCommandValues(config);
		this.#serverConfigs.clear();
		this.#callProvokedToolRefreshes.clear();
		this.#scopedTools.clear();
		const hadTools = this.#tools.length > 0;
		this.#tools = [];
		if (hadTools) this.#emitToolsChanged();
		this.#subscribedResources.clear();
		this.#reconnectHistory.clear();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 *
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers. Concurrent calls for
	 * the same server share one reconnection attempt. Returns the new
	 * connection, or `null` if reconnection failed or the per-server crash
	 * burst limit (see {@link RECONNECT_BURST_LIMIT}) is exceeded. A failed
	 * reconnect of a remote server that was connected keeps being retried in
	 * the background (see {@link MCPReconnectPolicy}).
	 * @param options.manual - When `true`, resets the crash-burst window so a
	 *   user-driven retry (e.g. `/mcp reconnect`) is never blocked by an
	 *   earlier storm. Defaults to `false`; the transport `onClose` callback
	 *   and the per-tool-call retry path in `tool-bridge` MUST NOT set it.
	 */
	async reconnectServer(
		name: string,
		options?: {
			manual?: boolean;
			authChallenge?: MCPAuthChallenge;
			authorizedConfig?: MCPServerConfig;
			awsProfile?: string;
			signal?: AbortSignal;
			isCurrent?: () => boolean;
		},
	): Promise<MCPServerConnection | null> {
		if (options?.signal?.aborted || options?.isCurrent?.() === false) return null;
		if (options?.manual) {
			this.#reconnectHistory.delete(name);
			this.#pendingAuthChallenges.delete(name);
			this.#declinedAuthServers.delete(name);
		}

		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		if (this.#tripReconnectBreaker(name)) {
			return null;
		}

		return this.#trackReconnect(
			name,
			this.#doReconnect(name, {
				authChallenge: options?.authChallenge,
				authorizedConfig: options?.authorizedConfig,
				awsProfile: options?.awsProfile,
				signal: options?.signal,
				isCurrent: options?.isCurrent,
			}),
		);
	}

	/**
	 * Register an in-flight reconnect so concurrent callers share it, and
	 * settle the lost-server schedule on its outcome: a new connection or an
	 * interactive auth challenge ends the schedule; other failures retry.
	 */
	#trackReconnect(name: string, attempt: Promise<MCPServerConnection | null>): Promise<MCPServerConnection | null> {
		this.#pendingReconnections.set(name, attempt);
		return attempt
			.finally(() => {
				if (this.#pendingReconnections.get(name) === attempt) {
					this.#pendingReconnections.delete(name);
				}
			})
			.then(
				connection => {
					if (connection || this.#pendingAuthChallenges.has(name)) this.#forgetLostServer(name);
					else if (this.#lostRemoteServers.has(name)) this.#scheduleLostServerRetry(name);
					return connection;
				},
				error => {
					if (this.#lostRemoteServers.has(name)) this.#scheduleLostServerRetry(name);
					throw error;
				},
			);
	}

	/**
	 * Arm the next quiet attempt for a lost remote server, doubling the delay
	 * each time up to the policy ceiling. An explicit reconnect that lands
	 * first takes the usual path; the timer then finds it pending and stands
	 * down, and that reconnect's outcome settles the schedule instead.
	 */
	#scheduleLostServerRetry(name: string): void {
		const state = this.#lostRemoteServers.get(name);
		if (!state) return;
		clearTimeout(state.timer);
		const delayMs = state.delayMs;
		state.delayMs = Math.min(delayMs * 2, this.reconnectPolicy.retryMaxMs);
		state.timer = setTimeout(() => {
			state.timer = undefined;
			if (this.#lostRemoteServers.get(name) !== state || this.#pendingReconnections.has(name)) return;
			void this.#trackReconnect(name, this.#doReconnect(name, { scheduled: true }));
		}, delayMs);
		state.timer.unref();
		logger.debug("MCP reconnect scheduled", { path: `mcp:${name}`, delayMs });
	}

	/** End a lost server's retry schedule: it reconnected, or it was disconnected or reconfigured. */
	#forgetLostServer(name: string): void {
		const state = this.#lostRemoteServers.get(name);
		if (!state) return;
		clearTimeout(state.timer);
		this.#lostRemoteServers.delete(name);
	}

	/**
	 * Record a reconnect attempt against the per-server crash window and report
	 * whether the circuit breaker is now open. Sliding window: entries older
	 * than {@link RECONNECT_BURST_WINDOW_MS} are pruned before the new
	 * timestamp is appended, so a single transient failure ages out cheaply
	 * but repeated rapid crashes accumulate until the limit is hit.
	 */
	#tripReconnectBreaker(name: string): boolean {
		const now = Date.now();
		const previous = this.#reconnectHistory.get(name) ?? [];
		const recent = previous.filter(ts => now - ts < RECONNECT_BURST_WINDOW_MS);
		recent.push(now);
		this.#reconnectHistory.set(name, recent);

		if (recent.length > RECONNECT_BURST_LIMIT) {
			logger.error("MCP server crashed too many times; suspending automatic reconnects", {
				path: `mcp:${name}`,
				crashes: recent.length,
				windowMs: RECONNECT_BURST_WINDOW_MS,
			});
			// Tear down the stale connection so `getConnectionStatus()` no
			// longer reports it as "connected" and `waitForConnection()` does
			// not hand a closed transport to callers. Tools stay registered
			// in `#tools` — the user can recover with `/mcp reconnect <name>`
			// once they've fixed the underlying misconfiguration. Mirrors the
			// teardown in `#doReconnect`: detach `onClose` first so the
			// transport's own `close()` cannot re-arm this path.
			const stale = this.#connections.get(name);
			if (stale) {
				void this.#discardConnection(name, stale).catch(() => {});
			}
			this.#pendingConnections.delete(name);
			this.#pendingToolLoads.delete(name);
			this.#forgetLostServer(name);
			this.#emitConnectionStatus({
				type: "failed",
				serverName: name,
				error: "MCP server crashed too many times; automatic reconnects suspended",
			});
			return true;
		}
		return false;
	}

	async #doReconnect(
		name: string,
		options: {
			authChallenge?: MCPAuthChallenge;
			authorizedConfig?: MCPServerConfig;
			scheduled?: boolean;
			awsProfile?: string;
			signal?: AbortSignal;
			isCurrent?: () => boolean;
		},
	): Promise<MCPServerConnection | null> {
		const { authChallenge, authorizedConfig, scheduled = false } = options;
		if (options.signal?.aborted || options.isCurrent?.() === false) return null;
		const oldConnection = this.#connections.get(name);
		let config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const authEpoch = this.#epoch;
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;
		const reconnectSignal = this.#connectionAbortControllers.get(name)?.signal ?? this.#connectAbort.signal;

		if (authorizedConfig) {
			config = authorizedConfig;
			this.#serverConfigs.set(name, config);
			this.#pendingAuthChallenges.delete(name);
			this.#declinedAuthServers.delete(name);
		} else if (authChallenge) {
			if (!this.#authHandler) {
				logger.debug("MCP auth challenge deferred until an interactive integration use", {
					path: `mcp:${name}`,
				});
				return null;
			}
			try {
				const refreshedConfig = await this.#runAuthHandler(name, authChallenge, options);
				if (
					reconnectSignal.aborted ||
					this.#epoch !== authEpoch ||
					this.#serverConfigs.get(name) !== config ||
					this.#sources.get(name) !== source ||
					options.signal?.aborted ||
					options.isCurrent?.() === false
				)
					return null;
				if (!refreshedConfig) {
					this.#declinedAuthServers.add(name);
					return null;
				}
				config = refreshedConfig;
				this.#serverConfigs.set(name, config);
				this.#pendingAuthChallenges.delete(name);
				this.#declinedAuthServers.delete(name);
			} catch (error) {
				if (error instanceof MCPOAuthCancelledError) {
					this.#declinedAuthServers.add(name);
					return null;
				}
				logger.error("MCP auth challenge handling failed", { path: `mcp:${name}`, error });
				return null;
			}
		}

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });
		// A reconnect follows a lost or rejected connection; a cached `!command`
		// token may be what the server rejected, so mint fresh values once.
		invalidateCommandValues(config);

		// Close the old transport without removing tools or notifying consumers.
		// Tools stay available (stale) while we establish the new connection.
		// Fire-and-forget: don't await the close — HttpTransport.close() sends a
		// DELETE with config.timeout (30s default), and blocking here delays the
		// reconnect loop by that amount on every server restart.
		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			// From here the live remote connection is gone: the server is lost
			// until a reconnect succeeds, and the schedule outlives this attempt.
			// Stdio stops at the ladder (see MCPReconnectPolicy). A server that
			// never connected is not lost — a startup timeout or a typo'd URL
			// stays a one-shot failure.
			if ((config.type === "http" || config.type === "sse") && !this.#lostRemoteServers.has(name)) {
				this.#lostRemoteServers.set(name, { timer: undefined, delayMs: this.reconnectPolicy.retryBaseMs });
			}
			void this.#discardConnection(name, oldConnection).catch(() => {});
		}
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);

		// Retry with backoff — the server may still be starting up. A scheduled
		// attempt is a single quiet probe; its pacing is the schedule itself.
		const delays = scheduled ? [] : this.reconnectPolicy.ladderMs;
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (options.signal?.aborted || options.isCurrent?.() === false) {
				this.#forgetLostServer(name);
				return null;
			}
			if (reconnectSignal.aborted || this.#epoch !== reconnectEpoch || this.#serverConfigs.get(name) !== config) {
				logger.debug("MCP reconnect aborted before attempt after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			try {
				const connection = await this.#connectAndWireServer(
					name,
					config,
					source,
					reconnectEpoch,
					reconnectSignal,
					options.awsProfile ?? oldConnection?.awsPreferredProfile,
					options,
				);
				if (!this.#ownsConnection(name, connection)) return null;
				this.#pendingAuthChallenges.delete(name);
				logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
				this.#emitConnectionStatus({ type: "connected", serverName: name });
				return connection;
			} catch (error) {
				if (options.signal?.aborted || options.isCurrent?.() === false) {
					this.#forgetLostServer(name);
					return null;
				}
				if (reconnectSignal.aborted || this.#epoch !== reconnectEpoch || this.#serverConfigs.get(name) !== config) {
					logger.debug("MCP reconnect aborted after configuration changed", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#epoch,
					});
					return null;
				}

				const msg = error instanceof Error ? error.message : String(error);
				const challenge = getInitialAuthChallenge(error, config);
				if (challenge) {
					this.#pendingAuthChallenges.set(name, challenge);
					this.#emitConnectionStatus({ type: "failed", serverName: name, error: msg });
					return null;
				}
				if (attempt < delays.length) {
					logger.debug("MCP reconnect attempt failed, retrying", {
						path: `mcp:${name}`,
						attempt: attempt + 1,
						error: msg,
					});
					await Bun.sleep(delays[attempt]);
				} else if (scheduled) {
					logger.debug("MCP scheduled reconnect attempt failed", { path: `mcp:${name}`, error: msg });
				} else {
					logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
					this.#emitConnectionStatus({ type: "failed", serverName: name, error: msg });
					// Don't remove stale tools — keep them in the registry so they
					// remain selected. Calls will fail with MCP errors, which
					// triggers the tool-level reconnect, or the user can run
					// /mcp reconnect <name> manually. A lost remote server is also
					// retried on the schedule (#trackReconnect arms it).
				}
			}
		}
		return null;
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
		connectionSignal: AbortSignal,
		awsPreferredProfile?: string,
		options: { signal?: AbortSignal; isCurrent?: () => boolean } = {},
	): Promise<MCPServerConnection> {
		const connectSignal = options.signal ? AbortSignal.any([connectionSignal, options.signal]) : connectionSignal;
		const assertCurrent = (): void => {
			if (
				connectSignal.aborted ||
				options.isCurrent?.() === false ||
				this.#serverConfigs.get(name) !== config ||
				this.#epoch !== reconnectEpoch
			) {
				throw new MCPOAuthCancelledError();
			}
		};
		assertCurrent();
		const resolvedConfig = await this.#resolveAuthConfig(config, {
			sourceLevel: source?.level,
			signal: connectSignal,
		});
		assertCurrent();
		const policy = resolveMCPChildCredentialPolicy(name, resolvedConfig, source);
		const connection = await connectToServer(name, resolvedConfig, {
			signal: connectSignal,
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
			...policy,
			awsAnonymousBootstrap: policy.preserveOperationalAws && !awsPreferredProfile,
			awsPreferredProfile,
		});

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		try {
			assertCurrent();
		} catch (error) {
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw error;
		}

		this.#connections.set(name, connection);

		this.#wireAuthRefresh(connection, config, source?.level, connectSignal);
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			this.#emitConnectionStatus({ type: "reconnecting", serverName: name });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection, { signal: connectSignal });
			assertCurrent();
			const reconnect = (options?: { authChallenge?: MCPAuthChallenge; awsProfile?: string }) =>
				this.reconnectServer(name, options);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.#observeToolCall(name));
			if (!this.#replaceServerTools(name, config, customTools, connection)) {
				throw new Error(`Server "${name}" was disconnected during tool discovery`);
			}
			void this.toolCache?.set(name, config, serverTools);
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Detach synchronously and close in the background so a slow close
			// cannot delay the rejection (and the retry backoff that follows).
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection. A resource read that reached this fresh
	 * connection first may already have loaded its catalog; that load is current, so join it instead
	 * of blanking the catalog for a second listing.
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (!this.#ownsConnection(name, connection)) return;
		if (serverSupportsResources(connection.capabilities)) {
			try {
				await this.ensureServerResources(name);
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (!this.#ownsConnection(name, connection)) return;
		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await this.refreshServerPrompts(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	/**
	 * Refresh tools from a specific server.
	 *
	 * Single-flight per server: a refresh requested while one is running marks
	 * it dirty and shares its promise, so a `tools/list_changed` burst costs at
	 * most one in-flight plus one trailing `tools/list`.
	 */
	refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return Promise.resolve();
		const existing = this.#toolRefreshes.get(name);
		if (existing?.connection === connection) {
			existing.dirty = true;
			return existing.promise;
		}
		const entry = { connection, dirty: false, promise: Promise.resolve() };
		entry.promise = (async () => {
			try {
				// A failed pass must not swallow a refresh queued while it ran.
				let failure: unknown;
				let failed = false;
				do {
					entry.dirty = false;
					try {
						await this.#refreshServerToolsOnce(name, connection);
						failed = false;
					} catch (error) {
						failure = error;
						failed = true;
					}
				} while (entry.dirty && this.#connections.get(name) === connection);
				if (failed) throw failure;
			} finally {
				if (this.#toolRefreshes.get(name) === entry) this.#toolRefreshes.delete(name);
			}
		})();
		this.#toolRefreshes.set(name, entry);
		return entry.promise;
	}

	async #refreshServerToolsOnce(name: string, connection: MCPServerConnection): Promise<void> {
		if (this.#connections.get(name) !== connection) return;

		// Clear cached tools
		connection.tools = undefined;

		// Claimed before the request: only a list requested after a call's notice
		// can hold the tools that call made the server add. A pass already in
		// flight leaves the flag to the re-run the notice queued.
		const callProvoked = this.#callProvokedToolRefreshes.delete(name);
		let serverTools: MCPToolDefinition[];
		try {
			serverTools = await listTools(connection);
		} catch (error) {
			if (callProvoked) this.#callProvokedToolRefreshes.add(name);
			throw error;
		}
		if (!this.#ownsConnection(name, connection)) return;
		const reconnect = (options?: { authChallenge?: MCPAuthChallenge; awsProfile?: string }) =>
			this.#reconnectServerForTool(name, options);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.#observeToolCall(name));
		if (callProvoked) this.#scopeAddedTools(name, customTools);

		// Replace tools from this server
		if (!this.#replaceServerTools(name, connection.config, customTools, connection)) return;
		void this.toolCache?.set(name, connection.config, serverTools);
		await this.#notifyOwnerToolsChanged();
	}

	/**
	 * Refresh tools from all servers.
	 */
	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	/**
	 * Refresh resources from a specific server.
	 */
	async refreshServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			// Clear cached resources
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			// Reload. Template listing failures must not discard a successful
			// resources/list — let both settle, then continue without templates.
			const [resourcesResult, templatesResult] = await Promise.allSettled([
				listResources(connection),
				listResourceTemplates(connection),
			]);
			if (templatesResult.status === "rejected") {
				logger.debug("Failed to list MCP resource templates", {
					path: `mcp:${name}`,
					error: templatesResult.reason,
				});
			}
			if (resourcesResult.status === "rejected") throw resourcesResult.reason;
			const resources = resourcesResult.value;
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				// Unsubscribe URIs that were removed
				if (oldUris) {
					const removed = [...oldUris].filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				// Subscribe to the current set and update tracking atomically
				try {
					const allUris = [...newUris];
					await subscribeToResources(connection, allUris);
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh()
			.then(() => {
				this.#emitCatalogChange({ serverName: name, kind: "resources" });
			})
			.finally(() => {
				const pending = this.#pendingResourceRefresh.get(name);
				if (pending?.promise === promise) {
					this.#pendingResourceRefresh.delete(name);
				}
			});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Wait until a connected server's resource catalog has been loaded.
	 * Coalesces with initial loading and notification-driven refreshes: a refresh still in flight
	 * (its `resources/list` may have landed while templates are pending) is joined. A settled
	 * catalog whose `resources/list` succeeded keeps its concrete resources when the template
	 * listing failed transiently; only the templates are listed again, never the whole catalog,
	 * and that retry is the connection's pending refresh so concurrent callers share it.
	 */
	async ensureServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;
		const pending = this.#pendingResourceRefresh.get(name);
		if (pending?.connection === connection) return pending.promise;
		if (connection.resources === undefined) return this.refreshServerResources(name);
		if (connection.resourceTemplates !== undefined) return;
		const promise = listResourceTemplates(connection)
			.then(
				() => undefined,
				error => {
					logger.debug("Failed to list MCP resource templates", { path: `mcp:${name}`, error });
				},
			)
			.finally(() => {
				if (this.#pendingResourceRefresh.get(name)?.promise === promise) this.#pendingResourceRefresh.delete(name);
			});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Refresh prompts from a specific server.
	 */
	async refreshServerPrompts(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
		this.#emitCatalogChange({ serverName: name, kind: "prompts" });
	}

	/**
	 * Get resources and templates for a specific server.
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	/**
	 * Read a specific resource from a server.
	 */
	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(connection, uri, options);
	}

	/**
	 * Get prompts for a specific server.
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	/**
	 * Get a specific prompt from a server.
	 */
	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(connection, promptName, args, options);
	}

	/**
	 * Get server instructions allowed by config (for prompt injection and rebuild signatures),
	 * keyed by server name in sorted order. `#connections` follows connection order, which
	 * shifts with late connects and reconnects; sorting keeps the rendered
	 * "## MCP Server Instructions" section byte-stable so the provider prompt cache survives.
	 */
	getServerInstructions(): Map<string, string> {
		const instructions: [string, string][] = [];
		for (const [name, connection] of this.#connections) {
			if (connection.config.instructions !== false && connection.instructions) {
				instructions.push([name, connection.instructions]);
			}
		}
		instructions.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return new Map(instructions);
	}

	/**
	 * Get notification state for display.
	 */
	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	/**
	 * Retry an HTTP/SSE 401/403 once with re-resolved credentials: a managed
	 * OAuth credential is force-refreshed and `!command` headers run again.
	 * Servers with neither keep the transport's plain auth error.
	 */
	#wireAuthRefresh(
		connection: MCPServerConnection,
		config: MCPServerConfig,
		sourceLevel: SourceMeta["level"] | undefined,
		signal: AbortSignal,
	): void {
		const transport = connection.transport;
		if (!isAuthRefreshableMCPTransport(transport)) return;
		const authStorage = this.#authStorage;
		const credentialSource = authStorage?.sourceIdentity;
		const credentials = authStorage?.credentials;
		const isCurrent = () =>
			!signal.aborted &&
			this.#ownsConnection(connection.name, connection) &&
			this.#authStorage === authStorage &&
			authStorage?.sourceIdentity === credentialSource &&
			authStorage?.credentials === credentials &&
			authStorage?.isClosed !== true;
		if (
			(sourceLevel === "project" || commandValues(config).length === 0) &&
			!lookupMcpOAuthCredentialForSource(this.#authStorage, config, sourceLevel)
		)
			return;
		transport.onAuthError = async () => {
			if (!isCurrent()) return null;
			if (sourceLevel !== "project") invalidateCommandValues(config);
			const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true, sourceLevel, signal });
			if (!isCurrent()) return null;
			return refreshed.type === "http" || refreshed.type === "sse" ? (refreshed.headers ?? null) : null;
		};
	}

	/**
	 * Resolve OAuth credentials and shell commands in config.
	 * `oauth: false` skips credential injection (reauth's unauthenticated probe);
	 * `forceRefresh` bypasses the expiry buffer (401/403 auth-error hook).
	 */
	async #resolveAuthConfig(
		config: MCPServerConfig,
		opts?: { forceRefresh?: boolean; oauth?: boolean; sourceLevel?: SourceMeta["level"]; signal?: AbortSignal },
	): Promise<MCPServerConfig> {
		const signal = opts?.signal;
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		const refreshAuth = opts?.sourceLevel === "project" ? undefined : auth;
		const lookup: MCPOAuthCredentialLookup | undefined =
			opts?.oauth !== false
				? lookupMcpOAuthCredentialForSource(this.#authStorage, config, opts?.sourceLevel)
				: undefined;
		const authStorage = this.#authStorage;
		if (lookup && authStorage) {
			const { credentialId } = lookup;
			try {
				let credential: MCPStoredOAuthCredential | undefined = lookup.credential;
				// Stop waiting on abort; a refresh already running finishes so a rotated token is stored, not lost.
				const refreshResult = await untilAborted(signal, () =>
					refreshStoredManagedMcpOAuthCredential(authStorage, credentialId, {
						serverUrl: config.type === "http" || config.type === "sse" ? config.url : undefined,
						auth: refreshAuth,
						forceRefresh: opts?.forceRefresh,
						keepCredentialOnRefreshFailure: true,
						onRefreshFailure: refreshError => {
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						},
					}),
				);
				if (refreshResult.removed) {
					logger.warn("MCP OAuth refresh failed definitively; cleared credential", { credentialId });
				}
				credential = refreshResult.credential;

				if (credential) {
					if (resolved.type === "http" || resolved.type === "sse") {
						// Client-generated authorization wins over any configured header
						// with the same case-insensitive name (Agent Plugins §7.2.1).
						const headers = { ...resolved.headers };
						setGeneratedHeader(headers, "Authorization", `Bearer ${credential.access}`);
						resolved = { ...resolved, headers };
					} else {
						resolved = {
							...resolved,
							env: {
								...resolved.env,
								OAUTH_ACCESS_TOKEN: credential.access,
							},
						};
					}
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
			}
		}

		if (resolved.type !== "http" && resolved.type !== "sse") {
			// Literal env values (Agent Plugins §§4.1/9.2) are opaque package data:
			// no env-name lookup, no `!command` execution, no dropping empty values.
			if (resolved.env && resolved.envPolicy !== "literal") {
				// Null prototype: a `__proto__` env key must become an own
				// property, not mutate the prototype chain.
				const nextEnv: Record<string, string> = Object.create(null);
				const literalKeys = new Set(resolved.envLiteralKeys);
				for (const [key, value] of Object.entries(resolved.env)) {
					// Provider-expanded keys are final package data: keep them
					// verbatim (including empties) so they are never reinterpreted
					// as a bare env name or !command.
					if (literalKeys.has(key)) {
						nextEnv[key] = value;
						continue;
					}
					const resolvedValue =
						opts?.sourceLevel === "project" ? value : await untilAborted(signal, () => resolveConfigValue(value));
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			// Origin-locked servers (Agent Plugins §9.2) carry literal header
			// values: no placeholder or environment-variable expansion.
			if (resolved.headers && resolved.headerPolicy !== "origin-locked") {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue =
						opts?.sourceLevel === "project" ? value : await untilAborted(signal, () => resolveConfigValue(value));
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		return resolved;
	}
}

/**
 * Create an MCP manager and discover servers.
 * Convenience function for quick setup.
 */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
