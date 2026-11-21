import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, REMOTE_REFRESH_SENTINEL, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	discoverAuthStorage,
	type FetchSnapshotResult,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
	startAuthBroker,
} from "@oh-my-pi/pi-ai/auth-broker";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { decodeKiroCredential } from "@oh-my-pi/pi-catalog/wire/kiro";
import { removeWithRetries } from "../../utils/src/temp";
import { AbortError } from "../src/error";
import { withEnv } from "./helpers";

const ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"] as const;
const AUTH_BROKER_MODULE = path.resolve(import.meta.dir, "../src/auth-broker/index.ts");
const savedEnv: Partial<Record<(typeof ANTHROPIC_ENV)[number], string | undefined>> = {};

function mintOAuthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `account-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(10);
	}
	if (!predicate()) throw new Error("waitUntil timeout");
}

describe("RemoteAuthCredentialStore SSE integration", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | undefined;
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;
	let remote: RemoteAuthCredentialStore | undefined;
	const token = "remote-store-bearer";

	beforeEach(async () => {
		for (const key of ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-remote-store-"));
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		await store.saveOAuth("anthropic", mintOAuthCredential("a", Date.now() + 60_000));
		storage = new AuthStorage(store);
		await storage.credentials.reload();
		handle = startAuthBroker({
			storage,
			bind: "127.0.0.1:0",
			bearerTokens: [token],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		remote?.close();
		await handle?.close();
		await storage?.close();
		store?.close();
		await removeWithRetries(tempDir);
		for (const key of ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	test("consumes initial snapshot, upsert, and removal over SSE without manual refresh", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({ client });

		// 1. Initial snapshot frame populates the local store.
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		const initialEntry = remote!.snapshot.credentials[0];
		expect(initialEntry.provider).toBe("anthropic");
		expect(initialEntry.credential.type).toBe("oauth");
		if (initialEntry.credential.type === "oauth") {
			expect(initialEntry.credential.access).toBe("access-a");
			expect(initialEntry.credential.refresh).toBe(REMOTE_REFRESH_SENTINEL);
		}
		const initialGeneration = remote!.snapshot.generation;

		// 2. Server-side upsert is delivered as an `entry` frame.
		await storage!.credentials.upsert("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.credentials.length === 2);
		expect(remote!.snapshot.generation).toBeGreaterThan(initialGeneration);
		const accessTokens = remote!.snapshot.credentials
			.filter(entry => entry.credential.type === "oauth")
			.map(entry => (entry.credential.type === "oauth" ? entry.credential.access : ""))
			.sort();
		expect(accessTokens).toEqual(["access-a", "access-b"]);

		// 3. Server-side disable is delivered as a `removed` frame.
		const bId = remote!.snapshot.credentials.find(
			entry => entry.credential.type === "oauth" && entry.credential.access === "access-b",
		)?.id;
		expect(bId).toBeDefined();
		const disabled = await storage!.credentials.disable(bId!, "revoked by test");
		expect(disabled).toBe(true);
		await waitUntil(() => remote!.snapshot.credentials.length === 1);
		expect(remote!.snapshot.credentials[0].id).not.toBe(bId);
	});

	test("pollExternalChanges reports broker-side changes so a wrapping AuthStorage reloads", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		// Mirror `auth-gateway serve`'s boot: fetch the initial snapshot so the
		// store seeds its acknowledged generation, then wrap the broker-backed
		// store in its own AuthStorage whose credential view only refreshes on
		// reload().
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
		});
		const gatewayStorage = new AuthStorage(remote, {
			sourceLabel: `broker ${handle!.url}`,
		});
		try {
			await gatewayStorage.credentials.reload();
			await waitUntil(() => remote!.snapshot.credentials.length === 1);
			// Boot generation is acknowledged: no spurious reload before any change.
			expect(await gatewayStorage.credentials.poll()).toBe(false);
			expect(gatewayStorage.credentials.snapshot().credentials.map(c => c.provider)).toEqual(["anthropic"]);

			// Another process logs in a new provider; the change reaches the remote
			// store over SSE.
			await storage!.credentials.upsert("deepseek", {
				type: "api_key",
				key: "sk-repro",
			});
			await waitUntil(() => remote!.snapshot.credentials.some(c => c.provider === "deepseek"));

			// The poll now reports the change and the reload widens the gateway view.
			expect(await gatewayStorage.credentials.poll()).toBe(true);
			expect(
				gatewayStorage.credentials
					.snapshot()
					.credentials.map(c => c.provider)
					.sort(),
			).toEqual(["anthropic", "deepseek"]);
			// One true per observed change: an unchanged generation reports false.
			expect(await gatewayStorage.credentials.poll()).toBe(false);

			// A logout in another process removes the credential over SSE, and the
			// next poll drops it from the gateway view.
			const deepseekId = remote!.snapshot.credentials.find(c => c.provider === "deepseek")?.id;
			expect(deepseekId).toBeDefined();
			expect(await storage!.credentials.disable(deepseekId!, "logged out by test")).toBe(true);
			await waitUntil(() => !remote!.snapshot.credentials.some(c => c.provider === "deepseek"));
			expect(await gatewayStorage.credentials.poll()).toBe(true);
			expect(gatewayStorage.credentials.snapshot().credentials.map(c => c.provider)).toEqual(["anthropic"]);
		} finally {
			await gatewayStorage.close();
		}
	});

	test("accepts a lower-generation authoritative snapshot after broker restart", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial broker snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
		});
		const gatewayStorage = new AuthStorage(remote, {
			sourceLabel: `broker ${handle!.url}`,
		});
		try {
			await gatewayStorage.credentials.reload();

			// Drive the original broker above the generation its replacement will
			// start at, then acknowledge that complete credential view.
			await storage!.credentials.upsert("deepseek", {
				type: "api_key",
				key: "sk-deepseek",
			});
			await storage!.credentials.upsert("openai", {
				type: "api_key",
				key: "sk-openai",
			});
			await storage!.credentials.upsert("xai", {
				type: "api_key",
				key: "sk-xai",
			});
			await waitUntil(() => remote!.snapshot.credentials.length === 4);
			const previousGeneration = remote.snapshot.generation;
			expect(await gatewayStorage.credentials.poll()).toBe(true);
			expect(await gatewayStorage.credentials.poll()).toBe(false);

			// Stop the broker and boot a replacement over a different credential
			// set whose AuthStorage generation starts below the client's
			// previously acknowledged value.
			const brokerUrl = new URL(handle!.url);
			const bind = `${brokerUrl.hostname}:${brokerUrl.port}`;
			await handle!.close();
			await storage!.close();

			store = new SqliteAuthCredentialStore(new Database(":memory:"));
			await store.saveApiKey("google", "sk-restarted");
			storage = new AuthStorage(store);
			await storage.credentials.reload();
			expect(storage.credentials.generation).toBeLessThan(previousGeneration);
			handle = startAuthBroker({
				storage,
				bind,
				bearerTokens: [token],
				disableRefresher: true,
			});

			// The reconnect's first SSE frame is authoritative despite its lower
			// generation. The wrapping AuthStorage must reload that content.
			await waitUntil(
				() =>
					remote!.snapshot.generation < previousGeneration &&
					remote!.snapshot.credentials.length === 1 &&
					remote!.snapshot.credentials[0]?.provider === "google",
				4_000,
			);
			expect(await gatewayStorage.credentials.poll()).toBe(true);
			expect(gatewayStorage.credentials.snapshot().credentials.map(c => c.provider)).toEqual(["google"]);

			// Incremental events are now ordered against the replacement
			// baseline, not the previous broker process's higher generation.
			await storage!.credentials.upsert("deepseek", {
				type: "api_key",
				key: "sk-after-restart",
			});
			await waitUntil(() => remote!.snapshot.credentials.some(c => c.provider === "deepseek"));
			expect(remote.snapshot.generation).toBeLessThan(previousGeneration);
			expect(await gatewayStorage.credentials.poll()).toBe(true);
			expect(
				gatewayStorage.credentials
					.snapshot()
					.credentials.map(c => c.provider)
					.sort(),
			).toEqual(["deepseek", "google"]);
		} finally {
			await gatewayStorage.close();
		}
	});

	test("batches observed usage and reports it to the broker as per-install client usage", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		remote = new RemoteAuthCredentialStore({
			client,
			observedUsageFlushMs: 25,
		});

		const at = Date.now();
		// Two requests for the same (provider, model) must merge into one entry;
		// a second model produces its own entry in the same flush.
		remote.recordObservedUsage([
			{
				at,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 10,
				cacheWriteTokens: 5,
				costUsd: 0.5,
			},
		]);
		remote.recordObservedUsage([
			{
				at: at + 1,
				provider: "anthropic",
				model: "claude-x",
				requests: 1,
				inputTokens: 200,
				outputTokens: 100,
				cacheReadTokens: 20,
				cacheWriteTokens: 10,
				costUsd: 1.0,
			},
			{
				at: at + 2,
				provider: "openai-codex",
				model: "gpt-y",
				requests: 1,
				inputTokens: 30,
				outputTokens: 15,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			},
		]);

		await waitUntil(() => storage!.usage.clientSummary(0).clients.length === 1);
		const summary = storage!.usage.clientSummary(0);
		const reported = summary.clients[0];
		expect(reported.installId.length).toBeGreaterThan(0);
		expect(reported.hostname).toBe(os.hostname());
		// Default identity carries the app label so broker-side attribution can
		// answer "what did app X use" even for broker-direct installs.
		expect(reported.providers.every(p => p.app === "coreforge")).toBe(true);

		const anthropic = reported.providers.find(p => p.provider === "anthropic");
		expect(anthropic).toMatchObject({
			requests: 2,
			inputTokens: 300,
			outputTokens: 150,
			cacheReadTokens: 30,
			cacheWriteTokens: 15,
		});
		expect(anthropic?.costUsd).toBeCloseTo(1.5, 10);
		expect(reported.providers.find(p => p.provider === "openai-codex")).toMatchObject({
			requests: 1,
			inputTokens: 30,
		});

		// A follow-up report — routed through the client-side AuthStorage facade,
		// like the coding-agent does per assistant message — merges into the same
		// 5-minute bucket row instead of accreting a new row per flush.
		const clientStorage = new AuthStorage(remote);
		clientStorage.usage.observe({
			provider: "anthropic",
			model: "claude-x",
			at: at + 3,
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		});
		await waitUntil(() => {
			const current = storage!.usage.clientSummary(0).clients[0];
			return current?.providers.find(p => p.provider === "anthropic")?.requests === 3;
		});
		// An explicit identity (the auth-gateway attributing a caller) must
		// produce its own client row instead of folding into this install.
		remote.recordObservedUsage(
			[
				{
					at: at + 4,
					provider: "anthropic",
					model: "claude-x",
					requests: 1,
					inputTokens: 7,
					outputTokens: 3,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					costUsd: 0.05,
				},
			],
			{ installId: "robomp-install", hostname: "robomp-box", app: "robomp" },
		);
		await waitUntil(() => storage!.usage.clientSummary(0).clients.length === 2);
		const attributed = storage!.usage.clientSummary(0).clients.find(c => c.installId === "robomp-install");
		expect(attributed?.hostname).toBe("robomp-box");
		expect(attributed?.providers).toEqual([
			{
				app: "robomp",
				provider: "anthropic",
				requests: 1,
				inputTokens: 7,
				outputTokens: 3,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.05,
			},
		]);
	});

	test("a process that quits before the flush interval still reports its observed usage", async () => {
		// Mirrors `omp -p`: one turn, then postmortem.quit() well inside the default 10s flush interval.
		const script = [
			'import { postmortem } from "@oh-my-pi/pi-utils";',
			`import { AuthBrokerClient, RemoteAuthCredentialStore } from ${JSON.stringify(AUTH_BROKER_MODULE)};`,
			`const client = new AuthBrokerClient({ url: ${JSON.stringify(handle!.url)}, token: ${JSON.stringify(token)} });`,
			"const remote = new RemoteAuthCredentialStore({ client, streamSnapshots: false });",
			"remote.recordObservedUsage(",
			'	[{ at: Date.now(), provider: "anthropic", model: "claude-x", requests: 1, inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 }],',
			'	{ installId: "print-mode-install", hostname: "print-mode-host", app: "omp" },',
			");",
			"await postmortem.quit(0);",
		].join("\n");
		const child = Bun.spawn([process.execPath, "--eval", script], {
			cwd: import.meta.dir,
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
		expect(exitCode, stderr).toBe(0);

		const reported = storage!.usage.clientSummary(0).clients.find(c => c.installId === "print-mode-install");
		expect(reported?.providers).toEqual([
			{
				app: "omp",
				provider: "anthropic",
				requests: 1,
				inputTokens: 12,
				outputTokens: 4,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0.01,
			},
		]);
	});

	test("background sync parks after the idle window and resumes on the next store use", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const openSpy = vi.spyOn(client, "openSnapshotStream");
		remote = new RemoteAuthCredentialStore({ client, backgroundIdleMs: 150 });

		// Stream opens immediately (construction counts as activity).
		await waitUntil(() => openSpy.mock.calls.length === 1);
		const firstSignal = openSpy.mock.calls[0]![0]!.signal!;

		// Idle window elapses with no foreground use: the in-flight SSE request
		// is aborted without close(). A leaked store would otherwise hold this
		// connection forever and pin the process (the git-tui hang).
		await waitUntil(() => firstSignal.aborted);

		// Parked: no reconnect attempts while the store stays unused.
		// Real delay on purpose: the idle watchdog runs on real unref'd timers
		// against a live SSE server, so fake timers cannot drive this path.
		await Bun.sleep(300);
		expect(openSpy.mock.calls.length).toBe(1);

		// Any foreground use wakes the loop and re-establishes the stream.
		remote.listAuthCredentials();
		await waitUntil(() => openSpy.mock.calls.length === 2);
		expect(openSpy.mock.calls[1]![0]!.signal!.aborted).toBe(false);
	});

	test("calls onSnapshot for broker snapshots but not the constructor snapshot", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const callbacks: Array<{ snapshot: SnapshotResponse; generation: number }> = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			onSnapshot: (snapshot, generation) => {
				callbacks.push({ snapshot, generation });
			},
		});
		expect(callbacks).toHaveLength(0);

		const refreshed = await remote.refreshSnapshot();

		expect(callbacks).toHaveLength(1);
		expect(callbacks[0].generation).toBe(refreshed.generation);
		expect(callbacks[0].snapshot).toEqual(refreshed);
	});

	test("filters configured OAuth identities while preserving API keys and raw snapshot callbacks", async () => {
		await storage!.credentials.upsert("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await storage!.credentials.upsert("anthropic", {
			type: "api_key",
			key: "visible-api-key",
		});
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const identities = new Set([allowed.identityKey]);
		const callbacks: SnapshotResponse[] = [];
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", identities]]),
			onSnapshot: snapshot => {
				callbacks.push(snapshot);
			},
		});

		identities.add(excluded.identityKey);
		expect(
			remote
				.listAuthCredentials("anthropic")
				.map(entry => entry.credential.type)
				.sort(),
		).toEqual(["api_key", "oauth"]);
		const refreshed = await remote.refreshSnapshot();
		expect(refreshed.credentials.filter(entry => entry.credential.type === "oauth")).toHaveLength(1);
		expect(callbacks.at(-1)?.credentials).toHaveLength(3);
	});

	test("advances the SSE generation without exposing an excluded entry", async () => {
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials[0];
		if (!allowed?.identityKey) throw new Error("expected OAuth identity key");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			accountPool: new Map([["anthropic", new Set([allowed.identityKey])]]),
		});
		const initialGeneration = remote.snapshot.generation;

		await storage!.credentials.upsert("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await waitUntil(() => remote!.snapshot.generation > initialGeneration);

		expect(remote.snapshot.credentials).toHaveLength(1);
		expect(remote.snapshot.credentials[0]?.identityKey).toBe(allowed.identityKey);
	});

	test("treats a missing provider as unrestricted and an empty provider pool as OAuth-disabled", async () => {
		await storage!.credentials.upsert("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			streamSnapshots: false,
			accountPool: new Map([["anthropic", new Set()]]),
		});

		expect(remote.listAuthCredentials("anthropic")).toEqual([]);
		expect(remote.listAuthCredentials("openai-codex")).toHaveLength(1);
	});

	test("a broker-refreshed Kiro login keeps the routing fields its API key needs", async () => {
		const kiro = getProviderDefinition("kiro")!;
		vi.spyOn(kiro, "refreshToken").mockImplementation(async current => ({
			...current,
			access: "access-fresh",
			expires: Date.now() + 3_600_000,
		}));
		await storage!.credentials.upsert("kiro", {
			type: "oauth",
			access: "access-stale",
			refresh: "refresh-kiro",
			expires: Date.now() - 1_000,
			region: "us-east-1",
			accountId: "login-a",
		});
		remote = new RemoteAuthCredentialStore({ client: new AuthBrokerClient({ url: handle!.url, token }) });
		await waitUntil(() => remote!.snapshot.credentials.some(entry => entry.provider === "kiro"));
		const clientStorage = new AuthStorage(remote);
		try {
			await clientStorage.credentials.reload();
			// `accessAll` refreshes the expired row in `tryOAuth`, without the key-selection preflight.
			const [access] = await clientStorage.oauth.accessAll("kiro");
			expect(access).toMatchObject({ ok: true, accessToken: "access-fresh", accountId: "login-a" });
			const apiKey = await clientStorage.keys.get("kiro", "kiro-session");
			expect(decodeKiroCredential(apiKey ?? "", {})).toMatchObject({
				token: "access-fresh",
				region: "us-east-1",
				loginId: "login-a",
			});
		} finally {
			await clientStorage.close();
		}
	});

	test("an allow-list pool hides unlisted providers and API keys over snapshots and SSE", async () => {
		await storage!.credentials.upsert("anthropic", { type: "api_key", key: "hidden-anthropic-key" });
		await storage!.credentials.upsert("openai-codex", mintOAuthCredential("codex", Date.now() + 120_000));
		await storage!.credentials.upsert("openrouter", { type: "api_key", key: "visible-openrouter-key" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initialResult.snapshot,
			accountPool: new Map([
				["*", { accounts: new Set<string>(), apiKeys: false }],
				["anthropic", { apiKeys: false }],
				["openrouter", {}],
			]),
		});
		const visible = () =>
			remote!
				.listAuthCredentials()
				.map(entry => `${entry.provider}:${entry.credential.type}`)
				.sort();
		expect(visible()).toEqual(["anthropic:oauth", "openrouter:api_key"]);

		const initialGeneration = remote.snapshot.generation;
		await storage!.credentials.upsert("moonshot", { type: "api_key", key: "hidden-moonshot-key" });
		await waitUntil(() => remote!.snapshot.generation > initialGeneration);
		expect(visible()).toEqual(["anthropic:oauth", "openrouter:api_key"]);
	});

	test("copies object rules, identity sets, and wildcard rules before callers can widen them", async () => {
		await storage!.credentials.upsert("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		await storage!.credentials.upsert("anthropic", { type: "api_key", key: "hidden-key" });
		await storage!.credentials.upsert("openrouter", { type: "api_key", key: "hidden-provider-key" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initial = await client.fetchSnapshot();
		if (initial.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initial.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initial.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identities");
		const rule = { accounts: new Set([allowed.identityKey]), apiKeys: false };
		const pool = new Map<string, { accounts?: Set<string>; apiKeys?: boolean }>([
			["*", { accounts: new Set(), apiKeys: false }],
			["anthropic", rule],
		]);
		remote = new RemoteAuthCredentialStore({
			client,
			initialSnapshot: initial.snapshot,
			streamSnapshots: false,
			accountPool: pool,
		});

		rule.accounts.add(excluded.identityKey);
		rule.apiKeys = true;
		pool.set("*", {});
		await remote.refreshSnapshot();
		expect(remote.listAuthCredentials().map(entry => entry.id)).toEqual([allowed.id]);
	});

	test("loads the account pool once for broker-backed discovery", async () => {
		await storage!.credentials.upsert("anthropic", mintOAuthCredential("b", Date.now() + 120_000));
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		const excluded = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("b@example.com"));
		if (!allowed?.identityKey || !excluded?.identityKey) throw new Error("expected OAuth identity keys");
		const poolPath = path.join(tempDir, "account-pool.json");
		await Bun.write(poolPath, JSON.stringify({ anthropic: [allowed.identityKey] }));

		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "snapshot-cache.enc"),
				});
				try {
					expect(discovered.oauth.accounts("anthropic").map(account => account.email)).toEqual(["a@example.com"]);

					await Bun.write(
						poolPath,
						JSON.stringify({
							anthropic: [allowed.identityKey, excluded.identityKey],
						}),
					);
					await discovered.credentials.reload();
					expect(discovered.oauth.accounts("anthropic").map(account => account.email)).toEqual(["a@example.com"]);
				} finally {
					await discovered.close();
				}
			},
		);
	});

	test("loads allow-list rules from the account pool file", async () => {
		await storage!.credentials.upsert("anthropic", { type: "api_key", key: "hidden-anthropic-key" });
		await storage!.credentials.upsert("openrouter", { type: "api_key", key: "visible-openrouter-key" });
		await storage!.credentials.upsert("moonshot", { type: "api_key", key: "hidden-moonshot-key" });
		const client = new AuthBrokerClient({ url: handle!.url, token });
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200) throw new Error("expected initial snapshot");
		const allowed = initialResult.snapshot.credentials.find(entry => entry.identityKey?.includes("a@example.com"));
		if (!allowed?.identityKey) throw new Error("expected OAuth identity key");
		const poolPath = path.join(tempDir, "account-pool.json");
		await Bun.write(
			poolPath,
			JSON.stringify({
				"*": false,
				anthropic: { accounts: [allowed.identityKey], apiKeys: false },
				openrouter: true,
			}),
		);

		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: poolPath,
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "allow-list-snapshot-cache.enc"),
				});
				try {
					expect(discovered.oauth.accounts("anthropic").map(account => account.email)).toEqual(["a@example.com"]);
					expect(
						discovered.credentials
							.snapshot()
							.credentials.map(entry => `${entry.provider}:${entry.credential.type}`)
							.sort(),
					).toEqual(["anthropic:oauth", "openrouter:api_key"]);
				} finally {
					await discovered.close();
				}

				await Bun.write(poolPath, JSON.stringify({ anthropic: { apiKeys: "no" } }));
				await expect(
					discoverAuthStorage({ agentDir: tempDir, cachePath: path.join(tempDir, "invalid-cache.enc") }),
				).rejects.toThrow('"apiKeys" that is not a boolean');
			},
		);
	});

	test("prefers a programmatic SDK account pool over the environment file", async () => {
		await withEnv(
			{
				OMP_AUTH_BROKER_URL: handle!.url,
				OMP_AUTH_BROKER_TOKEN: token,
				OMP_AUTH_BROKER_ACCOUNT_POOL_FILE: path.join(tempDir, "missing-account-pool.json"),
			},
			async () => {
				const discovered = await discoverAuthStorage({
					agentDir: tempDir,
					cachePath: path.join(tempDir, "sdk-snapshot-cache.enc"),
					accountPool: new Map([["anthropic", new Set()]]),
				});
				try {
					expect(discovered.oauth.accounts("anthropic")).toEqual([]);
				} finally {
					await discovered.close();
				}
			},
		);
	});

	test("evicts cold sticky sessions while preserving recently accessed sessions", () => {
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		const expires = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
		for (let i = 0; i < 4096; i++) remote.setCache(`session:sticky:mock:${i}`, "credential-1", expires);
		expect(remote.getCache("session:sticky:mock:0")).toBe("credential-1");
		for (let i = 4096; i < 5000; i++) remote.setCache(`session:sticky:mock:${i}`, "credential-1", expires);
		expect(remote.getCache("session:sticky:mock:0")).toBe("credential-1");
		expect(remote.getCache("session:sticky:mock:1")).toBeNull();
		expect(remote.getCache("session:sticky:mock:4999")).toBe("credential-1");
	});

	test("bounds cached request data even when one session key or value is large", () => {
		remote = new RemoteAuthCredentialStore({
			client: new AuthBrokerClient({ url: handle!.url, token }),
		});
		const expires = Math.floor(Date.now() / 1000) + 60;
		const payload = "x".repeat(2 * 1024 * 1024);
		remote.setCache("first", payload, expires);
		remote.setCache("second", payload, expires);
		remote.setCache("third", payload, expires);
		expect(remote.getCache("first")).toBeNull();
		expect(remote.getCache("third")).toBe(payload);
		remote.setCache("oversized", payload + payload + "!", expires);
		expect(remote.getCache("oversized")).toBeNull();
		expect(remote.getCache("third")).toBe(payload);
	});

	test.each(["refresh", "rotate", "invalidateMatching"] as const)(
		"does not start delegated %s after shutdown stops mint admission",
		async operation => {
			const provider = "unit-broker-shutdown-admission";
			const sourceId = "auth-broker-remote-store-shutdown-test";
			let minted = 0;
			registerOAuthProvider({
				id: provider,
				name: provider,
				sourceId,
				async login() {
					throw new Error("Unexpected interactive login");
				},
				async refreshToken(credential) {
					minted++;
					return {
						...credential,
						access: "should-not-mint",
						refresh: "should-not-rotate",
						expires: Date.now() + 3_600_000,
					};
				},
				getApiKey(credential) {
					return credential.access;
				},
			});
			let gateway: AuthStorage | undefined;
			try {
				await storage!.credentials.set(provider, [
					{
						type: "oauth",
						access: "old-access",
						refresh: "old-refresh",
						expires: Date.now() + 3_600_000,
					},
				]);
				const client = new AuthBrokerClient({ url: handle!.url, token });
				const initial = await client.fetchSnapshot();
				if (initial.status !== 200) throw new Error("expected initial broker snapshot");
				remote = new RemoteAuthCredentialStore({
					client,
					initialSnapshot: initial.snapshot,
					streamSnapshots: false,
				});
				gateway = new AuthStorage(remote);
				await gateway.credentials.reload();
				const id = remote.snapshot.credentials.find(row => row.provider === provider)?.id;
				if (id === undefined) throw new Error("missing broker credential");
				const refresh =
					operation === "refresh"
						? gateway.oauth.refresh(id)
						: operation === "rotate"
							? gateway.limits.rotate(provider, undefined, {
									credentialId: id,
									error: Object.assign(new Error("Generic unauthorized response"), { status: 401 }),
								})
							: gateway.limits.invalidateMatching(provider, "old-access");
				const stopped = gateway.close();
				await expect(refresh).rejects.toBeInstanceOf(AbortError);
				await stopped;
				expect(minted).toBe(0);
				expect(store!.listAuthCredentials(provider)[0]?.credential).toMatchObject({
					type: "oauth",
					access: "old-access",
					refresh: "old-refresh",
				});
			} finally {
				await gateway?.close();
				unregisterOAuthProviders(sourceId);
			}
		},
	);
});

/**
 * Snapshot builder for the fake-client tests: only `id`/`provider`/`credential`
 * feed the content fingerprint, so the credential key is what drives change
 * detection.
 */
function buildApiKeySnapshot(
	generation: number,
	creds: { id: number; provider: string; key: string }[],
): SnapshotResponse {
	return {
		generation,
		generatedAt: Date.now(),
		serverNowMs: Date.now(),
		refresher: { enabled: false, intervalMs: 0, skewMs: 0, nextSweepInMs: 0 },
		credentials: creds.map(c => ({
			id: c.id,
			provider: c.provider,
			credential: { type: "api_key", key: c.key },
			identityKey: null,
			rotatesInMs: null,
		})),
	};
}

/**
 * Minimal broker client that serves a test-controlled snapshot. Background
 * long-poll calls (which pass `ifGenerationGt`) always report "unchanged" so
 * the manual `refreshSnapshot()` is the sole driver, keeping the test
 * deterministic.
 */
class FakeBrokerClient {
	current: SnapshotResponse;
	constructor(initial: SnapshotResponse) {
		this.current = initial;
	}
	async fetchSnapshot(opts: { ifGenerationGt?: number } = {}): Promise<FetchSnapshotResult> {
		if (opts.ifGenerationGt !== undefined) return { status: 304, generation: this.current.generation };
		return {
			status: 200,
			snapshot: this.current,
			generation: this.current.generation,
		};
	}
}

describe("RemoteAuthCredentialStore.pollExternalChanges content revision", () => {
	test("detects a replaced credential even when the broker generation repeats", async () => {
		const initial = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-old" }]);
		const client = new FakeBrokerClient(initial);
		const store = new RemoteAuthCredentialStore({
			client: client as unknown as AuthBrokerClient,
			initialSnapshot: initial,
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		try {
			// Boot state is acknowledged: nothing to report yet.
			expect(store.pollExternalChanges()).toBe(false);

			// An identical re-fetch (same generation, same content) stays quiet.
			client.current = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-old" }]);
			await store.refreshSnapshot();
			expect(store.pollExternalChanges()).toBe(false);

			// The broker restarts and replaces the credential's key while its
			// in-memory generation counter lands back on the acknowledged value 5.
			// A generation-equality check would miss this; the content revision
			// catches it.
			client.current = buildApiKeySnapshot(5, [{ id: 1, provider: "deepseek", key: "sk-new" }]);
			await store.refreshSnapshot();
			expect(store.snapshot.generation).toBe(5);
			expect(store.pollExternalChanges()).toBe(true);
			// One true per observed change.
			expect(store.pollExternalChanges()).toBe(false);
		} finally {
			store.close();
		}
	});
});

type TestBlock = {
	providerKey: string;
	blockScope: string;
	blockedUntilMs: number;
	updatedAtMs?: number;
	mutationToken?: string;
};

class DeferredBlockBroker extends FakeBrokerClient {
	readonly blocks = new Map<number, Map<string, TestBlock>>();
	readonly operations: Array<{
		id: number;
		kind: "upsert" | "delete" | "delete-all";
		release: () => void;
		completed: Promise<void>;
	}> = [];
	readonly #operationWaiters = new Map<number, PromiseWithResolvers<(typeof this.operations)[number]>>();
	readonly #snapshotWaiters: Array<PromiseWithResolvers<FetchSnapshotResult>> = [];
	readonly #timestamp: number;

	constructor(initial: SnapshotResponse, timestamp: number) {
		super(initial);
		this.current.blockRevision = {
			instanceId: "test-persisted-db",
			sequence: 1,
		};
		this.#timestamp = timestamp;
		for (const entry of initial.credentials) {
			this.blocks.set(entry.id, new Map((entry.blocks ?? []).map(block => [this.#key(block), block])));
		}
	}

	#key(block: Pick<TestBlock, "providerKey" | "blockScope">): string {
		return `${block.providerKey}\0${block.blockScope}`;
	}

	visible(id: number): TestBlock[] {
		return [...(this.blocks.get(id)?.values() ?? [])];
	}

	snapshot(): SnapshotResponse {
		return {
			...this.current,
			credentials: this.current.credentials.map(entry => {
				const blocks = this.visible(entry.id);
				return blocks.length ? { ...entry, blocks } : { ...entry, blocks: undefined };
			}),
		};
	}

	deferSnapshot(): PromiseWithResolvers<FetchSnapshotResult> {
		const waiter = Promise.withResolvers<FetchSnapshotResult>();
		this.#snapshotWaiters.push(waiter);
		return waiter;
	}

	override async fetchSnapshot(opts: { ifGenerationGt?: number } = {}): Promise<FetchSnapshotResult> {
		if (opts.ifGenerationGt !== undefined) return { status: 304, generation: this.current.generation };
		const waiter = this.#snapshotWaiters.shift();
		return (
			waiter?.promise ?? {
				status: 200,
				snapshot: this.snapshot(),
				generation: this.current.generation,
			}
		);
	}

	waitForOperation(index: number): Promise<(typeof this.operations)[number]> {
		const operation = this.operations[index];
		if (operation) return Promise.resolve(operation);
		const ready = Promise.withResolvers<(typeof this.operations)[number]>();
		this.#operationWaiters.set(index, ready);
		return ready.promise;
	}

	#defer(
		id: number,
		kind: "upsert" | "delete" | "delete-all",
		apply: () => boolean | void,
	): Promise<{ ok: true; deleted?: boolean }> {
		const gate = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const operation = {
			id,
			kind,
			release: () => gate.resolve(),
			completed: completed.promise,
		};
		this.operations.push(operation);
		const index = this.operations.length - 1;
		this.#operationWaiters.get(index)?.resolve(operation);
		this.#operationWaiters.delete(index);
		return gate.promise.then(() => {
			const deleted = apply();
			this.current.blockRevision = {
				instanceId: "test-persisted-db",
				sequence: this.current.blockRevision!.sequence + 1,
			};
			completed.resolve();
			return {
				ok: true as const,
				...(deleted !== undefined ? { deleted } : {}),
				blockRevision: this.current.blockRevision,
			};
		});
	}

	upsertCredentialBlock(id: number, block: TestBlock): Promise<{ ok: true }> {
		return this.#defer(id, "upsert", () => {
			const rows = this.blocks.get(id) ?? new Map<string, TestBlock>();
			const key = this.#key(block);
			const previous = rows.get(key);
			rows.set(key, {
				...block,
				blockedUntilMs: Math.max(previous?.blockedUntilMs ?? 0, block.blockedUntilMs),
				updatedAtMs: this.#timestamp,
			});
			this.blocks.set(id, rows);
		});
	}

	deleteCredentialBlock(
		id: number,
		block: Pick<TestBlock, "providerKey" | "blockScope" | "mutationToken" | "blockedUntilMs">,
	): Promise<{ ok: true; deleted?: boolean }> {
		return this.#defer(id, "delete", () => {
			const rows = this.blocks.get(id);
			const current = rows?.get(this.#key(block));
			if (
				!current ||
				current.mutationToken !== block.mutationToken ||
				current.blockedUntilMs !== block.blockedUntilMs
			)
				return false;
			rows!.delete(this.#key(block));
			return true;
		});
	}

	deleteCredentialBlocks(id: number, request: { blocks: TestBlock[] }): Promise<{ ok: true; deleted?: boolean }> {
		return this.#defer(id, "delete-all", () => {
			const rows = this.blocks.get(id);
			let deleted = true;
			for (const block of request.blocks) {
				const current = rows?.get(this.#key(block));
				if (
					!current ||
					current.mutationToken !== block.mutationToken ||
					current.blockedUntilMs !== block.blockedUntilMs
				) {
					deleted = false;
					continue;
				}
				rows!.delete(this.#key(block));
			}
			return deleted;
		});
	}
}

describe("RemoteAuthCredentialStore broker block mutation ordering", () => {
	const credentialId = 7;
	const providerKey = "anthropic:oauth";
	const blockScope = "tier:fable";

	function setup(initialBlocks: TestBlock[] = []) {
		const now = Date.now();
		const initial = buildApiKeySnapshot(1, [
			{ id: credentialId, provider: "anthropic", key: "sk-test" },
			{ id: 8, provider: "anthropic", key: "sk-other" },
		]);
		initial.blockMutationTokens = true;
		initial.credentials[0]!.blocks = initialBlocks.map((block, index) => ({
			...block,
			mutationToken: block.mutationToken ?? `initial-${index}`,
		}));
		const client = new DeferredBlockBroker(initial, now);
		const remote = new RemoteAuthCredentialStore({
			client: client as unknown as AuthBrokerClient,
			initialSnapshot: initial,
			streamSnapshots: false,
			backgroundIdleMs: 0,
		});
		const block = {
			credentialId,
			providerKey,
			blockScope,
			blockedUntilMs: now + 60_000,
			updatedAtMs: now,
		};
		return { client, remote, block };
	}

	test("upsert, scoped delete, and upsert commit in invocation order while another ID remains independent", async () => {
		const { client, remote, block } = setup();
		try {
			remote.upsertCredentialBlock(block);
			remote.deleteCredentialBlock(credentialId, providerKey, blockScope);
			remote.upsertCredentialBlock(block);
			remote.upsertCredentialBlock({ ...block, credentialId: 8 });
			expect(client.operations.map(op => [op.id, op.kind])).toEqual([
				[credentialId, "upsert"],
				[8, "upsert"],
			]);
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);

			client.operations[0]!.release();
			await client.operations[0]!.completed;
			const deleteOp = await client.waitForOperation(2);
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
			expect(deleteOp.kind).toBe("delete");
			deleteOp.release();
			await deleteOp.completed;
			await Promise.resolve();
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
			const upsertOp = await client.waitForOperation(3);
			expect(upsertOp.kind).toBe("upsert");
			upsertOp.release();
			await upsertOp.completed;
			await remote.refreshSnapshot();
			expect(client.visible(credentialId).map(row => row.blockedUntilMs)).toEqual([block.blockedUntilMs]);
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
			client.operations[1]!.release();
			await client.operations[1]!.completed;
			expect(client.visible(8).map(row => row.blockedUntilMs)).toEqual([block.blockedUntilMs]);
		} finally {
			remote.close();
		}
	});

	test("delete-all cannot erase a later upsert, even when an old snapshot arrives between acknowledgements", async () => {
		const { client, remote, block } = setup([
			{ providerKey, blockScope, blockedUntilMs: Date.now() + 60_000 },
			{
				providerKey,
				blockScope: "shared",
				blockedUntilMs: Date.now() + 60_000,
			},
		]);
		try {
			remote.deleteCredentialBlocks(credentialId);
			remote.upsertCredentialBlock(block);
			expect(client.operations.map(op => op.kind)).toEqual(["delete-all"]);
			const oldSnapshot = client.snapshot();
			const stale = client.deferSnapshot();
			const staleRequest = remote.refreshSnapshot();
			client.operations[0]!.release();
			await client.operations[0]!.completed;
			const upsertOp = await client.waitForOperation(1);
			expect(upsertOp.kind).toBe("upsert");
			// The pre-ack read may complete after the DELETE. Its durable revision
			// still predates the acknowledgement.
			stale.resolve({
				status: 200,
				generation: oldSnapshot.generation,
				snapshot: oldSnapshot,
			});
			await staleRequest;
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
			client.operations[1]!.release();
			await client.operations[1]!.completed;
			await remote.refreshSnapshot();
			expect(client.visible(credentialId).map(row => row.blockedUntilMs)).toEqual([block.blockedUntilMs]);
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
		} finally {
			remote.close();
		}
	});

	test("an older GET response cannot overwrite a newer committed snapshot", async () => {
		const { client, remote, block } = setup();
		try {
			const stale = client.deferSnapshot();
			const staleRequest = remote.refreshSnapshot();
			const oldSnapshot = client.snapshot();
			remote.upsertCredentialBlock(block);
			client.operations[0]!.release();
			await client.operations[0]!.completed;
			await Promise.resolve();
			await remote.refreshSnapshot();
			stale.resolve({
				status: 200,
				generation: oldSnapshot.generation,
				snapshot: oldSnapshot,
			});
			await staleRequest;
			expect(client.visible(credentialId).map(row => row.blockedUntilMs)).toEqual([block.blockedUntilMs]);
			expect(remote.listCredentialBlocks([credentialId]).map(row => row.blockedUntilMs)).toEqual([
				block.blockedUntilMs,
			]);
		} finally {
			remote.close();
		}
	});

	test("a later GET cannot roll back an acknowledged block to an older durable revision", async () => {
		const { client, remote, block } = setup();
		try {
			const oldSnapshot = client.snapshot();
			remote.upsertCredentialBlock(block);
			client.operations[0]!.release();
			await client.operations[0]!.completed;
			await remote.refreshSnapshot();
			expect(remote.getCredentialBlock(credentialId, providerKey, blockScope)).toBe(block.blockedUntilMs);

			const stale = client.deferSnapshot();
			const staleRequest = remote.refreshSnapshot();
			stale.resolve({
				status: 200,
				generation: oldSnapshot.generation,
				snapshot: oldSnapshot,
			});
			await staleRequest;
			expect(remote.getCredentialBlock(credentialId, providerKey, blockScope)).toBe(block.blockedUntilMs);
			expect(remote.snapshot.blockRevision!.sequence).toBeGreaterThan(oldSnapshot.blockRevision!.sequence);
		} finally {
			remote.close();
		}
	});

	test("a committed same-millisecond recreation survives the deleted row's tombstone", async () => {
		const timestamp = Date.now();
		const original = {
			providerKey,
			blockScope,
			blockedUntilMs: timestamp + 60_000,
			updatedAtMs: timestamp,
			mutationToken: "test-original",
		};
		const { client, remote } = setup([original]);
		try {
			remote.deleteCredentialBlock(credentialId, providerKey, blockScope);
			expect(remote.listCredentialBlocks([credentialId])).toEqual([]);
			const oldSnapshot = client.snapshot();
			const stale = client.deferSnapshot();
			const staleRequest = remote.refreshSnapshot();
			const staleAckRefresh = client.deferSnapshot();
			client.operations[0]!.release();
			await client.operations[0]!.completed;
			await Promise.resolve();
			const recreated = { ...original, mutationToken: "test-recreated" };
			client.blocks.get(credentialId)!.set(`${providerKey}\0${blockScope}`, recreated);
			expect(client.visible(credentialId)).toEqual([recreated]);
			client.current.blockRevision = {
				instanceId: "test-persisted-db",
				sequence: client.current.blockRevision!.sequence + 1,
			};
			await remote.refreshSnapshot();
			expect(remote.getCredentialBlock(credentialId, providerKey, blockScope)).toBe(original.blockedUntilMs);
			stale.resolve({
				status: 200,
				generation: oldSnapshot.generation,
				snapshot: oldSnapshot,
			});
			staleAckRefresh.resolve({
				status: 200,
				generation: oldSnapshot.generation,
				snapshot: oldSnapshot,
			});
			await Promise.resolve();
			await staleRequest;
			expect(remote.getCredentialBlock(credentialId, providerKey, blockScope)).toBe(original.blockedUntilMs);
		} finally {
			remote.close();
		}
	});
});
