import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildAnthropicClientOptions } from "@oh-my-pi/pi-ai/providers/anthropic";
import { anthropicProvider } from "@oh-my-pi/pi-ai/registry/anthropic";
import { anthropicAwsProvider } from "@oh-my-pi/pi-ai/registry/anthropic-aws";
import {
	anthropicBaseUrlIsAwsGateway,
	resolveAnthropicAwsApiKey,
	resolveAnthropicAwsWorkspaceId,
} from "@oh-my-pi/pi-ai/registry/anthropic-aws-env";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Claude Platform on AWS accepts two env-name families that reach the same
// gateway: the AWS-scoped names (`ANTHROPIC_AWS_*`) and the NATIVE Anthropic
// names (`ANTHROPIC_API_KEY` / `ANTHROPIC_WORKSPACE_ID`) that AWS's own
// onboarding hands out alongside `ANTHROPIC_BASE_URL` = the gateway host. The
// native names are honored ONLY under the gateway base URL so a plain
// api.anthropic.com key is never misrouted to AWS. These tests pin that
// resolution contract and the availability gate that depends on it.

const MANAGED_KEYS = [
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"CLAUDE_CODE_USE_FOUNDRY",
	"FOUNDRY_BASE_URL",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_ROLE_ARN",
	"OMP_MODEL_AWS_AUTH_MODE",
	"OMP_MODEL_AWS_PROFILE",
	"OMP_MODEL_AWS_REGION",
] as const;

const GATEWAY_URL = "https://aws-external-anthropic.us-east-1.api.aws";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of MANAGED_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of MANAGED_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("anthropicBaseUrlIsAwsGateway", () => {
	it("accepts a gateway host with any region segment", () => {
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		expect(anthropicBaseUrlIsAwsGateway()).toBe(true);
		process.env.ANTHROPIC_BASE_URL = "https://aws-external-anthropic.us-gov-west-1.api.aws";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(true);
	});

	it("rejects plaintext gateway URLs", () => {
		process.env.ANTHROPIC_BASE_URL = "http://aws-external-anthropic.us-east-1.api.aws";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
	});

	it("rejects a look-alike host that merely contains the gateway string", () => {
		// The guard gates a trust decision on user env, so it must full-match the
		// hostname — a suffix/substring check would accept an attacker domain.
		process.env.ANTHROPIC_BASE_URL = "https://aws-external-anthropic.us-east-1.api.aws.evil.com";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
		process.env.ANTHROPIC_BASE_URL = "https://evil.com/aws-external-anthropic.us-east-1.api.aws";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
	});

	it("rejects the native Anthropic API host and unset/garbage values", () => {
		process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
		delete process.env.ANTHROPIC_BASE_URL;
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
		process.env.ANTHROPIC_BASE_URL = "not a url";
		expect(anthropicBaseUrlIsAwsGateway()).toBe(false);
	});
});

describe("gateway credential name resolution", () => {
	it("prefers the AWS-scoped names when present", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		expect(resolveAnthropicAwsWorkspaceId()).toBe("wrkspc_aws");
		expect(resolveAnthropicAwsApiKey()).toBe("key-aws");
	});

	it("falls back to native names ONLY under the gateway base URL", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		// No gateway base URL -> native names are NOT adopted (avoid misrouting a
		// plain api.anthropic.com key to AWS).
		expect(resolveAnthropicAwsWorkspaceId()).toBeUndefined();
		expect(resolveAnthropicAwsApiKey()).toBeUndefined();
		// With the gateway base URL -> native names resolve.
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		expect(resolveAnthropicAwsWorkspaceId()).toBe("wrkspc_native");
		expect(resolveAnthropicAwsApiKey()).toBe("key-native");
	});

	it("does not adopt native names under a look-alike base URL", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = "https://aws-external-anthropic.us-east-1.api.aws.evil.com";
		expect(resolveAnthropicAwsWorkspaceId()).toBeUndefined();
		expect(resolveAnthropicAwsApiKey()).toBeUndefined();
	});

	it("trims surrounding whitespace", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "  wrkspc_aws  ";
		process.env.ANTHROPIC_AWS_API_KEY = "\tkey-aws\n";
		expect(resolveAnthropicAwsWorkspaceId()).toBe("wrkspc_aws");
		expect(resolveAnthropicAwsApiKey()).toBe("key-aws");
	});

	it("does not pair the AWS-scoped key with a native-only workspace id", () => {
		// Family coherence: the key must come from the SAME family as the workspace
		// id. A native workspace under the gateway resolves ONLY the native key;
		// the AWS-scoped key does not stand in for it.
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(resolveAnthropicAwsWorkspaceId()).toBe("wrkspc_native");
		expect(resolveAnthropicAwsApiKey()).toBeUndefined();
	});

	it("does not pair the native key with an AWS-scoped workspace id", () => {
		// The mirror case: an AWS-scoped workspace pairs only with the AWS-scoped
		// key, never the native ANTHROPIC_API_KEY (which would otherwise leak an
		// api.anthropic.com key into an AWS-scoped request).
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_API_KEY = "key-native";
		expect(resolveAnthropicAwsWorkspaceId()).toBe("wrkspc_aws");
		expect(resolveAnthropicAwsApiKey()).toBeUndefined();
	});
});

