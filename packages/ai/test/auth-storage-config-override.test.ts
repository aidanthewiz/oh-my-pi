import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthCredentialStore, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { buildGatewayApiKeyResolver, resolveGatewayApiKey } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const SUPPRESS_ANTHROPIC_ENV = {
	ANTHROPIC_API_KEY: undefined,
	ANTHROPIC_OAUTH_TOKEN: undefined,
	ANTHROPIC_BASE_URL: undefined,
	ANTHROPIC_WORKSPACE_ID: undefined,
	ANTHROPIC_AWS_WORKSPACE_ID: undefined,
	CLAUDE_CODE_USE_FOUNDRY: undefined,
	FOUNDRY_BASE_URL: undefined,
} as const;

describe("AuthStorage config-override apiKey", () => {
	let tempDir = "";
	let store: AuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-config-override-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await removeWithRetries(tempDir);
			tempDir = "";
		}
	});

	async function seedOAuth(provider: string, access: string): Promise<void> {
		if (!authStorage) throw new Error("test setup failed");
		await authStorage.credentials.set(provider, [
			{
				type: "oauth",
				access,
				refresh: `${access}-refresh`,
				expires: Date.now() + 60 * 60_000,
			},
		]);
	}

	test("config override beats OAuth access token when resolving a key", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");

			expect(await authStorage.keys.get("anthropic")).toBe("gateway-bearer");
			expect(await authStorage.keys.peek("anthropic")).toBe("gateway-bearer");
		});
	});

	test("runtime override (--api-key) still beats configured provider key", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			authStorage.keys.setRuntime("anthropic", "cli-flag-bearer");

			expect(await authStorage.keys.get("anthropic")).toBe("cli-flag-bearer");
		});
	});

	test("removing a config override restores OAuth resolution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			expect(await authStorage.keys.get("anthropic")).toBe("gateway-bearer");

			authStorage.keys.removeConfig("anthropic");
			expect(await authStorage.keys.get("anthropic")).toBe("oauth-from-broker");
		});
	});

	test("clearing config overrides restores credentials across providers", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-anthropic");
			await seedOAuth("openai-codex", "oauth-codex");
			authStorage.keys.setConfig("anthropic", "gateway-bearer-A");
			authStorage.keys.setConfig("openai-codex", "gateway-bearer-B");

			authStorage.keys.clearConfig();

			expect(await authStorage.keys.get("anthropic")).toBe("oauth-anthropic");
			expect(await authStorage.keys.get("openai-codex")).toBe("oauth-codex");
		});
	});

	test("AWS-routed Anthropic never borrows broker OAuth, static, or override credentials", async () => {
		await withEnv(
			{
				...SUPPRESS_ANTHROPIC_ENV,
				ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_test",
				ANTHROPIC_AWS_API_KEY: undefined,
				OMP_MODEL_AWS_AUTH_MODE: "managed",
				OMP_MODEL_AWS_PROFILE: undefined,
			},
			async () => {
				if (!authStorage || !store) throw new Error("test setup failed");
				const session = "aws-credential-isolation";
				await authStorage.credentials.set("anthropic", [
					{
						type: "oauth",
						access: "broker-oauth",
						refresh: "broker-refresh",
						expires: Date.now() + 60_000,
						accountId: "broker-account",
					},
					{ type: "api_key", key: "stored-broker-key" },
				]);
				const row = store.listAuthCredentials("anthropic").find(entry => entry.credential.type === "oauth");
				if (!row) throw new Error("missing broker credential");
				expect(authStorage.sessions.pin("anthropic", session, row.id)).toBe(true);
				expect(store.getCache(`session:sticky:anthropic:${session}`)).not.toBeNull();
				authStorage.keys.setConfig("anthropic", "configured-broker-key");
				authStorage.keys.setRuntime("anthropic", "runtime-broker-key");
				const gateway = { baseUrl: "https://api.anthropic.com", modelId: "claude-sonnet-4-5" };
				expect(await authStorage.keys.get("anthropic", session, gateway)).toBeUndefined();
				expect(authStorage.sessions.release("anthropic", session)).toBe(false);
				expect(store.getCache(`session:sticky:anthropic:${session}`)).toBeNull();
				expect(authStorage.oauth.identity("anthropic", session)).toBeUndefined();

				authStorage.keys.removeRuntime("anthropic");
				authStorage.keys.removeConfig("anthropic");
				expect(await authStorage.keys.get("anthropic", session, gateway)).toBeUndefined();
				await authStorage.credentials.set("anthropic-aws", [
					{
						type: "oauth",
						access: "aws-broker-oauth",
						refresh: "aws-broker-refresh",
						expires: Date.now() + 60_000,
					},
					{ type: "api_key", key: "aws-stored-broker-key" },
				]);
				authStorage.keys.setRuntime("anthropic-aws", "aws-runtime-broker-key");
				expect(
					await authStorage.keys.get("anthropic-aws", session, {
						baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
						modelId: "claude-sonnet-4-5",
					}),
				).toBeUndefined();
				expect(await authStorage.keys.get("anthropic-aws", session)).toBeUndefined();
				expect(
					await authStorage.keys.peek("anthropic-aws", {
						baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
					}),
				).toBeUndefined();
				expect(await authStorage.keys.peek("anthropic-aws")).toBeUndefined();
				expect(authStorage.keys.source("anthropic-aws")).toBeUndefined();
				expect(authStorage.keys.describe("anthropic-aws", session)).toBeUndefined();
				const resolver = authStorage.keys.resolver("anthropic-aws", {
					sessionId: session,
					baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
				});
				expect(await resolver({ error: new Error("401 unauthorized"), lastChance: true })).toBeUndefined();
				expect(authStorage.credentials.getOAuth("anthropic-aws")?.access).toBe("aws-broker-oauth");
			},
		);
	});

	test("AWS-routed Anthropic uses the workspace key and normal Anthropic retains broker precedence", async () => {
		await withEnv(
			{
				...SUPPRESS_ANTHROPIC_ENV,
				ANTHROPIC_BASE_URL: "https://aws-external-anthropic.us-east-1.api.aws",
				ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_test",
				ANTHROPIC_AWS_API_KEY: "aws-workspace-key",
				CLAUDE_CODE_USE_FOUNDRY: undefined,
			},
			async () => {
				if (!authStorage) throw new Error("test setup failed");
				await authStorage.credentials.set("anthropic", [
					{
						type: "oauth",
						access: "broker-oauth",
						refresh: "broker-refresh",
						expires: Date.now() + 60 * 60_000,
						accountId: "custom-proxy-account",
					},
				]);
				const context = { baseUrl: "https://api.anthropic.com", modelId: "claude-sonnet-4-5" };
				expect(await authStorage.keys.get("anthropic", "aws-session", context)).toBe("aws-workspace-key");
				expect(await authStorage.keys.getWithCredential("anthropic", "aws-session", context)).toEqual({
					apiKey: "aws-workspace-key",
				});
				expect(await authStorage.keys.peek("anthropic", context)).toBe("aws-workspace-key");
				expect(
					await authStorage.keys.get("anthropic", "normal-session", {
						baseUrl: "https://custom-anthropic.example",
						modelId: "claude-sonnet-4-5",
					}),
				).toBe("broker-oauth");
				expect(authStorage.oauth.identity("anthropic", "normal-session")?.accountId).toBe("custom-proxy-account");
			},
		);
	});

	test("gateway never invalidates a broker row after an AWS-owned bearer fails", async () => {
		await withEnv(
			{
				ANTHROPIC_AWS_WORKSPACE_ID: "wrkspc_test",
				ANTHROPIC_AWS_API_KEY: "aws-workspace-key",
			},
			async () => {
				if (!authStorage) throw new Error("test setup failed");
				const model = getBundledModel("anthropic-aws", "claude-opus-4-8");
				if (!model) throw new Error("missing bundled AWS Claude model");
				await seedOAuth("anthropic-aws", "broker-oauth");
				const signal = new AbortController().signal;
				const apiKey = await resolveGatewayApiKey(authStorage, model, "aws-session", signal, "local");
				expect(apiKey).toEqual({ apiKey: "aws-workspace-key" });
				if (!("apiKey" in apiKey)) throw new Error("missing AWS bearer");
				const resolver = buildGatewayApiKeyResolver(
					authStorage,
					model,
					"aws-session",
					apiKey,
					signal,
					"anthropic-messages",
					"local",
				);
				expect(await resolver({ error: new Error("401 unauthorized"), lastChance: true })).toBeUndefined();
				expect(authStorage.credentials.getOAuth("anthropic-aws")?.access).toBe("broker-oauth");
			},
		);
	});

	test("config override suppresses OAuth account_uuid attribution", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await authStorage.credentials.set("anthropic", [
				{
					type: "oauth",
					access: "oauth-with-account",
					refresh: "r",
					expires: Date.now() + 60 * 60_000,
					accountId: "acc-123",
				},
			]);
			// Sanity: without override, accountId is exposed.
			expect(authStorage.oauth.identity("anthropic")?.accountId).toBe("acc-123");

			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			// With an explicit config bearer in play, OAuth account attribution
			// must NOT leak — outbound auth is the gateway bearer, not OAuth.
			expect(authStorage.oauth.identity("anthropic")?.accountId).toBeUndefined();
		});
	});

	test("key source description reports config override", async () => {
		await withEnv(SUPPRESS_ANTHROPIC_ENV, async () => {
			if (!authStorage) throw new Error("test setup failed");
			await seedOAuth("anthropic", "oauth-from-broker");
			authStorage.keys.setConfig("anthropic", "gateway-bearer");
			expect(authStorage.keys.describe("anthropic")).toBe("config override (models.yml)");
		});
	});
});
