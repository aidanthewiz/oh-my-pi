import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { validateAgentAccountPools } from "@oh-my-pi/pi-coding-agent/config/account-pools";
import { SessionAccountPoolScope } from "@oh-my-pi/pi-coding-agent/config/account-pool-scope";
import { kNoAuth, ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgTaskAgentAccountPools } from "@oh-my-pi/pi-coding-agent/task/settings";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

describe("task.agentAccountPools", () => {
	it("keeps an empty provider list as a deny-all pool and lets null clear an agent", () => {
		expect(validateAgentAccountPools(undefined)).toEqual({});
		expect(validateAgentAccountPools(null)).toEqual({});
		expect(
			validateAgentAccountPools({
				reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] },
				cleared: null,
			}),
		).toEqual({ reviewer: { anthropic: ["email:a@example.com|org:org-a"], "openai-codex": [] } });
	});

	it("rejects every malformed level instead of widening the agent to all accounts", () => {
		const malformed: unknown[] = [
			"reviewer",
			[],
			{ reviewer: ["email:a@example.com"] },
			{ reviewer: { anthropic: "email:a@example.com" } },
			{ reviewer: { anthropic: null } },
			{ reviewer: { anthropic: [""] } },
			{ reviewer: { anthropic: [" email:a@example.com"] } },
			{ reviewer: { anthropic: [42] } },
		];
		for (const value of malformed) {
			expect(() => validateAgentAccountPools(value)).toThrow(Error);
		}
	});

	it("fails settings load on a malformed pool", async () => {
		await expect(
			Settings.loadIsolated({
				inMemory: true,
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: "email:a@example.com" } } },
			}),
		).rejects.toThrow(Error);
	});

	it("keeps an agent named __proto__ restricted across settings layers", async () => {
		// YAML parses `__proto__` as an own key; layer merging and validation must keep it one.
		const tempDir = TempDir.createSync("@pi-account-pools-");
		try {
			const overlay = tempDir.join("overlay.yml");
			await Bun.write(overlay, "task:\n  agentAccountPools:\n    __proto__:\n      anthropic: []\n");
			const settings = await Settings.loadIsolated({
				inMemory: true,
				configFiles: [overlay],
				overrides: { "task.agentAccountPools": { reviewer: { anthropic: [] } } },
			});
			// Dispatch and revival read the pools through the validator.
			const pools = validateAgentAccountPools(cfgTaskAgentAccountPools.get(settings));
			expect(Object.getOwnPropertyDescriptor(pools, "__proto__")?.value).toEqual({ anthropic: [] });
			expect(pools.reviewer).toEqual({ anthropic: [] });
		} finally {
			tempDir.removeSync();
		}
	});

	it("fails every pooled key route instead of returning a keyless authentication sentinel", async () => {
		const tempDir = TempDir.createSync("@pi-keyless-account-pool-");
		const authStorage = createInMemoryAuthStorage();
		const scope = new SessionAccountPoolScope(authStorage, { "pool-keyless": [] }, "pooled-session");
		try {
			const modelsPath = tempDir.join("models.yml");
			await Bun.write(
				modelsPath,
				"providers:\n  pool-keyless:\n    baseUrl: https://example.test/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: pooled-model\n",
			);
			const shared = new ModelRegistry(authStorage, modelsPath);
			const model = shared.find("pool-keyless", "pooled-model");
			if (!model) throw new Error("expected configured keyless model");
			const scoped = scope.registry(shared);
			expect(await shared.getApiKey(model)).toBe(kNoAuth);
			await expect(scoped.getApiKey(model)).rejects.toThrow(MissingApiKeyError);
			await expect(scoped.getApiKeyForProvider(model.provider)).rejects.toThrow(MissingApiKeyError);
			await expect(scoped.getApiKeyWithCredentialForProvider(model.provider)).rejects.toThrow(MissingApiKeyError);
			expect((await scoped.getApiKeyAndHeaders(model)).ok).toBe(false);
			await expect(resolveApiKeyOnce(scoped.resolver(model))).rejects.toThrow(MissingApiKeyError);
			await expect(resolveApiKeyOnce(scoped.resolver(model.provider))).rejects.toThrow(MissingApiKeyError);
		} finally {
			scope.release();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});

describe("SessionAccountPoolScope lease ownership", () => {
	const provider = "unit-account-pool-leases";
	const sourceId = "account-pool-leases-test";
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let shared: ModelRegistry;
	let model: Model<Api>;
	let scopes: SessionAccountPoolScope[];
	let refreshGate: { entered: PromiseWithResolvers<void>; resume: PromiseWithResolvers<void> } | undefined;

	function createScope(account: string, sessionId = "shared-session"): SessionAccountPoolScope {
		const scope = new SessionAccountPoolScope(authStorage, { [provider]: [`account:${account}`] }, sessionId);
		scopes.push(scope);
		return scope;
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-pool-leases-");
		authStorage = createInMemoryAuthStorage();
		scopes = [];
		refreshGate = undefined;
		registerOAuthProvider({
			id: provider,
			name: "Account pool lease fixture",
			sourceId,
			login: async () => {
				throw new Error("Login is not used");
			},
			refreshToken: async credentials => {
				if (refreshGate) {
					refreshGate.entered.resolve();
					await refreshGate.resume.promise;
				}
				return { ...credentials, expires: Date.now() + 3_600_000 };
			},
			getApiKey: credentials => credentials.access,
		});
		await authStorage.credentials.set(
			provider,
			["a", "b"].map(accountId => ({
				type: "oauth" as const,
				accountId,
				access: `synthetic-${accountId}`,
				refresh: "synthetic-refresh",
				expires: Date.now() + 3_600_000,
			})),
		);
		authStorage.keys.setRuntime(provider, "synthetic-runtime");
		const modelsPath = tempDir.join("models.yml");
		await Bun.write(
			modelsPath,
			`providers:\n  ${provider}:\n    baseUrl: https://example.test/v1\n    api: openai-completions\n    auth: oauth\n    models:\n      - id: synthetic-model\n`,
		);
		shared = new ModelRegistry(authStorage, modelsPath);
		const configured = shared.find(provider, "synthetic-model");
		if (!configured) throw new Error("expected synthetic model");
		model = configured;
	});

	afterEach(() => {
		refreshGate?.resume.resolve();
		for (const scope of scopes) scope.release();
		vi.restoreAllMocks();
		unregisterOAuthProviders(sourceId);
		authStorage.close();
		tempDir.removeSync();
	});

	it.each([false, true])("rejects stale key routes when the newer owner released first: %s", async releasedFirst => {
		const stale = createScope("a");
		const registry = stale.registry(shared);
		const modelResolver = registry.resolver(model);
		const providerResolver = registry.resolver(provider);
		expect(await registry.getApiKey(model)).toBe("synthetic-a");
		const current = createScope("b");
		const currentRegistry = current.registry(shared);
		expect(await currentRegistry.getApiKey(model)).toBe("synthetic-b");
		if (releasedFirst) current.release();

		await expect(registry.getApiKey(model)).rejects.toThrow(MissingApiKeyError);
		await expect(registry.getApiKeyForProvider(provider)).rejects.toThrow(MissingApiKeyError);
		await expect(registry.getApiKeyWithCredentialForProvider(provider)).rejects.toThrow(MissingApiKeyError);
		await expect(registry.getApiKeyForProvider(provider, "stale-child")).rejects.toThrow(MissingApiKeyError);
		expect(await authStorage.keys.get(provider, "stale-child")).toBe("synthetic-runtime");
		expect(await registry.getApiKeyAndHeaders(model)).toEqual({
			ok: false,
			error: expect.any(String),
		});
		await expect(resolveApiKeyOnce(modelResolver)).rejects.toThrow(MissingApiKeyError);
		await expect(resolveApiKeyOnce(providerResolver)).rejects.toThrow(MissingApiKeyError);
		expect(() => stale.restrict("shared-session")).toThrow(MissingApiKeyError);
		expect(() => stale.adopt("shared-session")).toThrow(MissingApiKeyError);
		stale.release();
		stale.release();
		expect(await authStorage.keys.get(provider, "shared-session")).toBe(
			releasedFirst ? "synthetic-runtime" : "synthetic-b",
		);
		if (!releasedFirst) expect(await currentRegistry.getApiKey(model)).toBe("synthetic-b");
	});

	it("does not recreate restrictions for late lookups after release", async () => {
		const scope = createScope("a");
		const registry = scope.registry(shared);
		const resolver = registry.resolver(provider);
		scope.release();
		await expect(registry.getApiKey(model)).rejects.toThrow(Error);
		await expect(registry.getApiKeyForProvider(provider, "late-child")).rejects.toThrow(Error);
		await expect(resolveApiKeyOnce(resolver)).rejects.toThrow(MissingApiKeyError);
		expect(() => scope.adopt("late-adopt")).toThrow(Error);
		expect(await authStorage.keys.get(provider, "late-child")).toBe("synthetic-runtime");
		expect(await authStorage.keys.get(provider, "late-adopt")).toBe("synthetic-runtime");
	});

	it.each(
		["model", "provider", "credential", "headers", "model-resolver", "provider-resolver"].flatMap(route => [
			[route, false] as const,
			[route, true] as const,
		]),
	)("rejects suspended %s acquisition after ownership changes (release: %s)", async (route, released) => {
		await authStorage.credentials.set(
			provider,
			["a", "b"].map(accountId => ({
				type: "oauth" as const,
				accountId,
				access: `synthetic-${accountId}`,
				refresh: "synthetic-refresh",
				expires: Date.now() + (accountId === "a" ? -1_000 : 3_600_000),
			})),
		);
		const stale = createScope("a");
		const registry = stale.registry(shared);
		refreshGate = { entered: Promise.withResolvers<void>(), resume: Promise.withResolvers<void>() };
		const pending = (async () => {
			switch (route) {
				case "model":
					return registry.getApiKey(model);
				case "provider":
					return registry.getApiKeyForProvider(provider);
				case "credential":
					return registry.getApiKeyWithCredentialForProvider(provider);
				case "headers":
					return registry.getApiKeyAndHeaders(model);
				case "model-resolver":
					return resolveApiKeyOnce(registry.resolver(model));
				default:
					return resolveApiKeyOnce(registry.resolver(provider));
			}
		})();
		const outcome = pending.then(
			value => ({ value }),
			error => ({ error }),
		);
		await refreshGate.entered.promise;
		const current = released ? undefined : createScope("b");
		if (released) stale.release();
		refreshGate.resume.resolve();
		const result = await outcome;
		if (route === "headers") {
			expect(result).toEqual({ value: { ok: false, error: expect.any(String) } });
		} else {
			expect(result).toEqual({ error: expect.any(MissingApiKeyError) });
		}
		if (current) expect(await current.registry(shared).getApiKey(model)).toBe("synthetic-b");
		else expect(await authStorage.keys.get(provider, "shared-session")).toBe("synthetic-runtime");
	});

	it("rechecks ownership after suspended provider headers", async () => {
		const stale = createScope("a");
		const registry = stale.registry(shared);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		vi.spyOn(shared, "getProviderHeaders").mockImplementation(async () => {
			entered.resolve();
			await resume.promise;
			return undefined;
		});
		const pending = registry.getApiKeyAndHeaders(model);
		await entered.promise;
		const current = createScope("b");
		resume.resolve();
		expect(await pending).toEqual({ ok: false, error: expect.any(String) });
		expect(await current.registry(shared).getApiKey(model)).toBe("synthetic-b");
	});
});
