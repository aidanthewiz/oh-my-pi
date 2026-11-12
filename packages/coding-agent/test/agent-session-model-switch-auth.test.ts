import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Switching the active model (Ctrl+P role cycling, /models selection) must be a
// cheap, synchronous operation. It used to call the async `getApiKey`, which can
// block the event loop on a command-backed key program (`execSync`) or stall on
// a network OAuth refresh. The real key is resolved lazily per request via the
// resolver, so the switch only needs a synchronous "is a credential configured"
// pre-flight (`hasConfiguredAuth`) — never the resolver.
describe("AgentSession model switch auth pre-flight", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-switch-auth-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(async () => {
		await authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		vi.useRealTimers();
		for (const spy of spies.splice(0)) spy.mockRestore();
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function makeSession(
		initialModel: Model<Api>,
		roles?: Record<string, string>,
		cacheWarmer?: CacheWarmer,
		sessionManager: SessionManager = SessionManager.inMemory(),
	): AgentSession {
		const settings = Settings.isolated();
		if (roles) {
			for (const role in roles) settings.setModelRole(role, roles[role]);
		}
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			cacheWarmer,
			modelRegistry: registry,
		});
		return session;
	}

	function startCacheWarming(current: AgentSession, model: Model<Api>): void {
		const context = { messages: [] };
		current.startCacheWarming(model, context, {});
		current.markPromptCacheDispatched(context);
	}

	it("switches the active model via the synchronous auth check, not the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth");
		spies.push(getApiKeySpy, hasAuthSpy);

		await s.setModel(to);

		expect(s.model?.id).toBe(to.id);
		expect(hasAuthSpy).toHaveBeenCalled();
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("cycles role models without invoking the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const slow = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from, {
			default: `${from.provider}/${from.id}`,
			slow: `${slow.provider}/${slow.id}`,
		});

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		const result = await s.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slow.id);
		expect(s.model?.id).toBe(slow.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("temporary switch also avoids the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		await s.setModelTemporary(to);

		expect(s.model?.id).toBe(to.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("rejects the switch synchronously when no credential is configured, without calling the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
		spies.push(getApiKeySpy, hasAuthSpy);

		await expect(s.setModel(to)).rejects.toThrow(/No API key/);
		expect(s.model?.id).toBe(from.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("rejects model and role switches outside enabledModels", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from, { slow: `${to.provider}/${to.id}` });
		cfgEnabledModels.override(s.settings, [`${from.provider}/${from.id}`]);

		expect(s.resolveRoleModel("slow")).toBeUndefined();
		await expect(s.setModel(to)).rejects.toThrow(`Model "${to.provider}/${to.id}" is excluded by model policy`);
		expect(s.model?.id).toBe(from.id);
	});

	it("does not replay an old request after tools change or the session is replaced", async () => {
		const model = { ...modelOrThrow("claude-sonnet-4-5"), promptCache: { short: 300 } };
		let replays = 0;
		const warmer = new CacheWarmer({
			stream: () => {
				replays++;
				throw new Error("Stale request replayed");
			},
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
		});
		const s = makeSession(model, undefined, warmer);
		vi.useFakeTimers();
		startCacheWarming(s, model);
		expect(s.cacheWarmingStatus?.state).toBe("scheduled");
		s.agent.setTools([
			{
				name: "changed_tool",
				label: "Changed tool",
				description: "A newly selected tool",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			},
		]);
		vi.advanceTimersByTime(270_000);
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(replays).toBe(0);

		startCacheWarming(s, model);
		expect(s.cacheWarmingStatus?.state).toBe("scheduled");
		const switched = s.newSession();
		vi.useRealTimers();
		expect(await switched).toBe(true);
		vi.useFakeTimers();
		vi.advanceTimersByTime(270_000);
		vi.useRealTimers();
		expect(replays).toBe(0);
		expect(s.cacheWarmingStatus?.state).toBe("inactive");
	});

	it("charges an accepted warm replay to its original session before switching", async () => {
		const model = { ...modelOrThrow("claude-sonnet-4-5"), promptCache: { short: 300 } };
		const usage: AssistantMessage["usage"] = {
			input: 1,
			output: 0,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 100_001,
			cost: { input: 0, output: 0, cacheRead: 0.125, cacheWrite: 0, total: 0.125 },
		};
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			usage,
			stopReason: "aborted",
		};
		const accepted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const warmer = new CacheWarmer({
			stream: () => ({
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial } as const;
					accepted.resolve();
					await release.promise;
				},
				result: () => Promise.resolve(partial),
			}),
			getPromptTokens: () => usage.totalTokens,
			getMode: () => "idle",
		});
		const manager = SessionManager.create(sharedDir.path(), path.join(sharedDir.path(), "sessions"));
		const originalFile = manager.getSessionFile();
		manager.appendMessage({ role: "user", content: "prefix to keep warm", timestamp: Date.now() });
		manager.appendMessage({ ...partial, content: [{ type: "text", text: "prior response" }], stopReason: "stop" });
		const s = makeSession(model, undefined, warmer, manager);
		vi.useFakeTimers();
		startCacheWarming(s, model);
		vi.advanceTimersByTime(270_000);
		await accepted.promise;
		const originalId = manager.getSessionId();

		const switching = s.newSession();
		vi.useRealTimers();
		const settledBeforeUsage = await Promise.race([switching.then(() => true), Bun.sleep(100).then(() => false)]);
		const sessionIdBeforeUsage = manager.getSessionId();
		release.resolve();
		expect(settledBeforeUsage).toBe(false);
		expect(sessionIdBeforeUsage).toBe(originalId);
		expect(await switching).toBe(true);
		expect(s.sessionManager.getUsageStatistics().cost).toBe(0);
		expect(originalFile).toBeDefined();
		const old = await SessionManager.open(originalFile!, undefined, undefined, { throwIfMissing: true });
		expect(old.getUsageStatistics().cost).toBe(usage.cost.total * 2);
		expect(old.getEntries().filter(entry => entry.type === "model_usage")).toMatchObject([
			{ purpose: "cache-warm", usage: { totalTokens: usage.totalTokens }, stopReason: "aborted" },
		]);
		await old.close();
	});

	it("keeps the original session and branch until a cancelled paid replay finally reports usage", async () => {
		const model = { ...modelOrThrow("claude-sonnet-4-5"), promptCache: { short: 300 } };
		const usage: AssistantMessage["usage"] = {
			input: 1,
			output: 0,
			cacheRead: 100_000,
			cacheWrite: 0,
			totalTokens: 100_001,
			cost: { input: 0, output: 0, cacheRead: 0.125, cacheWrite: 0, total: 0.125 },
		};
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
			usage,
			stopReason: "aborted",
		};
		const accepted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const warmer = new CacheWarmer({
			stream: () => ({
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial } as const;
					accepted.resolve();
					await release.promise;
				},
				result: () => Promise.resolve(partial),
			}),
			getPromptTokens: () => usage.totalTokens,
			getMode: () => "idle",
		});
		const manager = SessionManager.create(sharedDir.path(), path.join(sharedDir.path(), "sessions"));
		const ownerLeaf = manager.appendMessage({
			...partial,
			content: [{ type: "text", text: "prior response" }],
			stopReason: "stop",
		});
		const originalId = manager.getSessionId();
		const originalFile = manager.getSessionFile();
		const s = makeSession(model, undefined, warmer, manager);
		vi.useFakeTimers();
		try {
			startCacheWarming(s, model);
			vi.advanceTimersByTime(270_000);
			await accepted.promise;

			let settled = false;
			const outcome = s.newSession().then(
				() => undefined,
				(error: unknown) => error,
			);
			void outcome.then(() => {
				settled = true;
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			vi.advanceTimersByTime(4_999);
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(manager.getSessionId()).toBe(originalId);
			vi.advanceTimersByTime(1);
			expect(await outcome).toBeInstanceOf(Error);
			expect(manager.getSessionId()).toBe(originalId);
			expect(s.isSessionTransitioning).toBe(false);
		} finally {
			vi.useRealTimers();
			release.resolve();
		}
		await warmer.drain();
		expect(manager.getEntries().filter(entry => entry.type === "model_usage")).toMatchObject([
			{ parentId: ownerLeaf, purpose: "cache-warm", usage: { totalTokens: usage.totalTokens } },
		]);
		expect(manager.getUsageStatistics().cost).toBe(usage.cost.total * 2);
		expect(await s.newSession()).toBe(true);
		expect(manager.getSessionId()).not.toBe(originalId);
		expect(manager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
		expect(originalFile).toBeDefined();
		const old = await SessionManager.open(originalFile!, undefined, undefined, { throwIfMissing: true });
		expect(old.getEntries().filter(entry => entry.type === "model_usage")).toMatchObject([
			{ parentId: ownerLeaf, purpose: "cache-warm", usage: { totalTokens: usage.totalTokens } },
		]);
		await old.close();
	});

	it.each([false, true])(
		"persists an accepted warm replay before sealing after a terminal event (%s)",
		async terminal => {
			const model = { ...modelOrThrow("claude-sonnet-4-5"), promptCache: { short: 300 } };
			const usage: AssistantMessage["usage"] = {
				input: 1,
				output: 0,
				cacheRead: 100_000,
				cacheWrite: 0,
				totalTokens: 100_001,
				cost: { input: 0, output: 0, cacheRead: 0.125, cacheWrite: 0, total: 0.125 },
			};
			const response: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				usage,
				stopReason: terminal ? "stop" : "aborted",
			};
			const accepted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const warmer = new CacheWarmer({
				stream: () => ({
					async *[Symbol.asyncIterator]() {
						yield { type: "start", partial: response } as const;
						accepted.resolve();
						if (terminal) yield { type: "done", reason: "stop", message: response } as const;
						else await release.promise;
					},
					result: async () => {
						await release.promise;
						return response;
					},
				}),
				getPromptTokens: () => usage.totalTokens,
				getMode: () => "idle",
			});
			const manager = SessionManager.create(sharedDir.path(), path.join(sharedDir.path(), "sessions"));
			const originalFile = manager.getSessionFile();
			manager.appendMessage({
				...response,
				content: [{ type: "text", text: "prior response" }],
				stopReason: "stop",
			});
			const s = makeSession(model, undefined, warmer, manager);
			vi.useFakeTimers();
			startCacheWarming(s, model);
			vi.advanceTimersByTime(270_000);
			await accepted.promise;

			s.beginDispose();
			const closing = s.dispose();
			let closed = false;
			const outcome = closing.then(() => {
				closed = true;
			});
			vi.useRealTimers();
			try {
				const tick = Promise.withResolvers<void>();
				setImmediate(tick.resolve);
				await tick.promise;
				expect(closed).toBe(false);
			} finally {
				release.resolve();
			}
			await outcome;
			expect(originalFile).toBeDefined();
			const old = await SessionManager.open(originalFile!, undefined, undefined, { throwIfMissing: true });
			expect(old.getUsageStatistics().cost).toBe(usage.cost.total * 2);
			expect(old.getEntries().filter(entry => entry.type === "model_usage")).toMatchObject([
				{ purpose: "cache-warm", usage: { totalTokens: usage.totalTokens }, stopReason: response.stopReason },
			]);
			await old.close();
		},
	);

	it("cancels a scheduled paid replay as soon as disposal begins", () => {
		const model = { ...modelOrThrow("claude-sonnet-4-5"), promptCache: { short: 300 } };
		let replays = 0;
		const warmer = new CacheWarmer({
			stream: () => {
				replays++;
				throw new Error("Disposed session replayed");
			},
			getPromptTokens: () => 100_000,
			getMode: () => "idle",
		});
		const s = makeSession(model, undefined, warmer);
		vi.useFakeTimers();
		startCacheWarming(s, model);
		s.beginDispose();
		vi.advanceTimersByTime(270_000);
		expect(replays).toBe(0);
		expect(s.cacheWarmingStatus?.state).toBe("inactive");
	});
});
