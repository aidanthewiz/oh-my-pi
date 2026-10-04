import { describe, expect, it } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { encodeGatewayJobId } from "@oh-my-pi/pi-ai/providers/video-server";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAuthGatewayStdioRouter, selectorCandidates } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-stdio";
import { cfgDisabledModels, cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { isRecord } from "@oh-my-pi/pi-utils";

const fast = getBundledModel("google", "gemini-2.5-flash")!;
const mini = getBundledModel("openai", "gpt-4o-mini")!;
const vertex = getBundledModel("google-vertex", "gemini-2.5-flash")!;
const models = [fast, mini, vertex];
const registry = { getAll: () => models, getAvailable: () => models };
const key = (model: typeof fast) => `${model.provider}/${model.id}`;
const video = buildModel({
	id: "video-test",
	name: "Video test",
	api: "openrouter-video",
	provider: "stdio-video-test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: null,
	maxTokens: null,
	kind: "video",
});
const fullRegistry = {
	getAll: (kind?: string) => (kind === "all" ? [...models, video] : models),
	getAvailable: (kind?: string) => (kind === "all" ? [...models, video] : models),
};

describe("auth-gateway stdio model selectors", () => {
	it("skips comma entries that resolve to nothing and follows the chosen role's fallback chain", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { smol: [key(vertex), key(fast)] } });
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@commit,@smol", settings, registry)).toEqual([fast, vertex]);
	});

	it("follows a concrete model's own chain and stops at the first resolvable entry", () => {
		const settings = Settings.isolated({ "retry.fallbackChains": { [key(mini)]: [key(vertex)] } });
		expect(selectorCandidates(`${key(mini)},${key(fast)}`, settings, registry)).toEqual([mini, vertex]);
	});

	it("offers nothing when no entry resolves", () => {
		expect(selectorCandidates("@commit", Settings.isolated({}), registry)).toEqual([]);
	});

	it("excludes denied models and disabled providers from concrete and role fallbacks", () => {
		const settings = Settings.isolated({
			disabledModels: [key(vertex)],
			"retry.fallbackChains": { smol: [key(vertex), key(mini)], [key(fast)]: [key(vertex), key(mini)] },
		});
		settings.setModelRole("smol", key(fast));
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast, mini]);
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast, mini]);
		cfgDisabledProviders.override(settings, ["openai"]);
		expect(selectorCandidates("@smol", settings, registry)).toEqual([fast]);
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast]);
	});

	it("keeps the allowlist authoritative across fallback chains", () => {
		const settings = Settings.isolated({
			enabledModels: [key(fast)],
			"retry.fallbackChains": { [key(fast)]: [key(vertex), key(mini)] },
		});
		expect(selectorCandidates(key(fast), settings, registry)).toEqual([fast]);
	});

	it("resolves non-chat models from the complete inventory", () => {
		expect(selectorCandidates(`${video.provider}/${video.id}`, Settings.isolated({}), fullRegistry)).toEqual([video]);
	});
});

describe("auth-gateway stdio routing boundaries", () => {
	it("lists only permitted models and leaves unknown routes to the route owner", async () => {
		const storage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({ disabledModels: [key(mini)], disabledProviders: ["google-vertex"] });
		const router = createAuthGatewayStdioRouter(storage, settings, fullRegistry);
		try {
			const listing = await router.route(new Request("http://stdio/v1/models"));
			const body = await listing.json();
			if (!isRecord(body) || !Array.isArray(body.data)) throw new Error("Expected model inventory");
			expect(body.data.map(row => (isRecord(row) ? row.id : undefined))).toEqual([
				key(fast),
				`${video.provider}/${video.id}`,
			]);
			const unknown = await router.route(
				new Request("http://stdio/not-a-route", {
					method: "POST",
					body: JSON.stringify({ model: "missing" }),
				}),
			);
			expect(unknown.status).toBe(404);
			const unknownBody = await unknown.json();
			expect(isRecord(unknownBody) ? unknownBody.error : undefined).toEqual(expect.any(String));
		} finally {
			router.close();
			storage.close();
		}
	});

	it("resolves a persisted video job before any submission and preserves credential refusal", async () => {
		const storage = await AuthStorage.create(":memory:");
		const settings = Settings.isolated({});
		const router = createAuthGatewayStdioRouter(storage, settings, fullRegistry);
		const id = encodeGatewayJobId({ provider: video.provider, modelId: video.id, upstreamId: "existing-job" });
		try {
			const response = await router.route(new Request(`http://stdio/v1/videos/${id}`));
			expect(response.status).toBe(401);
			cfgDisabledModels.override(settings, [`${video.provider}/${video.id}`]);
			const blocked = await router.route(new Request(`http://stdio/v1/videos/${id}`));
			expect(blocked.status).toBe(404);
		} finally {
			router.close();
			storage.close();
		}
	});
});
