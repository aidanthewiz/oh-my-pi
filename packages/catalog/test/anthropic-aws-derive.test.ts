import { describe, expect, it } from "bun:test";
import {
	ANTHROPIC_AWS_PLATFORM_MODEL_IDS,
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	deriveAnthropicAwsModels,
} from "../src/provider-models/openai-compat";
import type { Api, ModelSpec } from "../src/types";

/**
 * `deriveAnthropicAwsModels` builds the Claude Platform on AWS (`anthropic-aws`)
 * catalog by cloning first-party `anthropic` Messages specs. Contract: only the
 * platform's model ids are cloned, onto the `anthropic-aws` provider + gateway
 * base URL, with pricing/capabilities copied verbatim; other providers, other
 * apis, and duplicate ids are excluded. This guards the generator derivation
 * without asserting on the bundled models.json.
 */
function spec(id: string, provider = "anthropic", over: Partial<ModelSpec<"anthropic-messages">> = {}): ModelSpec<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		...over,
	} as ModelSpec<Api>;
}

describe("deriveAnthropicAwsModels", () => {
	it("clones only the platform's anthropic Claude models onto the anthropic-aws gateway", () => {
		const out = deriveAnthropicAwsModels([
			spec("claude-sonnet-5"),
			spec("claude-opus-4-5", "anthropic", { contextWindow: 200_000, maxTokens: 64_000 }),
			spec("claude-3-haiku-20240307"), // anthropic, but not a platform id
		]);

		expect(out.map(m => m.id).sort()).toEqual(["claude-opus-4-5", "claude-sonnet-5"]);
		for (const m of out) {
			expect(m.provider).toBe("anthropic-aws");
			expect(m.baseUrl).toBe("https://aws-external-anthropic.us-east-1.api.aws");
			expect(m.api).toBe("anthropic-messages");
		}
		// Pricing/capabilities are copied verbatim from the source anthropic spec.
		const sonnet = out.find(m => m.id === "claude-sonnet-5");
		expect(sonnet?.contextWindow).toBe(1_000_000);
		expect(sonnet?.cost.output).toBe(15);
		expect(out.find(m => m.id === "claude-opus-4-5")?.contextWindow).toBe(200_000);
	});

	it("derives Opus 5 with authoritative pricing and token limits", () => {
		const opus = deriveAnthropicAwsModels(ANTHROPIC_CURATED_FALLBACK_MODELS).find(m => m.id === "claude-opus-5");

		expect(opus).toMatchObject({
			name: "Claude Opus 5",
			provider: "anthropic-aws",
			baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
	});

	it("ignores non-anthropic providers and dedups by id", () => {
		const out = deriveAnthropicAwsModels([
			spec("claude-sonnet-5"),
			spec("claude-sonnet-5"), // duplicate (e.g. models.dev + curated) collapses to one
			spec("claude-sonnet-5", "openrouter"), // not first-party anthropic
		]);
		expect(out).toHaveLength(1);
		expect(out[0].provider).toBe("anthropic-aws");
	});

	it("only clones anthropic-messages models", () => {
		const nonMessages = { ...spec("claude-sonnet-5"), api: "openai-completions" } as ModelSpec<Api>;
		expect(deriveAnthropicAwsModels([nonMessages])).toHaveLength(0);
	});

	it("includes the provider's default model in the platform list", () => {
		// The anthropic-aws catalog entry's defaultModel must be derivable.
		expect(ANTHROPIC_AWS_PLATFORM_MODEL_IDS).toContain("claude-opus-4-8");
	});
});
