import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importRoomKey } from "../../coding-agent/src/collab/crypto";
import type { CollabFrame } from "../../coding-agent/src/collab/protocol";
import { BrowserAuthorizationStore, type RelayIdentityVerifier } from "../src/auth";
import type { RelayServer } from "../src/server";
import { startRelayServer } from "../src/server";
import { FileShareStore, type ShareStore, ShareStoreCapacityError } from "../src/share-store";

// Mock the native-backed logger before loading the real CollabSocket protocol client.
mock.module("@oh-my-pi/pi-utils", () => ({ logger: { debug: () => undefined } }));
const { CollabSocket } = await import("../../coding-agent/src/collab/relay-client");

const ROOM_ID = "abcdefghijklmnop";

let root: string;
let relay: RelayServer;
let store: FileShareStore;

beforeEach(async () => {
	root = await mkdtemp(path.join(os.tmpdir(), "omp-relay-test-"));
	const publicDir = path.join(root, "public");
	await mkdir(publicDir);
	await writeFile(path.join(publicDir, "index.html"), "<html>collab</html>");
	await writeFile(path.join(publicDir, "deadbeef.js"), "console.log('ok')");
	await writeFile(path.join(root, "share.html"), "<html>share viewer</html>");
	store = new FileShareStore({ directory: path.join(root, "shares"), ttlMs: 60_000, maxStorageBytes: 2_000_000 });
	relay = await startRelayServer({
		hostname: "127.0.0.1",
		port: 0,
		staticRoot: publicDir,
		shareViewerPath: path.join(root, "share.html"),
		shareStore: store,
		maxHostRoomsPerClient: 1,
		maxShareUploadsPerClient: 2,
		shareUploadWindowMs: 60_000,
		roomIdleTimeoutMs: 60_000,
		roomMaxAgeMs: 120_000,
		trustedProxyHops: 1,
		pingIntervalMs: 60_000,
		cleanupIntervalMs: 60_000,
		shutdownTimeoutMs: 0,
		log: () => undefined,
	});
});

afterEach(async () => {
	await relay?.stop();
	await rm(root, { recursive: true, force: true });
});

const VALID_AUTH_TOKEN = "signed-aws-proof";
const TEST_IDENTITY = { userId: "140894b8-9011-70d3-65fa-cde7c8eb0194", subject: "test-role" };

async function restartWithAuthentication(): Promise<void> {
	await relay.stop();
	const identityVerifier: RelayIdentityVerifier = {
		async verify(token) {
			if (token !== VALID_AUTH_TOKEN) throw new Error("invalid proof");
			return TEST_IDENTITY;
		},
	};
	relay = await startRelayServer({
		hostname: "127.0.0.1",
		port: 0,
		staticRoot: path.join(root, "public"),
		shareViewerPath: path.join(root, "share.html"),
		shareStore: store,
		identityVerifier,
		browserAuthorizationStore: new BrowserAuthorizationStore(),
		pingIntervalMs: 60_000,
		cleanupIntervalMs: 60_000,
		shutdownTimeoutMs: 0,
		log: () => undefined,
	});
}

