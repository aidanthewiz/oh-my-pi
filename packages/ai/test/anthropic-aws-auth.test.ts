import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { buildAnthropicClientOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { regionFromAnthropicAwsBaseUrl } from "@oh-my-pi/pi-ai/providers/anthropic-http-options";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withEnv } from "./helpers";

// Claude Platform on AWS: Anthropic's first-party Messages API on the
// `aws-external-anthropic.{region}.api.aws` gateway. Auth is either an API key
// sent as a Bearer token (`Authorization: Bearer <key>`, authorized by the
// `aws-external-anthropic:CallWithBearerToken` IAM action) or AWS SigV4; every
// request also needs the `anthropic-workspace-id` header and a region-scoped base
// URL. These tests pin the transport contract for both auth paths against the
// observable request, not implementation details.

const AWS_ENV_KEYS = [
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_AWS_API_KEY",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"ANTHROPIC_AWS_INFERENCE_GEO",
	"OMP_MODEL_AWS_AUTH_MODE",
	"OMP_MODEL_AWS_PROFILE",
	"OMP_MODEL_AWS_REGION",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of AWS_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_testworkspace01";
	process.env.ANTHROPIC_AWS_API_KEY = "sk-aws-external-test";
	clearAwsCredentialCache();
});

afterEach(() => {
	for (const key of AWS_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	clearAwsCredentialCache();
	vi.restoreAllMocks();
});

function makeAwsClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic-aws",
		baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeAwsModelWithId(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic-aws",
		baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function headerCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

function getRequestHeader(
	input: string | URL | Request,
	init: RequestInit | undefined,
	headerName: string,
): string | null {
	if (input instanceof Request) return input.headers.get(headerName);
	return new Headers(init?.headers).get(headerName);
}

describe("regionFromAnthropicAwsBaseUrl", () => {
	it("extracts the region segment from a gateway URL", () => {
		expect(regionFromAnthropicAwsBaseUrl("https://aws-external-anthropic.ap-southeast-2.api.aws")).toBe(
			"ap-southeast-2",
		);
		expect(regionFromAnthropicAwsBaseUrl("https://aws-external-anthropic.us-gov-west-1.api.aws")).toBe(
			"us-gov-west-1",
		);
	});
	it("returns undefined for non-gateway URLs", () => {
		expect(regionFromAnthropicAwsBaseUrl("https://api.anthropic.com")).toBeUndefined();
		expect(regionFromAnthropicAwsBaseUrl(undefined)).toBeUndefined();
	});
});

describe("Claude Platform on AWS auth config", () => {
	it("sends the API key as a Bearer token (not x-api-key) and injects the workspace header on the API-key path", () => {
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "sk-aws-external-test",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});

		// The gateway authenticates API keys as bearer tokens
		// (`aws-external-anthropic:CallWithBearerToken`), never via the first-party
		// `x-api-key` scheme.
		expect(headerCaseInsensitive(options.defaultHeaders, "authorization")).toBe("Bearer sk-aws-external-test");
		expect(headerCaseInsensitive(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_testworkspace01");
		expect(headerCaseInsensitive(options.defaultHeaders, "x-api-key")).toBeUndefined();
		// The Bearer credential lives in defaultHeaders, so the client must not also
		// attach an X-Api-Key from the apiKey option.
		expect(options.apiKey).toBeNull();
		expect(options.isOAuthToken).toBe(false);
	});

	it("ignores a broker-supplied key when the AWS workspace owns the bearer", () => {
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "broker-oauth-should-not-leave",
		});
		expect(headerCaseInsensitive(options.defaultHeaders, "authorization")).toBe(
			`Bearer ${process.env.ANTHROPIC_AWS_API_KEY}`,
		);

		delete process.env.ANTHROPIC_AWS_API_KEY;
		process.env.OMP_MODEL_AWS_AUTH_MODE = "managed";
		expect(() =>
			buildAnthropicClientOptions({ model: makeAwsClaudeModel(), apiKey: "broker-oauth-should-not-leave" }),
		).toThrow("requires a matching API key or AWS credential chain");
	});

	it("rewrites the endpoint region from AWS_REGION / AWS_DEFAULT_REGION", () => {
		process.env.AWS_REGION = "eu-west-1";
		expect(
			buildAnthropicClientOptions({ model: makeAwsClaudeModel(), apiKey: "sk", extraBetas: [], stream: true })
				.baseURL,
		).toBe("https://aws-external-anthropic.eu-west-1.api.aws");

		delete process.env.AWS_REGION;
		process.env.AWS_DEFAULT_REGION = "ap-southeast-2";
		expect(
			buildAnthropicClientOptions({ model: makeAwsClaudeModel(), apiKey: "sk", extraBetas: [], stream: true })
				.baseURL,
		).toBe("https://aws-external-anthropic.ap-southeast-2.api.aws");
	});

	it("carries no API key or Bearer credential on the SigV4 path (signature is the sole auth)", () => {
		delete process.env.ANTHROPIC_AWS_API_KEY;
		process.env.AWS_PROFILE = "unit-test-sigv4";
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "<authenticated>",
			extraBetas: [],
			stream: true,
		});

		expect(options.apiKey).toBeNull();
		expect(options.authToken ?? null).toBeNull();
		expect(headerCaseInsensitive(options.defaultHeaders, "authorization")).toBeUndefined();
		expect(headerCaseInsensitive(options.defaultHeaders, "x-api-key")).toBeUndefined();
		expect(headerCaseInsensitive(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_testworkspace01");
	});

	it("keeps stock AWS credential and endpoint ownership when direct-provider metadata is disabled", async () => {
		await withEnv(
			{
				ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
				ANTHROPIC_AWS_API_KEY: "synthetic-stock-aws-bearer",
				ANTHROPIC_AWS_WORKSPACE_ID: "synthetic-stock-workspace",
				ANTHROPIC_API_KEY: "synthetic-direct-key-must-not-send",
				ANTHROPIC_OAUTH_TOKEN: undefined,
				ANTHROPIC_CUSTOM_HEADERS: undefined,
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				FOUNDRY_BASE_URL: undefined,
			},
			async () => {
				const model = buildModel({
					...makeAwsClaudeModel(),
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					compat: { firstPartyProvider: false },
				});
				const storage = new AuthStorage(await SqliteAuthCredentialStore.open(":memory:"));
				try {
					await storage.credentials.set("anthropic", [
						{
							type: "oauth",
							access: "synthetic-stored-oauth-must-not-send",
							refresh: "synthetic-stored-refresh",
							expires: Date.now() + 3_600_000,
						},
					]);
					storage.keys.setConfig("anthropic", "synthetic-config-key-must-not-send");
					storage.keys.setRuntime("anthropic", "synthetic-runtime-key-must-not-send");
					const apiKey = await storage.keys.get("anthropic", undefined, {
						baseUrl: model.baseUrl,
						modelId: model.id,
					});
					expect(apiKey).toBe("synthetic-stock-aws-bearer");
					const requests: Array<{ url: string; headers: Headers }> = [];
					const captureFetch = async (
						input: Parameters<typeof fetch>[0],
						init?: Parameters<typeof fetch>[1],
					): Promise<Response> => {
						requests.push({
							url: input instanceof Request ? input.url : String(input),
							headers: new Headers(input instanceof Request ? input.headers : init?.headers),
						});
						const frames = [
							{
								type: "message_start",
								message: {
									id: "synthetic-stock-aws-message",
									type: "message",
									role: "assistant",
									model: model.id,
									content: [],
									stop_reason: null,
									stop_sequence: null,
									usage: { input_tokens: 1, output_tokens: 0 },
								},
							},
							{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: "routed through AWS" },
							},
							{ type: "content_block_stop", index: 0 },
							{
								type: "message_delta",
								delta: { stop_reason: "end_turn", stop_sequence: null },
								usage: { output_tokens: 3 },
							},
							{ type: "message_stop" },
						];
						return new Response(
							frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
							{ headers: { "content-type": "text/event-stream" } },
						);
					};
					vi.spyOn(globalThis, "fetch").mockImplementation(
						Object.assign(captureFetch, {
							preconnect: () => {
								throw new Error("Synthetic inference must not open a prewarm connection");
							},
						}),
					);
					const result = await streamSimple(model, testContext, { apiKey, fetch: globalThis.fetch }).result();
					expect(result.stopReason).toBe("stop");
					expect(result.content).toEqual([{ type: "text", text: "routed through AWS" }]);
					expect(requests.map(request => request.url)).toEqual([
						"https://aws-external-anthropic.us-east-1.api.aws/v1/messages",
					]);
					expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-stock-aws-bearer");
					expect(requests[0]?.headers.get("anthropic-workspace-id")).toBe("synthetic-stock-workspace");
					expect(requests[0]?.headers.get("x-api-key")).toBeNull();
				} finally {
					await storage.close();
				}
			},
		);
	});

	it("SigV4-signs the request with service aws-external-anthropic and signs the workspace header", async () => {
		delete process.env.ANTHROPIC_AWS_API_KEY;
		process.env.AWS_REGION = "us-west-2";
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

		const captured: Record<string, string | null> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			captured.authorization = getRequestHeader(input, init, "Authorization");
			captured.amzDate = getRequestHeader(input, init, "x-amz-date");
			captured.contentSha = getRequestHeader(input, init, "x-amz-content-sha256");
			captured.workspace = getRequestHeader(input, init, "anthropic-workspace-id");
			captured.apiKeyHeader = getRequestHeader(input, init, "x-api-key");
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await streamAnthropic(makeAwsClaudeModel(), testContext, {
			apiKey: "<authenticated>",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(captured.authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
		expect(captured.authorization).toContain("/us-west-2/aws-external-anthropic/aws4_request");
		// The workspace header identifies the request target and must be signed.
		expect(captured.authorization).toContain("anthropic-workspace-id");
		expect(captured.amzDate).toMatch(/^\d{8}T\d{6}Z$/);
		expect(captured.contentSha).toMatch(/^[0-9a-f]{64}$/);
		expect(captured.workspace).toBe("wrkspc_testworkspace01");
		expect(captured.apiKeyHeader).toBeNull();
	});

	it("invalidates the active named-profile credentials after an authorization failure", async () => {
		delete process.env.ANTHROPIC_AWS_API_KEY;
		process.env.AWS_PROFILE = "coreforge-managed";
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
		const authorizations: string[] = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization");
			if (authorization) authorizations.push(authorization);
			// Simulate an ambient profile change while the request is in flight.
			// Invalidation must still target the profile captured for signing.
			process.env.AWS_PROFILE = "other-profile";
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		await streamAnthropic(makeAwsClaudeModel(), testContext, {
			apiKey: "<authenticated>",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();
		process.env.AWS_PROFILE = "coreforge-managed";
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7ROTATED";
		process.env.AWS_SECRET_ACCESS_KEY = "rotatedSecretAccessKeyForCacheRefreshTest";
		await streamAnthropic(makeAwsClaudeModel(), testContext, {
			apiKey: "<authenticated>",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(authorizations).toHaveLength(2);
		expect(authorizations[0]).toContain("Credential=AKIAIOSFODNN7EXAMPLE/");
		expect(authorizations[1]).toContain("Credential=AKIAIOSFODNN7ROTATED/");
	});
});

describe("Claude Platform on AWS inference_geo", () => {
	async function capturePostBody(model: Model<"anthropic-messages">): Promise<Record<string, unknown> | undefined> {
		const bodies: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ error: { type: "authentication_error", message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});
		await streamAnthropic(model, testContext, {
			apiKey: "sk-aws-external-test",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();
		return bodies[0];
	}

	it("pins inference_geo on models that support it (Sonnet 5 / Opus 4.6+) when the env var is set", async () => {
		process.env.ANTHROPIC_AWS_INFERENCE_GEO = "us";
		expect((await capturePostBody(makeAwsModelWithId("claude-sonnet-5")))?.inference_geo).toBe("us");
		expect((await capturePostBody(makeAwsModelWithId("claude-opus-4-6")))?.inference_geo).toBe("us");
	});

	it("omits inference_geo on models that reject it (Opus 4.5 / Sonnet 4.5 / Haiku 4.5)", async () => {
		process.env.ANTHROPIC_AWS_INFERENCE_GEO = "global";
		expect((await capturePostBody(makeAwsModelWithId("claude-opus-4-5")))?.inference_geo).toBeUndefined();
		expect((await capturePostBody(makeAwsModelWithId("claude-haiku-4-5")))?.inference_geo).toBeUndefined();
	});

	it("omits inference_geo when the env var is unset or invalid", async () => {
		expect((await capturePostBody(makeAwsModelWithId("claude-sonnet-5")))?.inference_geo).toBeUndefined();
		process.env.ANTHROPIC_AWS_INFERENCE_GEO = "antarctica";
		expect((await capturePostBody(makeAwsModelWithId("claude-sonnet-5")))?.inference_geo).toBeUndefined();
	});
});
