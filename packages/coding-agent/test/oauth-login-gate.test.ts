import { afterEach, describe, expect, it } from "bun:test";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import { filterOAuthLoginProviders } from "../src/config/oauth-login-gate";
import { resetSettingsForTest, Settings } from "../src/config/settings";

function provider(id: string, storeCredentialsAs?: string): OAuthProviderInfo {
	return { id, name: id, available: true, storeCredentialsAs };
}

const PROVIDERS: OAuthProviderInfo[] = [
	provider("anthropic"),
	provider("openai-codex"),
	provider("openai-codex-device", "openai-codex"),
	provider("openrouter"),
	provider("perplexity"), // no bundled catalog models: search key
	provider("tavily"), // no bundled catalog models: search key
];

async function initSettings(enabledModels: string[]): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { enabledModels } });
}

afterEach(() => {
	resetSettingsForTest();
});

describe("filterOAuthLoginProviders", () => {
	it("drops model providers outside the enabledModels allowlist, keeps non-model providers", async () => {
		await initSettings(["anthropic-aws/*", "openai-aws/openai.gpt-5.6-sol"]);
		const ids = filterOAuthLoginProviders(PROVIDERS).map(p => p.id);
		expect(ids).toEqual(["perplexity", "tavily"]);
	});

	it("keeps a model provider whose prefix is allowlisted, including credential aliases", async () => {
		await initSettings(["anthropic/*", "openai-codex/gpt-5.2"]);
		const ids = filterOAuthLoginProviders(PROVIDERS).map(p => p.id);
		expect(ids).toEqual(["anthropic", "openai-codex", "openai-codex-device", "perplexity", "tavily"]);
	});

	it("passes everything through when enabledModels is empty", async () => {
		await initSettings([]);
		expect(filterOAuthLoginProviders(PROVIDERS)).toEqual(PROVIDERS);
	});

	it("turns itself off when a pattern has no provider prefix", async () => {
		await initSettings(["anthropic-aws/*", "gpt-5.6-sol"]);
		expect(filterOAuthLoginProviders(PROVIDERS)).toEqual(PROVIDERS);
	});

	it("passes everything through before Settings.init()", () => {
		resetSettingsForTest();
		expect(filterOAuthLoginProviders(PROVIDERS)).toEqual(PROVIDERS);
	});
});
