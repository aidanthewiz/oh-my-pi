import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "@oh-my-pi/pi-utils";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "../src/auth-broker";
import { AuthStorage, SqliteAuthCredentialStore } from "../src/auth-storage";
import { isDefinitiveOAuthFailure } from "../src/error";
import * as agyBinary from "../src/providers/antigravity-cli/binary";
import {
	AGY_OAUTH_CLIENT_ID,
	agyCredentialEnv,
	agyCredentialKey,
	agyCredentialVersion,
	exportAgyCredentials,
	parseAgyApiKey,
	parseAgyStoredCredentials,
	refreshAgyCredentials,
	stageAgyCredentials,
} from "../src/providers/antigravity-cli/credentials";
import * as registry from "../src/registry";
import { AgyAuthUrlParser, agyAuthorizationCode } from "../src/registry/oauth/antigravity-cli";
import { getOAuthApiKey } from "../src/registry/oauth";
import type { OAuthCredentials } from "../src/registry/oauth/types";

const directories: string[] = [];
const credentialReleases: (() => Promise<void>)[] = [];
const authStorages: AuthStorage[] = [];
const grant: OAuthCredentials = {
	access: "fixture-access",
	refresh: "fixture-refresh",
	expires: Date.now() + 3_600_000,
	email: "account@example.test",
	accountId: "fixture-account",
};
const idToken = `header.${Buffer.from(JSON.stringify({ sub: grant.accountId, email: grant.email })).toString("base64url")}.signature`;
const stored = {
	token: {
		access_token: grant.access,
		refresh_token: grant.refresh,
		token_type: "Bearer",
		expiry: new Date(grant.expires).toISOString(),
	},
	auth_method: "consumer",
	id_token: idToken,
};
const apiKey = JSON.stringify({
	token: grant.access,
	refreshToken: grant.refresh,
	expiresAt: grant.expires,
	email: grant.email,
	accountId: grant.accountId,
});

afterEach(async () => {
	try {
		for (const release of credentialReleases.splice(0).reverse()) await release();
		for (const storage of authStorages.splice(0)) await storage.close();
		await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	} finally {
		vi.restoreAllMocks();
	}
});

