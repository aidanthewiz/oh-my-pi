/**
 * `browser.open` on omp's WebKit host, end to end through the prelude host
 * against a fake `ABHost` process: no real engine and no real Chromium.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { EventEmitter } from "node:events";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as launch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import * as supervisor from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { WebKitUnavailableError } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import * as utils from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { Browser, ConnectionTransport } from "puppeteer-core";
import { createFakeHost, type FakeHost, type FakeHostMode, isProcessAlive } from "./webkit-fake-host";

// Ambient browser env of the developer's shell (and of an omp running the suite) must not pick the backend.
const ENV_KEYS = [
	"PI_BROWSER_WEBKIT",
	"PI_BROWSER_WEBKIT_PATH",
	"PI_BROWSER_RELAY",
	"PI_BROWSER_TERN",
	"PI_BROWSER_CMUX",
	"TERN_PANE_SOCKET",
	"TERN_PANE",
	"CMUX_SOCKET_PATH",
	// Inherited from an interactive omp when the tests run from its bash tool.
	"PI_TERMINAL_OWNER_PID",
];

let savedEnv: Map<string, string | undefined>;
let fake: FakeHost | undefined;
const opened: string[] = [];
const syntheticBrowsers: Browser[] = [];

beforeEach(() => {
	savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	const trustedEnvValue = utils.getTrustedEnvValue;
	spyOn(utils, "getTrustedEnvValue").mockImplementation(name =>
		name === "PI_BROWSER_WEBKIT" || name === "PI_BROWSER_WEBKIT_PATH" ? undefined : trustedEnvValue(name),
	);
});

afterEach(async () => {
	try {
		const outcomes = await Promise.allSettled(
			opened.splice(0).map(name => supervisor.releaseTab(name, { kill: false })),
		);
		outcomes.push(
			...(await Promise.allSettled(
				syntheticBrowsers.splice(0).map(async browser => {
					if (browser.connected) await browser.close();
					return true;
				}),
			)),
		);
		const errors = outcomes.flatMap(outcome => (outcome.status === "rejected" ? [outcome.reason] : []));
		if (errors.length > 0) throw new AggregateError(errors, "Browser fixtures did not close");
	} finally {
		vi.restoreAllMocks();
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fake?.remove();
		fake = undefined;
	}
});

async function useFakeHost(mode?: FakeHostMode): Promise<FakeHost> {
	fake = await createFakeHost(mode);
	return fake;
}

function makeSession(sessionId: string): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalKernelOwnerId: () => sessionId,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.webkit": true,
			"browser.webkitPath": fake?.dir,
			"browser.relay": false,
			"tools.maxTimeout": 0,
		}),
	};
}

async function open(session: ToolSession, name: string, extra: Record<string, unknown> = {}) {
	opened.push(name);
	const result = await createBrowserPrelude(session).invoke(
		{ action: "open", name, timeout: 10, ...extra },
		{ session, toolCallId: "webkit-open" },
	);
	return result;
}

/** Synthetic CDP and worker peers; the browser adapter, registry and tab ownership stay real. */
async function useSyntheticChromium() {
	const targets = new Set<string>();
	const workers: Array<{ running: boolean }> = [];
	const browserTarget = {
		targetId: "browser",
		type: "browser",
		title: "",
		url: "",
		attached: true,
		canAccessOpener: false,
	};
	let nextSession = 1;
	let nextTarget = 1;
	let running = true;
	const emit = (message: unknown) => transport.onmessage?.(JSON.stringify(message));
	const transport: ConnectionTransport = {
		send(message) {
			const { id, method, params, sessionId } = JSON.parse(message) as {
				id: number;
				method: string;
				params?: { targetId?: string; sessionId?: string; discover?: boolean };
				sessionId?: string;
			};
			queueMicrotask(() => {
				const reply = (result: unknown) => emit({ id, sessionId, result });
				switch (method) {
					case "Target.getBrowserContexts":
						reply({ browserContextIds: [] });
						break;
					case "Target.setDiscoverTargets":
						if (!sessionId && params?.discover) {
							emit({ method: "Target.targetCreated", params: { targetInfo: browserTarget } });
						}
						reply({});
						break;
					case "Target.setAutoAttach":
						reply({});
						break;
					case "Target.attachToTarget": {
						const attachedSession = `fixture-${nextSession++}`;
						emit({
							method: "Target.attachedToTarget",
							params: { sessionId: attachedSession, targetInfo: browserTarget, waitingForDebugger: false },
						});
						reply({ sessionId: attachedSession });
						break;
					}
					case "Target.detachFromTarget":
						emit({ method: "Target.detachedFromTarget", params: { sessionId: params?.sessionId } });
						reply({});
						break;
					case "Target.getTargets":
						reply({
							targetInfos: [
								browserTarget,
								...Array.from(targets, targetId => ({ ...browserTarget, targetId, type: "page" })),
							],
						});
						break;
					case "Target.closeTarget": {
						const targetId = params?.targetId;
						const success = targetId !== undefined && targets.delete(targetId);
						if (success) emit({ sessionId, method: "Target.targetDestroyed", params: { targetId } });
						reply({ success });
						break;
					}
					case "Browser.close":
						running = false;
						targets.clear();
						reply({});
						break;
					default:
						emit({ id, sessionId, error: { code: -32601, message: `Unsupported fixture command: ${method}` } });
				}
			});
		},
		close() {
			transport.onclose?.();
		},
	};
	const browser = await (await launch.loadPuppeteer()).connect({ transport, defaultViewport: null });
	syntheticBrowsers.push(browser);
	const preflight = spyOn(launch, "ensureChromiumExecutable").mockResolvedValue("/stub/chromium");
	spyOn(launch, "launchHeadlessBrowser").mockResolvedValue({
		browser,
		wsEndpoint: "ws://127.0.0.1/devtools/browser/fixture",
	});
	spyOn(supervisor, "spawnTabWorker").mockImplementation(async () => {
		const events = new EventEmitter();
		const state = { running: true };
		const targetId = `page-${nextTarget++}`;
		workers.push(state);
		return {
			mode: "worker" as const,
			send(message: WorkerInbound) {
				if (!state.running) throw new Error("Fixture worker is closed");
				queueMicrotask(() => {
					if (!state.running) return;
					if (message.type === "init") {
						targets.add(targetId);
						events.emit("message", { type: "setup" } satisfies WorkerOutbound);
						events.emit("message", { type: "page-created", targetId } satisfies WorkerOutbound);
						events.emit("message", {
							type: "ready",
							info: {
								url: "about:blank",
								title: "",
								viewport: message.payload.viewport ?? { width: 1280, height: 800 },
								targetId,
							},
						} satisfies WorkerOutbound);
					} else if (message.type === "close") {
						if (!message.keepPage) targets.delete(targetId);
						events.emit("message", { type: "closed" } satisfies WorkerOutbound);
					} else {
						events.emit("error", new Error(`Unsupported fixture worker message: ${message.type}`));
					}
				});
			},
			onMessage(handler: (message: WorkerOutbound) => void) {
				events.on("message", handler);
				return () => events.off("message", handler);
			},
			onError(handler: (error: Error) => void) {
				events.on("error", handler);
				return () => events.off("error", handler);
			},
			onExit(handler: (code: number) => void) {
				events.on("exit", handler);
				return () => events.off("exit", handler);
			},
			async terminate() {
				state.running = false;
				events.removeAllListeners();
			},
		};
	});
	return {
		browser,
		preflight,
		get running() {
			return running;
		},
		get targetCount() {
			return targets.size;
		},
		get workerCount() {
			return workers.filter(worker => worker.running).length;
		},
	};
}

