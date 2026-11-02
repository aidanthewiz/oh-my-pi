import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

// Each subprocess needs a fresh module cache for the first lazy runner import.
const fixture = String.raw`
import { plugin } from "bun";
import { readFile } from "node:fs/promises";
const root = process.env.BROWSER_LAZY_FIXTURE_ROOT;
// Bootstrap from the subprocess-selected root before gating the runner's first module load.
const scenario = process.env.BROWSER_LAZY_FIXTURE_SCENARIO;
const { CmuxSocketClient } = await import(root + "src/tools/browser/cmux/socket-client.ts");
const { acquireBrowser, holdBrowser, releaseBrowser } = await import(root + "src/tools/browser/registry.ts");
const { acquireTab, getTabsMapForTest, releaseTab, runInTab } = await import(root + "src/tools/browser/tab-supervisor.ts");
const { Settings } = await import(root + "src/config/settings.ts");
const { JsRuntime } = await import(root + "src/eval/js/shared/runtime.ts");
const { disposeAllVmContexts } = await import(root + "src/eval/js/context-manager.ts");
CmuxSocketClient.prototype.connect = async () => {};
CmuxSocketClient.prototype.close = () => {};
CmuxSocketClient.prototype.request = async method => {
  if (method === "browser.url.get") return { url: "about:blank" };
  if (method === "browser.eval") return { value: "" };
  throw new Error("Unexpected synthetic cmux request: " + method);
};
const loaded = Promise.withResolvers();
const gate = Promise.withResolvers();
const finished = Promise.withResolvers();
const runtimes = new Set();
let runtimeStarted = false;
const originalRun = JsRuntime.prototype.run;
JsRuntime.prototype.run = async function (...args) {
  runtimes.add(this);
  runtimeStarted = true;
  try { return await originalRun.apply(this, args); }
  finally { finished.resolve(); }
};
let starts = 0;
let loadCount = 0;
globalThis.__browserLazyGuestStart = () => { starts++; };
let browser;
let evidence;
try {
  browser = await acquireBrowser({ kind: "cmux", socketPath: "/tmp/omp-lazy-fixture-unused.sock", surface: "surface-lazy" }, { cwd: root });
  holdBrowser(browser);
  const acquired = await acquireTab("lazy-fixture", browser, { timeoutMs: 5000, ownerSessionId: "lazy-fixture" });
  if (acquired.tab.backend !== "cmux") throw new Error("Expected synthetic cmux backend");
  plugin({ name: "gate-browser-runner", setup(build) {
    build.onLoad({ filter: /[/\\]in-process-run\.ts$/ }, async args => {
      loadCount++;
      loaded.resolve();
      await gate.promise;
      return { contents: await readFile(args.path, "utf8"), loader: "ts" };
    });
  } });
  const aborter = new AbortController();
  const session = { cwd: root, hasUI: false, settings: Settings.isolated({}), getSessionFile: () => null };
  const run = runInTab("lazy-fixture", {
    code: "globalThis.__browserLazyGuestStart();", timeoutMs: 5000, session, signal: aborter.signal,
  }).then(() => ({ ok: true }), error => ({ ok: false, name: error.name, message: error.message }));
  await loaded.promise;
  const pendingAtLoad = getTabsMapForTest().get("lazy-fixture")?.pending.size;
  if (pendingAtLoad !== 1) throw new Error("Lazy gate did not intercept an admitted pending run");
  let released;
  if (scenario === "close") released = await releaseTab("lazy-fixture", { kill: false });
  if (scenario === "abort") aborter.abort();
  gate.resolve();
  const outcome = await run;
  // The public cancellation can settle before the losing guest compilation.
  if (runtimeStarted) await finished.promise;
  evidence = { starts, outcome, loadCount, pendingAtLoad, released };
} finally {
  gate.resolve();
  try {
    await releaseTab("lazy-fixture", { kill: false });
  } finally {
    if (runtimeStarted) await finished.promise;
    for (const runtime of runtimes) runtime.dispose();
    JsRuntime.prototype.run = originalRun;
    await disposeAllVmContexts();
    if (browser) await releaseBrowser(browser, { kill: false });
    delete globalThis.__browserLazyGuestStart;
  }
}
process.stdout.write(JSON.stringify(evidence) + "\n");
`;

describe("browser lazy in-process runner admission", () => {
	for (const scenario of ["close", "abort", "control"] as const) {
		it(`admits guest code only while its pending run remains live: ${scenario}`, async () => {
			const child = Bun.spawn([process.execPath, "--eval", fixture], {
				cwd: root,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, BROWSER_LAZY_FIXTURE_ROOT: root, BROWSER_LAZY_FIXTURE_SCENARIO: scenario },
			});
			// A real subprocess watchdog must also stop a blocked loader or native import.
			const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
			try {
				const [stdout, stderr, exit] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(exit, stderr).toBe(0);
				const evidence = JSON.parse(stdout.trim());
				expect(evidence).toMatchObject({ loadCount: 1, pendingAtLoad: 1 });
				expect(evidence.starts).toBe(scenario === "control" ? 1 : 0);
				if (scenario === "control") expect(evidence.outcome).toEqual({ ok: true });
				if (scenario === "abort") expect(evidence.outcome).toMatchObject({ ok: false, name: "ToolAbortError" });
				if (scenario === "close") {
					expect(evidence.released).toBe(true);
					expect(evidence.outcome).toMatchObject({ ok: false, message: 'Tab "lazy-fixture" was closed' });
				}
			} finally {
				clearTimeout(timeout);
				child.kill();
				await child.exited;
			}
		}, 20_000);
	}
});
