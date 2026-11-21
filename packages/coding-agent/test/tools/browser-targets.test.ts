import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { listRelayTargets, relayTargets } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

const ENV_KEYS = ["TERN_PANE_SOCKET", "TERN_PANE", "PI_BROWSER_TERN", "PI_BROWSER_RELAY"] as const;
let savedEnv: Map<string, string | undefined>;

let daemon: FakeDaemon | undefined;
const opened: string[] = [];

beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
});

afterEach(async () => {
	for (const name of opened.splice(0)) await releaseTab(name, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A Tern window listing `blocks`, able to host an adoption of any of them. */
async function startWindow(blocks: readonly Record<string, unknown>[]): Promise<FakeDaemon> {
	daemon = await startFakeDaemon((op): FakeAnswer => {
		switch (op.op) {
			case "blocks":
				return { ok: { blocks } };
			case "events":
				return { ok: { events: [], next: 40, dropped: 0 } };
			case "state": {
				const block = blocks.find(entry => entry.block === op.block);
				return {
					ok: {
						url: block?.url ?? "about:blank",
						title: block?.title ?? "",
						loading: false,
						shown: true,
						width: 800,
						height: 600,
					},
				};
			}
			case "eval":
				return { ok: { value: { value: [] } } };
			default:
				return { ok: {} };
		}
	});
	process.env.TERN_PANE_SOCKET = daemon.socketPath;
	process.env.TERN_PANE = String(PANE);
	delete process.env.PI_BROWSER_TERN;
	return daemon;
}

function session(settings: Record<string, unknown> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": false,
			"browser.cmux": false,
			"tools.maxTimeout": 0,
			...settings,
		}),
	};
}

async function invoke(tool: ToolSession, parameters: Record<string, unknown>) {
	const result = await createBrowserPrelude(tool).invoke(parameters, { session: tool, toolCallId: "browser-targets" });
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	const value = isRecord(result.details) ? result.details.value : undefined;
	return { text, value };
}

describe("browser targets in Tern", () => {
	it("lists the window's browser blocks and names the omp tab holding an adopted one", async () => {
		await startWindow(BLOCKS);
		const tool = session();
		opened.push("docs");
		await invoke(tool, { action: "open", name: "docs", timeout: 5, target: "Docs C" });
		const { text, value } = await invoke(tool, { action: "targets", timeout: 5 });
		expect(value).toEqual([
			{ target: "5", title: "Docs A", url: "https://docs.example/a", shown: false, docked: true, driven: false },
			{ target: "6", title: "Docs B", url: "https://docs.example/b", shown: true, docked: false, driven: true },
			{
				target: "7",
				title: "Docs C",
				url: "https://docs.example/c",
				shown: true,
				docked: true,
				driven: false,
				tab: "docs",
			},
		]);
		expect(text).toStartWith("Tern browser blocks (adopt one with target set to its id):\n");
		expect(text).toContain('- 5 "Docs A" https://docs.example/a (docked, not on screen)');
		expect(text).toContain('- 7 "Docs C" https://docs.example/c (docked, on screen, driven by omp tab "docs")');
	});

	it("omits shown and driven an older Tern does not report", async () => {
		await startWindow([{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE }]);
		const { text, value } = await invoke(session(), { action: "targets", timeout: 5 });
		expect(value).toStrictEqual([{ target: "6", title: "Docs B", url: "https://docs.example/b", docked: false }]);
		expect(text).toContain("update Tern to adopt the user's own");
	});
});

describe("browser targets elsewhere", () => {
	it("explains that targets exist only inside Tern or with the relay", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const failure = await invoke(session(), { action: "targets", timeout: 5 }).catch((error: unknown) => error);
		expect(String(failure)).toContain("targets exist only inside a Tern pane");
		expect(String(failure)).toContain('app: "relay" or the browser.relay setting');
	});
});

