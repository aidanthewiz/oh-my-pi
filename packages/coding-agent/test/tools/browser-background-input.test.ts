import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import {
	acquireBrowser,
	type BrowserHandle,
	type BrowserKind,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	unpackedExtensionId,
	writeRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import { startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";
import { privateRelayNativePort } from "./private-relay-native-port";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const session = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated(),
	getSessionFile: () => null,
} as unknown as ToolSession;

const site = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const html =
			new URL(request.url).pathname === "/target"
				? `<title>Target</title><button onclick="this.textContent='clicked'">Click</button><p id="hover" onmouseover="this.textContent='hovered'">Hover</p>`
				: "<title>Human</title><h1>Keep me</h1>";
		return new Response(html, { headers: { "Content-Type": "text/html" } });
	},
});
const origin = `http://127.0.0.1:${site.port}`;
afterAll(() => site.stop(true));

/** Opens the user's tab selected and the tab omp will drive in the background, which therefore reads hidden. */
async function openTabs(browser: Browser, openBackground: (url: string) => Promise<unknown>): Promise<Page> {
	const human = await browser.newPage();
	await human.goto(`${origin}/human`);
	await human.bringToFront();
	await openBackground(`${origin}/target`);
	const target = await (await browser.waitForTarget(t => t.url() === `${origin}/target`)).page();
	if (!target) throw new Error("Missing background page");
	await target.waitForFunction("document.readyState === 'complete'");
	expect(await target.evaluate(() => document.visibilityState)).toBe("hidden");
	return target;
}

/** Resolves once the page reads hidden: a session ends after omp's connection closes, a beat after the release. */
async function waitHidden(target: Page): Promise<void> {
	// rAF polling would never fire in the hidden tab this waits for.
	await target.waitForFunction(() => document.visibilityState === "hidden", {
		polling: 50,
		timeout: 5_000,
	});
}

/** Hovers and clicks the background page through omp, then releases it; hover needs a rendered frame, which a hidden tab never produces. */
async function driveAndRelease(kind: BrowserKind, target: Page): Promise<void> {
	const handle: BrowserHandle = await acquireBrowser(kind, {
		cwd: process.cwd(),
	});
	const name = `background-${kind.kind}-${process.pid}`;
	try {
		await acquireTab(name, handle, { target: "Target", timeoutMs: 15_000 });
		const result = await runInTab(name, {
			code: "await tab.hover('#hover'); await tab.click('button'); return [await tab.text('#hover'), await tab.text('button')];",
			timeoutMs: 10_000,
			session,
		});
		expect(result.returnValue).toEqual(["hovered", "clicked"]);
		await releaseTab(name);
		// The page must not stay focus-emulated once omp lets it go.
		await waitHidden(target);
	} finally {
		await releaseTab(name).catch(() => undefined);
		await releaseBrowser(handle, { kill: false });
	}
}

interface RelayFixture {
	cdpUrl: string;
	/** Evaluates in a persistent extension page's default context, where Chrome APIs are available. */
	inExtension(expression: string): Promise<unknown>;
	/** The page omp drives, open in a background tab. */
	target: Page;
}

