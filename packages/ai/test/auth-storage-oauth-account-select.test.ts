import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withOAuthAccess } from "@oh-my-pi/pi-ai/auth-retry";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { MissingApiKeyError } from "../src/error/auth";

const PROVIDER = "unit-oauth-select";

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

describe("AuthStorage OAuth account selection", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let authStorage: AuthStorage | null = null;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-select-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		authStorage = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		authStorage = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("oauth.accounts reports stored order, positions, and identity without refreshing", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const refreshSpy = vi.spyOn(oauthUtils, "getOAuthApiKey");
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const accounts = storage.oauth.accounts(PROVIDER);

		expect(accounts.map(a => a.position)).toEqual([0, 1, 2]);
		expect(accounts.map(a => a.accountId)).toEqual(["acc-a", "acc-b", "acc-c"]);
		expect(accounts.map(a => a.email)).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
		// Read-only: listing must not refresh any token.
		expect(refreshSpy).not.toHaveBeenCalled();
	});

	test("model account restrictions preserve row identity after credentials reorder", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const credentialA = oauthCredential("a");
		const credentialB = oauthCredential("b");
		await storage.credentials.set(PROVIDER, [credentialA, credentialB]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected two OAuth accounts");
		await storage.credentials.set(PROVIDER, [
			{ ...credentialB, access: "access-b-rotated" },
			{ ...credentialA, access: "access-a-rotated" },
		]);
		expect(storage.sessions.pin(PROVIDER, "reordered-model", accountA.credentialId)).toBe(true);
		expect(
			await storage.keys.getWithCredential(PROVIDER, "reordered-model", { accountIds: ["acc-b"] }),
		).toMatchObject({ apiKey: "access-b-rotated", credentialId: accountB.credentialId });
	});

	test.each([
		["disappears", "preflight"],
		["changes identity", "preflight"],
		["changes identity", "request preparation"],
		["changes identity", "credential refresh"],
	] as const)("hard pools reject a permitted row that %s during %s", async (transition, phase) => {
		let storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		let armed = false;
		let changed = false;
		if (phase === "request preparation") {
			storage = new AuthStorage(
				new Proxy(credentialStore, {
					get(target, key) {
						if (key === "prepareForRequest") {
							return async () => {
								if (armed) changed = true;
								return true;
							};
						}
						const value = Reflect.get(target, key, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				}),
			);
			authStorage = storage;
		}
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = armed && phase === "credential refresh" ? oauthCredential("c") : credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("b"), oauthCredential("a")]);
		const accountB = storage.oauth.accounts(PROVIDER)[0];
		if (!accountB) throw new Error("expected permitted OAuth account");
		const listCredentials = credentialStore.listAuthCredentials.bind(credentialStore);
		vi.spyOn(credentialStore, "listAuthCredentials").mockImplementation(provider => {
			const rows = listCredentials(provider);
			if (armed && phase === "preflight" && provider === PROVIDER) changed = true;
			if (!changed) return rows;
			return transition === "disappears"
				? rows.filter(row => row.id !== accountB.credentialId)
				: rows.map(row => (row.id === accountB.credentialId ? { ...row, credential: oauthCredential("c") } : row));
		});
		const sessionId = `preflight-${transition}`;
		const lease = storage.sessions.restrict(PROVIDER, sessionId, ["account:acc-b"]);
		try {
			expect(await storage.keys.getWithCredential(PROVIDER, sessionId)).toMatchObject({
				apiKey: "access-b",
				credentialId: accountB.credentialId,
			});
			armed = true;
			await expect(storage.keys.getWithCredential(PROVIDER, sessionId)).rejects.toBeInstanceOf(MissingApiKeyError);
		} finally {
			storage.sessions.unrestrict(PROVIDER, sessionId, lease);
		}
	});

	test("sessions.pin selects and restores the exact stored account", async () => {
		const storage = authStorage;
		const credentialStore = store;
		if (!storage || !credentialStore) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const accounts = storage.oauth.accounts(PROVIDER, "session-pin");
		const target = accounts[1];
		if (!target) throw new Error("expected second OAuth account");

		expect(accounts.some(account => account.active)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", -1)).toBe(false);
		expect(storage.sessions.pin(PROVIDER, "session-pin", target.credentialId)).toBe(true);
		expect(storage.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(
			storage.oauth
				.accounts(PROVIDER, "session-pin")
				.filter(account => account.active)
				.map(account => account.email),
		).toEqual(["b@example.com"]);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "session-pin",
			}),
		).toBe("b@example.com");

		const restored = new AuthStorage(credentialStore);
		await restored.credentials.reload();
		expect(restored.oauth.identity(PROVIDER, "session-pin")?.email).toBe("b@example.com");
		expect(restored.oauth.accounts(PROVIDER, "session-pin").find(account => account.active)?.credentialId).toBe(
			target.credentialId,
		);
	});

	test("inherited session affinity keeps usage rotation on the selected account", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const accountB = storage.oauth.accounts(PROVIDER)[1];
		if (!accountB) throw new Error("expected second OAuth account");
		expect(storage.sessions.pin(PROVIDER, "parent-session", accountB.credentialId)).toBe(true);

		expect(storage.sessions.inherit("parent-session", "child-session")).toBe(1);
		expect(storage.oauth.accounts(PROVIDER, "child-session").find(account => account.active)?.email).toBe(
			"b@example.com",
		);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("b@example.com");

		const outcome = await storage.limits.markReached(PROVIDER, "child-session", { retryAfterMs: 60_000 });
		expect(outcome.switched).toBe(true);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.email), {
				sessionId: "child-session",
			}),
		).toBe("a@example.com");
	});

	test("filtered inheritance preserves a child's automatic affinity but applies an explicit parent pin", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [accountA, accountB] = storage.oauth.accounts(PROVIDER);
		if (!accountA || !accountB) throw new Error("expected two OAuth accounts");
		storage.sessions.pin(PROVIDER, "parent-filtered", accountB.credentialId, { restoredAtMs: Date.now() });
		storage.sessions.pin(PROVIDER, "child-filtered", accountA.credentialId, { restoredAtMs: Date.now() });
		const include = (provider: string, explicit: boolean) => provider === PROVIDER && explicit;

		storage.sessions.inherit("parent-filtered", "child-filtered", include);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.accessToken), {
				sessionId: "child-filtered",
			}),
		).toBe("access-a");

		storage.sessions.pin(PROVIDER, "parent-filtered", accountB.credentialId);
		storage.sessions.inherit("parent-filtered", "child-filtered", include);
		expect(
			await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.accessToken), {
				sessionId: "child-filtered",
			}),
		).toBe("access-b");

		const lease = storage.sessions.restrict(PROVIDER, "restricted-child", ["account:acc-a"]);
		try {
			storage.sessions.inherit("parent-filtered", "restricted-child", include);
			expect(
				await withOAuthAccess(storage, PROVIDER, access => Promise.resolve(access.accessToken), {
					sessionId: "restricted-child",
				}),
			).toBe("access-a");
		} finally {
			storage.sessions.unrestrict(PROVIDER, "restricted-child", lease);
		}
	});

	test("tries undiscovered accounts before reusing rate-limited discovery matches", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const accounts = ["a", "b", "c", "d", "e", "f", "g"];
		await storage.credentials.set(PROVIDER, accounts.map(oauthCredential));
		const options = { accountIds: ["acc-a", "acc-b"] };
		const sessionId = "partial-discovery-failover";
		const attempted: string[] = [];
		const error = new ProviderHttpError(
			"This request would exceed your account's rate limit. Please try again later. retry-after-ms=13724000",
			429,
		);

		for (const _account of accounts) {
			const key = await storage.keys.get(PROVIDER, sessionId, options);
			if (!key) throw new Error("expected a stored account");
			attempted.push(key);
			const rotation = await storage.limits.rotate(PROVIDER, sessionId, { error, apiKey: key });
			expect(rotation.switched).toBe(attempted.length < accounts.length);
		}

		expect(new Set(attempted)).toEqual(new Set(accounts.map(account => `access-${account}`)));
		expect(new Set(attempted.slice(0, 2))).toEqual(new Set(["access-a", "access-b"]));
		// With every account blocked, the normal last-resort lookup still prefers discovery matches.
		expect(await storage.keys.get(PROVIDER, sessionId, options)).toMatch(/^access-[ab]$/);
	});

	test("resolves the account at the requested position by ID and touches only that one", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		for (const [position, suffix] of [
			[0, "a"],
			[1, "b"],
			[2, "c"],
		] as const) {
			seen.length = 0;
			const account = storage.oauth.accounts(PROVIDER)[position];
			if (!account) throw new Error("expected OAuth account at position");
			const result = await storage.oauth.accessById(PROVIDER, account.credentialId);
			expect(result?.ok).toBe(true);
			if (!result?.ok) throw new Error("expected ok resolution");
			expect(result.accountId).toBe(`acc-${suffix}`);
			expect(result.accessToken).toBe(`access-${suffix}`);
			// Only the targeted credential is resolved — no sibling is touched.
			expect(seen).toEqual([`access-${suffix}`]);
		}
	});

	test("oauth.accessById force-refreshes only the durable requested row", async () => {
		if (!store) throw new Error("test setup failed");
		const refreshedIds: number[] = [];
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, credentialId, credential) => {
				refreshedIds.push(credentialId);
				return {
					access: `${credential.access}-reminted`,
					refresh: credential.refresh,
					expires: Date.now() + 60 * 60_000,
					accountId: credential.accountId,
					email: credential.email,
				};
			},
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");

		const result = await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });

		expect(result).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
		expect(refreshedIds).toEqual([target.credentialId]);
		expect(
			store.listAuthCredentials(PROVIDER).map(row => (row.credential.type === "oauth" ? row.credential.access : "")),
		).toEqual(["access-a", "access-b-reminted", "access-c"]);

		// Without forceRefresh the still-fresh row is served as stored.
		const again = await storage.oauth.accessById(PROVIDER, target.credentialId);
		expect(again).toMatchObject({ ok: true, accessToken: "access-b-reminted" });
		expect(refreshedIds).toEqual([target.credentialId]);
	});

	test("oauth.accessById force refresh keeps the requested account when a lower row is removed meanwhile", async () => {
		if (!store) throw new Error("test setup failed");
		const storage = new AuthStorage(store, {
			refreshOAuthCredential: async (_provider, _credentialId, credential) => ({
				...credential,
				access: `${credential.access}-reminted`,
				expires: Date.now() + 60 * 60_000,
			}),
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);
		const [lower, target] = storage.oauth.accounts(PROVIDER);
		if (!lower || !target) throw new Error("expected three OAuth accounts");

		// Another process holds the target's refresh lease and disables the lower row before releasing it,
		// so the forced refresh re-lists the provider's rows without that row.
		expect(store.tryAcquireCredentialRefreshLease(target.credentialId, "peer", Date.now() + 60_000)).toBe(true);
		const pending = storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true });
		await store.deleteAuthCredential(lower.credentialId, "oauth refresh failed: invalid_grant");
		store.releaseCredentialRefreshLease(target.credentialId, "peer");

		expect(await pending).toMatchObject({
			ok: true,
			credentialId: target.credentialId,
			accountId: "acc-b",
			accessToken: "access-b-reminted",
		});
	});

	test("oauth.accessById auth-recovery force reuses this process's recent mint", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		let mints = 0;
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async (_provider, credential) => {
			mints += 1;
			return { ...credential, access: `access-b-mint-${mints}`, expires: Date.now() + 60 * 60_000 };
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const target = storage.oauth.accounts(PROVIDER)[1];
		if (!target) throw new Error("expected second OAuth account");
		const recovery = { forceRefresh: true, refreshReason: "auth-recovery" as const };

		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, recovery)).toMatchObject({
			accessToken: "access-b-mint-1",
		});
		expect(mints).toBe(1);
		// A generic forced refresh still mints.
		expect(await storage.oauth.accessById(PROVIDER, target.credentialId, { forceRefresh: true })).toMatchObject({
			accessToken: "access-b-mint-2",
		});
	});

	test("resolving the selected account by ID fails without touching siblings", async () => {
		const storage = authStorage;
		if (!storage) throw new Error("test setup failed");
		// The targeted account (acc-b) fails definitively; siblings would refresh fine.
		const seen: string[] = [];
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			if (!credential) return null;
			seen.push(credential.access);
			if (credential.access === "access-b") throw new Error("invalid_grant");
			return { newCredentials: credential, apiKey: credential.access };
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b"), oauthCredential("c")]);

		const account = storage.oauth.accounts(PROVIDER)[1];
		if (!account) throw new Error("expected second OAuth account");
		const result = await storage.oauth.accessById(PROVIDER, account.credentialId);

		expect(result?.ok).toBe(false);
		if (!result || result.ok) throw new Error("expected failed resolution");
		// Reports the requested account, never a sibling's token.
		expect(result.accountId).toBe("acc-b");
		expect("accessToken" in result).toBe(false);
		// Target-only: no sibling credential was refreshed/rotated on the failure path.
		expect(seen).toEqual(["access-b"]);
	});
});
