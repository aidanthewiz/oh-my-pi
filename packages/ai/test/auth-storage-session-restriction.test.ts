import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-oauth-restrict";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage session account restrictions", () => {
	let tempDir = "";
	let stores: SqliteAuthCredentialStore[] = [];
	let storage: AuthStorage;
	/** Access tokens the OAuth exchange was asked to serve, in order. */
	let exchanged: string[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-session-restrict-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		stores = [store];
		storage = new AuthStorage(store);
		exchanged = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (credential) exchanged.push(credential.access);
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const store of stores) store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("serves only allowed accounts, over inherited and explicit pins", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		expect(storage.sessions.pin(PROVIDER, "parent", accountB.credentialId)).toBe(true);
		expect(storage.sessions.inherit("parent", "child")).toBe(1);

		storage.sessions.restrict(PROVIDER, "child", ["account:acc-c"]);

		expect(storage.oauth.identity(PROVIDER, "child")?.accountId).toBe("acc-c");
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		expect(storage.sessions.pin(PROVIDER, "child", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-c");
		// Excluded accounts are never ranked, refreshed, or exchanged for the child.
		expect(exchanged).toEqual(["access-c", "access-c"]);
		// The parent keeps its own pin; restrictions are per session.
		expect(await storage.keys.get(PROVIDER, "parent")).toBe("access-b");
	});

	test("skips a runtime key and stored API keys, and fails closed past a config key", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), { type: "api_key", key: "stored-key" }]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");

		storage.sessions.restrict(PROVIDER, "allowed", ["account:acc-a"]);
		const missing = storage.sessions.restrict(PROVIDER, "missing", ["account:acc-z"]);
		storage.sessions.restrict(PROVIDER, "empty", []);

		expect(await storage.keys.get(PROVIDER, "allowed")).toBe("access-a");
		// Metadata, usage attribution, and OAuth-access callers (web search) follow
		// the account the request uses, not the runtime key.
		expect(storage.oauth.identity(PROVIDER, "allowed")?.accountId).toBe("acc-a");
		expect((await storage.oauth.access(PROVIDER, "allowed"))?.accessToken).toBe("access-a");
		for (const sessionId of ["missing", "empty"]) {
			await expect(storage.keys.get(PROVIDER, sessionId)).rejects.toThrow(
				`No API key for provider: ${PROVIDER} (session ${sessionId} is restricted to its OAuth account pool`,
			);
		}
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");

		// The owner lifts a restriction when its session ends.
		storage.sessions.unrestrict(PROVIDER, "missing", missing);
		expect(await storage.keys.get(PROVIDER, "missing")).toBe("runtime-key");

		// A config key marks the provider's endpoint (often a proxy) as taking that
		// key: the pooled session fails rather than sending it an OAuth token.
		storage.keys.setConfig(PROVIDER, "config-key");
		await expect(storage.keys.get(PROVIDER, "allowed")).rejects.toThrow("pooled OAuth tokens are never sent past it");
		expect(await storage.oauth.access(PROVIDER, "allowed")).toBeUndefined();
		expect(storage.oauth.identity(PROVIDER, "allowed")).toBeUndefined();
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("runtime-key");
	});

	test("does not exchange OAuth or use environment-owned transport credentials for a restricted request", async () => {
		await storage.credentials.set("anthropic-aws", oauthCredential("a"));
		storage.keys.setRuntime("anthropic-aws", "runtime-key");
		storage.sessions.restrict("anthropic-aws", "session", ["account:acc-a"]);

		await expect(storage.keys.get("anthropic-aws", "session")).rejects.toThrow("environment credentials");
		expect(await storage.oauth.access("anthropic-aws", "session")).toBeUndefined();
		expect(storage.oauth.identity("anthropic-aws", "session")).toBeUndefined();
		expect(exchanged).toEqual([]);
	});

	test("fails a deny-all request instead of using an environment key", async () => {
		const previousProcess = process.env.OPENAI_API_KEY;
		const previousBun = Bun.env.OPENAI_API_KEY;
		try {
			process.env.OPENAI_API_KEY = "synthetic-env-key";
			Bun.env.OPENAI_API_KEY = "synthetic-env-key";
			storage.sessions.restrict("openai", "empty", []);
			await expect(storage.keys.get("openai", "empty")).rejects.toThrow("restricted to its OAuth account pool");
			expect(await storage.keys.get("openai", "unrestricted")).toBe("synthetic-env-key");
			expect(exchanged).toEqual([]);
		} finally {
			if (previousProcess === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previousProcess;
			if (previousBun === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousBun;
		}
	});

	test("denies config fallback keys and does not copy restrictions with inherited affinity", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setConfig(PROVIDER, "fallback-key", { fallback: true });
		const accountA = storage.oauth.accounts(PROVIDER)[0];
		if (!accountA) throw new Error("expected stored account");
		storage.sessions.pin(PROVIDER, "parent", accountA.credentialId);
		storage.sessions.restrict(PROVIDER, "parent", ["account:acc-a"]);
		expect(storage.sessions.inherit("parent", "child")).toBe(1);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected stored account");
		expect(storage.sessions.pin(PROVIDER, "child", accountB.credentialId)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");

		storage.sessions.restrict(PROVIDER, "empty", []);
		await expect(storage.keys.get(PROVIDER, "empty")).rejects.toThrow("restricted to its OAuth account pool");
		expect(exchanged).toEqual(["access-b"]);
	});

	test("keeps a deny-all restriction when affinity exceeds its LRU capacity", async () => {
		await storage.credentials.set(PROVIDER, oauthCredential("a"));
		const account = storage.oauth.accounts(PROVIDER)[0];
		if (!account) throw new Error("expected stored account");
		storage.sessions.restrict(PROVIDER, "empty", []);
		for (let index = 0; index < 300; index++) {
			storage.sessions.pin(PROVIDER, `session-${index}`, account.credentialId);
		}
		await expect(storage.keys.get(PROVIDER, "empty")).rejects.toThrow("restricted to its OAuth account pool");
		expect(exchanged).toEqual([]);
	});

	test("cannot invalidate or rotate from an excluded bearer", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
		expect(await storage.limits.invalidateMatching(PROVIDER, "access-a", { sessionId: "session" })).toBe(false);
		expect(
			(await storage.limits.markReached(PROVIDER, "session", { apiKey: "access-a", retryAfterMs: 60_000 })).switched,
		).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
		const accountA = storage.oauth.accounts(PROVIDER)[0];
		if (!accountA) throw new Error("expected stored account");
		storage.sessions.pin(PROVIDER, "unrestricted", accountA.credentialId);
		expect(await storage.keys.get(PROVIDER, "unrestricted")).toBe("access-a");
	});

	test("lifts a restriction only with the lease that installed it", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		storage.keys.setRuntime(PROVIDER, "runtime-key");
		const stale = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", stale)).toBe(true);
		expect(storage.sessions.ownsRestriction(PROVIDER, "other-session", stale)).toBe(false);
		expect(storage.sessions.ownsRestriction("other-provider", "session", stale)).toBe(false);
		// A revived owner restricts the same session id again.
		const current = storage.sessions.restrict(PROVIDER, "session", ["account:acc-a"]);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", stale)).toBe(false);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", current)).toBe(true);

		storage.sessions.unrestrict(PROVIDER, "session", stale);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", current)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-a");

		storage.sessions.unrestrict(PROVIDER, "session", current);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", current)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-key");
	});

	test("rotates only among allowed accounts", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);

		const allowedKeys = ["access-a", "access-b"];
		const first = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(first ?? "");
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(true);
		const second = await storage.keys.get(PROVIDER, "session");
		expect(allowedKeys).toContain(second ?? "");
		expect(second).not.toBe(first);

		// Account c is free, but outside the pool: no sibling is left to switch to,
		// and the last-resort pass retries a blocked allowed account instead.
		expect((await storage.limits.markReached(PROVIDER, "session", { retryAfterMs: 60_000 })).switched).toBe(false);
		expect(allowedKeys).toContain((await storage.keys.get(PROVIDER, "session")) ?? "");
	});

	test("honors a blocked explicit pin without escaping the permitted pool", async () => {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		storage.sessions.restrict(PROVIDER, "session", ["account:acc-a", "account:acc-b"]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected stored accounts");
		await storage.limits.markReached(PROVIDER, "session", {
			credentialId: accountA.credentialId,
			retryAfterMs: 60_000,
		});
		await storage.limits.markReached(PROVIDER, "session", {
			credentialId: accountB.credentialId,
			retryAfterMs: 120_000,
		});
		expect(storage.sessions.pin(PROVIDER, "session", accountB.credentialId)).toBe(true);

		expect(await storage.keys.getWithCredential(PROVIDER, "session")).toMatchObject({
			apiKey: "access-b",
			credentialId: accountB.credentialId,
		});
		expect(storage.oauth.identity(PROVIDER, "session")?.accountId).toBe("acc-b");
		expect(exchanged).toEqual(["access-b"]);
	});

	test("keeps restrictions across a credential store replacement", async () => {
		const lease = storage.sessions.restrict(PROVIDER, "session", ["account:acc-b"]);
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		stores.push(replacement);
		await storage.replaceStore(replacement);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", lease)).toBe(true);
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA] = storage.oauth.accounts(PROVIDER);
		if (!accountA) throw new Error("expected stored accounts");

		expect(storage.sessions.pin(PROVIDER, "session", accountA.credentialId)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "session")).toBe("access-b");
		storage.sessions.unrestrict(PROVIDER, "session", lease);
		expect(storage.sessions.ownsRestriction(PROVIDER, "session", lease)).toBe(false);
		storage.keys.setRuntime(PROVIDER, "runtime-after-store-replacement");
		expect(await storage.keys.get(PROVIDER, "session")).toBe("runtime-after-store-replacement");
	});
});
