import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels, getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import { sambanovaModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, Model } from "@oh-my-pi/pi-catalog/types";

const BASE_URL = "https://api.sambanova.ai/v1";

function rosterFetch(data: unknown[], calls?: Array<{ url: string; authorization: string | null }>): FetchImpl {
	return async (input: string | URL | Request, init?: RequestInit) => {
		calls?.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
		return new Response(JSON.stringify({ object: "list", data }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
}

async function discover(data: unknown[]) {
	return (
		(await sambanovaModelManagerOptions({ apiKey: "test-key", fetch: rosterFetch(data) }).fetchDynamicModels?.()) ??
		[]
	);
}

function buildSambaNova(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "sambanova",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: null,
	});
}

describe("SambaNova discovery", () => {
	test("maps per-token prices and limits, and drops non-chat SKUs", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		const options = sambanovaModelManagerOptions({
			apiKey: "sambanova-test-key",
			fetch: rosterFetch(
				[
					{
						id: "DeepSeek-V3.1",
						context_length: 131072,
						max_completion_tokens: 7168,
						pricing: { prompt: "0.00000300", completion: "0.00000450" },
					},
					{
						id: "MiniMax-M3",
						context_length: 1048576,
						max_completion_tokens: 1048576,
						pricing: {
							prompt: "0.00000060",
							completion: "0.00000240",
							input_cache_read: "0.00000006",
							input_cache_write: "0.00000000",
						},
					},
					{ id: "E5-Mistral-7B-Instruct", pricing: { prompt: "0.0000001", completion: "0" } },
					{ id: "Whisper-large-v3", pricing: { prompt: "0.0000001", completion: "0" } },
				],
				calls,
			),
		});
		const models = (await options.fetchDynamicModels?.()) ?? [];

		expect(calls).toEqual([{ url: `${BASE_URL}/models`, authorization: "Bearer sambanova-test-key" }]);
		expect(models.map(model => model.id)).toEqual(["DeepSeek-V3.1", "MiniMax-M3"]);
		expect(models[0]).toMatchObject({
			contextWindow: 131072,
			maxTokens: 7168,
			cost: { input: 3, output: 4.5, cacheRead: 0, cacheWrite: 0 },
		});
		expect(models[1].cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0 });
		expect(getModelPricingStatus(models[0])).toBe("fixed");
	});

	test("an all-zero card is free; an unreadable card is unpriced", async () => {
		const models = await discover([
			{ id: "free", pricing: { prompt: "0", completion: "0" } },
			{ id: "bad-required", pricing: { prompt: "0.00000300", completion: "abc" } },
			{ id: "negative", pricing: { prompt: "-1", completion: "0.00000300" } },
			{ id: "bad-cache", pricing: { prompt: "0.00000022", completion: "0.00000059", input_cache_read: "abc" } },
			{ id: "missing" },
		]);
		const status = Object.fromEntries(models.map(model => [model.id, getModelPricingStatus(model)]));
		expect(status).toEqual({
			free: "free",
			"bad-required": "unknown",
			negative: "unknown",
			"bad-cache": "unknown",
			missing: "unknown",
		});
	});

	test("the seed shows without a key and the live roster replaces it", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-sambanova-"));
		try {
			// No staticModels: resolution falls back to the committed bundle, so
			// this fails if the generated catalog lacks the seed row.
			const withoutKey = await resolveProviderModels(
				{ ...sambanovaModelManagerOptions({}), cacheDbPath: path.join(tempDir, "keyless.db") },
				"online-if-uncached",
			);
			const seed = withoutKey.models.find(model => model.id === "gpt-oss-120b");
			expect(seed && getModelPricingStatus(seed)).toBe("fixed");

			const withLive = await resolveProviderModels(
				{
					...sambanovaModelManagerOptions({
						apiKey: "test-key",
						fetch: rosterFetch([
							{ id: "DeepSeek-V3.1", pricing: { prompt: "0.00000300", completion: "0.00000450" } },
						]),
					}),
					cacheDbPath: path.join(tempDir, "live.db"),
				},
				"online",
			);
			expect(withLive.models.map(model => model.id)).toEqual(["DeepSeek-V3.1"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("SambaNova cache isolation", () => {
	test.each([
		{
			label: "credentials",
			first: { apiKey: "synthetic-sambanova-key-a", baseUrl: BASE_URL },
			second: { apiKey: "synthetic-sambanova-key-b", baseUrl: BASE_URL },
		},
		{
			label: "discovery endpoints",
			first: { apiKey: "synthetic-sambanova-key-a", baseUrl: BASE_URL },
			second: {
				apiKey: "synthetic-sambanova-key-a",
				baseUrl: "https://sambanova-cache.invalid/tenant-b/v1",
			},
		},
	])("isolates authoritative rosters across $label and reuses each identity's cache", async ({ first, second }) => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-sambanova-scope-"));
		try {
			const cacheDbPath = path.join(tempDir, "models.db");
			const calls: Array<{ url: string; authorization: string | null }> = [];
			const now = () => 1_900_000_000_000;
			const firstOptions = {
				...sambanovaModelManagerOptions({
					...first,
					fetch: rosterFetch(
						[
							{
								id: "DeepSeek-V3.1",
								context_length: 65536,
								max_completion_tokens: 4096,
								pricing: { prompt: "0.000003", completion: "0.0000045" },
							},
						],
						calls,
					),
				}),
				cacheDbPath,
				now,
			};
			const secondOptions = {
				...sambanovaModelManagerOptions({
					...second,
					fetch: rosterFetch(
						[
							{
								id: "MiniMax-M3",
								context_length: 1048576,
								max_completion_tokens: 8192,
								pricing: { prompt: "0.0000006", completion: "0.0000024" },
							},
						],
						calls,
					),
				}),
				cacheDbPath,
				now,
			};
			const firstLive = await resolveProviderModels(firstOptions, "online-if-uncached");
			expect(firstLive.models.map(model => model.id)).toEqual(["DeepSeek-V3.1"]);
			expect(firstLive.models[0]).toMatchObject({
				provider: "sambanova",
				baseUrl: first.baseUrl,
				cost: { input: 3, output: 4.5, cacheRead: 0, cacheWrite: 0 },
			});
			const firstWarm = await resolveProviderModels(firstOptions, "online-if-uncached");
			expect(firstWarm.source).toBe("cache");
			expect(firstWarm.models).toEqual(firstLive.models);

			const secondLive = await resolveProviderModels(secondOptions, "online-if-uncached");
			expect(secondLive.models.map(model => model.id)).toEqual(["MiniMax-M3"]);
			expect(secondLive.models[0]).toMatchObject({
				provider: "sambanova",
				baseUrl: second.baseUrl,
				cost: { input: 0.6, output: 2.4, cacheRead: 0, cacheWrite: 0 },
			});
			const firstAgain = await resolveProviderModels(firstOptions, "online-if-uncached");
			expect(firstAgain.source).toBe("cache");
			expect(firstAgain.models).toEqual(firstLive.models);
			const secondOffline = await resolveProviderModels(secondOptions, "offline");
			expect(secondOffline.source).toBe("cache");
			expect(secondOffline.models).toEqual(secondLive.models);
			expect(calls).toEqual([
				{ url: `${first.baseUrl}/models`, authorization: `Bearer ${first.apiKey}` },
				{ url: `${second.baseUrl}/models`, authorization: `Bearer ${second.apiKey}` },
			]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("keyless resolution keeps the bundled seed after authenticated cache writes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-sambanova-keyless-"));
		try {
			const cacheDbPath = path.join(tempDir, "models.db");
			const calls: Array<{ url: string; authorization: string | null }> = [];
			const now = () => 1_900_000_000_000;
			const apiKey = "synthetic-sambanova-key-a";
			const baseUrls = [BASE_URL, "https://sambanova-cache.invalid/tenant-b/v1"];
			for (const baseUrl of baseUrls) {
				const authenticated = await resolveProviderModels(
					{
						...sambanovaModelManagerOptions({
							apiKey,
							baseUrl,
							fetch: rosterFetch(
								[{ id: "DeepSeek-V3.1", pricing: { prompt: "0.000003", completion: "0.0000045" } }],
								calls,
							),
						}),
						cacheDbPath,
						now,
					},
					"online",
				);
				expect(authenticated.models.map(model => model.id)).toEqual(["DeepSeek-V3.1"]);
			}
			for (const baseUrl of baseUrls) {
				for (const strategy of ["online-if-uncached", "online", "offline"] as const) {
					const keyless = await resolveProviderModels(
						{
							...sambanovaModelManagerOptions({ baseUrl, fetch: rosterFetch([], calls) }),
							cacheDbPath,
							now,
						},
						strategy,
					);
					expect(keyless.models.map(model => model.id)).toEqual(
						getBundledModels("sambanova").map(model => model.id),
					);
					const seed = keyless.models.find(model => model.id === "gpt-oss-120b");
					expect(seed?.provider).toBe("sambanova");
					expect(seed && getModelPricingStatus(seed)).toBe("fixed");
				}
			}
			expect(calls).toEqual(
				baseUrls.map(baseUrl => ({
					url: `${baseUrl}/models`,
					authorization: `Bearer ${apiKey}`,
				})),
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("SambaNova capability rules", () => {
	test("gpt-oss and MiniMax M3 take reasoning_effort; MiniMax M2 does not reason", () => {
		for (const id of ["gpt-oss-120b", "MiniMax-M3", "MiniMax-M3.1"]) {
			const model = buildSambaNova(id);
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High]);
			expect(model.compat?.thinkingFormat).toBe("openai");
		}
		expect(buildSambaNova("MiniMax-M2").reasoning).toBe(false);
	});

	test("DeepSeek V3.1+ and Gemma 4 toggle thinking through the chat template", () => {
		for (const id of [
			"DeepSeek-V3.1",
			"DeepSeek-V3.1-Terminus",
			"deepseek-v3.2",
			"gemma-4-31B-it",
			"Gemma-4-12B-it",
		]) {
			const model = buildSambaNova(id);
			expect(model.reasoning).toBe(true);
			expect(model.thinking?.efforts).toEqual([Effort.High]);
			expect(model.compat?.thinkingFormat).toBe("qwen-chat-template");
		}
	});

	test("only Gemma 4+ gains image input", () => {
		expect(buildSambaNova("gemma-4-31B-it").input).toEqual(["text", "image"]);
		const gemma3 = buildSambaNova("gemma-3-27b-it");
		expect(gemma3.input).toEqual(["text"]);
		expect(gemma3.reasoning).toBe(false);
		expect(buildSambaNova("Meta-Llama-3.3-70B-Instruct").reasoning).toBe(false);
	});
});
