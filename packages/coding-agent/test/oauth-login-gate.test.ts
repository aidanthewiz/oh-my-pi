import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { AuthStorage, getOAuthProviders, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import {
	assertOAuthLoginProviderAllowed,
	filterOAuthLoginProviders,
	isOAuthLoginProviderAllowed,
} from "../src/config/oauth-login-gate";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { runTerminalOAuthLogin } from "../src/cli/oauth-terminal";
import { cfgDisabledProviders, cfgEnabledModels } from "../src/config/model-settings";
import { asGlobalFetch } from "./helpers/fetch-mock";

function provider(id: string, storeCredentialsAs?: string): OAuthProviderInfo {
	return { id, name: id, available: true, storeCredentialsAs };
}

const PROVIDERS: OAuthProviderInfo[] = [
	provider("anthropic"),
	provider("openai-codex"),
	provider("openai-codex-device", "openai-codex"),
	provider("openrouter"),
	provider("deepinfra"),
	provider("perplexity"), // no bundled catalog models: search key
	provider("tavily"), // no bundled catalog models: search key
	provider("yolo-auto"),
];

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("filterOAuthLoginProviders", () => {
	it("drops model providers outside the enabledModels allowlist, keeps non-model providers", () => {
		const settings = Settings.isolated({ enabledModels: ["anthropic-aws/*", "bedrock-mantle/openai.gpt-5.6-sol"] });
		const ids = filterOAuthLoginProviders(PROVIDERS, settings).map(p => p.id);
		expect(ids).toEqual(["perplexity", "tavily"]);
	});

	it("keeps a model provider whose prefix is allowlisted, including credential aliases", () => {
		const settings = Settings.isolated({ enabledModels: ["anthropic/*", "openai-codex/gpt-5.2"] });
		const ids = filterOAuthLoginProviders(PROVIDERS, settings).map(p => p.id);
		expect(ids).toEqual(["anthropic", "openai-codex", "openai-codex-device", "perplexity", "tavily"]);
	});

	it("passes everything through when enabledModels is empty", () => {
		const settings = Settings.isolated({ enabledModels: [] });
		expect(filterOAuthLoginProviders(PROVIDERS, settings)).toEqual(PROVIDERS);
	});

	it("turns itself off when a pattern has no provider prefix", () => {
		const settings = Settings.isolated({ enabledModels: ["anthropic-aws/*", "gpt-5.6-sol"] });
		expect(filterOAuthLoginProviders(PROVIDERS, settings)).toEqual(PROVIDERS);
	});

	it("does not borrow an ambient managed policy for an unmanaged SDK host", async () => {
		await Settings.init({
			inMemory: true,
			overrides: { enabledModels: ["anthropic/*"], disabledProviders: ["openai-codex"] },
		});
		expect(filterOAuthLoginProviders(PROVIDERS)).toEqual(PROVIDERS);
	});

	it("applies explicit provider denial before bare patterns, aliases, and non-model exemptions", () => {
		const settings = Settings.isolated({
			enabledModels: ["gpt-5.6-sol"],
			disabledProviders: ["openai-codex", "tavily"],
		});
		expect(filterOAuthLoginProviders(PROVIDERS, settings).map(p => p.id)).toEqual([
			"anthropic",
			"openrouter",
			"deepinfra",
			"perplexity",
			"yolo-auto",
		]);
		expect(() =>
			assertOAuthLoginProviderAllowed(provider("openai-codex-device", "openai-codex"), settings),
		).toThrow();
		const aliasDenied = Settings.isolated({ disabledProviders: ["openai-codex-device"] });
		expect(isOAuthLoginProviderAllowed(provider("openai-codex-device", "openai-codex"), aliasDenied)).toBe(false);
		expect(isOAuthLoginProviderAllowed(provider("openai-codex"), aliasDenied)).toBe(true);
	});

	it("uses the consuming policy independently of another active Settings instance", async () => {
		await Settings.init({ inMemory: true, overrides: { disabledProviders: ["anthropic"] } });
		const allowed = Settings.isolated({ enabledModels: ["anthropic/*"] });
		const denied = Settings.isolated({ enabledModels: ["openai-codex/*"] });
		expect(isOAuthLoginProviderAllowed(provider("anthropic"), allowed)).toBe(true);
		expect(isOAuthLoginProviderAllowed(provider("anthropic"), denied)).toBe(false);
		expect(isOAuthLoginProviderAllowed(provider("tavily"), denied)).toBe(true);
	});
});

async function terminalLogin(settings: Settings) {
	const info = getOAuthProviders().find(entry => entry.id === "inception");
	if (!info) throw new Error("expected Inception login provider");
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	const input = new PassThrough();
	const output = new PassThrough();
	const rl = createInterface({ input, output, terminal: false });
	const prompted = Promise.withResolvers<void>();
	const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
	let prompts = 0;
	output.on("data", () => {
		prompts++;
		prompted.resolve();
	});
	const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (url, init) => {
			requests.push({ url: String(url), init });
			return Response.json({});
		}),
	);
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	return {
		input,
		storage,
		requests,
		stdout,
		prompted: prompted.promise,
		prompts: () => prompts,
		start: () =>
			runTerminalOAuthLogin(rl, storage, info.id, {
				assertLoginAllowed: () => assertOAuthLoginProviderAllowed(info, settings),
			}),
		async close() {
			rl.close();
			input.destroy();
			output.destroy();
			if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			await storage.close();
		},
	};
}

