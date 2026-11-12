import { expect, test } from "bun:test";
import {
	closeLaunchedBrowser,
	isPuppeteerTimeout,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";
declare const location: { hostname: string };

const CHROMIUM_AVAILABLE = await chromiumAvailable();

test.skipIf(!CHROMIUM_AVAILABLE)(
	"raw predicate wait survives cross-origin document navigation without accepting false predicates",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const { pathname, port } = new URL(request.url);
				return new Response(
					pathname === "/start"
						? `<button id="unlock" onclick="location.href='http://localhost:${port}/done'">Unlock</button>`
						: "<h1>destination</h1>",
					{ headers: { "content-type": "text/html" } },
				);
			},
		});
		await using _serverCleanup = {
			[Symbol.asyncDispose]: () => server.stop(true),
		};
		const { browser, userDataDir } = await launchHeadlessBrowser({ headless: true });
		await using _profileCleanup = {
			async [Symbol.asyncDispose]() {
				if (userDataDir) await removeUserDataDir(userDataDir);
			},
		};
		await using _browserCleanup = { [Symbol.asyncDispose]: () => closeLaunchedBrowser(browser) };
		const context = await browser.createBrowserContext();
		await using _contextCleanup = { [Symbol.asyncDispose]: () => context.close() };
		const checkout = await context.newPage();
		await checkout.goto(`http://127.0.0.1:${server.port}/start`);
		const destination = checkout.waitForFunction(() => location.hostname === "localhost", { timeout: 3000 });
		void destination.catch(() => undefined);
		await checkout.click("#unlock");
		const result = await destination;
		await using _resultCleanup = { [Symbol.asyncDispose]: () => result.dispose() };
		expect(await result.jsonValue()).toBe(true);
		expect(await checkout.evaluate(() => location.hostname)).toBe("localhost");
		const timeout = await rejectionOf(
			checkout.waitForFunction(() => location.hostname === "not-this-host", { timeout: 150 }),
		);
		expect(isPuppeteerTimeout(timeout)).toBe(true);
		expect(browser.connected).toBe(true);
	},
	20_000,
);
