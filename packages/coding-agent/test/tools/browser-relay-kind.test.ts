import { describe, expect, it } from "bun:test";
import { DEFAULT_RELAY_URL, resolveRelayKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { resolveRelayWebSocketEndpoint } from "../../src/tools/browser/relay/kind";
import { connectPuppeteer } from "../../src/tools/browser/launch";
import type Puppeteer from "puppeteer-core";

describe("resolveRelayKind", () => {
	it("is disabled by default", () => {
		expect(resolveRelayKind(null, {})).toBeNull();
		expect(resolveRelayKind({}, {})).toBeNull();
	});

	it("resolves the default endpoint when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, {})).toEqual({ kind: "relay", cdpUrl: DEFAULT_RELAY_URL });
	});

	it("uses the configured URL and trims trailing slashes", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "http://127.0.0.1:9333///" }, {})).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:9333",
		});
	});

	it("falls back to the default endpoint for a blank URL", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "   " }, {})).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
		});
	});

	it("PI_BROWSER_RELAY=0 disables the relay even when the setting enables it", () => {
		expect(resolveRelayKind({ settingEnabled: true }, { PI_BROWSER_RELAY: "0" })).toBeNull();
	});

	it("PI_BROWSER_RELAY=1 enables the relay when the setting is off", () => {
		expect(resolveRelayKind({ settingEnabled: false }, { PI_BROWSER_RELAY: "1" })).toEqual({
			kind: "relay",
			cdpUrl: DEFAULT_RELAY_URL,
		});
	});
});

describe("resolveRelayWebSocketEndpoint", () => {
	it("keeps the token on the configured relay authority", () => {
		const endpoint = new URL(
			resolveRelayWebSocketEndpoint("https://relay.example.test/base", "ws://attacker.example/cdp", "secret token"),
		);

		expect(endpoint.protocol).toBe("wss:");
		expect(endpoint.host).toBe("relay.example.test");
		expect(endpoint.pathname).toBe("/base/cdp");
		expect(endpoint.searchParams.get("token")).toBe("secret token");
	});

	it("rejects discovery responses that do not advertise the CDP websocket path", () => {
		expect(() =>
			resolveRelayWebSocketEndpoint("http://127.0.0.1:9224", "ws://127.0.0.1:9224/other", "secret"),
		).toThrow("invalid relay CDP websocket endpoint");
	});
});

describe("authenticated relay connection errors", () => {
	it.each([false, true])("omits raw and encoded tokens from transport failures (ErrorEvent: %s)", async event => {
		const token = "synthetic relay&secret";
		const endpointUrl = new URL("ws://127.0.0.1:9224/cdp");
		endpointUrl.searchParams.set("token", token);
		const endpoint = endpointUrl.toString();
		const message = `Unexpected HTTP 401 at ${endpoint}; token ${token}`;
		const failure = event ? { message, target: { url: endpoint } } : new Error(message, { cause: { endpoint } });
		const puppeteer = {
			connect: async () => {
				throw failure;
			},
		} as unknown as typeof Puppeteer;
		const error = await connectPuppeteer(puppeteer, { browserWSEndpoint: endpoint }).catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("HTTP 401");
		expect(error.message).not.toContain(token);
		expect(error.message).not.toContain(encodeURIComponent(token).replaceAll("%20", "+"));
		expect(error.message).not.toContain(encodeURIComponent(token));
		expect(error.stack).not.toContain(token);
		expect(error.cause).toBeUndefined();
	});
});
