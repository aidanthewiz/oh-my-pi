import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { getOAuthProvider, registerOAuthProvider, unregisterOAuthProvider } from "@oh-my-pi/pi-ai/registry/oauth";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pool-scope";
import type { OAuthAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ModelUsageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createCodexAutoRedeemCoordinator } from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const PROVIDER_SESSION_ID = "pooled-provider-session";

describe("AgentSession account pools after a dispose deadline", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let sessions: AgentSession[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-pool-dispose-");
		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set(
			"anthropic",
			["a", "b", "c"].map(suffix => ({
				type: "oauth" as const,
				access: `access-${suffix}`,
				refresh: `refresh-${suffix}`,
				expires: Date.now() + 60 * 60_000,
				accountId: `account-${suffix}`,
				email: `${suffix}@example.com`,
				orgId: `org-${suffix}`,
			})),
		);
		// An unrestricted session resolves the runtime key; a pooled one never does.
		authStorage.keys.setRuntime("anthropic", "runtime-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const session of sessions.reverse()) await session.dispose();
		sessions = [];
		await authStorage.close();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/**
	 * A session pooled to account c on {@link PROVIDER_SESSION_ID}. With
	 * `stallUntil`, its `message_end` handler holds dispose past its deadline
	 * until that promise resolves; `released` resolves once the session has
	 * released its pool scope.
	 */
	async function createPooledSession(
		stallUntil?: Promise<void>,
		cacheWarmer?: CacheWarmer,
		identityKey = "email:c@example.com|org:org-c",
		sessionManager: SessionManager = SessionManager.inMemory(tempDir.path()),
	): Promise<{ session: AgentSession; released: Promise<void> }> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("expected bundled model");
		const model = { ...bundled, promptCache: { short: 10.05 } };
		const accountPoolScope = new SessionAccountPoolScope(
			authStorage,
			{ anthropic: [identityKey] },
			PROVIDER_SESSION_ID,
		);
		const modelRegistry = accountPoolScope.registry(
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		);
		const reached = Promise.withResolvers<void>();
		let extensionRunner: ExtensionRunner | undefined;
		if (stallUntil) {
			const runtime = new ExtensionRuntime();
			const extension = await loadExtensionFromFactory(
				pi => {
					pi.on("message_end", async () => {
						reached.resolve();
						await stallUntil;
					});
				},
				tempDir.path(),
				new EventBus(),
				runtime,
				"stalled-message-end",
			);
			extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		}
		const codexResetCoordinator = createCodexAutoRedeemCoordinator();
		codexResetCoordinator.resetLockPath = path.join(tempDir.path(), "reset-fences");
		const session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["test"], tools: [] },
			}),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
			providerSessionId: PROVIDER_SESSION_ID,
			accountPoolScope,
			cacheWarmer,
			codexResetCoordinator,
		});
		sessions.push(session);

		const released = Promise.withResolvers<void>();
		const release = accountPoolScope.release.bind(accountPoolScope);
		vi.spyOn(accountPoolScope, "release").mockImplementation(() => {
			release();
			released.resolve();
		});
		if (stallUntil) {
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message });
			await reached.promise;
		}
		return { session, released: released.promise };
	}

	it("does not spend a manual reset through a superseded session's restriction", async () => {
		const { session: stale } = await createPooledSession();
		await createPooledSession(undefined, undefined, "email:b@example.com|org:org-b");
		const b = authStorage.oauth
			.accounts("anthropic", PROVIDER_SESSION_ID)
			.find(account => account.email === "b@example.com")!;
		const redeem = vi.spyOn(authStorage.resets, "redeem").mockImplementation(async () => {
			throw new Error("A denied reset must not reach provider redemption");
		});
		const result = await stale.redeemResetCredit({
			provider: "anthropic",
			credentialId: b.credentialId,
			email: b.email,
			orgId: b.orgId,
			creditId: "synthetic-credit",
		});
		expect(result).toMatchObject({ ok: false, code: "no_account" });
		expect(redeem).not.toHaveBeenCalled();
	});

	it("retains reset authorization until an already-started redemption physically settles", async () => {
		const { session } = await createPooledSession();
		const accounts = authStorage.oauth.accounts("anthropic", PROVIDER_SESSION_ID);
		const c = accounts.find(account => account.email === "c@example.com")!;
		const b = accounts.find(account => account.email === "b@example.com")!;
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<void>();
		vi.spyOn(authStorage.resets, "redeem").mockImplementation(async () => {
			entered.resolve();
			await response.promise;
			return {
				ok: true,
				code: "reset",
				provider: "anthropic",
				creditId: "synthetic-credit",
			};
		});
		const redemption = session.redeemResetCredit({
			provider: "anthropic",
			credentialId: c.credentialId,
			email: c.email,
			orgId: c.orgId,
			creditId: "synthetic-credit",
		});
		await entered.promise;
		expect(session.hasPostPromptWork).toBe(true);
		let disposed = false;
		const disposing = session.dispose().then(() => {
			disposed = true;
		});
		await Promise.resolve();
		expect(disposed).toBe(false);
		expect(authStorage.sessions.permits("anthropic", PROVIDER_SESSION_ID, b.credentialId)).toBe(false);
		response.resolve();
		await expect(redemption).resolves.toMatchObject({ code: "reset" });
		await disposing;
		expect(authStorage.sessions.permits("anthropic", PROVIDER_SESSION_ID, b.credentialId)).toBe(true);
	});

	async function pastDisposeDeadline<T>(start: () => Promise<T>): Promise<T> {
		const armed = Promise.withResolvers<void>();
		vi.useFakeTimers();
		const schedule = globalThis.setTimeout;
		const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(
			new Proxy(schedule, {
				apply(target, receiver, args) {
					const result = Reflect.apply(target, receiver, args);
					if (args[1] === 20) armed.resolve();
					return result;
				},
			}),
		);
		try {
			const operation = start();
			expect(
				await Promise.race([
					armed.promise.then(() => "armed"),
					operation.then(
						() => "settled",
						() => "settled",
					),
				]),
			).toBe("armed");
			vi.advanceTimersByTime(20);
			return await operation;
		} finally {
			timer.mockRestore();
			vi.useRealTimers();
		}
	}

	it("lifts the pool once a run that outlived the deadline settles", async () => {
		const release = Promise.withResolvers<void>();
		const { session, released } = await createPooledSession(release.promise);
		await pastDisposeDeadline(() => session.dispose({ drainTimeoutMs: 20 }));
		// The unsettled run may still resolve keys, so the pool stays for now.
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");

		release.resolve();
		await released;
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});

	it.each([false, true])("rejects the timed-out owner after revival (newer disposes first: %s)", async newerFirst => {
		const release = Promise.withResolvers<void>();
		const { session, released } = await createPooledSession(release.promise);
		await pastDisposeDeadline(() => session.dispose({ drainTimeoutMs: 20 }));

		const { session: revived } = await createPooledSession(undefined, undefined, "email:b@example.com|org:org-b");
		expect(await revived.modelRegistry.getApiKeyForProvider("anthropic")).toBe("access-b");
		await expect(session.modelRegistry.getApiKeyForProvider("anthropic")).rejects.toThrow("no longer owns");
		if (newerFirst) {
			await revived.dispose();
			await expect(session.modelRegistry.getApiKeyForProvider("anthropic")).rejects.toThrow("no longer owns");
		}
		release.resolve();
		await released;
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe(
			newerFirst ? "runtime-key" : "access-b",
		);
		if (!newerFirst) {
			expect(await revived.modelRegistry.getApiKeyForProvider("anthropic")).toBe("access-b");
			await revived.dispose();
		}
		await expect(session.modelRegistry.getApiKeyForProvider("anthropic", "late-title")).rejects.toThrow("released");
		expect(await authStorage.keys.get("anthropic", "late-title")).toBe("runtime-key");
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});

	it("keeps pool custody through a refused prewarm and deferred accepted replay", async () => {
		const journal = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const entered = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		const replayKeys: (string | null)[] = [];
		let replayKey: string | undefined;
		const warmer = new CacheWarmer({
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
			stream: async (requestModel, context, options) => {
				const source = streamSimple(requestModel, context, {
					...options,
					apiKey: session.modelRegistry.resolver(requestModel, PROVIDER_SESSION_ID),
					fetch: async (input, init) => {
						const request =
							input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
						replayKeys.push(request.headers.get("x-api-key"));
						const payload: unknown = await request.clone().json();
						if (payload && typeof payload === "object" && "max_tokens" in payload && payload.max_tokens === 0) {
							return Response.json(
								{ error: { type: "invalid_request_error", message: "prewarm unsupported" } },
								{ status: 400 },
							);
						}
						const events = [
							{
								type: "message_start",
								message: {
									id: "msg_accepted_cache_replay",
									type: "message",
									role: "assistant",
									content: [],
									model: requestModel.id,
									stop_reason: null,
									stop_sequence: null,
									usage: {
										input_tokens: 5,
										output_tokens: 0,
										cache_read_input_tokens: 100_000,
										cache_creation_input_tokens: 0,
									},
								},
							},
							{
								type: "content_block_start",
								index: 0,
								content_block: { type: "text", text: "" },
							},
							{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "warm" } },
							{ type: "content_block_stop", index: 0 },
							{
								type: "message_delta",
								delta: { stop_reason: "end_turn", stop_sequence: null },
								usage: { output_tokens: 1 },
							},
							{ type: "message_stop" },
						];
						const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
						return new Response(body, { headers: { "content-type": "text/event-stream" } });
					},
				});
				await source.result();
				if (options?.prewarm) return source;
				entered.resolve();
				await settle.promise;
				replayKey = await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID);
				return source;
			},
		});
		const { session, released } = await createPooledSession(undefined, warmer, undefined, journal);
		await journal.ensureOnDisk();
		const replayModel = session.model!;
		expect(session.sessionId).toBe(PROVIDER_SESSION_ID);
		expect(session.sessionManager.getSessionId()).not.toBe(PROVIDER_SESSION_ID);
		vi.useFakeTimers();
		const context = { messages: [{ role: "user" as const, content: "synthetic cache custody", timestamp: 1 }] };
		session.startCacheWarming(replayModel, context, { cacheRetention: "short" });
		session.markPromptCacheDispatched(context);
		let disposal: Promise<void> | undefined;
		try {
			vi.advanceTimersByTime(50);
			await entered.promise;
			vi.useRealTimers();
			disposal = session.dispose({ drainTimeoutMs: 20 });
			const tick = Promise.withResolvers<false>();
			setImmediate(() => tick.resolve(false));
			expect(await Promise.race([disposal.then(() => true), tick.promise])).toBe(false);
			expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");
		} finally {
			vi.useRealTimers();
			settle.resolve();
			await warmer.drain();
			await disposal;
			await released;
		}
		expect(replayKey).toBe("access-c");
		expect(replayKeys).toEqual(["access-c", "access-c"]);
		const persisted = await SessionManager.open(journal.getSessionFile()!);
		try {
			const entries = persisted
				.getEntries()
				.filter(
					(entry): entry is ModelUsageEntry => entry.type === "model_usage" && entry.purpose === "cache-warm",
				);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				provider: "anthropic",
				model: replayModel.id,
				stopReason: "aborted",
				usage: { input: 5, output: 1, cacheRead: 100_000, cacheWrite: 0, totalTokens: 100_006 },
			});
			const cost = replayModel.cost;
			expect(entries[0]?.usage.cost.total).toBeCloseTo(
				(5 * cost.input + cost.output + 100_000 * cost.cacheRead) / 1e6,
				10,
			);
			expect(persisted.getUsageStatistics().totalTokens).toBe(100_006);
		} finally {
			await persisted.close();
		}
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});

	it("keeps session-owned restrictions when startup cleanup outlives its dispose deadline", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const settle = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const originalDispose = AgentSession.prototype.dispose;
		const originalRelease = SessionAccountPoolScope.prototype.release;
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementationOnce(function (this: AgentSession, options) {
			return pastDisposeDeadline(() => originalDispose.call(this, { ...options, drainTimeoutMs: 20 }));
		});
		vi.spyOn(SessionAccountPoolScope.prototype, "release").mockImplementation(
			function (this: SessionAccountPoolScope) {
				originalRelease.call(this);
				released.resolve();
			},
		);
		vi.spyOn(AgentSession.prototype, "startHintCompression").mockImplementation(function (this: AgentSession) {
			sessions.push(this);
			vi.spyOn(this.agent, "waitForIdle").mockImplementation(() => settle.promise);
			throw new Error("synthetic startup failure");
		});
		try {
			await expect(
				createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: SessionManager.inMemory(tempDir.path()),
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
					settings: Settings.isolated({
						"async.enabled": false,
						"compaction.enabled": false,
					}),
					model,
					providerSessionId: PROVIDER_SESSION_ID,
					oauthAccountPools: { anthropic: ["email:c@example.com|org:org-c"] },
					toolNames: ["read"],
					disableExtensionDiscovery: true,
				}),
			).rejects.toThrow("synthetic startup failure");
			expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");
		} finally {
			settle.resolve();
			await released.promise;
		}
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});
});

