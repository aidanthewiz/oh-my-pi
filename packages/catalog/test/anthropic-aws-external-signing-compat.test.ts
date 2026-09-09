import { describe, expect, it } from "bun:test";
import { isAnthropicSigningProxyUrl } from "../src/compat/anthropic";
import { resolveModelPolicy } from "../src/compat/resolve";
import type { ModelSpec } from "../src/types";

/**
 * Anthropic's first-party "Claude on AWS" external gateway
 * (`aws-external-anthropic.<region>.api.aws`) forwards to signature-enforcing
 * Anthropic — a SIGNING endpoint like GitHub Copilot's proxy (#2851). It must NOT
 * be classified `replayUnsignedThinking`: an unsigned/summarized thinking block
 * replayed as `signature: ""` 400s with "Invalid signature in thinking block".
 * Auth is Bearer API key or SigV4 plus `anthropic-workspace-id`, never OAuth,
 * so it is also not the OAuth-official host.
 */
function spec(overrides: Partial<ModelSpec<"anthropic-messages">>): ModelSpec<"anthropic-messages"> {
	return {
		api: "anthropic-messages",
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (AWS)",
		provider: "anthropic-aws",
		baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		maxTokens: 64_000,
		contextWindow: 1_000_000,
		reasoning: true,
		...overrides,
	} as ModelSpec<"anthropic-messages">;
}

describe("anthropic compat: aws-external-anthropic is a signing endpoint", () => {
	it("does NOT replay unsigned thinking for the AWS external gateway", () => {
		const compat = resolveModelPolicy(spec({})).compat;
		expect(compat.replayUnsignedThinking).toBe(false);
	});

	it("recognizes the effective AWS URL after a canonical model is rerouted", () => {
		expect(isAnthropicSigningProxyUrl("https://aws-external-anthropic.us-east-1.api.aws")).toBe(true);
	});

	it("is not treated as the OAuth-official Anthropic host", () => {
		const compat = resolveModelPolicy(spec({})).compat;
		expect(compat.officialEndpoint).toBe(false);
	});

	it("still replays unsigned thinking for generic non-official reasoning endpoints (#2005, no regression)", () => {
		const compat = resolveModelPolicy(
			spec({ provider: "custom", baseUrl: "https://llm.example.com/anthropic" }),
		).compat;
		expect(compat.replayUnsignedThinking).toBe(true);
	});
});
