import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AuthAccountPolicies, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { fetchCursorAccountEmail } from "@oh-my-pi/pi-ai/registry/oauth/cursor";
import { removeWithRetries } from "../../utils/src/temp";

const EMAIL = "dev@example.com";
const POLICIES = [{ provider: "cursor", account: { email: EMAIL }, priority: -1 }] satisfies AuthAccountPolicies;

function cursorAccessToken(label: string): string {
	const claims = { sub: "github|user_1", exp: Math.floor(Date.now() / 1000) + 86_400, label };
	const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
	return `header.${payload}.signature`;
}

/** Cursor's session renewal: `renewed` for the IDE's refresh grant on `session`; every other session is signed out. */
function renewCursorSession(init: RequestInit | undefined, session: string | undefined, renewed: string): Response {
	const body = JSON.parse(String(init?.body));
	if (
		body.grant_type === "refresh_token" &&
		body.client_id === "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB" &&
		body.refresh_token === session
	) {
		return Response.json({ access_token: renewed, id_token: "", shouldLogout: false });
	}
	return Response.json({ access_token: "", id_token: "", shouldLogout: true });
}

/** Answer Cursor's login poll with `access`, renew `session` into `access`, and answer its profile with the account email. */
function stubCursor(access: string, session?: string): void {
	vi.spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === "https://cursor.com/api/auth/me") return Response.json({ sub: "user_1", email: EMAIL });
		if (url.startsWith("https://api2.cursor.sh/auth/poll?")) {
			return Response.json({ accessToken: access, refreshToken: access });
		}
		if (url === "https://api2.cursor.sh/oauth/token") return renewCursorSession(init, session, access);
		throw new Error(`unexpected request: ${url}`);
	}) as typeof fetch);
}

let dir = "";
let savedAccessToken: string | undefined;

beforeEach(() => {
	savedAccessToken = process.env.CURSOR_ACCESS_TOKEN;
	delete process.env.CURSOR_ACCESS_TOKEN;
});

afterEach(async () => {
	vi.restoreAllMocks();
	if (savedAccessToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
	else process.env.CURSOR_ACCESS_TOKEN = savedAccessToken;
	if (dir) await removeWithRetries(dir);
	dir = "";
});

describe("Cursor account email", () => {
	test("rejects a profile email belonging to another token subject", async () => {
		const token = cursorAccessToken("profile");
		expect(
			await fetchCursorAccountEmail(token, async () => Response.json({ sub: "other_user", email: EMAIL })),
		).toBeUndefined();
		expect(
			await fetchCursorAccountEmail(token, async () => Response.json({ sub: "user_1", email: ` ${EMAIL} ` })),
		).toBe(EMAIL);
	});

	test("a Cursor login stores the email an account policy selects", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-login-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const auth = new AuthStorage(store, { accountPolicies: POLICIES });
		try {
			vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
			stubCursor(cursorAccessToken("login"));

			await auth.oauth.login("cursor", { onAuth() {}, onPrompt: async () => "" });

			expect(auth.oauth.accounts("cursor").map(account => account.email)).toEqual([EMAIL]);
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a Cursor login stored without an email gains it at the next token refresh", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-refresh-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const stale = cursorAccessToken("stale");
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: stale,
			refresh: stale,
			expires: Date.now() - 1,
		});
		const auth = new AuthStorage(store);
		const restarted = new AuthStorage(store, { accountPolicies: POLICIES });
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			stubCursor(fresh, stale);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);

			await restarted.credentials.reload();
			expect(restarted.oauth.accounts("cursor").map(account => account.email)).toEqual([EMAIL]);
		} finally {
			auth.close();
			restarted.close();
			store.close();
		}
	});

	test("a stalled profile lookup still keeps the tokens a refresh minted", async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-stall-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		const stale = cursorAccessToken("stale");
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: stale,
			refresh: stale,
			expires: Date.now() - 1,
		});
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			const profileDeadline = new AbortController();
			vi.spyOn(AbortSignal, "timeout").mockReturnValue(profileDeadline.signal);
			vi.spyOn(globalThis, "fetch").mockImplementation((async (
				input: string | URL | Request,
				init?: RequestInit,
			) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === "https://api2.cursor.sh/oauth/token") return renewCursorSession(init, stale, fresh);
				if (url !== "https://cursor.com/api/auth/me") throw new Error(`unexpected request: ${url}`);
				// The profile never answers; only the lookup's own deadline ends it.
				const { promise, reject } = Promise.withResolvers<Response>();
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				profileDeadline.abort();
				return promise;
			}) as typeof fetch);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
		} finally {
			auth.close();
			store.close();
		}
	});
});

