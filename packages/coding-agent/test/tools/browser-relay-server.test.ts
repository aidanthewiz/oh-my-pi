import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as dirs from "@oh-my-pi/pi-utils/dirs";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { relayCdpClientsOf } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const relays: RelayServer[] = [];
let directory: string;
beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-server-test-"));
	vi.spyOn(dirs, "getBrowserRelayInstallRegistryFile").mockReturnValue(path.join(directory, "installs.json"));
	vi.spyOn(dirs, "getBrowserRelayDir").mockReturnValue(path.join(directory, "profile"));
});
afterEach(async () => {
	try {
		for (const relay of relays.splice(0)) relay.stop();
	} finally {
		vi.restoreAllMocks();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	if (!/\r\ntransfer-encoding:\s*chunked\b/i.test(headers)) {
		return JSON.parse(body) as Record<string, string>;
	}

	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const length = Number.parseInt(body.slice(offset, lineEnd).split(";", 1)[0]!, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return JSON.parse(decoded) as Record<string, string>;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n") {
			throw new Error("Invalid chunked response: missing chunk terminator");
		}
		offset += 2;
	}
}
describe("browser relay authentication", () => {
	it("requires the token for privileged endpoints without leaking it through discovery", async () => {
		const port = await findFreeCdpPort();
		const connected = Promise.withResolvers<void>();
		const relay = startRelayServer({
			port,
			token: "test-token",
			log: message => {
				if (message === "extension connected") connected.resolve();
			},
		});
		relays.push(relay);
		const base = `http://127.0.0.1:${port}`;

		for (const path of ["/ext", "/cdp", "/json/list"]) {
			expect((await fetch(`${base}${path}`)).status).toBe(401);
			expect((await fetch(`${base}${path}?token=wrong`)).status).toBe(401);
		}
		expect((await fetch(`${base}/ext?token=test-token`)).status).toBe(426);
		expect((await fetch(`${base}/cdp?token=test-token`)).status).toBe(426);
		expect((await fetch(`${base}/json/list?token=test-token`)).status).toBe(200);
		expect((await fetch(`${base}/ext?token=test-token`, { headers: { Origin: "https://example.com" } })).status).toBe(
			403,
		);
		expect(
			(await fetch(`${base}/cdp?token=test-token`, { headers: { Origin: "chrome-extension://example" } })).status,
		).toBe(403);
		for (const path of ["/omp/extensions/recheck", "/omp/relay/restart"]) {
			expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(401);
			expect((await fetch(`${base}${path}?token=wrong`, { method: "POST" })).status).toBe(401);
			expect(
				(
					await fetch(`${base}${path}?token=test-token`, {
						method: "POST",
						headers: { Origin: "https://example.com" },
					})
				).status,
			).toBe(403);
			expect((await fetch(`${base}${path}?token=test-token`, { method: "POST" })).status).toBe(
				path.endsWith("/recheck") ? 204 : 409,
			);
		}

		const socket = new WebSocket(`ws://127.0.0.1:${port}/ext?token=test-token`);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("extension websocket failed to open")), {
				once: true,
			});
		});
		socket.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/test",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		await connected.promise;
		const version = await fetch(`${base}/json/version`);
		expect(version.status).toBe(200);
		const body = await version.text();
		expect(body).not.toContain("test-token");
		expect(JSON.parse(body).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
		socket.close();
	});

	it("advertises a valid request authority and rejects unusable authorities", async () => {
		const port = await findFreeCdpPort();
		const connected = Promise.withResolvers<void>();
		const relay = startRelayServer({
			port,
			token: "test-token",
			log: message => {
				if (message === "extension connected") connected.resolve();
			},
		});
		relays.push(relay);
		const socket = new WebSocket(`ws://127.0.0.1:${port}/ext?token=test-token`);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new Error("extension websocket failed to open")), {
				once: true,
			});
		});
		socket.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/test",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		await connected.promise;

		const requested = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(requested).webSocketDebuggerUrl).toBe("ws://100.100.92.97:12803/cdp");

		const malformed = await rawGet(
			port,
			"GET /json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n",
		);
		expect(parseVersion(malformed).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp`);
		socket.close();
	});

	it("rejects an empty server token", async () => {
		const port = await findFreeCdpPort();
		expect(() => startRelayServer({ port, token: " " })).toThrow("Browser relay token must be nonempty");
	});

	it("keeps relay identity stable when its authenticated extension disconnects", async () => {
		const port = await findFreeCdpPort();
		const connected = Promise.withResolvers<void>();
		const relay = startRelayServer({
			port,
			token: "test-token",
			log: message => {
				if (message === "extension connected") connected.resolve();
			},
		});
		relays.push(relay);
		const extension = new WebSocket(`ws://127.0.0.1:${port}/ext?token=test-token`);
		await new Promise<void>((resolve, reject) => {
			extension.addEventListener("open", () => resolve(), { once: true });
			extension.addEventListener("error", () => reject(new Error("extension websocket failed to open")), {
				once: true,
			});
		});
		extension.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/test",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		await connected.promise;
		const before = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
			ompRelayInstance: string;
		};
		expect(before.ompRelayInstance).toBeString();
		extension.close();
		const deadline = Date.now() + 1_000;
		let response = await fetch(`http://127.0.0.1:${port}/json/version`);
		while (response.status !== 503 && Date.now() < deadline) {
			response = await fetch(`http://127.0.0.1:${port}/json/version`);
		}
		expect(response.status).toBe(503);
		const info = (await response.json()) as RelayUnavailableInfo;
		expect(info.ompRelayInstance).toBe(before.ompRelayInstance);
	});

	it("reports how many CDP clients are connected, both while waiting for the extension and once ready", async () => {
		const port = await findFreeCdpPort();
		const ready = Promise.withResolvers<void>();
		const relay = startRelayServer({
			port,
			token: "test-token",
			log: message => {
				if (message === "extension connected") ready.resolve();
			},
		});
		relays.push(relay);
		const discovery = async () => {
			const response = await fetch(`http://127.0.0.1:${port}/json/version`);
			const body: unknown = await response.json();
			return {
				status: response.status,
				clients: typeof body === "object" && body !== null ? relayCdpClientsOf(body) : null,
			};
		};
		expect(await discovery()).toEqual({ status: 503, clients: 0 });
		const client = new WebSocket(`ws://127.0.0.1:${port}/cdp?token=test-token`);
		const opened = Promise.withResolvers<void>();
		client.addEventListener("open", () => opened.resolve(), { once: true });
		await opened.promise;
		expect(await discovery()).toEqual({ status: 503, clients: 1 });
		const extension = new WebSocket(`ws://127.0.0.1:${port}/ext?token=test-token`);
		await new Promise<void>((resolve, reject) => {
			extension.addEventListener("open", () => resolve(), { once: true });
			extension.addEventListener("error", () => reject(new Error("extension websocket failed")), { once: true });
		});
		extension.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/test",
				discardedTabsProtocol: 1,
				tabs: [],
				attachedTabIds: [],
			}),
		);
		await ready.promise;
		expect(await discovery()).toEqual({ status: 200, clients: 1 });
		client.close();
		const deadline = Date.now() + 1_000;
		let after = await discovery();
		while (after.clients !== 0 && Date.now() < deadline) after = await discovery();
		expect(after).toEqual({ status: 200, clients: 0 });
		extension.close();
	});
});