describe("relayTargets", () => {
	it("keeps live, non-internal pages with their URL as the target", () => {
		const entries = [
			{ id: "a", type: "page", url: "https://mail.example/", title: "Mail", active: "true", discarded: "false" },
			{ id: "b", type: "page", url: "https://docs.example/", title: "Docs", active: "false", discarded: "false" },
			{ id: "c", type: "page", url: "https://old.example/", title: "Old", active: "false", discarded: "true" },
			{ id: "d", type: "page", url: "devtools://devtools/bundled/inspector.html", title: "DevTools" },
			{ id: "e", type: "service_worker", url: "https://mail.example/sw.js", title: "sw" },
			{ id: "f", type: "page", title: "no url" },
			"garbage",
		];
		expect(relayTargets(entries)).toEqual([
			{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
			{ target: "https://docs.example/", title: "Docs", url: "https://docs.example/", shown: false },
		]);
	});
});

it("does not expose relay credentials when target discovery fails", async () => {
	const token = "synthetic relay/secret+marker";
	const username = "syntheticRelayUser";
	const password = "syntheticRelayPassword";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(null, { status: 503 }),
	});
	try {
		const endpoint = new URL(server.url);
		endpoint.username = username;
		endpoint.password = password;
		endpoint.searchParams.set("token", token);
		let failure: unknown;
		try {
			await listRelayTargets(endpoint.toString());
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).not.toContain(token);
		expect(String(failure)).not.toContain(encodeURIComponent(token));
		expect(String(failure)).not.toContain("token=");
		expect(String(failure)).not.toContain(username);
		expect(String(failure)).not.toContain(password);
	} finally {
		server.stop(true);
	}
});

describe("browser targets with the relay", () => {
	it("lists the user's Chrome pages through the authenticated relay in an isolated home", async () => {
		const tmp = await TempDir.create("@coreforge-browser-targets-");
		const source = (file: string) => JSON.stringify(path.resolve(import.meta.dir, "../../src", file));
		const script = `import { Settings } from ${source("config/settings.ts")};
import { createBrowserPrelude } from ${source("tools/browser.ts")};
import { findFreeCdpPort } from ${source("tools/browser/attach.ts")};
import { startRelayServer } from ${source("tools/browser/relay/server.ts")};
import { ensureBrowserRelayToken } from ${source("tools/browser/relay/token.ts")};
import { DISCARDED_TABS_PROTOCOL_VERSION } from ${source("tools/browser/relay/protocol.ts")};
import { isRecord } from "@oh-my-pi/pi-utils";
function session(settings = {}) { return { cwd: process.cwd(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => null, settings: Settings.isolated({ "browser.enabled": true, "browser.relay": false, "browser.cmux": false, "tools.maxTimeout": 0, ...settings }) }; }
async function invoke(tool, parameters) { const result = await createBrowserPrelude(tool).invoke(parameters, {session: tool, toolCallId: "browser-targets"}); return { value: result.details?.value }; }
function snapshot(tabId, fields) {
	return {
		tabId,
		url: "https://example.com/",
		title: "Example",
		active: false,
		discarded: false,
		windowId: 1,
		pinned: false,
		groupId: -1,
		...fields,
	};
}
async function connectExtension(port, tabs) {
	const opened = Promise.withResolvers();
	const ws = new WebSocket(\`ws://127.0.0.1:\${port}/ext?token=\${encodeURIComponent(token)}\`);
	ws.addEventListener("open", () => {
		ws.send(
			JSON.stringify({
				t: "hello",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
				tabs,
				attachedTabIds: [],
			}),
		);
		opened.resolve(ws);
	});
	ws.addEventListener("error", () => opened.reject(new Error("extension socket failed")));
	ws.addEventListener("message", event => {
		const message = JSON.parse(String(event.data));
		if (isRecord(message) && message.t === "rpc" && typeof message.id === "number") {
			ws.send(JSON.stringify({ t: "rpcResult", id: message.id, ok: true, result: {} }));
		}
	});
	return await opened.promise;
}
const port = await findFreeCdpPort();
const token = await ensureBrowserRelayToken();
const relay = startRelayServer({ port, token });
let extension;
try {
	extension = await connectExtension(port, [
		snapshot(1, { url: "https://mail.example/", title: "Mail", active: true }),
		snapshot(2, { url: "https://docs.example/", title: "Docs" }),
		snapshot(3, { url: "https://old.example/", title: "Old", discarded: true }),
	]);
	const tool = session({ "browser.relayUrl": "http://127.0.0.1:" + port });
	const result = await invoke(tool, { action: "targets", timeout: 10, app: "relay" });
	console.log(JSON.stringify(result.value));
} finally {
	extension?.close();
	relay.stop();
}`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: path.resolve(import.meta.dir, "../.."),
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				HOME: tmp.path(),
				USERPROFILE: tmp.path(),
				PI_CONFIG_DIR: ".omp",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const [exit, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exit, stderr).toBe(0);
			expect(JSON.parse(stdout)).toEqual([
				{ target: "https://mail.example/", title: "Mail", url: "https://mail.example/", shown: true },
				{ target: "https://docs.example/", title: "Docs", url: "https://docs.example/", shown: false },
			]);
		} finally {
			if (child.exitCode === null) child.kill();
			await child.exited;
			await tmp.remove();
		}
	}, 20_000);
});