describe("browser.open on omp's WebKit host", () => {
	it("keeps session identities isolated on its native host without requiring Puppeteer workers", async () => {
		const host = await useFakeHost();
		spyOn(supervisor, "spawnTabWorker").mockRejectedValue(new Error("Isolated workers unavailable"));
		const sessionA = makeSession("session-a");
		const result = await open(sessionA, "wk-a1");
		expect(result.details).toMatchObject({ browser: "webkit" });
		await open(sessionA, "wk-a2");
		await open(makeSession("session-b"), "wk-b");

		const requests = await host.requests();
		const opens = requests.filter(request => request.op === "open");
		// One process hosts all three tabs: its block ids keep counting.
		expect(opens).toHaveLength(3);
		const identities = requests.filter(request => request.op === "identity");
		expect(identities.map(request => request.block)).toEqual([1, 2, 3]);
		// Sent right after the open, before anything configures or reads the page.
		for (const identity of identities) {
			const index = requests.indexOf(identity);
			expect(requests[index - 1]?.op).toBe("open");
		}
		const [a1, a2, b] = identities.map(request => request.seed);
		expect(a1).toMatch(/^[0-9a-f]{16}$/);
		expect(a2).toBe(a1);
		expect(b).not.toBe(a1);

		// The process belongs to omp: closing its last tab ends its input and it exits.
		const pid = await host.pid();
		for (const name of opened.splice(0)) await supervisor.releaseTab(name, { kill: false });
		expect(await host.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(pid)).toBe(false);
	});

	it.each([
		["the host cannot start", "exit-on-hello", false],
		["the host cannot open its first tab", "fail-open", false],
		["neither Tern nor WebKit can start", "exit-on-hello", true],
	] as const)("falls back to Chromium and retires an unusable host when %s", async (_case, mode, afterTern) => {
		const host = await useFakeHost(mode);
		const chromium = await useSyntheticChromium();
		if (afterTern) {
			process.env.TERN_PANE_SOCKET = `${host.dir}/no-tern.sock`;
			process.env.TERN_PANE = "3";
		}
		const result = await open(makeSession("session-fallback"), "wk-fallback");
		expect(result.details).toMatchObject({ browser: "headless" });
		const tab = supervisor.getTab("wk-fallback");
		expect(tab?.state).toBe("alive");
		expect(tab?.browser.refCount).toBe(1);
		expect(chromium.browser.connected).toBe(true);
		expect(chromium.targetCount).toBe(1);
		expect(chromium.workerCount).toBe(1);
		// The unusable host is not left running behind the Chromium tab.
		expect(isProcessAlive(await host.pid())).toBe(false);
		if (mode === "fail-open") expect(await host.sawEndOfInput()).toBe(true);

		expect(await supervisor.releaseTab("wk-fallback", { kill: false })).toBe(true);
		expect(supervisor.getTab("wk-fallback")).toBeUndefined();
		expect(chromium.targetCount).toBe(0);
		expect(chromium.workerCount).toBe(0);
		expect(chromium.browser.connected).toBe(false);
		expect(chromium.running).toBe(false);
	});

	it("fails a required WebKit open without selecting Chromium", async () => {
		const host = await useFakeHost("fail-open");
		const chromium = await useSyntheticChromium();
		const failure = await open(makeSession("session-required"), "wk-required", { app: "webkit" }).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(WebKitUnavailableError);
		expect(chromium.preflight).not.toHaveBeenCalled();
		expect(supervisor.getTab("wk-required")).toBeUndefined();
		expect(await host.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(await host.pid())).toBe(false);
	});

	it("opens the selected WebKit engine when automatic Tern is unavailable", async () => {
		const host = await useFakeHost();
		// A Tern pane whose daemon is gone.
		process.env.TERN_PANE_SOCKET = `${host.dir}/no-tern.sock`;
		process.env.TERN_PANE = "3";
		const result = await open(makeSession("session-tern"), "wk-after-tern");
		expect(result.details).toMatchObject({ browser: "webkit" });
	});

	it("reports a failed navigation as the page's failure instead of switching browsers", async () => {
		const host = await useFakeHost("fail-navigation");
		const chromium = await useSyntheticChromium();
		const failure = await open(makeSession("session-nav"), "wk-nav", { url: "https://nowhere.invalid/" }).catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(ToolError);
		expect(failure).not.toBeInstanceOf(WebKitUnavailableError);
		expect(chromium.preflight).not.toHaveBeenCalled();
		expect(supervisor.getTab("wk-nav")).toBeUndefined();
		expect(await host.sawEndOfInput()).toBe(true);
		expect(isProcessAlive(await host.pid())).toBe(false);
	});
});