describe("Antigravity CLI credential ownership", () => {
	it("exports a real refreshable native consumer grant and identity", () => {
		expect(parseAgyStoredCredentials(stored)).toEqual(grant);
	});

	it("exports the ACP id_token_email shape without requiring the older standalone ID token", () => {
		const credentials = parseAgyStoredCredentials({
			token: stored.token,
			auth_method: "consumer",
			id_token_email: grant.email,
		});
		expect(credentials.access).toBe(grant.access);
		expect(credentials.refresh).toBe(grant.refresh);
		expect(credentials.email).toBe(grant.email);
		expect(credentials.accountId).toBeUndefined();
		const emailOnly = JSON.stringify({ ...JSON.parse(apiKey), accountId: undefined });
		expect(agyCredentialKey(emailOnly)).toBe(agyCredentialKey(apiKey));
	});

	it("rejects non-consumer, missing, corrupt and non-refreshable grants without echoing secrets", () => {
		for (const value of [
			null,
			{ ...stored, auth_method: "business" },
			{ ...stored, token: { ...stored.token, refresh_token: "" } },
			{ ...stored, token: { ...stored.token, refresh_token: "__remote__" } },
			{ ...stored, token: { ...stored.token, expiry: "secret-invalid-expiry" } },
		]) {
			expect(() => parseAgyStoredCredentials(value)).toThrow();
		}
		try {
			parseAgyApiKey("not-json-secret");
			throw new Error("unexpected success");
		} catch (error) {
			expect(String(error)).not.toContain("not-json-secret");
		}
		expect(() => parseAgyApiKey("agy-keychain")).toThrow();
		expect(() => parseAgyApiKey(JSON.stringify({ token: "secret" }))).toThrow();
	});

	it("keeps account ownership stable across rotations and changes host revisions", () => {
		const rotated = JSON.stringify({
			...JSON.parse(apiKey),
			token: "rotated-access",
			refreshToken: "rotated-refresh",
		});
		expect(agyCredentialKey(rotated)).toBe(agyCredentialKey(apiKey));
		expect(agyCredentialVersion(rotated)).not.toBe(agyCredentialVersion(apiKey));
		const other = JSON.stringify({
			...JSON.parse(apiKey),
			accountId: "another-account",
			email: "other@example.test",
		});
		expect(agyCredentialKey(other)).not.toBe(agyCredentialKey(apiKey));
		const emailOnly = { ...JSON.parse(apiKey), accountId: undefined };
		expect(agyCredentialKey(JSON.stringify({ ...emailOnly, email: "ACCOUNT@EXAMPLE.TEST" }))).toBe(
			agyCredentialKey(JSON.stringify(emailOnly)),
		);
		expect(() => agyCredentialKey(JSON.stringify({ ...emailOnly, email: undefined }))).toThrow();
	});

	it("stages a private complete native file and atomically replaces it without changing another account", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-credentials-"));
		directories.push(directory);
		const account = path.join(directory, agyCredentialKey(apiKey));
		const releaseOriginal = await stageAgyCredentials(apiKey, account);
		credentialReleases.push(releaseOriginal);
		const tokenPath = path.join(account, "antigravity-cli", "antigravity-oauth-token");
		const previous = await fs.open(tokenPath, "r");
		try {
			credentialReleases.push(
				await stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), token: "new-access" }), account),
			);
			await releaseOriginal();
			expect(JSON.parse(await previous.readFile("utf8")).token.access_token).toBe(grant.access);
			expect((await exportAgyCredentials(account)).access).toBe("new-access");
		} finally {
			await previous.close();
		}
		if (process.platform !== "win32") {
			expect((await fs.stat(account)).mode & 0o777).toBe(0o700);
			expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);
		}
		expect((await fs.readdir(path.join(account, "antigravity-cli"))).filter(name => name.endsWith(".tmp"))).toEqual(
			[],
		);
		const otherKey = JSON.stringify({
			...JSON.parse(apiKey),
			accountId: "second",
			email: "second@example.test",
			token: "second-access",
		});
		const otherAccount = path.join(directory, agyCredentialKey(otherKey));
		credentialReleases.push(await stageAgyCredentials(otherKey, otherAccount));
		expect((await exportAgyCredentials(account)).access).toBe("new-access");
		expect((await exportAgyCredentials(otherAccount)).access).toBe("second-access");
	});

	it("preserves a staging error after complete cleanup and permits the next native lease", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-staging-recovery-"));
		directories.push(directory);
		const failure = Object.assign(new Error("synthetic staged-file read failure"), { code: "EACCES" });
		const read = vi.spyOn(fs, "readFile").mockRejectedValueOnce(failure);
		try {
			await expect(stageAgyCredentials(apiKey, directory)).rejects.toBe(failure);
		} finally {
			read.mockRestore();
		}
		expect(await fs.readdir(path.join(directory, "antigravity-cli"))).toEqual([]);
		const release = await stageAgyCredentials(apiKey, directory);
		credentialReleases.push(release);
		expect((await exportAgyCredentials(directory)).refresh).toBe(grant.refresh);
		await release();
		await expect(fs.stat(path.join(directory, "antigravity-cli", "antigravity-oauth-token"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("renders broker credentials with the local structured policy before staging", async () => {
		const result = await getOAuthApiKey("antigravity-cli", {
			"antigravity-cli": { ...grant, refresh: "__remote__" },
		});
		expect(result).not.toBeNull();
		expect(parseAgyApiKey(result!.apiKey)).toEqual({ ...grant, refresh: "__remote__" });
	});

	it("never stages the broker's refresh sentinel or mutates the parent environment", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agy-broker-"));
		directories.push(directory);
		const before = process.env.SSH_TTY;
		expect(agyCredentialEnv()).toEqual({ SSH_TTY: "omp-agy-file-auth" });
		expect(process.env.SSH_TTY).toBe(before);
		credentialReleases.push(
			await stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), refreshToken: "__remote__" }), directory),
		);
		const contents = await fs.readFile(path.join(directory, "antigravity-cli", "antigravity-oauth-token"), "utf8");
		expect(contents).not.toContain("__remote__");
		expect(JSON.parse(contents).token.refresh_token).toBeUndefined();
		await expect(
			stageAgyCredentials(JSON.stringify({ ...JSON.parse(apiKey), expiresAt: 1 }), directory),
		).rejects.toThrow("refreshed");
	});
});

