import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { AuthStorage, type AuthStorageOptions, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import { ModelRegistry } from "../../src/config/model-registry";
import { anthropicSlowModeLanes } from "../../src/session/anthropic-slow-mode";
import type { MainThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { authService } from "../../src/thread/services/auth";
import type { AuthProbe, AuthTestGlobals } from "../fixtures/auth-service-worker";

const PROVIDER = "unit-oauth-thread";
const LANE = "cred:thread-test";

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

describe("auth thread service", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let registry: ModelRegistry;
	let worker: Worker | undefined;
	let link: MainThreadLink | undefined;
	let syncReplyPort: MessagePort;
	let peer: WorkerPeer;
	let probe: AuthProbe;
	let refreshCredential: NonNullable<AuthStorageOptions["refreshOAuthCredential"]>;
	const releaseGates: Array<() => void> = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-thread-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		refreshCredential = async (_provider, _id, credential) => credential;
		storage = new AuthStorage(store, {
			sourceIdentity: "fixture:first",
			refreshOAuthCredential: (...args) => refreshCredential(...args),
			refreshOAuthCredentialMints: true,
		});
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider];
			return credential ? { newCredentials: credential, apiKey: credential.access } : null;
		});
		const modelsPath = path.join(tempDir, "models.json");
		await Bun.write(
			modelsPath,
			JSON.stringify({
				providers: {
					"unit-mirror": {
						baseUrl: "https://unit-mirror.example.invalid/v1",
						api: "openai-completions",
						apiKey: "mirror-config-key",
						models: [{ id: "mirror-model", name: "Mirror Model" }],
					},
				},
			}),
		);
		registry = new ModelRegistry(storage, modelsPath, { cacheDbPath: path.join(tempDir, "models.db") });

		const spawned = new Worker(new URL("../fixtures/auth-service-worker.ts", import.meta.url).href, {
			type: "module",
		});
		worker = spawned;
		const channel = new MessageChannel();
		syncReplyPort = channel.port1;
		const counter = new SharedArrayBuffer(4);
		const { promise: ready, resolve: onReady } = Promise.withResolvers<void>();
		const readyListener = (event: MessageEvent): void => {
			if (event.data?.ready) {
				spawned.removeEventListener("message", readyListener);
				onReady();
			}
		};
		spawned.addEventListener("message", readyListener);
		spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
		await ready;
		const mainLink: MainThreadLink = new RpcLink(
			{
				send: frame => spawned.postMessage(frame),
				listen: handler => {
					const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
					spawned.addEventListener("message", listener);
					return () => spawned.removeEventListener("message", listener);
				},
			},
			{ name: "main↔auth-fixture", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		link = mainLink;
		mainLink.handle("ping", nonce => nonce);
		peer = { threadId: "w1", link: mainLink };
		authService.installMain?.(peer);
		const { promise: probed, resolve: onProbe } = Promise.withResolvers<AuthProbe>();
		const test: AuthTestGlobals = { storage, ready: received => onProbe(received) };
		await mainLink.call("boot", { [authService.name]: authService.globals?.(peer), test });
		probe = await probed;
	});

	afterEach(async () => {
		for (const release of releaseGates.splice(0)) release();
		link?.close("test done");
		link = undefined;
		await worker?.terminate();
		worker = undefined;
		anthropicSlowModeLanes.lane(LANE).reset();
		vi.restoreAllMocks();
		await storage.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function storeAccounts(): Promise<{ a: number; b: number }> {
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const [a, b] = storage.oauth.accounts(PROVIDER);
		if (!a || !b) throw new Error("expected two stored accounts");
		return { a: a.credentialId, b: b.credentialId };
	}

	it("hands the worker one canonical AuthStorage that resolves on the main instance", async () => {
		const { b } = await storeAccounts();
		expect(await probe.sameStorage(storage)).toBe(true);
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);

		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("restricts main lookups with a worker lease until the worker unrestricts", async () => {
		const { a, b } = await storeAccounts();
		const handle = await probe.restrict(PROVIDER, "child", ["account:acc-b"]);

		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-b");
		expect(await probe.key(PROVIDER, "child")).toBe("access-b");

		await probe.unrestrict(PROVIDER, "child", handle);
		expect(storage.sessions.permits(PROVIDER, "child", a)).toBe(true);
		expect(storage.sessions.permits(PROVIDER, "child", b)).toBe(true);
	});

	it("checks worker leases against the current restriction and their issuing storage", async () => {
		await storeAccounts();
		const handle = await probe.restrict(PROVIDER, "owned", ["account:acc-b"]);
		expect(await probe.ownsRestriction(PROVIDER, "owned", handle)).toBe(true);
		expect(await probe.ownsRestriction(PROVIDER, "other", handle)).toBe(false);
		expect(await probe.ownsRestriction("other-provider", "owned", handle)).toBe(false);
		expect(await probe.ownsRestriction(PROVIDER, "owned", "symbol")).toBe(false);
		expect(await probe.ownsRestriction(PROVIDER, "owned", "record")).toBe(false);

		const foreign = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "foreign.db")));
		try {
			foreign.sessions.restrict(PROVIDER, "owned", ["account:acc-b"]);
			expect(await probe.ownsRestriction(PROVIDER, "owned", handle, foreign)).toBe(false);
		} finally {
			await foreign.close();
		}

		const successor = await probe.restrict(PROVIDER, "owned", ["account:acc-a"]);
		expect(await probe.ownsRestriction(PROVIDER, "owned", handle)).toBe(false);
		expect(await probe.ownsRestriction(PROVIDER, "owned", successor)).toBe(true);
		await probe.unrestrict(PROVIDER, "owned", handle);
		expect(await probe.key(PROVIDER, "owned")).toBe("access-a");
	});

	it("resolves a worker's scoped primary and auxiliary lookups only through its issued leases", async () => {
		const { a } = await storeAccounts();
		storage.keys.setRuntime(PROVIDER, "outside-pool");
		const scope = await probe.scope(registry, { [PROVIDER]: ["account:acc-b"] }, "scope-root");

		expect(await probe.scopedKey(scope, PROVIDER)).toBe("access-b");
		expect(await probe.scopedKey(scope, PROVIDER, "scope-auxiliary")).toBe("access-b");
		expect(storage.sessions.permits(PROVIDER, "scope-auxiliary", a)).toBe(false);

		storage.sessions.restrict(PROVIDER, "scope-root", ["account:acc-a"]);
		const [primary] = await Promise.allSettled([probe.scopedKey(scope, PROVIDER)]);
		expect(primary).toEqual({ status: "rejected", reason: expect.any(Error) });
		const [auxiliary] = await Promise.allSettled([probe.scopedKey(scope, PROVIDER, "new-auxiliary")]);
		expect(auxiliary).toEqual({ status: "rejected", reason: expect.any(Error) });
	});

	it("rejects a scoped worker result superseded during refresh without discarding accepted token persistence", async () => {
		const { a, b } = await storeAccounts();
		const scope = await probe.scope(registry, { [PROVIDER]: ["account:acc-b"] }, "scope-refresh");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		refreshCredential = async (_provider, _id, credential) => {
			entered.resolve();
			await release.promise;
			return { ...credential, access: "access-b-refreshed", refresh: "refresh-b-refreshed" };
		};
		const lookup = Promise.allSettled([probe.scopedKey(scope, PROVIDER, undefined, { forceRefresh: true })]);
		await entered.promise;
		storage.sessions.restrict(PROVIDER, "scope-refresh", ["account:acc-b"]);
		release.resolve();

		const [outcome] = await lookup;
		expect(outcome).toEqual({ status: "rejected", reason: expect.any(Error) });
		expect(storage.sessions.permits(PROVIDER, "scope-refresh", a)).toBe(false);
		expect(storage.sessions.permits(PROVIDER, "scope-refresh", b)).toBe(true);
		expect(storage.credentials.list(PROVIDER).find(entry => entry.id === b)?.credential).toMatchObject({
			access: "access-b-refreshed",
			refresh: "refresh-b-refreshed",
		});
	});

	it("rebuilds main-thread auth errors by class in the worker", async () => {
		await storeAccounts();
		await probe.restrict(PROVIDER, "nowhere", ["account:acc-z"]);

		const outcome = await probe.keyError(PROVIDER, "nowhere");
		expect(outcome.missingApiKey).toBe(true);
		expect(outcome.message).toContain(`No API key for provider: ${PROVIDER}`);
	});

	it("releases every lease a worker holds when it exits", async () => {
		const { a } = await storeAccounts();
		await probe.restrict(PROVIDER, "orphan", ["account:acc-b"]);
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(false);

		authService.onWorkerExit?.(peer, "crashed");
		expect(storage.sessions.permits(PROVIDER, "orphan", a)).toBe(true);
	});

	it("delivers main credential events to worker listeners until they unsubscribe", async () => {
		await probe.watchGenerations();
		await storeAccounts();
		// Frames to the worker are ordered: the listener call lands before this read.
		expect((await probe.generations()).at(-1)).toBe(storage.credentials.generation);

		await probe.unwatchGenerations();
		const seen = (await probe.generations()).length;
		await storage.credentials.remove(PROVIDER);
		expect((await probe.generations()).length).toBe(seen);
	});

	it("answers worker auth availability from one cached batch until main's credentials change", async () => {
		// Main lists stored providers once per batch.
		const batches = vi.spyOn(storage.credentials, "all");
		const keyless = vi.spyOn(storage.keys, "keyless");
		// The first lookup brings every bundled provider along with the asked one.
		expect(await probe.sourceKinds([PROVIDER, "anthropic", "openai"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);
		const answered = new Set(keyless.mock.calls.map(([provider]) => provider));
		for (const provider of [PROVIDER, "anthropic", "openai"]) expect(answered.has(provider)).toBe(true);

		// A provider main did not list costs an answer of its own, not another batch.
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual([undefined, undefined]);
		expect(await probe.sourceKinds([PROVIDER, "unit-other", "anthropic"])).toHaveLength(3);
		expect(batches).toHaveBeenCalledTimes(1);

		// The generation bump reaches the worker before this probe call (frames are ordered).
		await storeAccounts();
		expect(await probe.sourceKinds([PROVIDER, "unit-other"])).toEqual(["oauth", undefined]);
		expect(batches).toHaveBeenCalledTimes(2);
	});

	it("resolves a worker's OAuth identity from main once main stores an account after the worker saw none", async () => {
		expect(await probe.accountId(PROVIDER, "pinned")).toBeUndefined();

		const { b } = await storeAccounts();
		expect(storage.sessions.pin(PROVIDER, "pinned", b)).toBe(true);
		expect(await probe.key(PROVIDER, "pinned")).toBe("access-b");
		expect(await probe.accountId(PROVIDER, "pinned")).toBe("acc-b");
	});

	it("revokes worker admissions and drains its admitted lookup without closing the owner's storage", async () => {
		await storeAccounts();
		await probe.captureResolver(PROVIDER, "child");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		refreshCredential = async (_provider, _id, credential) => {
			entered.resolve();
			await release.promise;
			return { ...credential, access: "access-rotated", refresh: "refresh-rotated" };
		};
		const lookup = probe.key(PROVIDER, "child", { forceRefresh: true });
		await entered.promise;
		let closed = false;
		const closing = probe.close().then(() => {
			closed = true;
		});
		try {
			expect(await probe.isClosed()).toBe(true);
			expect(closed).toBe(false);
			const [later] = await Promise.allSettled([probe.key(PROVIDER, "later")]);
			expect(later).toEqual({ status: "rejected", reason: expect.any(Error) });
			const [captured] = await Promise.allSettled([probe.resolveCaptured()]);
			expect(captured).toEqual({ status: "rejected", reason: expect.any(Error) });
		} finally {
			release.resolve();
		}
		expect(await lookup).toBe("access-rotated");
		await closing;
		expect(storage.isClosed).toBe(false);
		expect(await storage.keys.get(PROVIDER, "child")).toBe("access-rotated");
	});

	it("retains main's late token persistence after the worker cancels its refresh waiter", async () => {
		await storage.credentials.set(PROVIDER, oauthCredential("a"));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		let refreshDispatches = 0;
		refreshCredential = async (_provider, _id, credential) => {
			refreshDispatches += 1;
			entered.resolve();
			await release.promise;
			return { ...credential, access: "access-after-abort", refresh: "refresh-after-abort" };
		};
		const controller = new AbortController();
		const lookup = probe.key(PROVIDER, "cancelled", { forceRefresh: true, signal: controller.signal });
		await entered.promise;
		controller.abort(new Error("cancel worker waiter"));
		expect(await lookup).toBeUndefined();
		expect(refreshDispatches).toBe(1);
		let closed = false;
		const closing = storage.close().then(() => {
			closed = true;
		});
		try {
			expect(await probe.isClosed()).toBe(true);
			expect(closed).toBe(false);
			expect(await probe.key(PROVIDER, "after-owner-close", { forceRefresh: true })).toBeUndefined();
			expect(refreshDispatches).toBe(1);
			expect(closed).toBe(false);
		} finally {
			release.resolve();
		}
		await closing;
		expect(refreshDispatches).toBe(1);
		const persisted = new AuthStorage(await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db")));
		try {
			await persisted.credentials.reload();
			expect(persisted.credentials.getOAuth(PROVIDER)?.refresh).toBe("refresh-after-abort");
		} finally {
			await persisted.close();
		}
	});

	it("retires a worker's captured source authority when main replaces its credential store", async () => {
		await probe.captureSource();
		expect(await probe.sourceCurrent()).toBe(true);
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "replacement.db"));
		await storage.replaceStore(replacement, { sourceIdentity: "fixture:replacement" });
		expect(await probe.sourceCurrent()).toBe(false);
	});

	it("runs a worker's captured credential guard before accepting writes to a changed generation or source", async () => {
		await storeAccounts();
		await probe.captureSource();
		await probe.setCapturedCredential("unit-write", { type: "api_key", key: "accepted-key" });
		expect(storage.credentials.get("unit-write")).toEqual({ type: "api_key", key: "accepted-key" });

		await probe.captureSource();
		await probe.retireCapturedOwner();
		const [retiredOwner] = await Promise.allSettled([
			probe.setCapturedCredential("unit-write", { type: "api_key", key: "stale-worker-owner" }),
		]);
		expect(retiredOwner).toEqual({ status: "rejected", reason: expect.any(Error) });
		expect(storage.credentials.get("unit-write")).toEqual({ type: "api_key", key: "accepted-key" });

		await probe.captureSource();
		await storage.credentials.set("unit-other", { type: "api_key", key: "other-key" });
		const [staleGeneration] = await Promise.allSettled([
			probe.setCapturedCredential("unit-write", { type: "api_key", key: "stale-generation" }),
		]);
		expect(staleGeneration).toEqual({ status: "rejected", reason: expect.any(Error) });
		expect(storage.credentials.get("unit-write")).toEqual({ type: "api_key", key: "accepted-key" });

		await probe.captureSource();
		const replacement = await SqliteAuthCredentialStore.open(path.join(tempDir, "guard-replacement.db"));
		await storage.replaceStore(replacement, { sourceIdentity: "fixture:guard-replacement" });
		const [staleSource] = await Promise.allSettled([
			probe.setCapturedCredential("unit-write", { type: "api_key", key: "stale-source" }),
		]);
		expect(staleSource).toEqual({ status: "rejected", reason: expect.any(Error) });
		expect(replacement.listAuthCredentials("unit-write")).toEqual([]);
	});

	it("fences a guarded worker write when an earlier notification changes main's credential generation", async () => {
		const { a } = await storeAccounts();
		await probe.captureSource();
		const block = {
			credentialId: a,
			providerKey: PROVIDER,
			blockScope: "admission",
			blockedUntilMs: Date.now() + 60 * 60_000,
		};
		const [outcome] = await Promise.allSettled([
			probe.setCapturedCredential("unit-write", { type: "api_key", key: "stale-admission" }, block),
		]);
		expect(outcome).toEqual({ status: "rejected", reason: expect.any(Error) });
		expect(store.listCredentialBlocks([a])).toEqual([expect.objectContaining(block)]);
		expect(store.listAuthCredentials("unit-write")).toEqual([]);
	});

	it("drains actual credential persistence after revoking the worker's admissions", async () => {
		await probe.captureSource();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		const replace = store.replaceAuthCredentials.bind(store);
		vi.spyOn(store, "replaceAuthCredentials").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return replace(...args);
		});
		const write = probe.setCapturedCredential("unit-write", { type: "api_key", key: "settled-key" });
		await entered.promise;
		await probe.retireCapturedOwner();
		let closed = false;
		const closing = probe.close().then(() => {
			closed = true;
		});
		try {
			expect(await probe.isClosed()).toBe(true);
			expect(await probe.sourceCurrent()).toBe(false);
			expect(closed).toBe(false);
			expect(store.listAuthCredentials("unit-write")).toEqual([]);
		} finally {
			release.resolve();
		}
		await write;
		await closing;
		expect(store.listAuthCredentials("unit-write")).toEqual([
			expect.objectContaining({ credential: { type: "api_key", key: "settled-key" } }),
		]);
		expect(storage.isClosed).toBe(false);
	});

	it("drains a genuinely admitted write even when the worker loses its admission receipt", async () => {
		await probe.captureSource();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		releaseGates.push(release.resolve);
		const replace = store.replaceAuthCredentials.bind(store);
		const postReply = syncReplyPort.postMessage.bind(syncReplyPort);
		let loseReceipt = false;
		vi.spyOn(store, "replaceAuthCredentials").mockImplementation(async (...args) => {
			loseReceipt = true;
			entered.resolve();
			await release.promise;
			return replace(...args);
		});
		vi.spyOn(syncReplyPort, "postMessage").mockImplementation((...args) => {
			if (loseReceipt) {
				loseReceipt = false;
				throw new Error("credential admission receipt lost");
			}
			const [message, transferOrOptions] = args;
			if (Array.isArray(transferOrOptions)) return postReply(message, transferOrOptions);
			return postReply(message, transferOrOptions);
		});
		const write = Promise.allSettled([
			probe.setCapturedCredential("unit-write", { type: "api_key", key: "receipt-lost-key" }),
		]);
		await entered.promise;
		const [outcome] = await write;
		expect(outcome).toEqual({ status: "rejected", reason: expect.any(Error) });
		await probe.retireCapturedOwner();
		let closed = false;
		const closing = probe.close().then(() => {
			closed = true;
		});
		try {
			expect(await probe.isClosed()).toBe(true);
			expect(await probe.sourceCurrent()).toBe(false);
			expect(closed).toBe(false);
			expect(store.listAuthCredentials("unit-write")).toEqual([]);
		} finally {
			release.resolve();
		}
		await closing;
		expect(store.listAuthCredentials("unit-write")).toEqual([
			expect.objectContaining({ credential: { type: "api_key", key: "receipt-lost-key" } }),
		]);
		expect(storage.isClosed).toBe(false);
	});

	it("preserves newer persisted blocks until a worker clears their exact mutation and deadline", async () => {
		const { a, b } = await storeAccounts();
		const before = await probe.blockRevision();
		if (!before) throw new Error("expected a SQLite block revision");
		const blockedUntilMs = Date.now() + 60 * 60_000;
		await probe.upsertBlock({ credentialId: a, providerKey: PROVIDER, blockScope: "single", blockedUntilMs });
		await probe.upsertBlock({ credentialId: b, providerKey: PROVIDER, blockScope: "other", blockedUntilMs });
		const [observed] = await probe.listBlocks([a]);
		if (!observed?.mutationToken) throw new Error("expected a persisted block mutation");
		const written = await probe.blockRevision();
		expect(written?.instanceId).toBe(before.instanceId);
		expect(written?.sequence).toBeGreaterThan(before.sequence);

		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			peerStore.upsertCredentialBlock({
				...observed,
				blockedUntilMs: blockedUntilMs + 60_000,
				mutationToken: "peer-single-block",
			});
			const [current] = peerStore.listCredentialBlocks([a]);
			if (!current?.mutationToken) throw new Error("expected the peer's block mutation");
			const revision = peerStore.getCredentialBlockRevision();
			expect(await probe.blockRevision()).toEqual(revision);
			expect(
				await probe.deleteBlockIfMatches(a, PROVIDER, "single", observed.mutationToken, observed.blockedUntilMs),
			).toBe(false);
			expect(
				await probe.deleteBlockIfMatches(a, PROVIDER, "single", current.mutationToken, observed.blockedUntilMs),
			).toBe(false);
			expect(peerStore.listCredentialBlocks([a])).toEqual([current]);
			expect(await probe.blockRevision()).toEqual(revision);

			expect(
				await probe.deleteBlockIfMatches(a, PROVIDER, "single", current.mutationToken, current.blockedUntilMs),
			).toBe(true);
			expect(peerStore.listCredentialBlocks([a])).toEqual([]);
			expect(peerStore.listCredentialBlocks([b])).toEqual([
				expect.objectContaining({ credentialId: b, blockScope: "other", blockedUntilMs }),
			]);
			expect((await probe.blockRevision())?.sequence).toBeGreaterThan(revision.sequence);
		} finally {
			peerStore.close();
		}
	});

	it("atomically refuses stale or repeated worker block batches without clearing an earlier matching row", async () => {
		const { a, b } = await storeAccounts();
		const blockedUntilMs = Date.now() + 60 * 60_000;
		for (const block of [
			{ credentialId: a, providerKey: PROVIDER, blockScope: "first", blockedUntilMs },
			{ credentialId: a, providerKey: PROVIDER, blockScope: "second", blockedUntilMs },
			{ credentialId: b, providerKey: PROVIDER, blockScope: "other", blockedUntilMs },
		]) {
			await probe.upsertBlock(block);
		}
		const observed = await probe.listBlocks([a]);
		const first = observed.find(block => block.blockScope === "first");
		const second = observed.find(block => block.blockScope === "second");
		if (!first?.mutationToken || !second?.mutationToken) throw new Error("expected both persisted blocks");

		const peerStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		try {
			peerStore.upsertCredentialBlock({ ...second, mutationToken: "peer-batch-block" });
			const current = peerStore.listCredentialBlocks([a]);
			const revision = peerStore.getCredentialBlockRevision();
			expect(await probe.deleteBlocksIfAllMatch(a, [first, second])).toBe(false);
			expect(peerStore.listCredentialBlocks([a])).toEqual(current);
			expect(await probe.blockRevision()).toEqual(revision);
			expect(await probe.deleteBlocksIfAllMatch(a, [first, first])).toBe(false);
			expect(peerStore.listCredentialBlocks([a])).toEqual(current);
			expect(await probe.blockRevision()).toEqual(revision);
			expect(await probe.deleteBlocksIfAllMatch(a, [])).toBe(true);
			expect(await probe.blockRevision()).toEqual(revision);

			expect(await probe.deleteBlocksIfAllMatch(a, current)).toBe(true);
			expect(peerStore.listCredentialBlocks([a])).toEqual([]);
			expect(peerStore.listCredentialBlocks([b])).toEqual([
				expect.objectContaining({ credentialId: b, blockScope: "other", blockedUntilMs }),
			]);
			expect((await probe.blockRevision())?.sequence).toBeGreaterThan(revision.sequence);
		} finally {
			peerStore.close();
		}
	});

	it("mirrors the main ModelRegistry locally over the shared AuthStorage", async () => {
		const first = await probe.registry(registry);
		expect(first).toEqual({
			local: true,
			canonical: true,
			sharesAuth: true,
			hasModel: true,
			apiKey: "mirror-config-key",
		});
		expect((await probe.registry(registry)).canonical).toBe(true);
		// The mirror never clears or reinstalls the key config main's registry owns.
		expect(await storage.keys.get("unit-mirror")).toBe("mirror-config-key");
	});

	it("shares the main thread's slow-mode lane state", async () => {
		const observed = await probe.observeWrapUp(LANE);
		expect(observed).toEqual({ remoteLane: true, stage: "wrap_up" });
		expect(anthropicSlowModeLanes.lane(LANE).status()?.stage).toBe("wrap_up");
	});
});