describe("anthropic-aws availability gate (envKeys)", () => {
	it("advertises the native API key as the Bearer credential under the gateway URL", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		// The gate's return value becomes the apiKey the transport sends as
		// `Authorization: Bearer <key>`, so returning the native key here is what
		// makes an AWS-onboarded machine work with no extra env.
		expect(anthropicAwsProvider.envKeys()).toBe("key-native");
	});

	it("is unavailable when only native names are set WITHOUT the gateway URL", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		expect(anthropicAwsProvider.envKeys()).toBeUndefined();
	});

	it("is unavailable with no workspace id even when an API key is present", () => {
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(anthropicAwsProvider.envKeys()).toBeUndefined();
	});

	it("reports the SigV4 sentinel when a workspace id + AWS_PROFILE are set (no API key)", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.AWS_PROFILE = "somaprod";
		expect(anthropicAwsProvider.envKeys()).toBe("<authenticated>");
	});

	it("is unavailable for a native workspace + gateway + AWS_PROFILE but no native API key", () => {
		// AWS's console onboarding is an API-key (Bearer) path. A native workspace
		// id must NOT be rescued by an ambient AWS profile / SigV4 chain, or the
		// gate would advertise availability the API-key user does not actually have.
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.AWS_PROFILE = "somaprod";
		expect(anthropicAwsProvider.envKeys()).toBeUndefined();
	});

	it("does not cross families: native workspace is not authenticated by the AWS-scoped key", () => {
		// The credential families never cross. A native workspace id pairs only
		// with the native ANTHROPIC_API_KEY; the AWS-scoped key belongs to the
		// AWS-scoped workspace name and cannot stand in for a missing native key.
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(anthropicAwsProvider.envKeys()).toBeUndefined();
	});

	it("is unavailable when the AWS-scoped workspace wins but only a native key is set", () => {
		// Both workspace ids present ⇒ the AWS-scoped id wins, selecting the AWS
		// family. A native-only ANTHROPIC_API_KEY does not complete it (no AWS key,
		// no SigV4 source), so the provider is unavailable — matching the wrapper.
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_API_KEY = "key-native";
		expect(anthropicAwsProvider.envKeys()).toBeUndefined();
		// The AWS-scoped key (same family as the winning workspace id) completes it.
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(anthropicAwsProvider.envKeys()).toBe("key-aws");
	});
});

describe("stock anthropic availability on an AWS gateway route", () => {
	it("uses the native AWS-onboarding key family", () => {
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		expect(anthropicProvider.envKeys()).toBe("key-native");
	});

	it("uses the AWS-scoped SigV4 credential family", () => {
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.AWS_PROFILE = "somaprod";
		expect(anthropicProvider.envKeys()).toBe("<authenticated>");
	});

	it("does not advertise an incomplete AWS route from a plain Anthropic key", () => {
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_API_KEY = "key-native";
		expect(anthropicProvider.envKeys()).toBeUndefined();
	});

	it("uses the AWS credential family when an enabled Foundry route has no base URL", () => {
		process.env.CLAUDE_CODE_USE_FOUNDRY = "true";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(anthropicProvider.envKeys()).toBe("key-aws");
	});

	it("uses the AWS credential family for a Foundry AWS base URL", () => {
		process.env.CLAUDE_CODE_USE_FOUNDRY = "true";
		process.env.FOUNDRY_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		process.env.ANTHROPIC_API_KEY = "key-generic";
		expect(anthropicProvider.envKeys()).toBe("key-aws");
	});

	it("does not apply stock AWS credentials to an explicit non-AWS base URL", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(
			getEnvApiKey("anthropic", {
				baseUrl: "https://anthropic-proxy.example.com/v1",
				modelId: "claude-sonnet-4-5",
			}),
		).toBeUndefined();

		process.env.ANTHROPIC_API_KEY = "key-generic";
		expect(
			getEnvApiKey("anthropic", {
				baseUrl: "https://anthropic-proxy.example.com/v1",
				modelId: "claude-sonnet-4-5",
			}),
		).toBe("key-generic");
	});

	it("uses stock AWS credentials for official models but not explicit custom gateway routes", () => {
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		expect(
			getEnvApiKey("anthropic", {
				baseUrl: "https://api.anthropic.com",
				modelId: "claude-sonnet-4-5",
			}),
		).toBe("key-aws");

		process.env.ANTHROPIC_API_KEY = "key-generic";
		expect(
			getEnvApiKey("anthropic", {
				baseUrl: GATEWAY_URL,
				modelId: "claude-sonnet-4-5",
			}),
		).toBe("key-generic");
	});
});

function makeAwsClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic-aws",
		baseUrl: GATEWAY_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeStockClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeCustomAwsClaudeModel(): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5 (custom AWS)",
		api: "anthropic-messages",
		provider: "custom-aws",
		baseUrl: GATEWAY_URL,
		headers: { "Anthropic-Workspace-Id": "wrkspc_custom" },
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function header(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
	return undefined;
}

describe("anthropic-aws transport with native names + gateway URL", () => {
	it("injects the native workspace id header and Bearer key (AWS onboarding env)", () => {
		// The AWS console hands out native ANTHROPIC_* names plus ANTHROPIC_BASE_URL.
		// The transport must still emit the mandatory workspace header; the apiKey
		// arg is what the gate (getEnvApiKey) resolved — here the native key.
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "key-native",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_native");
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-native");
		expect(header(options.defaultHeaders, "x-api-key")).toBeUndefined();
		expect(options.apiKey).toBeNull();
	});

	it("preserves AWS authentication when ANTHROPIC_BASE_URL reroutes the stock provider", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		const options = buildAnthropicClientOptions({
			model: makeStockClaudeModel(),
			apiKey: "key-native",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});
		expect(options.baseURL).toBe(GATEWAY_URL);
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_native");
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-native");
		expect(header(options.defaultHeaders, "x-api-key")).toBeUndefined();
		expect(options.apiKey).toBeNull();
	});

	it("preserves configured credentials for an explicit stock-provider gateway URL", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_environment";
		process.env.ANTHROPIC_AWS_API_KEY = "key-environment";
		const model = {
			...makeStockClaudeModel(),
			baseUrl: GATEWAY_URL,
			headers: { "Anthropic-Workspace-Id": "wrkspc_model" },
		};
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "key-model",
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});
		expect(options.baseURL).toBe(GATEWAY_URL);
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_model");
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-model");
		expect(options.apiKey).toBeNull();
	});

	it("lets an AWS Foundry route override an explicit non-AWS model base", () => {
		process.env.CLAUDE_CODE_USE_FOUNDRY = "true";
		process.env.FOUNDRY_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		const model = { ...makeStockClaudeModel(), baseUrl: "https://anthropic-proxy.example.com/v1" };
		const apiKey = getEnvApiKey(model.provider, { baseUrl: model.baseUrl, modelId: model.id });
		expect(apiKey).toBe("key-aws");
		if (!apiKey) throw new Error("Expected AWS environment credential");
		const options = buildAnthropicClientOptions({
			model,
			apiKey,
			extraBetas: [],
			stream: true,
			dynamicHeaders: {},
		});
		expect(options.baseURL).toBe(GATEWAY_URL);
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_aws");
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-aws");
		expect(options.apiKey).toBeNull();
	});

	it("rejects a stock-provider reroute whose winning credential family is incomplete", () => {
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";

		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		expect(() =>
			buildAnthropicClientOptions({
				model: makeStockClaudeModel(),
				apiKey: "key-native",
				extraBetas: [],
				stream: true,
				dynamicHeaders: {},
			}),
		).toThrow("matching API key or AWS credential chain");
	});
	it("owns AWS headers when an enabled Foundry route has no base URL", () => {
		process.env.CLAUDE_CODE_USE_FOUNDRY = "true";
		process.env.ANTHROPIC_AWS_WORKSPACE_ID = "wrkspc_aws";
		process.env.ANTHROPIC_AWS_API_KEY = "key-aws";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		const options = buildAnthropicClientOptions({
			model: makeStockClaudeModel(),
			apiKey: "key-aws",
			extraBetas: [],
			stream: true,
		});
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_aws");
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-aws");
	});

	it("derives the endpoint region from ANTHROPIC_BASE_URL when AWS_REGION is unset", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = "https://aws-external-anthropic.us-gov-west-1.api.aws";
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "key-native",
			extraBetas: [],
			stream: true,
		});
		expect(options.baseURL).toBe("https://aws-external-anthropic.us-gov-west-1.api.aws");
	});

	it("lets AWS_REGION override the base-URL region", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.AWS_REGION = "eu-west-1";
		const options = buildAnthropicClientOptions({
			model: makeAwsClaudeModel(),
			apiKey: "key-native",
			extraBetas: [],
			stream: true,
		});
		expect(options.baseURL).toBe("https://aws-external-anthropic.eu-west-1.api.aws");
	});

	it("overwrites colliding headers and suppresses enterprise headers on an env-owned AWS route", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Gateway-Key: secret, Authorization: Bearer gateway-secret";
		const model = {
			...makeStockClaudeModel(),
			headers: { authorization: "Bearer stale", "ANTHROPIC-WORKSPACE-ID": "wrkspc_stale" },
		};
		const options = buildAnthropicClientOptions({
			model,
			apiKey: "stored-stock-key",
			extraBetas: [],
			stream: true,
		});
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-native");
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_native");
		expect(header(options.defaultHeaders, "x-gateway-key")).toBeUndefined();
		expect(header(options.defaultHeaders, "x-api-key")).toBeUndefined();
	});

	it("rejects a native-only workspace instead of signing it with ambient AWS credentials", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		process.env.AWS_PROFILE = "somaprod";
		expect(() =>
			buildAnthropicClientOptions({
				model: makeStockClaudeModel(),
				apiKey: "stored-stock-key",
				extraBetas: [],
				stream: true,
			}),
		).toThrow("matching API key or AWS credential chain");
	});

	it("rejects a stock AWS reroute without a workspace id", () => {
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		expect(() =>
			buildAnthropicClientOptions({
				model: makeStockClaudeModel(),
				apiKey: "stored-stock-key",
				extraBetas: [],
				stream: true,
			}),
		).toThrow("requires ANTHROPIC_AWS_WORKSPACE_ID or ANTHROPIC_WORKSPACE_ID");
	});

	it("rejects plaintext AWS transport before attaching credentials", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = "http://aws-external-anthropic.us-east-1.api.aws";
		expect(() =>
			buildAnthropicClientOptions({
				model: makeStockClaudeModel(),
				apiKey: "key-native",
				extraBetas: [],
				stream: true,
			}),
		).toThrow("requires a canonical HTTPS");
	});

	it("rejects a non-AWS endpoint labeled as the anthropic-aws provider", () => {
		expect(() =>
			buildAnthropicClientOptions({
				model: { ...makeAwsClaudeModel(), baseUrl: "https://attacker.example" },
				apiKey: "key-native",
				extraBetas: [],
				stream: true,
			}),
		).toThrow("requires a canonical HTTPS");
	});

	it("preserves an explicit custom-provider AWS credential and workspace header", () => {
		const options = buildAnthropicClientOptions({
			model: makeCustomAwsClaudeModel(),
			apiKey: "key-custom",
			extraBetas: [],
			stream: true,
		});
		expect(header(options.defaultHeaders, "authorization")).toBe("Bearer key-custom");
		expect(header(options.defaultHeaders, "anthropic-workspace-id")).toBe("wrkspc_custom");
		expect(header(options.defaultHeaders, "x-api-key")).toBeUndefined();
	});

	it("adds the interleaved-thinking beta after a stock adaptive model is rerouted", () => {
		process.env.ANTHROPIC_WORKSPACE_ID = "wrkspc_native";
		process.env.ANTHROPIC_API_KEY = "key-native";
		process.env.ANTHROPIC_BASE_URL = GATEWAY_URL;
		const options = buildAnthropicClientOptions({
			model: makeStockClaudeModel(),
			apiKey: "key-native",
			extraBetas: [],
			stream: true,
			hasTools: true,
			interleavedThinking: true,
		});
		expect(header(options.defaultHeaders, "anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
	});
});
