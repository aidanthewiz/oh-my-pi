import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { logger, removeWithRetries } from "@oh-my-pi/pi-utils";

const PROVIDER = "unit-broker-rejected-access";
const SOURCE = "auth-broker-rejected-access-test";
const BEARER = "synthetic-rejected-access-broker-bearer";
const TARGET_ACCOUNT = "synthetic-target-account";
const OTHER_ACCOUNT = "synthetic-other-account";
const HOUR_MS = 60 * 60_000;

function accessToken(mint: number): string {
	return `synthetic-rejected-access-${mint}`;
}

function refreshToken(mint: number): string {
	return `synthetic-rejected-refresh-${mint}`;
}

describe("broker rejected access recovery", () => {
	let tempDir = "";
	let cleanups: Array<() => void | Promise<void>> = [];
	let requestUrls: string[] = [];
	let logEvents: logger.LogEvent[] = [];
	let exchanges: Array<{ accountId: string | undefined; refresh: string }> = [];

	beforeEach(async () => {
		cleanups = [];
		requestUrls = [];
		logEvents = [];
		exchanges = [];
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-broker-rejected-access-"));
		cleanups.push(() => removeWithRetries(tempDir));
		cleanups.push(logger.registerLogSink(event => logEvents.push(event)));
		registerOAuthProvider({
			id: PROVIDER,
			name: "Synthetic Broker Rejected Access",
			sourceId: SOURCE,
			async login() {
				throw new Error("Unexpected login in broker rejection fixture");
			},
			async refreshToken(credential) {
				exchanges.push({ accountId: credential.accountId, refresh: credential.refresh });
				return {
					...credential,
					access: accessToken(exchanges.length),
					refresh: refreshToken(exchanges.length),
					expires: Date.now() + HOUR_MS,
				};
			},
			getApiKey(credential) {
				return credential.access;
			},
		});
		cleanups.push(() => unregisterOAuthProviders(SOURCE));
	});

	afterEach(async () => {
		const errors: unknown[] = [];
		for (const cleanup of cleanups.reverse()) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length) throw new AggregateError(errors, "Broker rejection fixture cleanup failed");
	});

	async function startBroker(name: string) {
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, `${name}.db`));
		cleanups.push(() => store.close());
		await store.saveOAuth(PROVIDER, {
			access: accessToken(0),
			refresh: refreshToken(0),
			expires: Date.now() + HOUR_MS,
			accountId: TARGET_ACCOUNT,
		});
		await store.saveOAuth(PROVIDER, {
			access: "synthetic-other-access",
			refresh: "synthetic-other-refresh",
			expires: Date.now() + HOUR_MS,
			accountId: OTHER_ACCOUNT,
		});
		const storage = new AuthStorage(store, { sourceIdentity: `synthetic-broker:${name}` });
		cleanups.push(() => storage.close());
		await storage.credentials.reload();
		const handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [BEARER],
			disableRefresher: true,
		});
		cleanups.push(() => handle.close());
		const client = new AuthBrokerClient({
			url: handle.url,
			token: BEARER,
			maxRetries: 0,
			fetchImpl: Object.assign(
				(input: string | URL | Request, init?: RequestInit) => {
					const url = input instanceof Request ? input.url : String(input);
					if (new URL(url).origin !== handle.url) throw new Error("Non-fixture broker request refused");
					requestUrls.push(url);
					return fetch(input, init);
				},
				{ preconnect: fetch.preconnect },
			),
		});
		const target = store
			.listAuthCredentials(PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.accountId === TARGET_ACCOUNT);
		const other = store
			.listAuthCredentials(PROVIDER)
			.find(row => row.credential.type === "oauth" && row.credential.accountId === OTHER_ACCOUNT);
		if (!target || !other) throw new Error("Missing synthetic OAuth accounts");
		return { store, storage, client, target, other, url: handle.url };
	}

	async function setup() {
		const broker = await startBroker("target-source");
		const otherSource = await startBroker("other-source");
		expect(otherSource.target.id).toBe(broker.target.id);
		const otherSourceRows = otherSource.store.listAuthCredentials(PROVIDER);
		await broker.client.refreshCredential(broker.target.id);
		expect(exchanges).toEqual([{ accountId: TARGET_ACCOUNT, refresh: refreshToken(0) }]);
		const snapshot = await broker.client.fetchSnapshot();
		if (snapshot.status !== 200) throw new Error("Missing minted broker snapshot");
		const remote = new RemoteAuthCredentialStore({
			client: broker.client,
			initialSnapshot: snapshot.snapshot,
			streamSnapshots: false,
		});
		cleanups.push(() => remote.close());
		const auth = new AuthStorage(remote, { sourceIdentity: broker.storage.sourceIdentity });
		cleanups.push(() => auth.close());
		await auth.credentials.reload();
		expect(await auth.oauth.accessById(PROVIDER, broker.target.id)).toMatchObject({
			ok: true,
			credentialId: broker.target.id,
			accountId: TARGET_ACCOUNT,
			accessToken: accessToken(1),
		});
		expect(auth.credentials.list(PROVIDER).find(row => row.id === broker.target.id)?.credential).toMatchObject({
			refresh: REMOTE_REFRESH_SENTINEL,
		});
		return { broker, otherSource, otherSourceRows, auth };
	}

	function expectPrivateTransport() {
		const urls = JSON.stringify(requestUrls);
		const logs = JSON.stringify(logEvents);
		const secrets = [
			BEARER,
			"synthetic-other-access",
			"synthetic-other-refresh",
			...Array.from({ length: exchanges.length + 1 }, (_, mint) => accessToken(mint)),
			...Array.from({ length: exchanges.length + 1 }, (_, mint) => refreshToken(mint)),
		];
		for (const secret of secrets) {
			expect(urls).not.toContain(secret);
			expect(urls).not.toContain(encodeURIComponent(secret));
			expect(logs).not.toContain(secret);
		}
	}

	test("current401 remints the rejected recent token on the same broker row", async () => {
		const { broker, otherSource, otherSourceRows, auth } = await setup();
		const recovered = await auth.oauth.accessById(PROVIDER, broker.target.id, {
			forceRefresh: true,
			refreshReason: "auth-recovery",
			rejectedAccessToken: accessToken(1),
		});
		expectPrivateTransport();
		expect(broker.store.listAuthCredentials(PROVIDER).find(row => row.id === broker.other.id)).toEqual(broker.other);
		expect(otherSource.store.listAuthCredentials(PROVIDER)).toEqual(otherSourceRows);
		expect(recovered).toMatchObject({
			ok: true,
			credentialId: broker.target.id,
			accountId: TARGET_ACCOUNT,
			accessToken: accessToken(2),
		});
		expect(exchanges).toEqual([
			{ accountId: TARGET_ACCOUNT, refresh: refreshToken(0) },
			{ accountId: TARGET_ACCOUNT, refresh: refreshToken(1) },
		]);
		expect(
			broker.store.listAuthCredentials(PROVIDER).find(row => row.id === broker.target.id)?.credential,
		).toMatchObject({
			type: "oauth",
			accountId: TARGET_ACCOUNT,
			access: accessToken(2),
			refresh: refreshToken(2),
		});
	});

	test.each([
		{ name: "malformed JSON", body: `{"rejectedAccess":"${accessToken(0)}"` },
		{
			name: "unknown fields",
			body: JSON.stringify({ rejectedAccess: accessToken(0), unexpected: accessToken(0) }),
		},
		{ name: "non-string rejection identity", body: JSON.stringify({ rejectedAccess: [accessToken(0)] }) },
	])("rejects $name without minting or exposing token material", async ({ body }) => {
		const broker = await startBroker("invalid-body");
		const before = broker.store.listAuthCredentials(PROVIDER);
		const url = `${broker.url}/v1/credential/${broker.target.id}/refresh?reason=auth-recovery`;
		requestUrls.push(url);
		const response = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${BEARER}`, "Content-Type": "application/json" },
			body,
		});
		const responseBody = await response.text();
		expect(response.status).toBe(400);
		expect(responseBody).not.toContain(accessToken(0));
		expect(exchanges).toEqual([]);
		expect(broker.store.listAuthCredentials(PROVIDER)).toEqual(before);
		expectPrivateTransport();
	});

	test("stale401 adopts the newer broker mint without another provider exchange", async () => {
		const { broker, otherSource, otherSourceRows, auth } = await setup();
		expect(await auth.oauth.accessById(PROVIDER, broker.target.id, { forceRefresh: true })).toMatchObject({
			ok: true,
			accessToken: accessToken(2),
		});
		const recovered = await auth.oauth.accessById(PROVIDER, broker.target.id, {
			forceRefresh: true,
			refreshReason: "auth-recovery",
			rejectedAccessToken: accessToken(1),
		});
		expectPrivateTransport();
		expect(recovered).toMatchObject({
			ok: true,
			credentialId: broker.target.id,
			accountId: TARGET_ACCOUNT,
			accessToken: accessToken(2),
		});
		expect(exchanges).toEqual([
			{ accountId: TARGET_ACCOUNT, refresh: refreshToken(0) },
			{ accountId: TARGET_ACCOUNT, refresh: refreshToken(1) },
		]);
		expect(broker.store.listAuthCredentials(PROVIDER).find(row => row.id === broker.other.id)).toEqual(broker.other);
		expect(otherSource.store.listAuthCredentials(PROVIDER)).toEqual(otherSourceRows);
		expect(
			broker.store.listAuthCredentials(PROVIDER).find(row => row.id === broker.target.id)?.credential,
		).toMatchObject({
			access: accessToken(2),
			refresh: refreshToken(2),
		});
	});
});
