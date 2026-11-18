import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import type { OAuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { kiroModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { encodeKiroOAuthRow } from "@oh-my-pi/pi-catalog/wire/kiro";
import { resolveOAuthDiscoveryAccounts } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const AUTO = { modelId: "auto", tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 } };
const OPUS = { modelId: "claude-opus-5.5", tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 } };
const ROSTERS: Record<string, unknown[]> = { "Bearer token-free": [AUTO], "Bearer token-pro": [AUTO, OPUS] };

let tempDir: string;
let authStorage: AuthStorage;

beforeEach(async () => {
	tempDir = path.join(os.tmpdir(), `pi-test-kiro-accounts-${Snowflake.next()}`);
	await fs.promises.mkdir(tempDir, { recursive: true });
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(() => {
	authStorage.close();
	if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
});

test("Kiro discovery lists every login's models and routes each to a login serving it", async () => {
	await authStorage.credentials.set(
		"kiro",
		["free", "pro"].map((plan): OAuthCredential => ({
			type: "oauth",
			access: `token-${plan}`,
			refresh: `refresh-${plan}`,
			expires: Date.now() + 3_600_000,
			accountId: `login-${plan}`,
			region: "us-east-1",
		})),
	);
	const fetchMock: FetchImpl = async (_input, init) => {
		const models = ROSTERS[new Headers(init?.headers).get("authorization") ?? ""];
		return models ? Response.json({ models }) : new Response("Unauthorized", { status: 401 });
	};
	const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: fetchMock });

	await registry.refreshProvider("kiro", "online");

	const opus = registry.find("kiro", "claude-opus-5.5");
	expect(opus?.accountAccess).toEqual({ "login-pro": {} });
	const free = authStorage.oauth.accounts("kiro").find(account => account.accountId === "login-free");
	if (!free || !opus) throw new Error("expected the Free login and Claude Opus 5.5");
	expect(authStorage.sessions.pin("kiro", "kiro-opus-session", free.credentialId)).toBe(true);
	expect(await registry.getApiKey(opus, "kiro-opus-session")).toContain('"token":"token-pro"');
});

test("Kiro cached unions follow account membership and routes, not token rotation or account order", async () => {
	const credentials: OAuthCredential[] = ["free", "pro"].map(plan => ({
		type: "oauth",
		access: `token-${plan}`,
		refresh: `refresh-${plan}`,
		expires: Date.now() + 3_600_000,
		accountId: `login-${plan}`,
		region: "us-east-1",
	}));
	await authStorage.credentials.set("kiro", credentials);
	let fetchCount = 0;
	const fetchMock: FetchImpl = async (_input, init) => {
		fetchCount++;
		const models = ROSTERS[new Headers(init?.headers).get("authorization") ?? ""];
		return models ? Response.json({ models }) : new Response("Unauthorized", { status: 401 });
	};
	const refresh = async (strategy: "online" | "offline") => {
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.json"), { fetch: fetchMock });
		await registry.refreshProvider("kiro", strategy);
		return registry;
	};
	const online = await refresh("online");
	expect(online.find("kiro", "claude-opus-5.5")?.accountAccess).toEqual({ "login-pro": {} });
	expect(fetchCount).toBe(2);
	const restored = await refresh("offline");
	expect(restored.find("kiro", "claude-opus-5.5")?.accountAccess).toEqual({ "login-pro": {} });

	const rotated = [...credentials].reverse().map(credential => ({
		...credential,
		access: `${credential.access}-rotated`,
	}));
	await authStorage.credentials.set("kiro", rotated);
	const reordered = await refresh("offline");
	expect(reordered.find("kiro", "claude-opus-5.5")?.accountAccess).toEqual({ "login-pro": {} });
	expect(reordered.find("kiro", "auto")?.accountAccess).toEqual({ "login-free": {}, "login-pro": {} });

	await authStorage.credentials.remove("kiro");
	await authStorage.credentials.set(
		"kiro",
		rotated.map(credential =>
			credential.accountId === "login-pro" ? { ...credential, region: "eu-central-1" } : credential,
		),
	);
	const rerouted = await refresh("offline");
	expect(rerouted.getAll().filter(model => model.provider === "kiro")).toEqual([]);
	await authStorage.credentials.set("kiro", credentials.slice(0, 1));
	const removed = await refresh("offline");
	expect(removed.getAll().filter(model => model.provider === "kiro")).toEqual([]);
	expect(fetchCount).toBe(2);
	const single = await refresh("online");
	expect(single.find("kiro", "auto")?.accountAccess).toEqual({ "login-free": {} });
	expect(single.find("kiro", "claude-opus-5.5")).toBeUndefined();
	expect(fetchCount).toBe(3);
});

test("Kiro discovery does not append an encoded preflight key after its stored login refreshes", async () => {
	await authStorage.close();
	let refreshCount = 0;
	authStorage = await AuthStorage.create(":memory:", {
		refreshOAuthCredential: async (_provider, _credentialId, credential) => {
			refreshCount++;
			return { ...credential, access: "token-fresh", expires: Date.now() + 3_600_000 };
		},
	});
	const credential: OAuthCredential = {
		type: "oauth",
		access: "token-expired",
		refresh: "refresh-only",
		expires: Date.now() - 60_000,
		accountId: "login-only",
		region: "us-east-1",
	};
	await authStorage.credentials.set("kiro", credential);
	const preflightKey = encodeKiroOAuthRow(credential);
	const options = kiroModelManagerOptions({
		apiKey: preflightKey,
		resolveAccounts: async () => {
			const accounts = await resolveOAuthDiscoveryAccounts(authStorage, "kiro", preflightKey);
			return accounts?.map(account => ({ apiKey: account.apiKey, accountKey: account.accountId })) ?? null;
		},
		fetch: async (_input, init) =>
			new Headers(init?.headers).get("authorization") === "Bearer token-fresh"
				? Response.json({ models: [OPUS] })
				: new Response("Unavailable", { status: 503 }),
	});
	const models = await options.fetchDynamicModels?.();
	expect(models?.find(model => model.id === "claude-opus-5.5")?.accountAccess).toEqual({ "login-only": {} });
	expect(refreshCount).toBe(1);
});
