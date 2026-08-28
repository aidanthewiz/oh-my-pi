import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { type RelayServer, startRelayServer } from "../../src/tools/browser/relay/server";

const relays: RelayServer[] = [];
afterEach(() => {
	for (const relay of relays.splice(0)) relay.stop();
});

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

	it("rejects an empty server token", async () => {
		const port = await findFreeCdpPort();
		expect(() => startRelayServer({ port, token: " " })).toThrow("Browser relay token must be nonempty");
	});
});
