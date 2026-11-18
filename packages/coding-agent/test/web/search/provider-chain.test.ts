import { afterEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { cfgDisabledModels, cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
	resolveModelRoleValue,
	resolveRoleChain,
	roleCandidatePool,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as providerModule from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

const originalPerplexityApiKey = process.env.PERPLEXITY_API_KEY;
const originalPerplexityCookies = process.env.PERPLEXITY_COOKIES;
const storages = new Set<AuthStorage>();

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

function createRuntime(overrides: Parameters<typeof Settings.isolated>[0] = {}) {
	const authStorage = createInMemoryAuthStorage();
	storages.add(authStorage);
	const settings = Settings.isolated(overrides);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
	const pool = roleCandidatePool("web", settings, modelRegistry);
	return { authStorage, settings, modelRegistry, pool };
}

afterEach(async () => {
	for (const authStorage of storages) await authStorage.close();
	storages.clear();
	restoreEnv("PERPLEXITY_API_KEY", originalPerplexityApiKey);
	restoreEnv("PERPLEXITY_COOKIES", originalPerplexityCookies);
});

describe("web model role resolution", () => {
	it("resolves an arbitrary pure-engine selector from the catalog pool", () => {
		const { pool, settings } = createRuntime();

		const resolved = resolveModelRoleValue("web/duckduckgo", pool, { settings });

		expect(resolved.model).toMatchObject({ provider: "web", id: "duckduckgo", kind: "search" });
	});

	it("resolves authenticated OpenRouter chat models with web grounding", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openrouter", "test-openrouter-key");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry);

		const resolved = resolveModelRoleValue("openrouter/google/gemini-2.5-flash", pool, { settings });

		expect(resolved.model).toMatchObject({
			provider: "openrouter",
			id: "google/gemini-2.5-flash",
			webSearch: "openrouter",
		});
	});

	it("admits supported direct OpenAI web models but excludes realtime from candidates", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const openAiCandidates = roleCandidatePool("web", settings, modelRegistry).filter(
			model => model.provider === "openai",
		);
		expect(openAiCandidates.some(model => model.id === "gpt-6-luna")).toBe(true);
		expect(openAiCandidates.some(model => model.id === "gpt-realtime-2.1")).toBe(false);
		const candidates = resolveRoleChain("web", settings, openAiCandidates);

		// Credentials alone do not authorize API-billed search in the automatic chain.
		expect(candidates).toEqual([]);
	});

	it("selects API-billed OpenAI only when the web role explicitly requests it", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const settings = Settings.isolated({
			modelRoles: { web: "openai/gpt-6-luna" },
			"retry.fallbackChains": { web: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry);
		const candidates = resolveRoleChain("web", settings, pool);

		expect(
			candidates.map(candidate => [`${candidate.model.provider}/${candidate.model.id}`, candidate.explicit]),
		).toEqual([["openai/gpt-6-luna", true]]);
	});

	it("does not select API-billed OpenAI outside the configured model scope", () => {
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const settings = Settings.isolated({
			enabledModels: ["web/duckduckgo"],
			modelRoles: { web: "openai/gpt-6-luna" },
			"retry.fallbackChains": { web: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const pool = roleCandidatePool("web", settings, modelRegistry);

		expect(resolveRoleChain("web", settings, pool).some(candidate => candidate.model.provider === "openai")).toBe(
			false,
		);
	});

	it("marks configured primaries and configured fallbacks explicit", () => {
		const { pool, settings } = createRuntime({
			modelRoles: { web: "web/perplexity" },
			"retry.fallbackChains": { web: ["web/duckduckgo"] },
		});

		const candidates = resolveRoleChain("web", settings, pool);

		expect(candidates.map(candidate => [candidate.model.id, candidate.explicit])).toEqual([
			["perplexity", true],
			["duckduckgo", true],
		]);
	});
});

describe("web search transport authorization", () => {
	it("skips credential-triggered API engines automatically but permits an explicit selection", async () => {
		const settings = await Settings.init({ inMemory: true });
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		for (const name of ["parallel", "exa", "firecrawl"]) {
			authStorage.keys.setRuntime(name, `test-${name}-key`);
		}
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const attempted: string[] = [];
		vi.spyOn(providerModule, "getSearchProvider").mockResolvedValue({
			id: "parallel",
			label: "Recorded search",
			isAvailable: (_auth, model) =>
				model?.id === "duckduckgo" || model?.id === "parallel" || model?.id === "exa" || model?.id === "firecrawl",
			isExplicitlyAvailable: () => true,
			isKeyless: () => false,
			search: async ({ model }) => {
				attempted.push(model.id);
				return {
					provider: "parallel",
					sources: [{ title: "Result", url: "https://example.org/result" }],
				};
			},
		});
		try {
			const automatic = await runSearchQuery({ query: "example" }, { authStorage, modelRegistry });
			expect(automatic.details.response.sources[0]?.url).toBe("https://example.org/result");
			expect(attempted).toEqual(["duckduckgo"]);

			const explicit = await runSearchQuery(
				{ query: "example", model: "web/parallel" },
				{ authStorage, modelRegistry },
			);
			expect(explicit.details.response.sources[0]?.url).toBe("https://example.org/result");
			expect(attempted).toEqual(["duckduckgo", "parallel"]);
		} finally {
			vi.restoreAllMocks();
			resetSettingsForTest();
		}
	});

	it("keeps hosted swaps on the admitted session provider and refuses later policy denial", async () => {
		const settings = await Settings.init({ inMemory: true });
		const authStorage = createInMemoryAuthStorage();
		storages.add(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-anthropic-key");
		authStorage.keys.setRuntime("openai", "test-openai-key");
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings });
		const activeModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!activeModel) throw new Error("Bundled Anthropic session model missing");
		const attempted: string[] = [];
		vi.spyOn(providerModule, "getGroundedSearchProvider").mockResolvedValue({
			id: "anthropic",
			label: "Recorded grounding",
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			isKeyless: () => false,
			search: async ({ model }) => {
				attempted.push(`${model.provider}/${model.id}`);
				return {
					provider: "anthropic",
					sources: [{ title: "Result", url: "https://example.org/result" }],
				};
			},
		});
		try {
			const result = await runSearchQuery(
				{ query: "example", model: "web/hosted" },
				{
					authStorage,
					modelRegistry,
					sessionModel: { ...activeModel, webSearchModel: "openai/gpt-6-luna" },
				},
			);
			expect(result.details.response.sources[0]?.url).toBe("https://example.org/result");
			expect(attempted).toEqual(["anthropic/claude-sonnet-4-5"]);
			for (const policy of ["deny", "allowlist"] as const) {
				cfgDisabledModels.override(settings, policy === "deny" ? ["anthropic/*"] : []);
				cfgEnabledModels.override(settings, policy === "allowlist" ? ["web/hosted"] : []);
				const denied = await runSearchQuery(
					{ query: "example", model: "web/hosted" },
					{
						authStorage,
						modelRegistry,
						sessionModel: { ...activeModel, webSearchModel: "openai/gpt-6-luna" },
					},
				);
				expect(denied.details.response.sources).toEqual([]);
				expect(denied.details.error).toBeDefined();
				expect(attempted).toEqual(["anthropic/claude-sonnet-4-5"]);
			}
		} finally {
			vi.restoreAllMocks();
			resetSettingsForTest();
		}
	});
});

describe("web model candidate availability", () => {
	it("skips anonymous explicit-only engines in the default chain", async () => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
		const { authStorage, pool } = createRuntime();
		const model = pool.find(candidate => candidate.provider === "web" && candidate.id === "perplexity");
		if (!model) throw new Error("Bundled Perplexity search model missing");
		const provider = await getSearchProvider(model.id);

		expect(await provider.isAvailable(authStorage, model)).toBe(false);
		expect(await provider.isExplicitlyAvailable(authStorage, model)).toBe(true);
	});

	it("admits a configured anonymous engine through explicit availability", async () => {
		delete process.env.PERPLEXITY_API_KEY;
		delete process.env.PERPLEXITY_COOKIES;
		const { authStorage, pool, settings } = createRuntime({ modelRoles: { web: "web/perplexity" } });
		const [candidate] = resolveRoleChain("web", settings, pool);
		if (!candidate) throw new Error("Configured Perplexity candidate missing");
		const provider = await getSearchProvider(candidate.model.id);

		expect(candidate.explicit).toBe(true);
		expect(await provider.isExplicitlyAvailable(authStorage, candidate.model)).toBe(true);
	});
});
