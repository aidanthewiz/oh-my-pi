import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as providers from "@oh-my-pi/pi-coding-agent/web/search/provider";
import type { SearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

beforeEach(() => resetSettingsForTest());
afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

async function withSearch(
	fallbacks: string[],
	run: (context: { authStorage: AuthStorage; modelRegistry: ModelRegistry }) => Promise<void>,
) {
	using temp = TempDir.createSync("@omp-search-disclosure-");
	const settings = await Settings.init({ inMemory: true, cwd: temp.path(), agentDir: temp.join("agent") });
	settings.setModelRole("web", "web/ex");
	cfgRetryFallbackChains.set(settings, { web: fallbacks });
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"), {
		settings,
		cacheDbPath: temp.join("models.db"),
	});
	const preconnect = () => {
		throw new Error("Unexpected network preconnect");
	};
	const network = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async () => {
				throw new Error("Unexpected network request");
			},
			{ preconnect },
		),
	);
	Object.assign(network, { preconnect });
	try {
		await run({ authStorage, modelRegistry });
	} finally {
		settings.cancelPendingSaves();
		await authStorage.close();
		expect(network).not.toHaveBeenCalled();
	}
}

function searchProvider(id: SearchProviderId, available = true): providers.SearchProvider {
	return {
		id,
		label: `Synthetic ${id}`,
		isAvailable: () => available,
		isExplicitlyAvailable: () => available,
		isKeyless: () => false,
		search: async () => ({
			provider: id,
			sources: [{ title: "Synthetic search result", url: "https://x.com/synthetic/status/1" }],
		}),
	};
}

function assertDisclosure(text: string, servingModel: string) {
	// Provider payloads contain no model selectors, so these identities must come from consumer disclosure.
	const identities = new Set(text.match(/(?:web|xai)\/[a-z0-9._-]+/g) ?? []);
	expect(identities).toContain("web/ex");
	expect(identities).toContain(servingModel);
}

describe("web role replacement disclosure reaches search consumers", () => {
	it("TA-WEB-IMMEDIATE discloses a primary miss when the fallback answers immediately", async () => {
		await withSearch(["web/parallel"], async context => {
			vi.spyOn(providers, "getSearchProvider").mockImplementation(async id => {
				if (id !== "parallel") throw new Error(`Unexpected provider ${id}`);
				return searchProvider("parallel");
			});
			const result = await runSearchQuery({ query: "synthetic documentation" }, context);
			expect(result.details.response.provider).toBe("parallel");
			expect(result.details.response.sources).toEqual([
				{ title: "Synthetic search result", url: "https://x.com/synthetic/status/1" },
			]);
			assertDisclosure(result.content[0]!.text, "web/parallel");
		});
	});

	it.each(["unavailable", "failure"])(
		"TA-WEB-ADVANCE retains the miss after its first fallback is %s",
		async condition => {
			await withSearch(["web/exa", "web/parallel"], async context => {
				vi.spyOn(providers, "getSearchProvider").mockImplementation(async id => {
					if (id === "exa") {
						const first = searchProvider("exa", condition !== "unavailable");
						if (condition === "failure")
							first.search = async () => {
								throw new Error("synthetic refusal");
							};
						return first;
					}
					if (id === "parallel") return searchProvider("parallel");
					throw new Error(`Unexpected provider ${id}`);
				});
				const result = await runSearchQuery({ query: "synthetic documentation" }, context);
				expect(result.details.response.provider).toBe("parallel");
				assertDisclosure(result.content[0]!.text, "web/parallel");
			});
		},
	);

	it("TA-WEB-XORDER names the actual serving model after authorized X-only reordering", async () => {
		await withSearch(["web/parallel", "xai/grok-4.7"], async context => {
			context.authStorage.keys.setRuntime("xai", "synthetic-xai-key");
			vi.spyOn(providers, "getGroundedSearchProvider").mockImplementation(async grounding => {
				if (grounding !== "xai") throw new Error(`Unexpected grounding ${grounding}`);
				return searchProvider("xai");
			});
			vi.spyOn(providers, "getSearchProvider").mockImplementation(async () => {
				throw new Error("The original fallback must not run ahead of admitted X search");
			});
			const result = await runSearchQuery({ query: "synthetic site:x.com" }, context);
			expect(result.details.response.provider).toBe("xai");
			assertDisclosure(result.content[0]!.text, "xai/grok-4.7");
		});
	});

	it("TA-WEB-CONSTRAINT preserves replacement identity while reporting a relaxed constraint", async () => {
		await withSearch(["web/parallel"], async context => {
			vi.spyOn(providers, "getSearchProvider").mockImplementation(async id => {
				if (id !== "parallel") throw new Error(`Unexpected provider ${id}`);
				return searchProvider("parallel");
			});
			const result = await runSearchQuery({ query: "synthetic site:unmatched.invalid" }, context);
			expect(result.details.response.sources).toEqual([
				{ title: "Synthetic search result", url: "https://x.com/synthetic/status/1" },
			]);
			expect(result.content[0]!.text).toContain("site:unmatched.invalid");
			assertDisclosure(result.content[0]!.text, "web/parallel");
		});
	});

	it("TA-WEB-OVERRIDE does not report a role miss for an explicit request model", async () => {
		await withSearch(["web/parallel"], async context => {
			vi.spyOn(providers, "getSearchProvider").mockImplementation(async id => {
				if (id !== "exa") throw new Error(`Unexpected provider ${id}`);
				return searchProvider("exa");
			});
			const result = await runSearchQuery({ query: "synthetic documentation", model: "web/exa" }, context);
			expect(result.details.response.provider).toBe("exa");
			const identities = new Set(result.content[0]!.text.match(/(?:web|xai)\/[a-z0-9._-]+/g) ?? []);
			expect(identities.has("web/ex")).toBe(false);
		});
	});
});