describe("paid login admission", () => {
	it("denies a disabled provider before auth UI, credential entry, or validation dispatch", async () => {
		const harness = await terminalLogin(Settings.isolated({ disabledProviders: ["inception"] }));
		try {
			await expect(harness.start()).rejects.toThrow();
			expect(harness.prompts()).toBe(0);
			expect(harness.stdout).not.toHaveBeenCalled();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("inception")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("rechecks a narrowed allowlist after credential entry without validating or storing the key", async () => {
		const settings = Settings.isolated({ enabledModels: ["inception/*"] });
		const harness = await terminalLogin(settings);
		try {
			const pending = harness.start();
			await harness.prompted;
			cfgEnabledModels.override(settings, ["anthropic/*"]);
			harness.input.write("synthetic-inception-key\n");
			await expect(pending).rejects.toThrow();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("inception")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("rechecks an explicit deny added while a bare-pattern login prompt waits", async () => {
		const settings = Settings.isolated({ enabledModels: ["mercury-3"] });
		const harness = await terminalLogin(settings);
		try {
			const pending = harness.start();
			await harness.prompted;
			cfgDisabledProviders.override(settings, ["inception"]);
			harness.input.write("synthetic-inception-key\n");
			await expect(pending).rejects.toThrow();
			expect(harness.requests).toEqual([]);
			expect(harness.storage.credentials.list("inception")).toEqual([]);
		} finally {
			await harness.close();
		}
	});

	it("validates an admitted explicit key once before storing it", async () => {
		const harness = await terminalLogin(Settings.isolated({ enabledModels: ["inception/*"] }));
		try {
			const pending = harness.start();
			await harness.prompted;
			harness.input.write("synthetic-inception-key\n");
			await pending;
			expect(harness.requests).toHaveLength(1);
			const request = harness.requests[0];
			expect(request.url).toBe("https://api.inceptionlabs.ai/v1/chat/completions");
			expect(new Headers(request.init?.headers).get("Authorization")).toBe(
				["Bearer", "synthetic-inception-key"].join(" "),
			);
			expect(JSON.parse(String(request.init?.body))).toMatchObject({
				model: "mercury-3",
				max_completion_tokens: 1,
			});
			expect(harness.storage.credentials.list("inception")).toMatchObject([
				{ credential: { type: "api_key", key: "synthetic-inception-key" } },
			]);
		} finally {
			await harness.close();
		}
	});
});
