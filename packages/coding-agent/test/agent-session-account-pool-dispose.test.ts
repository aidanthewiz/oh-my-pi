import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pool-scope";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

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
		authStorage.close();
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
	): Promise<{ session: AgentSession; released: Promise<void> }> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const sessionManager = SessionManager.inMemory(tempDir.path());
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
		const session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["test"], tools: [] } }),
			sessionManager,
			settings: Settings.isolated(),
			modelRegistry,
			agentId: "Main",
			extensionRunner,
			providerSessionId: PROVIDER_SESSION_ID,
			accountPoolScope,
			cacheWarmer,
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
			await armed.promise;
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

	it("keeps the pool until an accepted cache replay finishes after the dispose deadline", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const entered = Promise.withResolvers<void>();
		const settle = Promise.withResolvers<void>();
		let replayKey: string | undefined;
		const warmer = new CacheWarmer({
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
			stream: async () => {
				entered.resolve();
				await settle.promise;
				replayKey = await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID);
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
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
				return {
					async *[Symbol.asyncIterator]() {},
					result: async () => message,
				};
			},
		});
		const { session, released } = await createPooledSession(undefined, warmer);
		vi.useFakeTimers();
		warmer.start(
			{
				model: { ...model, promptCache: { short: 10.05 } },
				context: { messages: [] },
				options: { cacheRetention: "short" },
			},
			() => true,
		);
		try {
			vi.advanceTimersByTime(50);
			await entered.promise;
			vi.useRealTimers();
			await pastDisposeDeadline(() => session.dispose({ drainTimeoutMs: 20 }));
			expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");
		} finally {
			vi.useRealTimers();
			settle.resolve();
			await warmer.drain();
			await released;
		}
		expect(replayKey).toBe("access-c");
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});

	it("keeps session-owned restrictions when startup cleanup outlives its dispose deadline", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const settle = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const originalDispose = AgentSession.prototype.dispose;
		const originalRelease = SessionAccountPoolScope.prototype.release;
		vi.spyOn(AgentSession.prototype, "dispose").mockImplementation(function (this: AgentSession, options) {
			return originalDispose.call(this, { ...options, drainTimeoutMs: 20 });
		});
		vi.spyOn(SessionAccountPoolScope.prototype, "release").mockImplementation(
			function (this: SessionAccountPoolScope) {
				originalRelease.call(this);
				released.resolve();
			},
		);
		vi.spyOn(AgentSession.prototype, "registerSessionChangeCallback").mockImplementation(
			function (this: AgentSession) {
				sessions.push(this);
				vi.spyOn(this.agent, "waitForIdle").mockImplementation(() => settle.promise);
				throw new Error("synthetic startup failure");
			},
		);
		try {
			await expect(
				pastDisposeDeadline(() =>
					createAgentSession({
						cwd: tempDir.path(),
						agentDir: tempDir.path(),
						sessionManager: SessionManager.inMemory(tempDir.path()),
						authStorage,
						modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
						settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
						model,
						providerSessionId: PROVIDER_SESSION_ID,
						oauthAccountPools: { anthropic: ["email:c@example.com|org:org-c"] },
						toolNames: ["read"],
						disableExtensionDiscovery: true,
					}),
				),
			).rejects.toThrow("synthetic startup failure");
			expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("access-c");
		} finally {
			settle.resolve();
			await released.promise;
		}
		expect(await authStorage.keys.get("anthropic", PROVIDER_SESSION_ID)).toBe("runtime-key");
	});
});