/** Headless Chromium running the real relay extension against a relay on a free port, with the tabs of {@link openTabs}. */
async function withRelay(run: (fixture: RelayFixture) => Promise<void>): Promise<void> {
	const port = await findFreeCdpPort();
	const token = crypto.randomUUID();
	const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-relay-background-"));
	let browser: Browser | undefined;
	let server: ReturnType<typeof startRelayServer> | undefined;
	try {
		server = startRelayServer({
			port,
			token,
			group: false,
			installRegistryFile: path.join(extensionDir, "installs.json"),
		});
		await writeRelayExtension(extensionDir, VERSION);
		const backgroundPath = path.join(extensionDir, "background.js");
		const background = await Bun.file(backgroundPath).text();
		await Bun.write(path.join(extensionDir, "fixture.html"), "<title>Private relay fixture</title>");
		await Bun.write(
			backgroundPath,
			`${privateRelayNativePort(`http://127.0.0.1:${port}`, token)}${background}
void chrome.tabs.create({ url: chrome.runtime.getURL("fixture.html"), active: false });`,
		);
		const extensionId = await unpackedExtensionId(extensionDir);
		if (!extensionId) throw new Error("Missing relay extension directory");
		const optionsUrl = `chrome-extension://${extensionId}/fixture.html`;
		browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			pipe: true,
			enableExtensions: [extensionDir],
			args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
		});
		// The worker creates this page after registration; unlike a service-worker target, the page persists.
		const extension = await (
			await browser.waitForTarget(target => target.url() === optionsUrl, { timeout: 15_000 })
		).page();
		if (!extension) throw new Error("Missing relay extension page");
		const cdp = await extension.createCDPSession();
		async function inExtension(expression: string): Promise<unknown> {
			const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
				expression,
				awaitPromise: true,
				returnByValue: true,
			});
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		}
		const cdpUrl = `http://127.0.0.1:${port}`;
		expect(await waitForRelayExtension(cdpUrl)).toBe("ready");
		const target = await openTabs(browser, url =>
			inExtension(`chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false })`),
		);
		await run({ cdpUrl: `${cdpUrl}?token=${encodeURIComponent(token)}`, inExtension, target });
	} finally {
		try {
			await browser?.close();
		} finally {
			try {
				server?.stop();
			} finally {
				await fs.rm(extensionDir, { recursive: true, force: true });
			}
		}
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("background tab input", () => {
	it("drives a relay tab in the background without selecting it", async () => {
		await withRelay(async ({ cdpUrl, inExtension, target }) => {
			// The relay keeps the tab's debugger session after omp lets go, so the release must end the emulation itself.
			await driveAndRelease({ kind: "relay", cdpUrl }, target);
			expect(
				await inExtension(
					"chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => tabs[0]?.url)",
				),
			).toBe(`${origin}/human`);
		});
	}, 60_000);

	it("keeps a relay page driveable through a second named tab after the first is released", async () => {
		await withRelay(async ({ cdpUrl, target }) => {
			const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			const names = [`background-first-${process.pid}`, `background-second-${process.pid}`];
			try {
				for (const name of names)
					await acquireTab(name, handle, {
						target: "Target",
						timeoutMs: 15_000,
					});
				await releaseTab(names[0]!);
				const result = await runInTab(names[1]!, {
					code: "await tab.hover('#hover'); return await tab.text('#hover');",
					timeoutMs: 10_000,
					session,
				});
				expect(result.returnValue).toBe("hovered");
				await releaseTab(names[1]!);
				await waitHidden(target);
			} finally {
				for (const name of names) await releaseTab(name).catch(() => undefined);
				await releaseBrowser(handle, { kill: false });
			}
		});
	}, 60_000);

	it("ends a relay page's emulation when its tab worker dies without closing", async () => {
		await withRelay(async ({ cdpUrl, target }) => {
			const handle = await acquireBrowser({ kind: "relay", cdpUrl }, { cwd: process.cwd() });
			const name = `background-killed-${process.pid}`;
			// Another live tab keeps omp's relay connection, and with it the page's debugger session, attached.
			const other = `background-other-${process.pid}`;
			try {
				await acquireTab(other, handle, { target: "Human", timeoutMs: 15_000 });
				await acquireTab(name, handle, { target: "Target", timeoutMs: 15_000 });
				expect(await target.evaluate(() => document.visibilityState)).toBe("visible");
				const tab = getTabsMapForTest().get(name);
				if (tab?.backend !== "worker") throw new Error("Expected a worker tab");
				await tab.worker.terminate();
				await releaseTab(name);
				await waitHidden(target);
			} finally {
				for (const tab of [name, other]) await releaseTab(tab).catch(() => undefined);
				await releaseBrowser(handle, { kill: false });
			}
		});
	}, 60_000);

	it("drives an app CDP URL tab in the background", async () => {
		const port = await findFreeCdpPort();
		const browser = await puppeteer.launch({
			executablePath: await ensureChromiumExecutable(),
			headless: true,
			args: [
				"--no-first-run",
				"--no-default-browser-check",
				"--use-mock-keychain",
				`--remote-debugging-port=${port}`,
			],
		});
		try {
			const root = await browser.target().createCDPSession();
			const target = await openTabs(browser, url => root.send("Target.createTarget", { url, background: true }));
			await driveAndRelease({ kind: "connected", cdpUrl: `http://127.0.0.1:${port}` }, target);
		} finally {
			await browser.close();
		}
	}, 60_000);
});
