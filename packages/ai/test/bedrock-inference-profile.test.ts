import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";
const profileModel: Model<"bedrock-converse-stream"> = buildModel({
	id: profileArn,
	name: "Bedrock inference profile",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
	contextWindow: 1000000,
	maxTokens: 128000,
	thinking: {
		mode: "anthropic-adaptive",
		efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		supportsDisplay: true,
	},
});
const nova2LiteModel: Model<"bedrock-converse-stream"> = buildModel({
	id: "global.amazon.nova-2-lite-v1:0",
	name: "Nova 2 Lite",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0.33, output: 2.75, cacheRead: 0.0825, cacheWrite: 0.33 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
	thinking: {
		mode: "effort",
		efforts: [Effort.Low, Effort.Medium, Effort.High],
	},
});

interface CapturedBedrockPayload {
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	additionalModelRequestFields?: {
		reasoningConfig?: { type?: string; maxReasoningEffort?: string };
		thinking?: unknown;
	};
}

function userContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
	};
}
async function captureNova2Payload(reasoning: Effort): Promise<CapturedBedrockPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<CapturedBedrockPayload>();
	void streamBedrock(nova2LiteModel, userContext(), {
		bearerToken: "test-token",
		signal: controller.signal,
		reasoning,
		maxTokens: 16,
		temperature: 0.7,
		topP: 0.9,
		onPayload: payload => {
			resolve(payload as CapturedBedrockPayload);
		},
	});
	return promise;
}

describe("Nova 2 Lite reasoning", () => {
	test("uses the native Nova reasoningConfig at medium effort", async () => {
		const payload = await captureNova2Payload(Effort.Medium);
		expect(payload.additionalModelRequestFields).toEqual({
			reasoningConfig: {
				type: "enabled",
				maxReasoningEffort: "medium",
			},
		});
		expect(payload.inferenceConfig).toEqual({
			maxTokens: 16,
			temperature: 0.7,
			topP: 0.9,
		});
	});

	test("omits unsupported sampling controls at high effort", async () => {
		const payload = await captureNova2Payload(Effort.High);
		expect(payload.additionalModelRequestFields?.reasoningConfig?.maxReasoningEffort).toBe("high");
		expect(payload.inferenceConfig?.temperature).toBeUndefined();
		expect(payload.inferenceConfig?.topP).toBeUndefined();
	});
});

describe("Bedrock inference profile ARNs", () => {
	test("honors an explicit bearer token during managed model authentication", async () => {
		await withEnv(
			{
				OMP_MODEL_AWS_AUTH_MODE: "managed",
				OMP_MODEL_AWS_PROFILE: "missing-test-profile",
				AWS_BEARER_TOKEN_BEDROCK: "ambient-token",
			},
			async () => {
				const calls: string[] = [];
				const authorizations: Array<string | null> = [];
				const customFetch: FetchImpl = Object.assign(
					async (input: string | URL | Request, init?: RequestInit) => {
						const request = input instanceof Request ? input : new Request(String(input), init);
						calls.push(request.url);
						authorizations.push(request.headers.get("authorization"));
						return new Response("nope", { status: 418 });
					},
					{ preconnect: fetch.preconnect },
				);

				const result = await streamBedrock(profileModel, userContext(), {
					bearerToken: "test-token",
					fetch: customFetch,
					maxTokens: 16,
				}).result();

				expect(result.stopReason).toBe("error");
				expect(authorizations).toEqual(["Bearer test-token"]);
				expect(calls).toEqual([
					`https://bedrock-runtime.us-east-2.amazonaws.com/model/${encodeURIComponent(profileArn)}/converse-stream`,
				]);
			},
		);
	});

	test("replays captured thinking signatures for ARN profiles", async () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Plan the change", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Inspect the implementation", thinkingSignature: "signed-reasoning" },
						{ type: "text", text: "I found the relevant code." },
					],
					api: "bedrock-converse-stream",
					provider: "amazon-bedrock",
					model: profileArn,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<unknown>();

		void streamBedrock(profileModel, context, {
			bearerToken: "test-token",
			signal: controller.signal,
			reasoning: Effort.High,
			maxTokens: 16,
			onPayload: payload => {
				resolve(payload);
			},
		});

		expect(await promise).toMatchObject({
			additionalModelRequestFields: {
				thinking: { type: "adaptive", display: "summarized" },
				output_config: { effort: "high" },
			},
			messages: [
				{ role: "user", content: [{ text: "Plan the change" }] },
				{
					role: "assistant",
					content: [
						{
							reasoningContent: {
								reasoningText: {
									text: "Inspect the implementation",
									signature: "signed-reasoning",
								},
							},
						},
						{ text: "I found the relevant code." },
					],
				},
				{ role: "user", content: [{ text: "Continue" }] },
			],
		});
	});
});

function bedrockModel(id: string): Model<"bedrock-converse-stream"> {
	return buildModel({
		id,
		name: id,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
	});
}

