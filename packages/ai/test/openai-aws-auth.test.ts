import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { wrapFetchForOpenAIAwsSigV4 } from "@oh-my-pi/pi-ai/providers/openai-aws";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { openaiAwsProvider } from "@oh-my-pi/pi-ai/registry/openai-aws";
import {
	openaiBaseUrlIsAwsMantle,
	regionFromOpenAIAwsBaseUrl,
	resolveOpenAIAwsBaseUrl,
} from "@oh-my-pi/pi-ai/registry/openai-aws-env";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// OpenAI on AWS: OpenAI models on Amazon Bedrock via the
// `bedrock-mantle.{region}.api.aws` OpenAI-compatible Responses endpoint. Auth
// is either an Amazon Bedrock API key sent as a Bearer token (IAM action
// `bedrock-mantle:CallWithBearerToken`) or AWS SigV4 request signing (service
// `bedrock-mantle`) via the standard credential chain. These tests pin the
// transport contract for both auth paths against the observable request.

const AWS_ENV_KEYS = [
	"OPENAI_AWS_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"OPENAI_API_KEY",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_PROFILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of AWS_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of AWS_ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	vi.restoreAllMocks();
});

function makeAwsGptModel(): Model<"openai-responses"> {
	return buildModel({
		id: "openai.gpt-5.6-terra",
		name: "GPT-5.6 Terra",
		api: "openai-responses",
		provider: "openai-aws",
		baseUrl: "https://bedrock-mantle.us-east-1.api.aws/openai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
		contextWindow: 272_000,
		maxTokens: 128_000,
	});
}

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function getRequestHeader(
	input: string | URL | Request,
	init: RequestInit | undefined,
	headerName: string,
): string | null {
	// fetch semantics: init headers override Request-object headers.
	const fromInit = init?.headers ? new Headers(init.headers).get(headerName) : null;
	if (fromInit !== null) return fromInit;
	return input instanceof Request ? input.headers.get(headerName) : null;
}

function requestUrl(input: string | URL | Request): string {
	return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("openai-aws env helpers", () => {
	it("extracts the region segment from a Mantle URL", () => {
		expect(regionFromOpenAIAwsBaseUrl("https://bedrock-mantle.us-east-2.api.aws/openai/v1")).toBe("us-east-2");
		expect(regionFromOpenAIAwsBaseUrl("https://bedrock-mantle.us-gov-west-1.api.aws/v1")).toBe("us-gov-west-1");
		expect(regionFromOpenAIAwsBaseUrl("https://api.openai.com/v1")).toBeUndefined();
	});

	it("matches the Mantle host on the full hostname only", () => {
		expect(openaiBaseUrlIsAwsMantle("https://bedrock-mantle.us-east-1.api.aws/openai/v1")).toBe(true);
		expect(openaiBaseUrlIsAwsMantle("https://bedrock-mantle.us-east-1.api.aws.evil.com/v1")).toBe(false);
		expect(openaiBaseUrlIsAwsMantle("https://api.openai.com/v1")).toBe(false);
	});

	it("rewrites the endpoint region from AWS_REGION / AWS_DEFAULT_REGION and keeps the path", () => {
		process.env.AWS_REGION = "eu-west-1";
		expect(resolveOpenAIAwsBaseUrl("https://bedrock-mantle.us-east-1.api.aws/openai/v1")).toBe(
			"https://bedrock-mantle.eu-west-1.api.aws/openai/v1",
		);
		delete process.env.AWS_REGION;
		process.env.AWS_DEFAULT_REGION = "us-gov-west-1";
		expect(resolveOpenAIAwsBaseUrl("https://bedrock-mantle.us-east-1.api.aws/v1")).toBe(
			"https://bedrock-mantle.us-gov-west-1.api.aws/v1",
		);
	});

	it("falls back to the catalog region, then us-east-1", () => {
		expect(resolveOpenAIAwsBaseUrl("https://bedrock-mantle.us-east-2.api.aws/openai/v1")).toBe(
			"https://bedrock-mantle.us-east-2.api.aws/openai/v1",
		);
		expect(resolveOpenAIAwsBaseUrl(undefined)).toBe("https://bedrock-mantle.us-east-1.api.aws/openai/v1");
	});
});

describe("openai-aws availability gate (envKeys)", () => {
	it("prefers the explicit Bearer API key", () => {
		process.env.OPENAI_AWS_API_KEY = "bedrock-key";
		expect(openaiAwsProvider.envKeys()).toBe("bedrock-key");
	});

	it("honors the AWS-documented AWS_BEARER_TOKEN_BEDROCK fallback", () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "bedrock-bearer";
		expect(openaiAwsProvider.envKeys()).toBe("bedrock-bearer");
	});

	it("resolves the SigV4 sentinel from the AWS credential chain", () => {
		process.env.AWS_PROFILE = "somacommercial";
		expect(openaiAwsProvider.envKeys()).toBe("<authenticated>");
	});

	it("never reads OPENAI_API_KEY (first-party key must not advertise AWS availability)", () => {
		process.env.OPENAI_API_KEY = "sk-first-party";
		expect(openaiAwsProvider.envKeys()).toBeUndefined();
	});
});