describe("SDK inherited account-pool lifetime", () => {
	const provider = "unit-inherited-pool-lifetime";
	const api = "unit-inherited-pool-stream";
	const sourceId = "test/inherited-pool-lifetime";
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let shared: ModelRegistry;
	let model: Model<Api>;
	let outsideCredentialId: number;
	let sessions: AgentSession[];
	let requests: Array<{
		sessionId: string | undefined;
		key: string | undefined;
	}>;

	function registerModel(registry: ModelRegistry): void {
		registry.registerProvider(provider, {
			api,
			baseUrl: "https://example.test/v1",
			oauth: getOAuthProvider(provider),
			models: [
				{
					id: "inherited-model",
					name: "Inherited pool fixture",
					api,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 1024,
				},
			],
		});
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-inherited-pool-");
		authStorage = createInMemoryAuthStorage();
		sessions = [];
		requests = [];
		registerOAuthProvider({
			id: provider,
			name: "Inherited pool fixture",
			sourceId,
			login: async () => {
				throw new Error("Login is not used");
			},
			refreshToken: async credentials => ({
				...credentials,
				expires: Date.now() + 3_600_000,
			}),
			getApiKey: credentials => credentials.access,
		});
		registerCustomApi(
			api,
			(requestModel, _context, options) => {
				requests.push({
					sessionId: options?.sessionId,
					key: typeof options?.apiKey === "string" ? options.apiKey : undefined,
				});
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					const message = {
						...createAssistantMessage("accepted"),
						api: requestModel.api,
						provider,
						model: requestModel.id,
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
			sourceId,
		);
		await authStorage.credentials.set(
			provider,
			["a", "b", "c"].map(accountId => ({
				type: "oauth" as const,
				accountId,
				access: `synthetic-${accountId}`,
				refresh: "synthetic-refresh",
				expires: Date.now() + 3_600_000,
			})),
		);
		const outside = authStorage.oauth.accounts(provider).find(row => row.accountId === "b");
		if (!outside) throw new Error("Expected outside account");
		outsideCredentialId = outside.credentialId;
		authStorage.keys.setRuntime(provider, "synthetic-runtime");
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(
			modelsPath,
			`providers:\n  ${provider}:\n    baseUrl: https://example.test/v1\n    api: openai-completions\n    auth: oauth\n    models:\n      - id: inherited-model\n`,
		);
		shared = new ModelRegistry(authStorage, modelsPath);
		registerModel(shared);
		const configured = shared.find(provider, "inherited-model");
		if (!configured) throw shared.getError() ?? new Error("Expected inherited pool model");
		model = configured;
	});

	afterEach(async () => {
		for (const session of sessions.reverse()) await session.dispose();
		unregisterCustomApis(sourceId);
		unregisterOAuthProvider(provider);
		await authStorage.close();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		tempDir.removeSync();
	});

	async function createSession(
		id: string,
		modelRegistry: ModelRegistry,
		oauthAccountPools?: OAuthAccountPools,
		sessionManager = SessionManager.inMemory(tempDir.path()),
		expectedAgentRef?: AgentRef,
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			oauthAccountPools,
			sessionManager,
			expectedAgentRef,
			agentId: id,
			taskDepth: 1,
			providerSessionId: `pool-${id}`,
			model,
			settings: Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
				"advisor.enabled": false,
				"todo.enabled": false,
			}),
			cacheWarming: "off",
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
		});
		sessions.push(session);
		return session;
	}

	async function request(session: AgentSession, account: string): Promise<void> {
		const before = requests.length;
		await session.prompt("Authorize this request.");
		expect(requests.slice(before)).toEqual([{ sessionId: session.agent.sessionId, key: `synthetic-${account}` }]);
	}

	it("keeps an unrelated adopted session usable after another SDK startup fails", async () => {
		const peer = await createSession("StartupPeer", shared, {
			[provider]: ["account:a"],
		});
		const registry = AgentRegistry.global();
		registry.setStatus("StartupPeer", "idle");
		const lifecycle = AgentLifecycleManager.global();
		lifecycle.adopt("StartupPeer", { idleTtlMs: 0 });
		const startupError = new Error("synthetic startup failure");
		const registration = vi
			.spyOn(AgentSession.prototype, "startHintCompression")
			.mockImplementationOnce(function (this: AgentSession) {
				sessions.push(this);
				throw startupError;
			});
		try {
			await expect(
				createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					authStorage,
					modelRegistry: shared,
					sessionManager: SessionManager.inMemory(tempDir.path()),
					agentId: "FailedStartup",
					providerSessionId: "failed-startup-peer",
					model,
					settings: Settings.isolated({
						"async.enabled": false,
						"compaction.enabled": false,
						"retry.enabled": false,
						"advisor.enabled": false,
						"todo.enabled": false,
					}),
					cacheWarming: "off",
					toolNames: ["read"],
					disableExtensionDiscovery: true,
					enableLsp: false,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					rules: [],
				}),
			).rejects.toBe(startupError);
			expect(await lifecycle.ensureLive("StartupPeer")).toBe(peer);
			await request(peer, "a");
		} finally {
			registration.mockRestore();
			await lifecycle.release("StartupPeer");
		}
	});

	it("keeps child requests and warm revival authorized after the parent parks, without affecting siblings", async () => {
		const identities = ["account:a"];
		const parent = await createSession("PoolParent", shared, {
			[provider]: identities,
		});
		const inherited = parent.modelRegistry;
		const manager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		const child = await createSession("PoolChild", inherited, undefined, manager);
		const sibling = await createSession("PoolSibling", inherited);
		const childFile = manager.getSessionFile();
		if (!childFile) throw new Error("Expected child transcript");
		const lifecycle = AgentLifecycleManager.global();
		AgentRegistry.global().setStatus("PoolParent", "idle");
		lifecycle.adopt("PoolParent", { idleTtlMs: 0 });
		await lifecycle.park("PoolParent");
		expect(AgentRegistry.global().get("PoolParent")).toMatchObject({
			status: "parked",
			session: null,
		});
		identities[0] = "account:b";
		await request(child, "a");
		await request(sibling, "a");
		const retired = child.modelRegistry.resolver(model, child.agent.sessionId);
		AgentRegistry.global().setStatus("PoolChild", "idle");
		let revived: AgentSession | undefined;
		lifecycle.adopt("PoolChild", {
			idleTtlMs: 0,
			revive: async expected => {
				revived = await createSession(
					"PoolChild",
					inherited,
					undefined,
					await SessionManager.open(childFile),
					expected,
				);
				return revived;
			},
		});
		await lifecycle.park("PoolChild");
		await expect(resolveApiKeyOnce(retired)).rejects.toThrow();
		await lifecycle.ensureLive("PoolChild");
		if (!revived) throw new Error("Expected a revived child fixture session");
		await request(revived, "a");
		const revivedSessionId = revived.agent.sessionId;
		if (!revivedSessionId) throw new Error("Expected revived provider session ID");
		expect(authStorage.sessions.pin(provider, revivedSessionId, outsideCredentialId)).toBe(false);
		await expect(resolveApiKeyOnce(retired)).rejects.toThrow();
		const revivedResolver = revived.modelRegistry.resolver(model, revived.agent.sessionId);
		await lifecycle.release("PoolChild");
		await expect(resolveApiKeyOnce(revivedResolver)).rejects.toThrow();
		await request(sibling, "a");
	});

	it("uses explicit child authorization rather than the released inherited pool", async () => {
		const parent = await createSession("ExplicitParent", shared, {
			[provider]: ["account:a"],
		});
		const child = await createSession("ExplicitChild", parent.modelRegistry, {
			[provider]: ["account:b"],
		});
		await parent.dispose();
		await request(child, "b");
		const inheritedChild = await createSession("ExplicitGrandchild", child.modelRegistry);
		await child.dispose();
		await request(inheritedChild, "b");
	});

	it("keeps inherited deny-all pools closed after parent disposal and rejects sibling rotation", async () => {
		const parent = await createSession("DeniedParent", shared, {
			[provider]: [],
		});
		const child = await createSession("DeniedChild", parent.modelRegistry);
		await parent.dispose();
		const resolver = child.modelRegistry.resolver(model, child.agent.sessionId);
		await expect(resolveApiKeyOnce(resolver)).rejects.toThrow();
		await expect(
			resolver({
				lastChance: true,
				error: new Error("synthetic unauthorized"),
			}),
		).rejects.toThrow();
		expect(requests).toEqual([]);
	});

	it("fails inherited authorization rather than using a configured provider key", async () => {
		const configPath = tempDir.join("configured-models.yml");
		await Bun.write(
			configPath,
			`providers:\n  ${provider}:\n    baseUrl: https://example.test/v1\n    api: openai-completions\n    auth: oauth\n    apiKey: synthetic-config\n    models:\n      - id: inherited-model\n`,
		);
		const configuredRegistry = new ModelRegistry(authStorage, configPath);
		registerModel(configuredRegistry);
		const parent = await createSession("ConfiguredParent", configuredRegistry, {
			[provider]: ["account:a"],
		});
		const child = await createSession("ConfiguredChild", parent.modelRegistry);
		await parent.dispose();
		await expect(resolveApiKeyOnce(child.modelRegistry.resolver(model, child.agent.sessionId))).rejects.toThrow();
		expect(requests).toEqual([]);
	});
});