async function capturedRequestHost(
	model: Model<"bedrock-converse-stream">,
	options: { region?: string; profile?: string } = {},
): Promise<string> {
	let host: string | undefined;
	await withEnv(
		{
			OMP_MODEL_AWS_AUTH_MODE: undefined,
			OMP_MODEL_AWS_PROFILE: undefined,
			OMP_MODEL_AWS_REGION: undefined,
		},
		async () => {
			const calls: string[] = [];
			const customFetch: FetchImpl = Object.assign(
				async (input: string | URL | Request, _init?: RequestInit) => {
					calls.push(String(input instanceof Request ? input.url : input));
					return new Response("nope", { status: 418 });
				},
				{ preconnect: fetch.preconnect },
			);
			const result = await streamBedrock(model, userContext(), {
				bearerToken: "test-token",
				fetch: customFetch,
				maxTokens: 16,
				...options,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(calls).toHaveLength(1);
			host = new URL(calls[0]).host;
		},
	);
	if (!host) throw new Error("Bedrock request was not captured");
	return host;
}

describe("Bedrock cross-region inference-profile geo routing", () => {
	// A `us-east-1` ambient region exercises the mismatch-correction path: a non-`us`
	// geo profile must be rerouted off the ambient `us` region, not pass through it.
	const US_AMBIENT = { AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: undefined } as const;

	// Repro: an `eu.` profile defaulted to us-east-1 → HTTP 400 "The provided model identifier is invalid."
	test("routes an eu. profile to an EU region instead of us-east-1", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-fable-5"))).toBe(
				"bedrock-runtime.eu-west-1.amazonaws.com",
			);
		});
	});

	test("routes an au. profile to the Australia region", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("au.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.ap-southeast-2.amazonaws.com",
			);
		});
	});

	test("routes a jp. profile to a Japan region", async () => {
		await withEnv(US_AMBIENT, async () => {
			expect(await capturedRequestHost(bedrockModel("jp.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.ap-northeast-1.amazonaws.com",
			);
		});
	});

	test("falls back to us-east-1 for a geo profile when no ambient region is set", async () => {
		await withEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("us.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.us-east-1.amazonaws.com",
			);
		});
	});

	test("leaves region-agnostic global. profiles on the ambient region", async () => {
		await withEnv({ AWS_REGION: undefined, AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("global.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.us-east-1.amazonaws.com",
			);
		});
	});

	test("honors a same-geo ambient region for a geo-prefixed profile", async () => {
		await withEnv({ AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-opus-4-8"))).toBe(
				"bedrock-runtime.eu-central-1.amazonaws.com",
			);
		});
	});

	test("uses the selected profile region when environment regions are absent", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-profile-region-"));
		try {
			const configPath = path.join(tmp, "config");
			await Bun.write(configPath, "[profile regional]\nregion = eu-west-2\n");
			await withEnv(
				{
					AWS_REGION: undefined,
					AWS_DEFAULT_REGION: undefined,
					AWS_PROFILE: "regional",
					AWS_CONFIG_FILE: configPath,
				},
				async () => {
					expect(
						await capturedRequestHost(bedrockModel("eu.anthropic.claude-opus-4-8"), {
							profile: "regional",
						}),
					).toBe("bedrock-runtime.eu-west-2.amazonaws.com");
				},
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("explicit per-request region wins over the geo prefix and ambient region", async () => {
		await withEnv({ AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: undefined }, async () => {
			expect(await capturedRequestHost(bedrockModel("eu.anthropic.claude-opus-4-8"), { region: "eu-west-3" })).toBe(
				"bedrock-runtime.eu-west-3.amazonaws.com",
			);
		});
	});

	test("rejects a malformed explicit region before attaching credentials", async () => {
		await withEnv(
			{
				OMP_MODEL_AWS_AUTH_MODE: undefined,
				OMP_MODEL_AWS_PROFILE: undefined,
				OMP_MODEL_AWS_REGION: undefined,
			},
			async () => {
				let fetchCalls = 0;
				const result = await streamBedrock(bedrockModel("global.anthropic.claude-opus-4-8"), userContext(), {
					region: "bedrock.attacker.example#",
					bearerToken: "secret-token",
					maxTokens: 16,
					fetch: async () => {
						fetchCalls++;
						return new Response("unexpected");
					},
				}).result();
				expect(result.stopReason).toBe("error");
				expect(result.errorMessage).toContain("Invalid AWS model region");
				expect(fetchCalls).toBe(0);
			},
		);
	});
});

describe("Bedrock error handling", () => {
	const circular: Record<string, unknown> = {};
	circular.self = circular;

	test.each([
		["undefined", undefined],
		["BigInt", 1n],
		["circular object", circular],
	])("surfaces a stream error when %s is thrown", async (_name, thrown) => {
		const result = await streamBedrock(profileModel, userContext(), {
			bearerToken: "test-token",
			maxTokens: 16,
			onPayload: () => {
				throw thrown;
			},
		}).result();

		expect(result.stopReason).toBe("error");
	});
});
