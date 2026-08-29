import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	MANAGED_AWS_MODEL_AUTH_MODE,
} from "@oh-my-pi/pi-ai";
import { clearAwsCredentialCache } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import {
	type BedrockMantleOptions,
	createBedrockMantleAuthenticatedFetch,
} from "@oh-my-pi/pi-ai/providers/bedrock-mantle";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { stream, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const mantleModel: Model<"openai-responses"> = buildModel({
	id: "openai.gpt-5.6-sol",
	name: "GPT-5.6 Sol",
	api: "openai-responses",
	provider: "bedrock-mantle",
	baseUrl: "https://bedrock-mantle.{region}.api.aws/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88 },
	contextWindow: 272_000,
	maxTokens: 128_000,
});

const context: Context = { messages: [{ role: "user", content: "Say hello", timestamp: 0 }] };
const cleanAwsEnv = {
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_SESSION_TOKEN: undefined,
	AWS_PROFILE: undefined,
	AWS_REGION: undefined,
	AWS_CONFIG_FILE: undefined,
	AWS_SHARED_CREDENTIALS_FILE: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE: undefined,
	AWS_DEFAULT_REGION: undefined,
	AWS_EC2_METADATA_DISABLED: "true",
	[AWS_MODEL_AUTH_MODE_ENV]: undefined,
	[AWS_MODEL_PROFILE_ENV]: undefined,
	[AWS_MODEL_REGION_ENV]: undefined,
};

interface Capture {
	url?: string;
	authorization?: string | null;
	securityToken?: string | null;
	body?: RequestInit["body"];
}

function captureFetch(capture: Capture): FetchImpl {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			capture.url = String(input instanceof Request ? input.url : input);
			const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			capture.authorization = headers.get("authorization");
			capture.securityToken = headers.get("x-amz-security-token");
			capture.body = init?.body;
			return new Response("captured", { status: 418 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function runDirect(
	env: Record<string, string | undefined>,
	options: BedrockMantleOptions = {},
): Promise<Capture> {
	const capture: Capture = {};
	await withEnv({ ...cleanAwsEnv, ...env }, async () => {
		clearAwsCredentialCache();
		await stream(mantleModel, context, { ...options, fetch: captureFetch(capture), maxTokens: 16 }).result();
	});
	return capture;
}

async function expectRejectedEndpoint(baseUrl: string, env: Record<string, string | undefined>): Promise<void> {
	const capture: Capture = {};
	await withEnv({ ...cleanAwsEnv, ...env }, async () => {
		clearAwsCredentialCache();
		const model = { ...mantleModel, baseUrl };
		await expect(
			Promise.resolve().then(() => stream(model, context, { fetch: captureFetch(capture), maxTokens: 16 }).result()),
		).rejects.toThrow("Bedrock Mantle endpoint must use");
	});
	expect(capture.url).toBeUndefined();
	expect(capture.authorization).toBeUndefined();
}

describe("Bedrock Mantle authentication", () => {
	test("uses the configured region and Bedrock bearer token", async () => {
		const capture = await runDirect({
			AWS_BEARER_TOKEN_BEDROCK: "test-token",
			AWS_REGION: "us-east-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/v1/responses");
		expect(capture.authorization).toBe("Bearer test-token");
	});

	test("resolves the regional endpoint before forwarding a bearer token", async () => {
		const capture: Capture = {};
		await withEnv(cleanAwsEnv, async () => {
			const authenticatedFetch = createBedrockMantleAuthenticatedFetch({
				apiKey: "test-token",
				providerOptions: { region: "us-east-2" },
				fetch: captureFetch(capture),
			});
			await authenticatedFetch("https://bedrock-mantle.{region}.api.aws/v1/models", { method: "GET" });
		});
		expect(capture.url).toBe("https://bedrock-mantle.us-east-2.api.aws/v1/models");
		expect(capture.authorization).toBe("Bearer test-token");
	});

	test("rebuilds bearer-authenticated Request inputs against the resolved regional endpoint", async () => {
		let forwarded: Request | undefined;
		const baseFetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				forwarded =
					input instanceof Request
						? new Request(input, init)
						: new Request(input instanceof URL ? input.href : input, init);
				return new Response("captured", { status: 418 });
			},
			{ preconnect: fetch.preconnect },
		);
		await withEnv(cleanAwsEnv, async () => {
			const authenticatedFetch = createBedrockMantleAuthenticatedFetch({
				apiKey: "test-token",
				providerOptions: { region: "us-east-2" },
				fetch: baseFetch,
			});
			const request = new Request("https://bedrock-mantle.{region}.api.aws/v1/responses", {
				method: "POST",
				headers: { "content-type": "application/json", "x-request-header": "preserved" },
				body: '{"input":"preserved"}',
			});
			await authenticatedFetch(request, { headers: { "x-init-header": "merged" } });
		});
		expect(forwarded?.url).toBe("https://bedrock-mantle.us-east-2.api.aws/v1/responses");
		expect(forwarded?.method).toBe("POST");
		expect(forwarded?.headers.get("authorization")).toBe("Bearer test-token");
		expect(forwarded?.headers.get("x-request-header")).toBe("preserved");
		expect(forwarded?.headers.get("x-init-header")).toBe("merged");
		expect(await forwarded?.text()).toBe('{"input":"preserved"}');
	});

	test("uses the selected profile region when environment regions are absent", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-mantle-region-"));
		try {
			const configPath = path.join(tmp, "config");
			await Bun.write(configPath, "[profile regional]\nregion = eu-west-2\n");
			const capture = await runDirect({
				AWS_BEARER_TOKEN_BEDROCK: "test-token",
				AWS_PROFILE: "regional",
				AWS_CONFIG_FILE: configPath,
				AWS_SHARED_CREDENTIALS_FILE: path.join(tmp, "missing-credentials"),
			});
			expect(capture.url).toStartWith("https://bedrock-mantle.eu-west-2.api.aws/v1/responses");
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("prepares bearer-authenticated model discovery", async () => {
		const capture: Capture = {};
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_BEARER_TOKEN_BEDROCK: "discovery-token",
				AWS_REGION: "eu-west-2",
			},
			async () => {
				const config = getProviderDefinition("bedrock-mantle")?.prepareModelDiscovery?.({
					fetch: captureFetch(capture),
				});
				expect(config?.authenticated).toBeTrue();
				expect(config?.baseUrl).toBe("https://bedrock-mantle.eu-west-2.api.aws/v1");
				await config?.fetch?.("https://bedrock-mantle.eu-west-2.api.aws/v1/models", { method: "GET" });
			},
		);
		expect(capture.authorization).toBe("Bearer discovery-token");
		expect(capture.body).toBeUndefined();
	});

	test("prepares SigV4-authenticated model discovery", async () => {
		const capture: Capture = {};
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIADISCOVERY",
				AWS_SECRET_ACCESS_KEY: "discovery-secret",
				AWS_REGION: "eu-west-2",
			},
			async () => {
				clearAwsCredentialCache();
				const config = getProviderDefinition("bedrock-mantle")?.prepareModelDiscovery?.({
					fetch: captureFetch(capture),
				});
				expect(config?.authenticated).toBeTrue();
				expect(config?.baseUrl).toBe("https://bedrock-mantle.eu-west-2.api.aws/v1");
				await config?.fetch?.("https://bedrock-mantle.eu-west-2.api.aws/v1/models", { method: "GET" });
			},
		);
		expect(capture.authorization).toContain("/eu-west-2/bedrock-mantle/aws4_request");
		expect(capture.authorization).not.toContain("content-type");
		expect(capture.body).toBeUndefined();
	});

	test("SigV4-signs with the standard AWS credential chain", async () => {
		const capture = await runDirect({
			AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
			AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			AWS_SESSION_TOKEN: "test-session-token",
			AWS_REGION: "us-west-2",
		});
		expect(capture.url).toStartWith("https://bedrock-mantle.us-west-2.api.aws/v1/responses");
		expect(capture.authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(capture.securityToken).toBe("test-session-token");
	});

	test("managed model auth signs with the isolated profile and region", async () => {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-mantle-managed-"));
		try {
			await fs.mkdir(path.join(home, ".aws"), { recursive: true });
			await Bun.write(
				path.join(home, ".aws", "credentials"),
				"[model-inference]\naws_access_key_id = MODELKEY\naws_secret_access_key = model-secret\n",
			);
			const capture = await runDirect({
				HOME: home,
				USERPROFILE: home,
				[AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE,
				[AWS_MODEL_PROFILE_ENV]: "model-inference",
				[AWS_MODEL_REGION_ENV]: "us-east-1",
				AWS_BEARER_TOKEN_BEDROCK: "ambient-bearer",
				AWS_ACCESS_KEY_ID: "AMBIENTKEY",
				AWS_SECRET_ACCESS_KEY: "ambient-secret",
				AWS_PROFILE: "employee-operations",
				AWS_REGION: "eu-west-1",
			});
			expect(capture.url).toStartWith("https://bedrock-mantle.us-east-1.api.aws/v1/responses");
			expect(capture.authorization).toContain("Credential=MODELKEY/");
			expect(capture.authorization).toContain("/us-east-1/bedrock-mantle/aws4_request");
			expect(capture.authorization).not.toStartWith("Bearer ");
		} finally {
			await removeWithRetries(home);
		}
	});

	test("invalidates cached SigV4 credentials after an authentication rejection", async () => {
		const authorizations: string[] = [];
		const rejectingFetch: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
				authorizations.push(headers.get("authorization") ?? "");
				return new Response("rejected", { status: 403 });
			},
			{ preconnect: fetch.preconnect },
		);
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIAFIRST",
				AWS_SECRET_ACCESS_KEY: "first-secret",
				AWS_REGION: "us-west-2",
			},
			async () => {
				clearAwsCredentialCache();
				await stream(mantleModel, context, { fetch: rejectingFetch, maxTokens: 16 }).result();
				Bun.env.AWS_ACCESS_KEY_ID = "AKIASECOND";
				Bun.env.AWS_SECRET_ACCESS_KEY = "second-secret";
				await stream(mantleModel, context, { fetch: rejectingFetch, maxTokens: 16 }).result();
			},
		);
		expect(authorizations).toHaveLength(2);
		expect(authorizations[0]).toContain("Credential=AKIAFIRST/");
		expect(authorizations[1]).toContain("Credential=AKIASECOND/");
	});

	test("streamSimple preserves AWS options and resolver-supplied keys", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		const options: SimpleStreamOptions = {
			apiKey: async () => {
				resolverCalls++;
				return "resolved-token";
			},
			providerOptions: {
				region: "us-east-2",
				profile: "ignored-for-bearer",
			},
			fetch: captureFetch(capture),
			maxTokens: 16,
		};
		await withEnv(cleanAwsEnv, async () => {
			await streamSimple(mantleModel, context, options).result();
		});
		expect(resolverCalls).toBe(1);
		expect(capture.url).toStartWith("https://bedrock-mantle.us-east-2.api.aws/v1/responses");
		expect(capture.authorization).toBe("Bearer resolved-token");
	});

	test("streamSimple falls back to SigV4 when its optional key resolver is empty", async () => {
		const capture: Capture = {};
		let resolverCalls = 0;
		await withEnv(
			{
				...cleanAwsEnv,
				AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
				AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
				AWS_REGION: "us-east-2",
			},
			async () => {
				await streamSimple(mantleModel, context, {
					apiKey: async () => {
						resolverCalls++;
						return undefined;
					},
					fetch: captureFetch(capture),
					maxTokens: 16,
				}).result();
			},
		);
		expect(resolverCalls).toBe(1);
		expect(capture.authorization).toContain("/us-east-2/bedrock-mantle/aws4_request");
	});

	test("rejects overridden and look-alike endpoints before bearer authentication", async () => {
		const invalidBaseUrls = [
			"https://listener.example/v1",
			"https://bedrock-mantle.us-east-1.api.aws.listener.example/v1",
			"https://user@bedrock-mantle.us-east-1.api.aws/v1",
			"http://bedrock-mantle.us-east-1.api.aws/v1",
			"https://bedrock-mantle.us-east-1.api.aws:8443/v1",
			"https://bedrock-mantle.us-east-1.api.aws/evil",
			"https://bedrock-mantle.us-east-1.api.aws/v1/extra",
			"https://bedrock-mantle.us-east-1.api.aws/v1?redirect=listener.example",
			"https://bedrock-mantle.us-east-1.api.aws/v1#listener.example",
		];
		for (const baseUrl of invalidBaseUrls) {
			await expectRejectedEndpoint(baseUrl, {
				AWS_BEARER_TOKEN_BEDROCK: "must-not-leak",
				AWS_REGION: "us-east-1",
			});
		}
	});

	test("rejects authenticated fetch paths outside the Mantle OpenAI prefix", async () => {
		const capture: Capture = {};
		await withEnv(cleanAwsEnv, async () => {
			const authenticatedFetch = createBedrockMantleAuthenticatedFetch({
				apiKey: "must-not-leak",
				providerOptions: { region: "us-east-1" },
				fetch: captureFetch(capture),
			});
			await expect(
				authenticatedFetch("https://bedrock-mantle.us-east-1.api.aws/openai/v1/models", { method: "GET" }),
			).rejects.toThrow("Bedrock Mantle endpoint must use");
		});
		expect(capture.url).toBeUndefined();
		expect(capture.authorization).toBeUndefined();
	});

	test("rejects an overridden endpoint before SigV4 authentication", async () => {
		await expectRejectedEndpoint("https://listener.example/v1", {
			AWS_ACCESS_KEY_ID: "AKIAMUSTNOTLEAK",
			AWS_SECRET_ACCESS_KEY: "must-not-leak",
			AWS_SESSION_TOKEN: "must-not-leak",
			AWS_REGION: "us-east-1",
		});
	});

	test("pi-native transport wins over local Mantle authentication", async () => {
		const capture: Capture = {};
		const gatewayModel = {
			...mantleModel,
			baseUrl: "http://gateway.internal",
			transport: "pi-native" as const,
		};
		await expect(
			streamSimple(gatewayModel, context, {
				apiKey: "gateway-token",
				fetch: captureFetch(capture),
				maxTokens: 16,
			}).result(),
		).rejects.toThrow("auth-gateway 418");
		expect(capture.url).toBe("http://gateway.internal/v1/pi/stream");
	});
});
