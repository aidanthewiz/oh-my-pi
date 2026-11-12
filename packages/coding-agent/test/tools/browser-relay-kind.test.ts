import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createBrowserPrelude,
	DEFAULT_RELAY_URL,
	resolveBrowserKind,
	resolveRelayKind,
} from "@oh-my-pi/pi-coding-agent/tools/browser";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { resolveRelayWebSocketEndpoint } from "../../src/tools/browser/relay/kind";
import { connectPuppeteer, loadPuppeteer } from "../../src/tools/browser/launch";

describe("resolveRelayKind", () => {
	it("is disabled by default", () => {
		expect(resolveRelayKind(null, {})).toBeNull();
		expect(resolveRelayKind({}, {})).toBeNull();
	});

	it("uses the configured URL and trims trailing slashes", () => {
		expect(resolveRelayKind({ settingEnabled: true, url: "http://127.0.0.1:9333///" }, {})).toEqual({
			kind: "relay",
			cdpUrl: "http://127.0.0.1:9333",
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
	it("identifies the rejected credential-free websocket endpoint", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("Forbidden", { status: 403 }),
		});
		try {
			const puppeteer = await loadPuppeteer();
			const endpoint = `ws://127.0.0.1:${server.port}/cdp`;
			const error = await connectPuppeteer(puppeteer, { browserWSEndpoint: endpoint }).then(
				() => undefined,
				error => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain(endpoint);
		} finally {
			server.stop(true);
		}
	});

	it("redacts discovered websocket credentials when construction fails before the upgrade", async () => {
		const username = "synthetic discovered user";
		const password = "synthetic discovered password";
		const token = "synthetic discovered&token";
		const fragment = "synthetic discovered fragment";
		let upgradeAttempts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (new URL(request.url).pathname === "/json/version") {
					const endpoint = new URL(`ws://127.0.0.1:${server.port}/devtools/browser/invalid`);
					endpoint.username = username;
					endpoint.password = password;
					endpoint.searchParams.set("token", token);
					endpoint.hash = fragment;
					return Response.json({ webSocketDebuggerUrl: endpoint.toString() });
				}
				upgradeAttempts++;
				return new Response("Unexpected upgrade", { status: 418 });
			},
		});
		try {
			const puppeteer = await loadPuppeteer();
			const error = await connectPuppeteer(puppeteer, { browserURL: `http://127.0.0.1:${server.port}` }).then(
				() => undefined,
				error => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain(`ws://127.0.0.1:${server.port}/devtools/browser/invalid`);
			expect(upgradeAttempts).toBe(0);
			const diagnostic = `${error.message}\n${error.stack}`;
			for (const secret of [username, password, token, fragment]) {
				expect(diagnostic).not.toContain(secret);
				expect(diagnostic).not.toContain(encodeURIComponent(secret));
				expect(diagnostic).not.toContain(encodeURIComponent(secret).replaceAll("%20", "+"));
			}
			expect(error.cause).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});

	it("keeps the rejected endpoint without exposing relay credentials", async () => {
		const token = "synthetic relay&secret";
		const received: { token: string | null } = { token: null };
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				received.token = new URL(request.url).searchParams.get("token");
				return new Response("Unauthorized", { status: 401 });
			},
		});
		const endpointUrl = new URL(`ws://127.0.0.1:${server.port}/cdp`);
		endpointUrl.searchParams.set("token", token);
		const endpoint = endpointUrl.toString();
		try {
			const puppeteer = await loadPuppeteer();
			const error = await connectPuppeteer(puppeteer, { browserWSEndpoint: endpoint }).then(
				() => undefined,
				error => error,
			);
			expect(received.token).toBe(token);
			expect(error).toBeInstanceOf(Error);
			expect(error.message).toContain(`ws://127.0.0.1:${server.port}/cdp`);
			expect(error.message).not.toContain(token);
			expect(error.message).not.toContain(encodeURIComponent(token).replaceAll("%20", "+"));
			expect(error.message).not.toContain(encodeURIComponent(token));
			expect(error.stack).not.toContain(token);
			expect(error.cause).toBeUndefined();
		} finally {
			server.stop(true);
		}
	});
});

describe("browser prelude relay guidance", () => {
	const ENV_KEYS = [
		"PI_BROWSER_RELAY",
		"PI_BROWSER_TERN",
		"PI_BROWSER_CMUX",
		"TERN_PANE_SOCKET",
		"TERN_PANE",
		"CMUX_SOCKET_PATH",
		// Inherited from an interactive omp when the tests run from its bash tool.
		"PI_TERMINAL_OWNER_PID",
	] as const;
	const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	beforeEach(() => {
		for (const key of ENV_KEYS) delete process.env[key];
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	const sessionWith = (settings: Record<string, unknown>): ToolSession =>
		({
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settings),
		}) as ToolSession;

	it.each([
		[true, undefined, "relay"],
		[false, undefined, "headless"],
		[true, "0", "headless"],
		[false, "1", "relay"],
	] as const)("resolves relay setting %s with override %s to %s", (enabled, override, kind) => {
		if (override !== undefined) process.env.PI_BROWSER_RELAY = override;
		const session = sessionWith({ "browser.relay": enabled });
		expect(resolveBrowserKind({ action: "open" }, session).kind).toBe(kind);
		expect(resolveBrowserKind({ action: "open", app: "auto" }, session).kind).toBe("headless");
	});

	it.each([
		[
			"http://synthetic-user:synthetic-password@127.0.0.1:9333/secret-path?password=secret-password&session=secret-session#secret-fragment",
			[
				"synthetic-user",
				"synthetic-password",
				"secret-path",
				"secret-password",
				"secret-session",
				"secret-fragment",
			],
		],
		[
			"http://127.0.0.1:9333/?token=first-secret&TOKEN=second-secret&auth=third-secret&unrecognized=fourth-secret",
			["first-secret", "second-secret", "third-secret", "fourth-secret"],
		],
		["malformed-secret-cdp-endpoint", ["malformed-secret-cdp-endpoint"]],
	] as const)("never includes configured CDP credentials in provider guidance: %s", (endpoint, secrets) => {
		const session = sessionWith({ "browser.relay": true, "browser.cdpUrl": endpoint });
		expect(resolveBrowserKind({ action: "open", app: "auto" }, session)).toEqual({
			kind: "connected",
			cdpUrl: endpoint,
		});
		const guidance = createBrowserPrelude(session).guidance;
		expect(guidance).not.toContain(endpoint);
		for (const secret of secrets) expect(guidance).not.toContain(secret);
	});

	it.each([
		[{ TERN_PANE_SOCKET: "/tmp/synthetic-tern.sock", TERN_PANE: "1" }, "tern"],
		[{ CMUX_SOCKET_PATH: "/tmp/synthetic-cmux.sock" }, "cmux"],
	] as const)("skips only relay when selecting native fallback %s", (env, kind) => {
		Object.assign(process.env, env);
		const session = sessionWith({ "browser.relay": true });
		expect(resolveBrowserKind({ action: "open" }, session).kind).toBe("relay");
		expect(resolveBrowserKind({ action: "open", app: "auto" }, session).kind).toBe(kind);
	});
});
