import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { isPuppeteerTimeout, loadPuppeteer } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { navigateMainFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { getTab, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { type Page, TimeoutError } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

// Puppeteer errors derive their names from constructor names; classification must not depend on those names.

const CHROMIUM_AVAILABLE = await chromiumAvailable();
let neverCommitsRequests = 0;
const server = Bun.serve({
	port: 0,
	// `/never-commits` must outlive the run budget instead of Bun's 10s idle cut.
	idleTimeout: 0,
	fetch(request) {
		// Never answers, so a navigation to it never commits.
		if (new URL(request.url).pathname === "/never-commits") {
			neverCommitsRequests++;
			return Promise.withResolvers<Response>().promise;
		}
		return new Response("<!doctype html><title>start</title>", { headers: { "content-type": "text/html" } });
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
}, 30_000);

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			// Managed Chromium, whether or not omp's WebKit engine is installed on this machine.
			"browser.webkit": false,
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-release-build-timeouts-test" });
}

test("raises a main-frame wait past its timeout as Puppeteer's timeout, still named TimeoutError", async () => {
	// The tab worker loads Puppeteer before any navigation; the timeout is built from that load.
	await loadPuppeteer();
	const events = new Set<string>();
	const page = {
		mainFrame: () => ({ _lifecycleEvents: events }),
		isClosed: () => false,
		browser: () => ({ connected: true }),
	} as unknown as Page;
	const nameDescriptor = Object.getOwnPropertyDescriptor(TimeoutError, "name")!;
	Object.defineProperty(TimeoutError, "name", { ...nameDescriptor, value: "Og" });
	// Real time on purpose: the wait polls the frame on a timer and must stop reading at its deadline.
	const late = setTimeout(() => events.add("load"), 90);
	try {
		const error = await navigateMainFrame(page, "load", 60, undefined, async () => null).catch(err => err);
		// tab.goto stops the pending load only for an error it recognizes as Puppeteer's timeout.
		expect(isPuppeteerTimeout(error)).toBe(true);
		// back/forward/reload pass this error to the agent's cell, which may match on the name.
		expect(error.name).toBe("TimeoutError");
		expect(error.message).toBe("Navigation timeout of 60 ms exceeded");
	} finally {
		clearTimeout(late);
		Object.defineProperty(TimeoutError, "name", nameDescriptor);
	}
});

describe.skipIf(!CHROMIUM_AVAILABLE)("isolated browser navigation timeouts", () => {
	test("refuses to run a tab when isolated workers cannot start", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker")!;
		Object.defineProperty(globalThis, "Worker", {
			...descriptor,
			value: function UnavailableWorker(): never {
				throw new Error("Worker threads unavailable");
			},
		});
		try {
			await expect(
				createHost()({ action: "open", name: "unavailable-worker", url: `${baseUrl}/start` }),
			).rejects.toThrow("Failed to spawn isolated browser tab worker: Worker threads unavailable");
			expect(getTab("unavailable-worker")).toBeUndefined();
		} finally {
			Object.defineProperty(globalThis, "Worker", descriptor);
		}
	}, 30_000);

	test("tab.goto stops a navigation that never commits", async () => {
		const invoke = createHost();
		const name = "isolated-timeout";
		await invoke({ action: "open", name, url: `${baseUrl}/start` });
		const tab = getTab(name);
		if (tab?.backend !== "worker") throw new Error("Expected an isolated browser tab");
		const worker = tab.worker;
		expect(worker.mode).toBe("worker");
		await invoke({
			action: "run",
			name,
			code: 'await tab.evaluate(() => { globalThis.navigationMarker = "original document"; });',
		});
		const requestsBefore = neverCommitsRequests;
		const error = await invoke({
			action: "run",
			name,
			timeout: 3,
			code: `await tab.goto(${JSON.stringify(`${baseUrl}/never-commits`)});`,
		}).catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toMatch(/^tab\.goto\(.*\) timed out after \d+ms; pending navigation stopped/);
		expect(neverCommitsRequests - requestsBefore).toBe(1);
		const { details } = await invoke({
			action: "run",
			name,
			timeout: 3,
			code: "return [tab.url(), await tab.evaluate(() => globalThis.navigationMarker)];",
		});
		expect(details).toMatchObject({ value: [`${baseUrl}/start`, "original document"] });
		expect(getTab(name)).toBe(tab);
		expect(tab.worker).toBe(worker);
	}, 60_000);
});
