import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { carriesReasoning } from "@oh-my-pi/pi-catalog/compat/reasoning-carry";
import {
	kimiCodeModelManagerOptions,
	modelsDevCatalogFallback,
	moonshotModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

// Live `/models` rows: neither roster carries pricing or an output cap.
const KIMI_CODE_K31_PRO = {
	id: "k3.1-pro",
	display_name: "K3.1 Pro",
	context_length: 1_048_576,
	supports_reasoning: true,
	supports_image_in: true,
	supports_video_in: true,
	supports_thinking_type: "only",
	think_efforts: { support: true, valid_efforts: ["low", "high", "max"], default_effort: "max" },
};
const MOONSHOT_K31_PRO = {
	id: "kimi-k3.1-pro",
	object: "model",
	owned_by: "moonshot",
	context_length: 1_048_576,
	supports_image_in: true,
	supports_reasoning: true,
	supports_thinking_type: "only",
};

// https://platform.kimi.ai/docs/pricing/chat (5m cache-write tier, omp's default).
const K31_PRO_COST = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2 };
const K31_PRO_HIGHSPEED_COST = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 4 };

function rosterFetch(data: readonly Record<string, unknown>[]): FetchImpl {
	return async () => Response.json({ object: "list", data });
}

describe("Kimi K3.1 Pro catalog contract", () => {
	it("gives Kimi Code K3.1 rows K3's wire contract, K3.1 list pricing, and K3.1's output cap", async () => {
		const discovered = await kimiCodeModelManagerOptions({
			apiKey: "test-key",
			fetch: rosterFetch([
				KIMI_CODE_K31_PRO,
				{ ...KIMI_CODE_K31_PRO, id: "k3.1-pro-highspeed", display_name: "K3.1 Pro Highspeed" },
			]),
		}).fetchDynamicModels?.();
		const models = new Map((discovered ?? []).map(spec => [spec.id, buildModel(spec)]));

		for (const [id, cost] of [
			["k3.1-pro", K31_PRO_COST],
			["k3.1-pro-highspeed", K31_PRO_HIGHSPEED_COST],
		] as const) {
			expect(models.get(id)).toMatchObject({
				maxTokens: 131_072,
				cost,
				compat: { nativeKimiK3Reasoning: true, clampOutputToModelMax: true },
			});
		}
	});

	it("bills unpriced Moonshot K3.1 rows at their own list rates", async () => {
		const discovered = await moonshotModelManagerOptions({
			apiKey: "test-key",
			fetch: rosterFetch([MOONSHOT_K31_PRO, { ...MOONSHOT_K31_PRO, id: "kimi-k3.1-pro-highspeed" }]),
		}).fetchDynamicModels?.();
		const models = new Map((discovered ?? []).map(spec => [spec.id, buildModel(spec)]));

		expect(models.get("kimi-k3.1-pro")?.cost).toMatchObject(K31_PRO_COST);
		expect(models.get("kimi-k3.1-pro-highspeed")?.cost).toMatchObject(K31_PRO_HIGHSPEED_COST);
	});

	it("caps Moonshot K3.1 rows from the shared catalog at K3's output budget, not the full window", () => {
		const fallback = modelsDevCatalogFallback("moonshot");
		if (!fallback) throw new Error("Moonshot did not configure a shared catalog fallback");
		// The shared catalog lists Moonshot's settable `max_completion_tokens`
		// ceiling (the whole 1M window) as the output limit.
		const catalogRow = {
			reasoning: true,
			tool_call: true,
			modalities: { input: ["text", "image"], output: ["text"] },
			limit: { context: 1_048_576, output: 1_048_576 },
		};
		const specs = fallback.map(
			{
				moonshotai: {
					models: {
						"kimi-k3.1-pro": { ...catalogRow, name: "Kimi K3.1 Pro" },
						"kimi-k3.1-pro-highspeed": { ...catalogRow, name: "Kimi K3.1 Pro Highspeed" },
					},
				},
			},
			"moonshot",
		);
		const models = new Map(specs.map(spec => [spec.id, buildModel(spec)]));

		expect(models.get("kimi-k3.1-pro")?.maxTokens).toBe(131_072);
		expect(models.get("kimi-k3.1-pro-highspeed")?.maxTokens).toBe(131_072);

		for (const spec of specs) {
			expect(buildModel({ ...spec, maxTokens: 65_536 }).maxTokens).toBe(65_536);
		}
	});

	it.each([
		["kimi-code", "k3.1-pro"],
		["kimi-code", "k3.1-pro-highspeed"],
		["moonshot", "kimi-k3.1-pro"],
		["moonshot", "kimi-k3.1-pro-highspeed"],
	] as const)("preserves populated live prices for %s/%s", (provider, id) => {
		const cost = { input: 6.25, output: 17.5, cacheRead: 0.125, cacheWrite: 0.75 };
		const model = buildModel({
			provider,
			id,
			name: id,
			api: "openai-completions",
			baseUrl: "https://kimi.example/v1",
			reasoning: true,
			input: ["text", "image"],
			cost,
			contextWindow: 1_048_576,
			maxTokens: 131_072,
		});
		expect(model.cost).toEqual(cost);
	});

	it.each(["", "-highspeed"])("keeps K3.1 reasoning identity separate from K3 for %s routes", suffix => {
		const kimiCodeK31 = { provider: "kimi-code", api: "openai-completions", id: `k3.1-pro${suffix}` } as const;
		const moonshotK31 = { provider: "moonshot", api: "openai-completions", id: `kimi-k3.1-pro${suffix}` } as const;
		const kimiCodeK3 = { provider: "kimi-code", api: "openai-completions", id: "k3" } as const;
		const moonshotK3 = { provider: "moonshot", api: "openai-completions", id: "kimi-k3" } as const;

		expect(carriesReasoning({ ...moonshotK31, model: moonshotK31.id }, kimiCodeK31)).toBe(true);
		expect(carriesReasoning({ ...kimiCodeK31, model: kimiCodeK31.id }, moonshotK31)).toBe(true);
		expect(carriesReasoning({ ...moonshotK3, model: moonshotK3.id }, kimiCodeK31)).toBe(false);
		expect(carriesReasoning({ ...kimiCodeK31, model: kimiCodeK31.id }, moonshotK3)).toBe(false);
		expect(carriesReasoning({ ...kimiCodeK3, model: kimiCodeK3.id }, moonshotK31)).toBe(false);
		expect(carriesReasoning({ ...moonshotK31, model: moonshotK31.id }, kimiCodeK3)).toBe(false);
	});
});