describe("HTTP share and web surfaces", () => {
	test("serves health, static client, share viewer, and security headers", async () => {
		const health = await fetch(`${relay.url}/healthz`);
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok");

		const index = await fetch(`${relay.url}/`);
		expect(await index.text()).toContain("collab");
		expect(index.headers.get("content-security-policy")).toContain("connect-src 'self' wss:");
		expect(index.headers.get("x-frame-options")).toBe("DENY");

		const asset = await fetch(`${relay.url}/deadbeef.js`);
		expect(asset.headers.get("cache-control")).toContain("immutable");

		const viewer = await fetch(`${relay.url}/s/1234567890ab`);
		expect(await viewer.text()).toContain("share viewer");
		expect(viewer.headers.get("content-security-policy")).toContain("https://api.github.com");

		expect((await fetch(`${relay.url}/../server.ts`)).status).toBe(404);
	});

	test("stores only opaque sealed bytes and returns the assigned non-hex id", async () => {
		const sealed = crypto.getRandomValues(new Uint8Array(128));
		const upload = await fetch(`${relay.url}/s`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: sealed,
		});
		expect(upload.status).toBe(201);
		const body = (await upload.json()) as { id: string };
		expect(body.id).toMatch(/^s_[A-Za-z0-9_-]{24}$/);

		const raw = await fetch(`${relay.url}/s/${body.id}/raw`);
		expect(raw.status).toBe(200);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(sealed);
		expect(raw.headers.get("cache-control")).toContain("no-store");

		const metrics = await (await fetch(`${relay.url}/metrics`)).text();
		expect(metrics).toContain("omp_relay_share_uploads_total 1");
		expect(metrics).toContain("omp_relay_share_reads_total 1");
	});

	test("requires AWS identity for uploads and browser identity for reads", async () => {
		await restartWithAuthentication();
		const sealed = crypto.getRandomValues(new Uint8Array(128));
		expect(
			(
				await fetch(`${relay.url}/s`, {
					method: "POST",
					headers: { "Content-Type": "application/octet-stream" },
					body: sealed,
				})
			).status,
		).toBe(401);
		const upload = await fetch(`${relay.url}/s`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${VALID_AUTH_TOKEN}`,
				"Content-Type": "application/octet-stream",
			},
			body: sealed,
		});
		expect(upload.status).toBe(201);
		const { id } = (await upload.json()) as { id: string };
		expect((await fetch(`${relay.url}/s/${id}/raw`)).status).toBe(401);

		const challengeResponse = await fetch(`${relay.url}/auth/browser/challenge`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(challengeResponse.status).toBe(201);
		const challenge = (await challengeResponse.json()) as { challengeId: string; userCode: string };
		const pending = await fetch(`${relay.url}/auth/browser/status`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId }),
		});
		expect(pending.status).toBe(202);

		const approval = await fetch(`${relay.url}/auth/browser/approve`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${VALID_AUTH_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ code: challenge.userCode }),
		});
		expect(approval.status).toBe(204);
		const exchange = await fetch(`${relay.url}/auth/browser/status`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeId: challenge.challengeId }),
		});
		expect(exchange.status).toBe(200);
		const session = (await exchange.json()) as { accessToken: string };
		expect(
			(
				await fetch(`${relay.url}/auth/browser/session`, {
					headers: { Authorization: `Bearer ${session.accessToken}` },
				})
			).status,
		).toBe(204);
		const raw = await fetch(`${relay.url}/s/${id}/raw`, {
			headers: { Authorization: `Bearer ${session.accessToken}` },
		});
		expect(raw.status).toBe(200);
		expect(new Uint8Array(await raw.arrayBuffer())).toEqual(sealed);
	});

	test("rejects malformed, wrong-content-type, and oversized uploads", async () => {
		const wrongType = await fetch(`${relay.url}/s`, { method: "POST", body: new Uint8Array(64) });
		expect(wrongType.status).toBe(415);

		const truncated = await fetch(`${relay.url}/s`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(28),
		});
		expect(truncated.status).toBe(400);

		const oversized = await fetch(`${relay.url}/s`, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(1_000_001),
		});
		expect(oversized.status).toBe(413);
	});

	test("rate-limits uploads by the ALB-appended client address", async () => {
		const upload = (forwardedFor: string) =>
			fetch(`${relay.url}/s`, {
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Forwarded-For": forwardedFor,
				},
				body: crypto.getRandomValues(new Uint8Array(64)),
			});

		expect((await upload("spoofed, 198.51.100.10")).status).toBe(201);
		expect((await upload("different-spoof, 198.51.100.10")).status).toBe(201);
		const limited = await upload("198.51.100.10");
		expect(limited.status).toBe(429);
		expect(limited.headers.get("retry-after")).toBeTruthy();
		expect((await upload("spoofed, 198.51.100.11")).status).toBe(201);

		const metrics = await (await fetch(`${relay.url}/metrics`)).text();
		expect(metrics).toContain("omp_relay_share_upload_rate_limited_total 1");
		expect(metrics).toContain("omp_relay_share_store_bytes 192");
	});
	test("records periodic cleanup failures without rejecting the timer task", async () => {
		await relay.stop();
		let cleanupCalls = 0;
		const cleanupFailed = Promise.withResolvers<void>();
		const cleanupStore: ShareStore = {
			put: data => store.put(data),
			get: id => store.get(id),
			stats: () => store.stats(),
			async cleanup() {
				cleanupCalls++;
				if (cleanupCalls > 1) throw new Error("cleanup failed");
				return store.cleanup();
			},
		};
		relay = await startRelayServer({
			hostname: "127.0.0.1",
			port: 0,
			staticRoot: path.join(root, "public"),
			shareViewerPath: path.join(root, "share.html"),
			shareStore: cleanupStore,
			cleanupIntervalMs: 1,
			pingIntervalMs: 60_000,
			shutdownTimeoutMs: 0,
			log: record => {
				if (record.event === "share_cleanup_failed") cleanupFailed.resolve();
			},
		});

		await cleanupFailed.promise;
		const metrics = await (await fetch(`${relay.url}/metrics`)).text();
		expect(metrics).toMatch(/omp_relay_share_store_errors_total [1-9]/);
		expect((await fetch(`${relay.url}/healthz`)).status).toBe(200);
	});
});

describe("WebSocket relay contract", () => {
	test("routes encrypted frames through the real omp CollabSocket client", async () => {
		const rawKey = crypto.getRandomValues(new Uint8Array(32));
		const key = await importRoomKey(rawKey);
		const wsUrl = `${relay.url.replace("http://", "ws://")}/r/${ROOM_ID}`;
		const host = new CollabSocket({ wsUrl, role: "host", key });
		const guest = new CollabSocket({ wsUrl, role: "guest", key });
		const hostOpened = Promise.withResolvers<void>();
		const guestOpened = Promise.withResolvers<void>();
		host.onOpen = () => hostOpened.resolve();
		guest.onOpen = () => guestOpened.resolve();
		host.connect();
		await hostOpened.promise;

		const joined = Promise.withResolvers<number>();
		host.onControl = message => {
			if (message.t === "peer-joined") joined.resolve(message.peer);
		};
		guest.connect();
		await guestOpened.promise;
		const peerId = await joined.promise;
		expect(peerId).toBe(1);

		const fromGuest = Promise.withResolvers<{ frame: CollabFrame; peer: number }>();
		host.onFrame = (frame, peer) => fromGuest.resolve({ frame, peer });
		guest.send({ t: "abort" });
		expect(await fromGuest.promise).toEqual({ frame: { t: "abort" }, peer: 1 });

		const fromHost = Promise.withResolvers<{ frame: CollabFrame; peer: number }>();
		guest.onFrame = (frame, peer) => fromHost.resolve({ frame, peer });
		host.send({ t: "error", message: "targeted" }, peerId);
		expect(await fromHost.promise).toEqual({ frame: { t: "error", message: "targeted" }, peer: 1 });

		guest.close();
		host.close();
	});

	test("authenticates native clients before allocating relay rooms", async () => {
		await restartWithAuthentication();
		const rawKey = crypto.getRandomValues(new Uint8Array(32));
		const key = await importRoomKey(rawKey);
		const wsUrl = `${relay.url.replace("http://", "ws://")}/r/${ROOM_ID}`;
		const host = new CollabSocket({
			wsUrl,
			role: "host",
			key,
			getAuthToken: async () => VALID_AUTH_TOKEN,
		});
		const opened = Promise.withResolvers<void>();
		host.onOpen = () => opened.resolve();
		host.connect();
		await opened.promise;

		const rejected = await openWebSocket(`${wsUrl}?role=guest`);
		rejected.send(JSON.stringify({ t: "auth", token: "invalid" }));
		expect((await waitForClose(rejected)).code).toBe(4401);
		host.close();
	});

	test("enforces missing-room, duplicate-host, and room-capacity close codes", async () => {
		const wsBase = relay.url.replace("http://", "ws://");
		const missingGuest = new WebSocket(`${wsBase}/r/${ROOM_ID}?role=guest`);
		expect((await waitForClose(missingGuest)).code).toBe(4004);

		const host = await openWebSocket(`${wsBase}/r/${ROOM_ID}?role=host`);
		const duplicate = new WebSocket(`${wsBase}/r/${ROOM_ID}?role=host`);
		expect((await waitForClose(duplicate)).code).toBe(4009);
		host.close();
	});

	test("limits host rooms per client address", async () => {
		const wsBase = relay.url.replace("http://", "ws://");
		const host = await openWebSocket(`${wsBase}/r/${ROOM_ID}?role=host`);
		const excess = new WebSocket(`${wsBase}/r/qrstuvwxyzabcdef?role=host`);
		expect((await waitForClose(excess)).code).toBe(4029);
		host.close();
	});

	test("expires idle rooms", async () => {
		await relay.stop();
		relay = await startRelayServer({
			hostname: "127.0.0.1",
			port: 0,
			staticRoot: path.join(root, "public"),
			shareViewerPath: path.join(root, "share.html"),
			shareStore: store,
			roomIdleTimeoutMs: 50,
			roomMaxAgeMs: 1_000,
			pingIntervalMs: 10,
			cleanupIntervalMs: 60_000,
			shutdownTimeoutMs: 0,
			log: () => undefined,
		});
		const host = await openWebSocket(`${relay.url.replace("http://", "ws://")}/r/${ROOM_ID}?role=host`);
		const closed = await waitForClose(host);
		expect(closed.code).toBe(4001);
		expect(closed.reason).toBe("room idle timeout");
	});
});

describe("file share store", () => {
	test("expires shares from disk and enforces the volume quota", async () => {
		const dataDir = path.join(root, "quota-shares");
		const quotaStore = new FileShareStore({ directory: dataDir, ttlMs: 1_000, maxStorageBytes: 80 });
		const id = await quotaStore.put(new Uint8Array(60));
		await expect(quotaStore.put(new Uint8Array(30))).rejects.toBeInstanceOf(ShareStoreCapacityError);

		const old = new Date(Date.now() - 5_000);
		await utimes(path.join(dataDir, id), old, old);
		expect(await quotaStore.cleanup()).toBe(1);
		expect(await quotaStore.get(id)).toBeNull();
		expect(await quotaStore.stats()).toEqual({ bytes: 0, capacityBytes: 80 });
	});
});

function openWebSocket(url: string): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const socket = new WebSocket(url);
	socket.addEventListener("open", () => resolve(socket), { once: true });
	socket.addEventListener("error", () => reject(new Error(`websocket failed: ${url}`)), { once: true });
	return promise;
}

function waitForClose(socket: WebSocket): Promise<CloseEvent> {
	const { promise, resolve } = Promise.withResolvers<CloseEvent>();
	socket.addEventListener("close", resolve, { once: true });
	return promise;
}