describe("openai-aws transport auth", () => {
	it("sends the Bedrock API key as a Bearer token against the region-rewritten endpoint", async () => {
		process.env.AWS_REGION = "us-east-2";
		const captured: Record<string, string | null> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = requestUrl(input);
			captured.authorization = getRequestHeader(input, init, "Authorization");
			return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await streamOpenAIResponses(makeAwsGptModel(), testContext, {
			apiKey: "bedrock-key",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(captured.url).toBe("https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses");
		expect(captured.authorization).toBe("Bearer bedrock-key");
	});

	it("SigV4-signs the request with service bedrock-mantle when only chain credentials exist", async () => {
		process.env.AWS_REGION = "us-west-2";
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

		const captured: Record<string, string | null> = {};
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = requestUrl(input);
			captured.authorization = getRequestHeader(input, init, "Authorization");
			captured.amzDate = getRequestHeader(input, init, "x-amz-date");
			captured.contentSha = getRequestHeader(input, init, "x-amz-content-sha256");
			return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		const result = await streamOpenAIResponses(makeAwsGptModel(), testContext, {
			apiKey: "<authenticated>",
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		expect(result.stopReason).toBe("error");
		expect(captured.url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
		expect(captured.authorization).toContain("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/");
		expect(captured.authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(captured.amzDate).toMatch(/^\d{8}T\d{6}Z$/);
		expect(captured.contentSha).toMatch(/^[0-9a-f]{64}$/);
	});

	it("forces store:false and never chains stored responses (zero-retention policy)", async () => {
		process.env.AWS_REGION = "us-east-1";
		const bodies: Array<Record<string, unknown>> = [];
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		});

		await streamOpenAIResponses(makeAwsGptModel(), testContext, {
			apiKey: "bedrock-key",
			sessionId: "session-1",
			providerSessionState: new Map(),
			fetch: fetchMock as unknown as typeof fetch,
		}).result();

		// Bedrock-Mantle retains responses for 30 days when `store` is unset.
		// The transport must send an explicit opt-out and never reference a
		// stored predecessor.
		expect(bodies[0]?.store).toBe(false);
		expect(bodies[0]?.previous_response_id).toBeUndefined();
	});

	it("hashes a Request-embedded body identically to an init body when signing", async () => {
		process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
		process.env.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

		const shas: string[] = [];
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			shas.push(getRequestHeader(input, init, "x-amz-content-sha256") ?? "");
			return new Response("{}", { status: 200 });
		});
		const wrapped = wrapFetchForOpenAIAwsSigV4(fetchMock as unknown as typeof fetch, "us-east-1");
		const url = "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses";
		const payload = JSON.stringify({ model: "openai.gpt-5.6-luna", store: false });

		await wrapped(url, { method: "POST", body: payload });
		await wrapped(new Request(url, { method: "POST", body: payload }));

		expect(shas[0]).toMatch(/^[0-9a-f]{64}$/);
		// A Request-object body must produce the same payload hash as the same
		// bytes passed via init — otherwise the signature covers an empty body
		// and the endpoint rejects with an opaque 403.
		expect(shas[1]).toBe(shas[0]);
	});
});
