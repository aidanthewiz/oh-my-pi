import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isPromptCachePersistent } from "@oh-my-pi/pi-catalog/compat/prompt-cache-persistent";

const base = {
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 272_000,
	maxTokens: 128_000,
};

describe("prompt-cache-persistent", () => {
	test("qualifies only the catalog Codex endpoint for persistent idle-cache policy", () => {
		const codex = buildModel({
			...base,
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		});
		const proxied = { ...codex, baseUrl: "https://codex-proxy.example/backend-api" };
		const api = buildModel({
			...base,
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});

		expect(isPromptCachePersistent(codex)).toBe(true);
		expect(isPromptCachePersistent(proxied)).toBe(false);
		expect(isPromptCachePersistent(api)).toBe(false);
	});

	test.each([
		undefined,
		"",
		"not a URL",
		"http://chatgpt.com/backend-api",
		"https://chatgpt.com.evil.example/backend-api",
		"https://chatgpt.com@proxy.example/backend-api",
		"https://user:secret@chatgpt.com/backend-api",
		"https://chatgpt.com:8443/backend-api",
		"https://codex-proxy.example/backend-api",
	])("rejects an unqualified endpoint %s", baseUrl => {
		const codex = buildModel({
			...base,
			id: "gpt-5.5",
			name: "Codex endpoint fixture",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		});
		expect(isPromptCachePersistent({ ...codex, baseUrl: baseUrl as string })).toBe(false);
	});
});
