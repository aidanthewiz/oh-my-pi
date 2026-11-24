import { discoverRelayEndpoints } from "../../coding-agent/src/tools/browser/relay/discovery";
/**
 * Manual end-to-end smoke for the relay: replicates the omp browser tool's
 * connection pattern against a live relay + extension.
 *
 * The tool opens TWO authenticated puppeteer connections per driven tab — the
 * supervisor picks a target, and a tab worker adopts that target by id — so
 * this script does exactly that, then exercises evaluate/navigate/screenshot,
 * an extra CDP session, and the createTarget/closeTarget path.
 *
 * Usage: bun scripts/smoke.ts [relay-url] [target-substring]
 */
import type { Target } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import { isLoopbackRelayUrl, resolveRelayWebSocketEndpoint } from "../../coding-agent/src/tools/browser/relay/kind";
import { ensureBrowserRelayToken } from "../../coding-agent/src/tools/browser/relay/token";

const endpoint = Bun.argv[2] ?? discoverRelayEndpoints()[0];
if (!endpoint) throw new Error("No local Coreforge browser relay found; supply the relay URL explicitly.");
const relayUrl = new URL(endpoint);
const configuredToken = relayUrl.searchParams.get("token")?.trim();
relayUrl.searchParams.delete("token");
const token =
	configuredToken || (isLoopbackRelayUrl(relayUrl.toString()) ? await ensureBrowserRelayToken() : undefined);
if (!token) throw new Error("A remote relay smoke requires an explicit token.");
const versionUrl = new URL(relayUrl);
versionUrl.pathname = `${versionUrl.pathname.replace(/\/+$/, "")}/json/version`;
const versionResponse = await fetch(versionUrl, { signal: AbortSignal.timeout(20_000) });
if (!versionResponse.ok) throw new Error(`Relay discovery failed (HTTP ${versionResponse.status}).`);
const version = (await versionResponse.json()) as { webSocketDebuggerUrl?: unknown };
if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Relay discovery omitted its CDP endpoint.");
const browserWSEndpoint = resolveRelayWebSocketEndpoint(relayUrl.toString(), version.webSocketDebuggerUrl, token);
const matcher = Bun.argv[3] ?? "Relay Smoke Page";

/** Puppeteer keeps the CDP target id on an internal field; same access the omp tab supervisor uses (`targetIdForPage`). */
function targetIdOf(target: Target): string {
	// Internal puppeteer field, not on the public type.
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

function step(name: string): void {
	console.log(`\n== ${name}`);
}

step("supervisor: connect via authenticated browserWSEndpoint");
const supervisor = await puppeteer
	.connect({ browserWSEndpoint, defaultViewport: null, protocolTimeout: 20_000 })
	.catch(() => {
		throw new Error("Authenticated supervisor connection failed.");
	});
console.log("version:", await supervisor.version());

step("supervisor: discover targets");
const pages = (
	await Promise.all(
		supervisor
			.targets()
			.map(async target => (String(target.type()) === "page" ? await target.page().catch(() => null) : null)),
	)
).filter(page => page !== null);
console.log(
	"pages:",
	pages.map(page => page.url()),
);
if (pages.length === 0) throw new Error("no page targets discovered");

let picked = null;
for (const page of pages) {
	const title = await page.title().catch(() => "");
	if (page.url().includes(matcher) || title.includes(matcher)) picked = page;
}
if (!picked) throw new Error(`no page matching ${JSON.stringify(matcher)}`);
const targetId = targetIdOf(picked.target());
const wsEndpoint = supervisor.wsEndpoint();
const workerEndpoint = new URL(wsEndpoint);
workerEndpoint.searchParams.set("claim", targetId);
console.log("picked target:", targetId);

step("worker: second connection via browserWSEndpoint");
const worker = await puppeteer
	.connect({
		browserWSEndpoint: workerEndpoint.toString(),
		defaultViewport: null,
		protocolTimeout: 20_000,
	})
	.catch(() => {
		throw new Error("Authenticated worker connection failed.");
	});
const workerTarget = await worker.waitForTarget(target => targetIdOf(target) === targetId, { timeout: 10_000 });
const page = await workerTarget.page();
if (!page) throw new Error("worker could not adopt page");

step("worker: evaluate on existing tab");
console.log("title:", await page.title());
// String form: the callback body runs in the page; a function literal would need the DOM lib.
console.log("hero:", await page.evaluate(`document.querySelector("#hero")?.textContent ?? "(no hero)"`));

step("worker: extra CDP session (screenshot path)");
const session = await page.createCDPSession();
const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
console.log("frame url:", frameTree.frameTree.frame.url);
await session.detach();

step("worker: navigate existing tab");
await page.goto("https://example.com/?relay-smoke", { waitUntil: "load", timeout: 20_000 });
console.log("navigated:", page.url(), "/", await page.title());

step("worker: screenshot");
const shot = await page.screenshot({ type: "png" });
console.log("screenshot bytes:", shot.byteLength);

step("supervisor: newPage (Target.createTarget) + close (Target.closeTarget)");
const fresh = await supervisor.newPage();
await fresh.goto("about:blank");
console.log("new page url:", fresh.url());
await fresh.close();
console.log("closed");

step("disconnect both");
await worker.disconnect();
await supervisor.disconnect();

console.log("\nSMOKE OK");
process.exit(0);
