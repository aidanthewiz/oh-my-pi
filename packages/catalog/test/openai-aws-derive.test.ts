import { describe, expect, it } from "bun:test";
import { deriveOpenAIAwsModels } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * `deriveOpenAIAwsModels` builds the OpenAI-on-AWS (`openai-aws`) catalog for
 * the Bedrock-Mantle endpoint. Contract: frontier entries clone the
 * first-party `openai` GPT-5.6 Responses specs (capabilities stay in sync)
 * onto the `openai.`-prefixed Bedrock id with AWS pricing, the Bedrock-served
 * 272K window, and the Mantle `openai/v1` base URL — first-party promotion
 * targets and cost never leak through; open-weight (`gpt-oss`) entries are
 * curated statics on the bare `/v1` path. GPT-5.5 and GPT-5.4 are deliberately
 * ABSENT: their Mantle metadata does not permit `data_retention_mode: none`.
 */

function spec(id: string, overrides: Partial<ModelSpec<"openai-responses">> = {}): ModelSpec<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_050_000,
		maxTokens: 128_000,
		contextPromotionTarget: "openai/gpt-5.4",
		...overrides,
	} as ModelSpec<Api>;
}

describe("deriveOpenAIAwsModels", () => {
	it("clones GPT-5.6 Sol/Terra/Luna onto the Mantle gateway with AWS pricing and the 272K window", () => {
		const out = deriveOpenAIAwsModels([spec("gpt-5.6-sol"), spec("gpt-5.6-terra"), spec("gpt-5.6-luna")]);
		const sol = out.find(m => m.id === "openai.gpt-5.6-sol");
		const terra = out.find(m => m.id === "openai.gpt-5.6-terra");
		const luna = out.find(m => m.id === "openai.gpt-5.6-luna");
		expect(sol).toBeDefined();
		expect(terra).toBeDefined();
		expect(luna).toBeDefined();
		for (const m of [sol, terra, luna] as ModelSpec<"openai-responses">[]) {
			expect(m.provider).toBe("openai-aws");
			expect(m.api).toBe("openai-responses");
			expect(m.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
			expect(m.contextWindow).toBe(272_000);
			// The first-party promotion target must not leak across providers;
			// a Mantle model never promotes to a direct OpenAI endpoint.
			expect(m.contextPromotionTarget).toBeUndefined();
		}
		// AWS Bedrock us-east-1 pricing published 30 Jul 2026.
		expect(sol?.cost).toEqual({ input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 });
		expect(terra?.cost).toEqual({ input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75 });
		expect(luna?.cost).toEqual({ input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275 });
	});

	it("keeps capabilities in sync with the first-party spec", () => {
		const out = deriveOpenAIAwsModels([spec("gpt-5.6-sol", { input: ["text", "image"], maxTokens: 128_000 })]);
		const sol = out.find(m => m.id === "openai.gpt-5.6-sol");
		expect(sol?.input).toEqual(["text", "image"]);
		expect(sol?.maxTokens).toBe(128_000);
	});

	it("never derives GPT-5.5/GPT-5.4 (no `none` retention mode on Mantle)", () => {
		const out = deriveOpenAIAwsModels([spec("gpt-5.5"), spec("gpt-5.4")]);
		expect(out.some(m => m.id.includes("5.5") || m.id.includes("5.4"))).toBe(false);
	});

	it("only clones from the first-party openai provider", () => {
		const out = deriveOpenAIAwsModels([
			spec("gpt-5.6-sol", { provider: "github-copilot" } as Partial<ModelSpec<"openai-responses">>),
		]);
		expect(out.some(m => m.id === "openai.gpt-5.6-sol")).toBe(false);
	});

	it("always seeds the open-weight Mantle models on the bare /v1 path", () => {
		const out = deriveOpenAIAwsModels([]);
		const oss = out.filter(m => m.id.startsWith("openai.gpt-oss-"));
		expect(oss.map(m => m.id).sort()).toEqual(["openai.gpt-oss-120b", "openai.gpt-oss-20b"]);
		for (const m of oss) {
			expect(m.provider).toBe("openai-aws");
			expect(m.baseUrl).toBe("https://bedrock-mantle.us-east-1.api.aws/v1");
		}
	});
});