describe("Cursor session refresh", () => {
	async function storeExpiredSession(session: string): Promise<SqliteAuthCredentialStore> {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cursor-session-"));
		const store = await SqliteAuthCredentialStore.open(path.join(dir, "agent.db"));
		await store.upsertAuthCredential("cursor", {
			type: "oauth",
			access: cursorAccessToken("expired-access"),
			refresh: session,
			expires: Date.now() - 1,
			email: EMAIL,
		});
		return store;
	}

	test("an expired Cursor login renews its access token and keeps its refresh token", async () => {
		const stale = cursorAccessToken("stale");
		const store = await storeExpiredSession(stale);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			stubCursor(fresh, stale);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
			expect(store.listAuthCredentials("cursor").map(row => row.credential)).toMatchObject([
				{ type: "oauth", access: fresh, refresh: stale, email: EMAIL },
			]);
			const payload: unknown = JSON.parse(atob(fresh.split(".")[1]!));
			if (
				typeof payload !== "object" ||
				payload === null ||
				!("exp" in payload) ||
				typeof payload.exp !== "number"
			) {
				throw new Error("expected expiry claim");
			}
			expect(store.listAuthCredentials("cursor")[0]?.credential).toMatchObject({
				expires: payload.exp * 1000 - 5 * 60 * 1000,
			});
		} finally {
			auth.close();
			store.close();
		}
	});

	test("a renewal that rotates the refresh token stores the rotated one", async () => {
		const stale = cursorAccessToken("stale");
		const store = await storeExpiredSession(stale);
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			const fresh = cursorAccessToken("fresh");
			const rotated = cursorAccessToken("rotated");
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({ access_token: fresh, refresh_token: rotated, shouldLogout: false }),
			);

			expect(await auth.keys.get("cursor", "session")).toBe(fresh);
			expect(store.listAuthCredentials("cursor").map(row => row.credential)).toMatchObject([
				{ type: "oauth", access: fresh, refresh: rotated },
			]);
		} finally {
			auth.close();
			store.close();
		}
	});

	test.each([false, true])("shouldLogout disables a session even with an access token present=%p", async hasToken => {
		const store = await storeExpiredSession(cursorAccessToken("ended"));
		const auth = new AuthStorage(store);
		try {
			await auth.credentials.reload();
			vi.spyOn(globalThis, "fetch").mockResolvedValue(
				Response.json({ access_token: hasToken ? cursorAccessToken("fresh") : "", shouldLogout: true }),
			);

			expect(await auth.keys.get("cursor", "session")).toBeUndefined();
			expect(store.listAuthCredentials("cursor")).toEqual([]);
			expect(await store.listDisabledCredentials("cursor")).toHaveLength(1);
		} finally {
			auth.close();
			store.close();
		}
	});

	test.each(["missing-token", "http-503", "network"] as const)(
		"a transient renewal failure keeps the stored session active (%s)",
		async failure => {
			const stale = cursorAccessToken("stale");
			const store = await storeExpiredSession(stale);
			const original = store.listAuthCredentials("cursor").map(row => row.credential);
			const auth = new AuthStorage(store);
			try {
				await auth.credentials.reload();
				const implementation = Object.assign(
					async () => {
						if (failure === "network") throw new TypeError("connection closed");
						if (failure === "http-503") return new Response("service unavailable", { status: 503 });
						return Response.json({ access_token: "", id_token: "", shouldLogout: false });
					},
					{ preconnect: fetch.preconnect },
				);
				vi.spyOn(globalThis, "fetch").mockImplementation(implementation);

				expect(await auth.keys.get("cursor", "session")).toBeUndefined();
				expect(store.listAuthCredentials("cursor").map(row => row.credential)).toEqual(original);
				expect(await store.listDisabledCredentials("cursor")).toEqual([]);
			} finally {
				auth.close();
				store.close();
			}
		},
	);
});
