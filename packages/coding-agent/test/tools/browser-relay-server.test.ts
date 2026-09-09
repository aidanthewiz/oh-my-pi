import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { type RelayServer, startRelayServer } from "../../src/tools/browser/relay/server";

const relays: RelayServer[] = [];
afterEach(() => {
	for (const relay of relays.splice(0)) relay.stop();
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
});
