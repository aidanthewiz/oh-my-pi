import { describe, expect, it } from "bun:test";
import type { Api } from "@oh-my-pi/pi-ai/types";
import {
	coerceServiceTierByFamily,
	getPremiumServiceTierRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { classifyModel } from "@oh-my-pi/pi-catalog/compat/taxonomy";

const m = (provider: string, api: Api, id: string) => ({
	provider,
	api,
	id,
	identity: classifyModel(provider, id),
});

const openai = m("openai", "openai-responses", "gpt-5");
const codex = m("openai-codex", "openai-codex-responses", "gpt-5.5");
const anthropic = m("anthropic", "anthropic-messages", "claude-opus-4-6");
const vertexClaude = m("google-vertex", "anthropic-messages", "claude-opus-4-6");
const gemini = m("google", "google-generative-ai", "gemini-3-flash");
const vertexGemini = m("google-vertex", "google-vertex", "gemini-3-flash");
const fireworks = m("fireworks", "openai-completions", "qwen3");
const fireworksOpenAI = m("fireworks", "openai-completions", "gpt-oss-120b");
const orOpenAI = m("openrouter", "openai-responses", "openai/gpt-5.5");
const orGoogle = m("openrouter", "openai-completions", "google/gemini-3-flash");
const orAnthropic = m("openrouter", "openai-completions", "anthropic/claude-opus-4-6");
const customOpenAI = m("custom-relay", "openai-completions", "gpt-5.5");
const customCodex = m("custom-relay", "openai-codex-responses", "gpt-5.5");
const customOpenAIAliases = [
	m("custom-relay", "openai-responses", "gpt-4o"),
	m("custom-relay", "openai-responses", "o3"),
	m("custom-relay", "openai-responses", "o4-mini"),
	m("custom-relay", "openai-responses", "codex-mini-latest"),
];

describe("serviceTierFamily", () => {
	it("classifies first-party providers by provider/api", () => {
		expect(serviceTierFamily(openai)).toBe("openai");
		expect(serviceTierFamily(codex)).toBe("openai");
		expect(serviceTierFamily(anthropic)).toBe("anthropic");
		expect(serviceTierFamily(vertexClaude)).toBe("anthropic"); // Claude on Vertex is the anthropic family
		expect(serviceTierFamily(gemini)).toBe("google");
		expect(serviceTierFamily(vertexGemini)).toBe("google");
		expect(serviceTierFamily(fireworks)).toBeUndefined();
		expect(serviceTierFamily(fireworksOpenAI)).toBeUndefined();
	});

	it("classifies OpenAI-compatible custom providers by api", () => {
		expect(serviceTierFamily(customOpenAI)).toBe("openai");
		expect(serviceTierFamily(customCodex)).toBe("openai");
		for (const model of customOpenAIAliases) {
			expect(serviceTierFamily(model)).toBe("openai");
		}
	});

	it("classifies OpenRouter models by id namespace", () => {
		expect(serviceTierFamily(orOpenAI)).toBe("openai");
		expect(serviceTierFamily(orGoogle)).toBe("google");
		expect(serviceTierFamily(orAnthropic)).toBe("anthropic");
		expect(serviceTierFamily(m("openrouter", "openai-completions", "z-ai/glm-4.7"))).toBeUndefined();
	});
});

describe("resolveModelServiceTier", () => {
	it("reduces a per-family map to the model's family entry", () => {
		const tiers = { openai: "priority", anthropic: "priority", google: "flex" } as const;
		expect(resolveModelServiceTier(tiers, openai)).toBe("priority");
		expect(resolveModelServiceTier(tiers, gemini)).toBe("flex");
		expect(resolveModelServiceTier(tiers, orAnthropic)).toBe("priority");
		expect(resolveModelServiceTier(tiers, customCodex)).toBe("priority");
		expect(resolveModelServiceTier(tiers, fireworks)).toBeUndefined(); // no family
		expect(resolveModelServiceTier(tiers, fireworksOpenAI)).toBeUndefined(); // dedicated provider tier
		expect(resolveModelServiceTier(undefined, openai)).toBeUndefined();
		expect(resolveModelServiceTier({ google: "priority" }, openai)).toBeUndefined();
	});
});

describe("shouldSendServiceTier", () => {
	it("admits unadvertised Ultrafast only for the exact official Codex Sol route", () => {
		const spec = {
			id: "gpt-6.1-sol",
			name: "Sol",
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"] as "text"[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 272_000,
			maxTokens: 128_000,
		};
		for (const serviceTiers of [undefined, [], ["priority"]]) {
			const model = buildModel({ ...spec, serviceTiers });
			expect(shouldSendServiceTier("ultrafast", model)).toBe(true);
			expect(getPremiumServiceTierRequests("ultrafast", model)).toBe(1);
			expect(shouldSendServiceTier(undefined, model)).toBe(false);
			expect(shouldSendServiceTier("auto", model)).toBe(false);
			expect(shouldSendServiceTier("default", model)).toBe(true);
			expect(shouldSendServiceTier("flex", model)).toBe(true);
			expect(shouldSendServiceTier("priority", model)).toBe(true);
		}
		for (const route of [
			{ id: "gpt-6-sol" },
			{ id: "gpt-unknown" },
			{ provider: "custom-relay" },
			{ baseUrl: "https://relay.invalid/backend-api" },
			{ baseUrl: "https://chatgpt.com.evil.invalid/backend-api" },
			{ baseUrl: "http://chatgpt.com/backend-api" },
			{ baseUrl: "https://chatgpt.com/backend-apix" },
			{ baseUrl: "https://chatgpt.com:444/backend-api" },
			{ baseUrl: "not a URL" },
			{ requestModelId: "gpt-6-sol" },
			{ requestModelId: "" },
			{ id: "sol-alias", requestModelId: spec.id },
		]) {
			const model = buildModel({ ...spec, ...route, serviceTiers: ["priority"] });
			expect(shouldSendServiceTier("ultrafast", model)).toBe(false);
			expect(getPremiumServiceTierRequests("ultrafast", model)).toBe(0);
			expect(
				shouldSendServiceTier("ultrafast", buildModel({ ...spec, ...route, serviceTiers: ["ultrafast"] })),
			).toBe(true);
		}
		for (const api of ["openai-responses", "openai-completions"] as const) {
			expect(shouldSendServiceTier("ultrafast", buildModel({ ...spec, api }))).toBe(false);
		}
		for (const baseUrl of [
			undefined,
			"",
			"https://chatgpt.com/backend-api/",
			"https://chatgpt.com/backend-api/codex/responses",
		]) {
			expect(shouldSendServiceTier("ultrafast", { ...buildModel(spec), baseUrl })).toBe(true);
		}
		expect(shouldSendServiceTier("ultrafast", buildModel({ ...spec, requestModelId: spec.id }))).toBe(true);
		const model = buildModel(spec);
		const historical = { provider: model.provider, api: model.api, identity: model.identity };
		expect(shouldSendServiceTier("ultrafast", historical)).toBe(false);
		expect(getPremiumServiceTierRequests("ultrafast", historical, { served: true })).toBe(1);
		expect(serviceTierFamily(historical)).toBe("openai");
		expect(resolveModelServiceTier({ openai: "priority" }, historical)).toBe("priority");
		expect(shouldSendServiceTier("priority", buildModel({ ...spec, serviceTiers: ["ultrafast"] }))).toBe(false);
		expect(shouldSendServiceTier("scale", buildModel({ ...spec, serviceTiers: ["priority"] }))).toBe(false);
	});

	it("sends every explicit tier on the OpenAI family, omits auto, supported tiers elsewhere", () => {
		for (const p of ["openai", "openai-codex"] as const) {
			expect(shouldSendServiceTier("flex", p)).toBe(true);
			expect(shouldSendServiceTier("scale", p)).toBe(true);
			expect(shouldSendServiceTier("priority", p)).toBe(true);
			expect(shouldSendServiceTier("default", p)).toBe(true);
			// `auto` is OpenAI's implicit default and the Codex endpoint rejects it — never sent.
			expect(shouldSendServiceTier("auto", p)).toBe(false);
		}
		expect(shouldSendServiceTier("auto", codex)).toBe(false);
		expect(shouldSendServiceTier("auto", customOpenAI)).toBe(false);
		expect(shouldSendServiceTier("flex", "openrouter")).toBe(true);
		expect(shouldSendServiceTier("default", "openrouter")).toBe(false);
		expect(shouldSendServiceTier("priority", customCodex)).toBe(true);
		expect(shouldSendServiceTier("scale", customOpenAI)).toBe(true);
		expect(shouldSendServiceTier("default", customOpenAI)).toBe(true);
		for (const model of customOpenAIAliases) {
			expect(shouldSendServiceTier("priority", model)).toBe(true);
		}
	});

	it("sends flex/priority on direct Google, priority-only on Vertex (no scale)", () => {
		expect(shouldSendServiceTier("flex", "google")).toBe(true);
		expect(shouldSendServiceTier("priority", "google")).toBe(true);
		expect(shouldSendServiceTier("scale", "google")).toBe(false);
		expect(shouldSendServiceTier("priority", "google-vertex")).toBe(true);
		expect(shouldSendServiceTier("flex", "google-vertex")).toBe(false); // Vertex flex has no wire control
	});

	it("sends only priority on Fireworks, nothing on Anthropic", () => {
		expect(shouldSendServiceTier("priority", "fireworks")).toBe(true);
		expect(shouldSendServiceTier("flex", "fireworks")).toBe(false);
		expect(shouldSendServiceTier("priority", "anthropic")).toBe(false);
	});

	it("sends ultrafast to OpenAI, and to Codex or relays only when discovery advertises it", () => {
		expect(shouldSendServiceTier("ultrafast", openai)).toBe(true);
		expect(shouldSendServiceTier("ultrafast", codex)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", { ...codex, serviceTiers: ["priority"] })).toBe(false);
		expect(shouldSendServiceTier("ultrafast", { ...codex, serviceTiers: ["priority", "ultrafast"] })).toBe(true);
		// The advertised list, not the provider id, gates Codex-backend models and relays.
		expect(shouldSendServiceTier("ultrafast", { ...customCodex, serviceTiers: ["ultrafast"] })).toBe(true);
		expect(shouldSendServiceTier("ultrafast", customCodex)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", customOpenAI)).toBe(false);
		for (const api of ["openai-completions", "openai-responses"] as const) {
			const advertised = { ...customOpenAI, api, serviceTiers: ["ultrafast"] };
			expect(shouldSendServiceTier("ultrafast", advertised)).toBe(true);
			expect(getPremiumServiceTierRequests("ultrafast", advertised)).toBe(0);
			expect(shouldSendServiceTier("ultrafast", { ...advertised, serviceTiers: [] })).toBe(false);
			expect(shouldSendServiceTier("ultrafast", { ...advertised, provider: "github-copilot" })).toBe(false);
			expect(shouldSendServiceTier("ultrafast", { ...advertised, identity: gemini.identity })).toBe(false);
		}
		// Providers that own a separate tier control never take OpenAI's, advertised or not.
		expect(shouldSendServiceTier("ultrafast", { ...fireworksOpenAI, serviceTiers: ["ultrafast"] })).toBe(false);
		expect(shouldSendServiceTier("ultrafast", orOpenAI)).toBe(false);
		expect(shouldSendServiceTier("ultrafast", gemini)).toBe(false);
		expect(realizesPriorityServiceTier("ultrafast", openai)).toBe(false);
	});

	it("gates Codex priority/scale only on a non-empty discovered tier list", () => {
		const unlisted = { ...codex, serviceTiers: ["ultrafast"] };
		expect(shouldSendServiceTier("priority", unlisted)).toBe(false);
		expect(realizesPriorityServiceTier("priority", unlisted)).toBe(false);
		expect(getPremiumServiceTierRequests("priority", unlisted)).toBe(0);
		expect(shouldSendServiceTier("scale", unlisted)).toBe(false);
		expect(shouldSendServiceTier("priority", { ...codex, serviceTiers: ["priority"] })).toBe(true);
		// An empty list means "not reported" (free-plan accounts list [] for every model): Fast stays available.
		const unreported = { ...codex, serviceTiers: [] };
		expect(shouldSendServiceTier("priority", unreported)).toBe(true);
		expect(realizesPriorityServiceTier("priority", unreported)).toBe(true);
		expect(shouldSendServiceTier("ultrafast", unreported)).toBe(false);
		// Flex is always an accepted request option; `default` is out of this gate's scope.
		expect(shouldSendServiceTier("flex", unlisted)).toBe(true);
		expect(shouldSendServiceTier("default", unlisted)).toBe(true);
		// No discovered list (bundled/custom rows): the provider-level answer stands.
		expect(shouldSendServiceTier("priority", codex)).toBe(true);
		expect(shouldSendServiceTier("priority", customCodex)).toBe(true);
	});

	it("returns false for unset tiers", () => {
		expect(shouldSendServiceTier(undefined, "openai")).toBe(false);
		expect(shouldSendServiceTier(null, "openai")).toBe(false);
	});
});

describe("realizesPriorityServiceTier", () => {
	it("realizes priority where the wire actually applies it", () => {
		expect(realizesPriorityServiceTier("priority", openai)).toBe(true);
		expect(realizesPriorityServiceTier("priority", anthropic)).toBe(true); // direct fast mode
		expect(realizesPriorityServiceTier("priority", gemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", vertexGemini)).toBe(true);
		expect(realizesPriorityServiceTier("priority", fireworks)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orOpenAI)).toBe(true);
		expect(realizesPriorityServiceTier("priority", orGoogle)).toBe(true);
		expect(realizesPriorityServiceTier("priority", customCodex)).toBe(true);
		for (const model of customOpenAIAliases) {
			expect(realizesPriorityServiceTier("priority", model)).toBe(true);
		}
	});

	it("does not realize priority where the wire drops it", () => {
		expect(realizesPriorityServiceTier("priority", vertexClaude)).toBe(false); // no fast mode on Vertex
		expect(realizesPriorityServiceTier("priority", orAnthropic)).toBe(false); // OpenRouter Anthropic
		expect(realizesPriorityServiceTier("flex", openai)).toBe(false);
		expect(realizesPriorityServiceTier(undefined, openai)).toBe(false);
	});
});

describe("getPremiumServiceTierRequests", () => {
	it("counts one premium request per realized priority on billing providers", () => {
		expect(getPremiumServiceTierRequests("priority", openai)).toBe(1);
		expect(getPremiumServiceTierRequests("priority", codex)).toBe(1);
		expect(getPremiumServiceTierRequests("priority", anthropic)).toBe(1);
		expect(getPremiumServiceTierRequests("priority", gemini)).toBe(1);
		expect(getPremiumServiceTierRequests("priority", vertexGemini)).toBe(1);
	});

	it("counts ultrafast on the OpenAI family only where the wire sends it", () => {
		expect(getPremiumServiceTierRequests("ultrafast", openai)).toBe(1);
		// Codex-backend models realize ultrafast only when discovery advertises it.
		expect(getPremiumServiceTierRequests("ultrafast", codex)).toBe(0);
		expect(getPremiumServiceTierRequests("ultrafast", { ...codex, serviceTiers: ["ultrafast"] })).toBe(1);
		// Relays, OpenRouter, and other families never bill it as a premium request.
		expect(getPremiumServiceTierRequests("ultrafast", customOpenAI)).toBe(0);
		expect(getPremiumServiceTierRequests("ultrafast", orOpenAI)).toBe(0);
		expect(getPremiumServiceTierRequests("ultrafast", gemini)).toBe(0);
	});

	it("trusts a served tier over the discovery gate", () => {
		// A recorded served tier is proof the tier reached the wire, so a
		// stats-backfill row without discovery metadata still counts.
		expect(getPremiumServiceTierRequests("ultrafast", codex, { served: true })).toBe(1);
		expect(getPremiumServiceTierRequests("ultrafast", customOpenAI, { served: true })).toBe(0);
		// The family gate still applies: a non-OpenAI provider never bills it.
		expect(getPremiumServiceTierRequests("ultrafast", gemini, { served: true })).toBe(0);
		// `served` does not invent premium weight for a standard tier.
		expect(getPremiumServiceTierRequests("default", openai, { served: true })).toBe(0);
		// Priority follows the same rule: a Codex model whose discovered list omits
		// it still counts when the response reported serving it.
		const unlisted = { ...codex, serviceTiers: ["ultrafast"] };
		expect(getPremiumServiceTierRequests("priority", unlisted)).toBe(0);
		expect(getPremiumServiceTierRequests("priority", unlisted, { served: true })).toBe(1);
		// The provider allowlist is not bypassed.
		expect(getPremiumServiceTierRequests("priority", { ...orOpenAI, serviceTiers: [] }, { served: true })).toBe(0);
	});

	it("does not bill OpenRouter, unrealized, or non-priority traffic", () => {
		expect(getPremiumServiceTierRequests("priority", orOpenAI)).toBe(0); // OpenRouter bills its own way
		expect(getPremiumServiceTierRequests("priority", vertexClaude)).toBe(0); // not realized
		expect(getPremiumServiceTierRequests("priority", fireworks)).toBe(0); // realized but not Copilot-premium
		expect(getPremiumServiceTierRequests("priority", fireworksOpenAI)).toBe(0); // dedicated provider tier
		expect(getPremiumServiceTierRequests("flex", openai)).toBe(0);
		expect(getPremiumServiceTierRequests(undefined, openai)).toBe(0);
	});
});

describe("coerceServiceTierByFamily", () => {
	it("migrates legacy scalar values to a per-family map", () => {
		expect(coerceServiceTierByFamily("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
		});
		expect(coerceServiceTierByFamily("openai-only")).toEqual({ openai: "priority" });
		expect(coerceServiceTierByFamily("claude-only")).toEqual({ anthropic: "priority" });
		expect(coerceServiceTierByFamily("flex")).toEqual({ openai: "flex" });
		expect(coerceServiceTierByFamily("none")).toBeUndefined();
		expect(coerceServiceTierByFamily(null)).toBeUndefined();
	});

	it("passes a per-family map through, dropping invalid entries", () => {
		expect(coerceServiceTierByFamily({ openai: "priority", google: "flex" })).toEqual({
			openai: "priority",
			google: "flex",
		});
		expect(coerceServiceTierByFamily({ openai: "bogus" })).toBeUndefined();
	});
});