async function accountFixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-account-removal-"));
	directories.push(root);
	vi.spyOn(agyBinary, "agyGeminiDir").mockReturnValue(root);
	const store = await SqliteAuthCredentialStore.open(path.join(root, "agent.db"));
	const storage = new AuthStorage(store);
	authStorages.push(storage);
	const credential = { type: "oauth" as const, ...grant };
	await storage.credentials.set("antigravity-cli", credential);
	const row = storage.credentials.list("antigravity-cli")[0];
	if (!row) throw new Error("Missing synthetic account");
	const directory = path.join(root, agyCredentialKey(apiKey));
	const file = path.join(directory, "antigravity-cli", "antigravity-oauth-token");
	return { root, store, storage, credential, row, directory, file };
}

describe("Antigravity CLI account removal", () => {
	it("preserves an account added during provider logout", async () => {
		const state = await accountFixture();
		await fs.mkdir(state.directory, { recursive: true });
		const lock = await acquireFileLock(path.join(state.directory, ".credential-ownership"));
		const removing = state.storage.credentials.remove("antigravity-cli");
		try {
			const sibling = {
				...state.credential,
				access: "new-account-access",
				refresh: "new-account-refresh",
				email: "new-account@example.test",
				accountId: "new-account",
			};
			await state.store.upsertAuthCredential("antigravity-cli", sibling);
			const siblingDirectory = path.join(state.root, agyCredentialKey(sibling));
			const release = await stageAgyCredentials(
				JSON.stringify({
					token: sibling.access,
					refreshToken: sibling.refresh,
					expiresAt: sibling.expires,
					email: sibling.email,
					accountId: sibling.accountId,
				}),
				siblingDirectory,
			);
			credentialReleases.push(release);
			lock.release();
			await removing;
			expect(state.store.listAuthCredentials("antigravity-cli").map(row => row.credential)).toEqual([sibling]);
			expect(state.storage.credentials.list("antigravity-cli").map(row => row.credential)).toEqual([sibling]);
			expect(await exportAgyCredentials(siblingDirectory)).toEqual({
				access: sibling.access,
				refresh: sibling.refresh,
				expires: sibling.expires,
				email: sibling.email,
				accountId: undefined,
			});
		} finally {
			lock.release();
			await removing;
		}
	});

	it("reauthenticates through a broker-redacted grant without staging its refresh sentinel", async () => {
		const state = await accountFixture();
		const token = "synthetic-antigravity-broker";
		const broker = startAuthBroker({
			storage: state.storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
		let clientStorage: AuthStorage | undefined;
		try {
			const client = new AuthBrokerClient({ url: broker.url, token });
			const initial = await client.fetchSnapshot();
			if (initial.status !== 200) throw new Error("Missing initial broker snapshot");
			clientStorage = new AuthStorage(new RemoteAuthCredentialStore({ client, initialSnapshot: initial.snapshot }));
			await clientStorage.credentials.reload();
			expect(await clientStorage.credentials.removeById("antigravity-cli", state.row.id)).toBe(true);
			const definition = registry.getProviderDefinition("antigravity-cli");
			if (!definition) throw new Error("Missing Antigravity login definition");
			const authenticated = { ...grant, access: "broker-access", refresh: "broker-refresh" };
			vi.spyOn(registry, "getProviderDefinition").mockReturnValue({
				...definition,
				login: async () => authenticated,
			});
			await clientStorage.oauth.login("antigravity-cli", { onAuth: () => {}, onPrompt: async () => "yes" });
			const credential = clientStorage.credentials.list("antigravity-cli")[0]?.credential;
			if (credential?.type !== "oauth") throw new Error("Missing saved broker login");
			const resolved = await getOAuthApiKey("antigravity-cli", { "antigravity-cli": credential });
			if (!resolved) throw new Error("Missing broker API grant");
			const release = await stageAgyCredentials(resolved.apiKey, state.directory);
			credentialReleases.push(release);
			const staged = JSON.parse(await fs.readFile(state.file, "utf8")).token;
			expect(staged.access_token).toBe(authenticated.access);
			expect(staged.refresh_token).toBeUndefined();
			expect(state.store.listAuthCredentials("antigravity-cli")[0]?.credential).toMatchObject(authenticated);
		} finally {
			await clientStorage?.close();
			await broker.close();
		}
	});

	it("refuses a foreign live owner without deleting the durable account, then succeeds after actual release", async () => {
		const state = await accountFixture();
		const release = await stageAgyCredentials(apiKey, state.directory);
		credentialReleases.push(release);
		const staged = await fs.readFile(state.file, "utf8");
		await expect(state.storage.credentials.removeById("antigravity-cli", state.row.id)).rejects.toThrow(
			"still running in another runtime",
		);
		expect(state.store.listAuthCredentials("antigravity-cli").map(row => row.credential)).toEqual([state.credential]);
		expect(await fs.readFile(state.file, "utf8")).toBe(staged);
		await release();
		expect(await state.storage.credentials.removeById("antigravity-cli", state.row.id)).toBe(true);
		expect(state.store.listAuthCredentials("antigravity-cli")).toEqual([]);
		await expect(fs.stat(state.file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects a delayed staging acquisition queued behind successful durable removal", async () => {
		const state = await accountFixture();
		const deleting = Promise.withResolvers<void>();
		const finishDeletion = Promise.withResolvers<void>();
		const remove = state.store.deleteAuthCredential.bind(state.store);
		vi.spyOn(state.store, "deleteAuthCredential").mockImplementation(async (id, cause) => {
			deleting.resolve();
			await finishDeletion.promise;
			return remove(id, cause);
		});
		const removing = state.storage.credentials.removeById("antigravity-cli", state.row.id);
		await deleting.promise;
		const delayed = stageAgyCredentials(apiKey, state.directory);
		void delayed.catch(() => undefined);
		finishDeletion.resolve();
		expect(await removing).toBe(true);
		await expect(delayed).rejects.toThrow("account was removed");
		await expect(fs.stat(state.file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retains the account fence and reports a durable deletion failure", async () => {
		const state = await accountFixture();
		vi.spyOn(state.store, "deleteAuthCredential").mockRejectedValueOnce(new Error("synthetic store failure"));
		await expect(state.storage.credentials.removeById("antigravity-cli", state.row.id)).rejects.toThrow(
			"synthetic store failure",
		);
		expect(state.store.listAuthCredentials("antigravity-cli").map(row => row.credential)).toEqual([state.credential]);
		await expect(stageAgyCredentials(apiKey, state.directory)).rejects.toThrow("account was removed");
		expect(await state.storage.credentials.removeById("antigravity-cli", state.row.id)).toBe(true);
	});

	it("does not delete the durable account when the filesystem cannot establish its removal fence", async () => {
		const state = await accountFixture();
		await fs.mkdir(path.join(state.directory, ".credentials-removed"), { recursive: true });
		await expect(state.storage.credentials.removeById("antigravity-cli", state.row.id)).rejects.toThrow();
		expect(state.store.listAuthCredentials("antigravity-cli").map(row => row.credential)).toEqual([state.credential]);
		await expect(stageAgyCredentials(apiKey, state.directory)).rejects.toThrow("account was removed");
	});

	it("allows only a durably saved explicit login to reopen staging, not a delayed credential update", async () => {
		const state = await accountFixture();
		expect(await state.storage.credentials.removeById("antigravity-cli", state.row.id)).toBe(true);
		await state.storage.credentials.set("antigravity-cli", state.credential);
		await expect(stageAgyCredentials(apiKey, state.directory)).rejects.toThrow("account was removed");
		const definition = registry.getProviderDefinition("antigravity-cli");
		if (!definition) throw new Error("Missing Antigravity login definition");
		const authenticated = { ...grant, access: "reauthenticated-access", refresh: "reauthenticated-refresh" };
		vi.spyOn(registry, "getProviderDefinition").mockReturnValue({
			...definition,
			login: async () => authenticated,
		});
		vi.spyOn(state.store, "upsertAuthCredential").mockRejectedValueOnce(new Error("synthetic login save failure"));
		const controller = { onAuth: () => {}, onPrompt: async () => "yes" };
		await expect(state.storage.oauth.login("antigravity-cli", controller)).rejects.toThrow(
			"synthetic login save failure",
		);
		await expect(stageAgyCredentials(apiKey, state.directory)).rejects.toThrow("account was removed");
		await state.storage.oauth.login("antigravity-cli", controller);
		const resolved = await getOAuthApiKey("antigravity-cli", { "antigravity-cli": authenticated });
		if (!resolved) throw new Error("Missing structured authenticated grant");
		const release = await stageAgyCredentials(resolved.apiKey, state.directory);
		credentialReleases.push(release);
		expect(JSON.parse(await fs.readFile(state.file, "utf8")).token).toMatchObject({
			access_token: authenticated.access,
			refresh_token: authenticated.refresh,
		});
		expect(state.storage.credentials.list("antigravity-cli").map(row => row.credential)).toEqual([
			{ type: "oauth", ...authenticated, authorizedAt: expect.any(Number) },
		]);
		await release();
		await expect(fs.stat(state.file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a saved explicit login visible when the native grant omits account metadata", async () => {
		const state = await accountFixture();
		await state.storage.credentials.remove("antigravity-cli");
		const definition = registry.getProviderDefinition("antigravity-cli");
		if (!definition) throw new Error("Missing Antigravity login definition");
		const authenticated = {
			access: "identity-less-access",
			refresh: "identity-less-refresh",
			expires: grant.expires,
		};
		vi.spyOn(registry, "getProviderDefinition").mockReturnValue({
			...definition,
			login: async () => authenticated,
		});
		await state.storage.oauth.login("antigravity-cli", { onAuth: () => {}, onPrompt: async () => "yes" });
		expect(state.storage.credentials.list("antigravity-cli").map(row => row.credential)).toEqual([
			{ type: "oauth", ...authenticated, authorizedAt: expect.any(Number) },
		]);
	});

	it("does not reopen an account when a saved login finishes after that exact row was removed", async () => {
		const state = await accountFixture();
		const definition = registry.getProviderDefinition("antigravity-cli");
		if (!definition) throw new Error("Missing Antigravity login definition");
		const authenticated = { ...grant, access: "late-login-access", refresh: "late-login-refresh" };
		vi.spyOn(registry, "getProviderDefinition").mockReturnValue({
			...definition,
			login: async () => authenticated,
		});
		const saved = Promise.withResolvers<void>();
		const finishLogin = Promise.withResolvers<void>();
		const persist = state.store.upsertAuthCredential.bind(state.store);
		vi.spyOn(state.store, "upsertAuthCredential").mockImplementation(async (provider, credential) => {
			const rows = await persist(provider, credential);
			saved.resolve();
			await finishLogin.promise;
			return rows;
		});
		const login = state.storage.oauth.login("antigravity-cli", { onAuth: () => {}, onPrompt: async () => "yes" });
		void login.catch(() => undefined);
		await saved.promise;
		await state.storage.credentials.reload();
		const target = state.storage.credentials.list("antigravity-cli")[0];
		if (!target) throw new Error("Missing saved login");
		expect(await state.storage.credentials.removeById("antigravity-cli", target.id)).toBe(true);
		finishLogin.resolve();
		await expect(login).rejects.toThrow("login is no longer the stored account");
		expect(state.storage.credentials.list("antigravity-cli")).toEqual([]);
		const resolved = await getOAuthApiKey("antigravity-cli", { "antigravity-cli": authenticated });
		if (!resolved) throw new Error("Missing structured login grant");
		await expect(stageAgyCredentials(resolved.apiKey, state.directory)).rejects.toThrow("account was removed");
		await expect(fs.stat(state.file)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("removes only the provider's stored accounts, including old unowned native files", async () => {
		const state = await accountFixture();
		const sibling = { ...state.credential, email: "sibling@example.test", accountId: "sibling" };
		await state.storage.credentials.set("antigravity-cli", [state.credential, sibling]);
		const unrelated = { ...sibling, email: "not-stored@example.test", accountId: "not-stored" };
		const files = [state.credential, sibling, unrelated].map(credential =>
			path.join(state.root, agyCredentialKey(credential), "antigravity-cli", "antigravity-oauth-token"),
		);
		for (const file of files) {
			await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
			await fs.writeFile(file, JSON.stringify(stored), { mode: 0o600 });
		}
		await state.storage.credentials.remove("antigravity-cli");
		await expect(fs.stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(fs.stat(files[1]!)).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.parse(await fs.readFile(files[2]!, "utf8"))).toEqual(stored);
		expect(state.storage.credentials.list("antigravity-cli")).toEqual([]);
	});
});

describe("Antigravity CLI authorization output", () => {
	const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&state=fixture&scope=a%20b`;

	it("waits for a complete URL at every possible chunk boundary", () => {
		for (let boundary = 0; boundary <= url.length; boundary++) {
			const parser = new AgyAuthUrlParser();
			expect(parser.push(`Sign in:\n${url.slice(0, boundary)}`)).toBeUndefined();
			expect(parser.push(url.slice(boundary))).toBeUndefined();
			expect(parser.push("\nPaste code: ")).toBe(url);
		}
	});

	it("handles EOF and ANSI delimiters but rejects a different OAuth client", () => {
		expect(new AgyAuthUrlParser().push(url, true)).toBe(url);
		expect(new AgyAuthUrlParser().push(`${url}\x1b[0m`)).toBe(url);
		expect(() => new AgyAuthUrlParser().push("https://accounts.google.com/auth?client_id=wrong\n")).toThrow(
			"unexpected OAuth client",
		);
		expect(() => new AgyAuthUrlParser().push("x".repeat(65 * 1024))).toThrow("limit");
	});

	it("accepts codes and callback URLs, not failed callbacks or multiline input", () => {
		expect(agyAuthorizationCode("  fixture-code  ")).toBe("fixture-code");
		expect(agyAuthorizationCode("http://localhost/callback?code=one%2Btwo&state=fixture")).toBe("one+two");
		expect(() => agyAuthorizationCode("http://localhost/callback?error=access_denied")).toThrow();
		expect(() => agyAuthorizationCode("one\ntwo")).toThrow();
	});
});

describe("Antigravity CLI login handoff", () => {
	it.skipIf(process.platform === "win32")(
		"exports ACP app-data credentials, suppresses child errors, and cancels pending input",
		async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-login-"));
			directories.push(root);
			const executable = path.join(root, "fixture-agy");
			await fs.writeFile(
				executable,
				`#!${process.execPath}
import * as fs from "node:fs/promises";
import * as path from "node:path";
if (process.env.SSH_TTY !== "omp-agy-file-auth") process.exit(9);
const args = process.argv.slice(2);
const appData = args[args.indexOf("--app-data-dir") + 1];
process.stdout.write("https://accounts.google.com/o/oauth2/v2/auth?client_id=${AGY_OAUTH_CLIENT_ID}&state=fixture\\n");
const code = (await Bun.stdin.text()).trim();
if (code !== "fixture-code") process.exit(8);
if (process.env.FIXTURE_MODE === "failure") {
	process.stderr.write("secret-native-error-payload");
	process.exit(1);
}
await fs.mkdir(appData, {recursive: true, mode: 0o700});
await fs.writeFile(path.join(appData, "antigravity-oauth-token"), JSON.stringify({
	token: ${JSON.stringify(stored.token)}, auth_method: "consumer", id_token_email: "account@example.test"
}), {mode: 0o600});
`,
				{ mode: 0o700 },
			);
			const moduleUrl = new URL("../src/registry/oauth/antigravity-cli.ts", import.meta.url).href;
			for (const mode of ["success", "failure", "cancel"]) {
				const runner = `
import { loginAntigravityCli } from ${JSON.stringify(moduleUrl)};
const controller = new AbortController();
try {
	const credentials = await loginAntigravityCli({
		signal: controller.signal,
		onAuth: () => { if (process.env.FIXTURE_MODE === "cancel") controller.abort("secret-cancel-reason"); },
		onPrompt: async () => process.env.FIXTURE_MODE === "cancel" ? new Promise(() => {}) : "fixture-code"
	});
	console.log(JSON.stringify({
		realGrant: typeof credentials === "object" && credentials.refresh === "fixture-refresh",
		identity: credentials.email === "account@example.test"
	}));
} catch (error) {
	console.log(JSON.stringify({error: String(error)}));
}
`;
				const child = Bun.spawn([process.execPath, "--eval", runner], {
					env: {
						...process.env,
						HOME: root,
						USERPROFILE: root,
						PI_CONFIG_DIR: ".omp-fixture",
						PI_CODING_AGENT_DIR: path.join(root, "agent"),
						PI_AGY_PATH: executable,
						FIXTURE_MODE: mode,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				try {
					const text = await new Response(child.stdout).text();
					const stderr = await new Response(child.stderr).text();
					expect(await child.exited).toBe(0);
					expect(text + stderr).not.toContain("secret-");
					expect(text + stderr).not.toContain("fixture-refresh");
					const result = JSON.parse(text);
					if (mode === "success") expect(result).toEqual({ realGrant: true, identity: true });
					else expect(result.error).toContain(mode === "cancel" ? "cancelled" : "sign-in failed");
				} finally {
					child.kill("SIGKILL");
				}
			}
		},
		15_000,
	);
});

describe("Antigravity CLI refresh", () => {
	it("uses the installed consumer client and preserves unrotated grant metadata", async () => {
		const refreshed = await refreshAgyCredentials(grant, undefined, async (url, init) => {
			expect(String(url)).toBe("https://oauth2.googleapis.com/token");
			const body = new URLSearchParams(String(init?.body));
			expect(body.get("client_id")).toBe(AGY_OAUTH_CLIENT_ID);
			expect(body.get("grant_type")).toBe("refresh_token");
			expect(body.get("refresh_token")).toBe(grant.refresh);
			expect(body.get("client_secret")).toBeTruthy();
			return Response.json({ access_token: "new-access", expires_in: 3600 });
		});
		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe(grant.refresh);
		expect(refreshed.accountId).toBe(grant.accountId);
		expect(refreshed.email).toBe(grant.email);
		expect(refreshed.expires).toBeGreaterThan(Date.now() + 3_000_000);
	});

	it("retains rotated refresh tokens and rejects malformed success bodies", async () => {
		const rotated = await refreshAgyCredentials(grant, undefined, async () =>
			Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }),
		);
		expect(rotated.refresh).toBe("new-refresh");
		for (const body of [
			null,
			{},
			{ access_token: "secret", expires_in: -1 },
			{ access_token: "secret", expires_in: "3600" },
			{ access_token: "secret", expires_in: 3600, refresh_token: "" },
		]) {
			await expect(refreshAgyCredentials(grant, undefined, async () => Response.json(body))).rejects.toThrow(
				"invalid token response",
			);
		}
	});

	it("classifies revoked grants but never exposes provider response payloads", async () => {
		for (const [status, code, definitive] of [
			[400, "invalid_grant", true],
			[401, "unknown", true],
			[403, "secret-provider-error", false],
			[429, "invalid_grant", false],
			[503, "invalid_grant", false],
		] as const) {
			try {
				await refreshAgyCredentials(grant, undefined, async () =>
					Response.json({ error: code, error_description: "secret-provider-payload" }, { status }),
				);
				throw new Error("unexpected success");
			} catch (error) {
				expect(String(error)).not.toContain("secret-provider");
				expect(isDefinitiveOAuthFailure(String(error))).toBe(definitive);
			}
		}
		await expect(
			refreshAgyCredentials(grant, undefined, async () => new Response("secret-html", { status: 401 })),
		).rejects.toThrow("HTTP 401");
	});

	it("does not send sentinel grants, pre-aborted work, or leaking network errors", async () => {
		let calls = 0;
		const fetchImpl = async () => {
			calls++;
			throw new Error("secret-network-payload");
		};
		await expect(refreshAgyCredentials({ ...grant, refresh: "__remote__" }, undefined, fetchImpl)).rejects.toThrow(
			"credential owner",
		);
		await expect(refreshAgyCredentials(grant, AbortSignal.abort("secret-reason"), fetchImpl)).rejects.toThrow(
			"cancelled",
		);
		expect(calls).toBe(0);
		try {
			await refreshAgyCredentials(grant, undefined, fetchImpl);
		} catch (error) {
			expect(String(error)).not.toContain("secret-network-payload");
		}
	});
});
