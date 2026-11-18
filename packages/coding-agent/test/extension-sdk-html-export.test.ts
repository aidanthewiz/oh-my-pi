import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";

const packageDir = path.resolve(import.meta.dir, "..");
const sourceUrl = (file: string) => pathToFileURL(path.join(packageDir, "src", file)).href;
const ownedText = "Owned SDK export: <script>must remain conversation data</script>";
const timestamp = 1_700_000_000_000;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("cold extension SDK HTML export", () => {
	it.each([
		"host-getter",
		"inline-extension",
		"file-extension",
		"type-import-extension",
		"file-asset-extension",
		"file-asset-extension-legacy-cache",
	] as const)(
		"exports an owned conversation and intact offline viewer through %s",
		async mode => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-sdk-html-export-")));
			roots.push(root);
			const home = path.join(root, "home");
			const work = path.join(root, "work");
			const temp = path.join(root, "tmp");
			for (const directory of [home, work, temp]) fs.mkdirSync(directory);
			const output = path.join(root, "conversation.html");
			const entry = path.join(root, "extension.ts");
			const typesPath = path.join(packageDir, "src", "extensibility", "extensions", "types.ts");
			const relativeTypes = `./${path.relative(root, typesPath).split(path.sep).join("/")}`;
			const relativeViewer = `./${path
				.relative(root, path.join(packageDir, "src", "export", "html", "viewer.generated.js"))
				.split(path.sep)
				.join("/")}`;
			const importsViewer = mode === "file-asset-extension" || mode === "file-asset-extension-legacy-cache";
			const entrySource = [
				...(mode === "type-import-extension"
					? [`import type { ExtensionAPI } from ${JSON.stringify(relativeTypes)};`]
					: []),
				...(importsViewer
					? [`import viewerPath from ${JSON.stringify(relativeViewer)} with { type: "file" };`]
					: []),
				`export default async function(api${mode === "type-import-extension" ? ": ExtensionAPI" : ""}) {`,
				`  await globalThis[Symbol.for("owned-sdk-html-export.consume")](api.pi${importsViewer ? ", viewerPath" : ""});`,
				"}",
			].join("\n");
			fs.writeFileSync(entry, entrySource);
			const cacheRoot = path.join(root, "cache");
			if (mode === "file-asset-extension-legacy-cache") {
				const cachePath = path.join(cacheRoot, "omp", "cache", "legacy-pi-extension-cache.db");
				fs.mkdirSync(path.dirname(cachePath), { recursive: true });
				const specifier = JSON.stringify(relativeViewer);
				const start = entrySource.indexOf(specifier);
				if (start < 0) throw new Error("Owned legacy cache fixture has no viewer import");
				const cache = new Database(cachePath, { create: true });
				try {
					cache.run(
						"CREATE TABLE extension_parse_cache (cache_key TEXT PRIMARY KEY, source_type TEXT NOT NULL, [references] TEXT NOT NULL, commonjs_syntax INTEGER NOT NULL)",
					);
					cache.run("PRAGMA user_version = 3");
					cache
						.query("INSERT INTO extension_parse_cache VALUES (?, ?, ?, ?)")
						.run(
							`3:.ts:${Bun.hash(entrySource).toString(16)}`,
							"module",
							JSON.stringify([
								{ kind: "import", specifier: relativeViewer, start, end: start + specifier.length },
							]),
							0,
						);
				} finally {
					cache.close();
				}
			}
			const program = path.join(root, "consumer.mjs");
			fs.writeFileSync(
				program,
				`
import * as path from "node:path";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
// Static SDK imports would warm the cache before the injected getter is exercised.
globalThis.fetch = async () => { throw new Error("Owned SDK export refuses network"); };
const work = ${JSON.stringify(work)};
const output = ${JSON.stringify(output)};
async function consume(sdk, viewerPath) {
  if (viewerPath !== undefined) {
    const file = path.isAbsolute(viewerPath) ? viewerPath : path.resolve(path.dirname(output), viewerPath);
    const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(packageDir, "src", "export", "html", "viewer.generated.json"))}, "utf8"));
    const integrity = "sha256-" + createHash("sha256").update(fs.readFileSync(file)).digest("base64");
    if (integrity !== manifest.integrity) throw new Error("File-loader viewer integrity mismatch");
  }
  const auth = await sdk.AuthStorage.create(":memory:");
  let session;
  try {
    const registry = new sdk.ModelRegistry(auth);
    const model = registry.find("openai", "gpt-4o-mini");
    if (!model) throw new Error("Missing bundled owned-fixture model");
    const message = { role: "user", content: ${JSON.stringify(ownedText)}, timestamp: ${timestamp} };
    const manager = sdk.SessionManager.create(work, path.join(work, "sessions"));
    manager.appendMessage(message);
    await manager.ensureOnDisk();
    const { Agent } = await import(${JSON.stringify(pathToFileURL(Bun.resolveSync("@oh-my-pi/pi-agent-core", packageDir)).href)});
    session = new sdk.AgentSession({
      agent: new Agent({ initialState: { model, systemPrompt: ["Owned SDK export"], tools: [], messages: [message] } }),
      sessionManager: manager,
      settings: sdk.Settings.isolated({ "memory.backend": "off", "compaction.enabled": false, "retry.enabled": false }),
      modelRegistry: registry,
    });
    await session.exportToHtml(output);
  } finally {
    await session?.dispose();
    auth.close();
  }
}
globalThis[Symbol.for("owned-sdk-html-export.consume")] = consume;
const mode = ${JSON.stringify(mode)};
if (mode === "host-getter") {
  const { getCodingAgentApi } = await import(${JSON.stringify(sourceUrl("extensibility/host-api.ts"))});
  await consume(getCodingAgentApi());
} else {
  const loader = await import(${JSON.stringify(sourceUrl("extensibility/extensions/loader.ts"))});
  if (mode === "inline-extension") {
    const { EventBus } = await import(${JSON.stringify(sourceUrl("utils/event-bus.ts"))});
    await loader.loadExtensionFromFactory(api => consume(api.pi), work, new EventBus(), new loader.ExtensionRuntime());
  } else {
    const loaded = await loader.loadExtensions([${JSON.stringify(entry)}], work);
    if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  }
}
`,
			);
			const proc = Bun.spawn([process.execPath, "--no-env-file", program], {
				cwd: work,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: mode === "file-asset-extension-legacy-cache" && process.platform === "win32" ? cacheRoot : home,
					USERPROFILE:
						mode === "file-asset-extension-legacy-cache" && process.platform === "win32" ? cacheRoot : home,
					TMPDIR: temp,
					TMP: temp,
					TEMP: temp,
					PI_CONFIG_DIR:
						mode === "file-asset-extension-legacy-cache" && process.platform === "win32" ? "omp" : ".omp",
					...(mode === "file-asset-extension-legacy-cache" ? { XDG_CACHE_HOME: cacheRoot } : {}),
					BUN_OPTIONS: "",
					TERM: "dumb",
					NO_COLOR: "1",
				},
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			// Native module loading runs in a real process; this only bounds a wedged child.
			const watchdog = setTimeout(() => proc.kill("SIGKILL"), 20_000);
			let exitCode: number;
			let stdout: string;
			let stderr: string;
			try {
				[exitCode, stdout, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
			} finally {
				clearTimeout(watchdog);
			}
			expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
			const { document } = parseHTML(fs.readFileSync(output, "utf8"));
			const data = JSON.parse(
				Buffer.from(document.querySelector("#session-data")!.textContent!, "base64").toString(),
			);
			expect(data.header.cwd).toBe(work);
			expect(
				data.entries.find(
					(entry: { type: string; message?: { role: string } }) =>
						entry.type === "message" && entry.message?.role === "user",
				).message,
			).toMatchObject({
				role: "user",
				content: ownedText,
				timestamp,
			});
			expect(document.querySelectorAll("script[src]")).toHaveLength(0);
			const assetDir = path.join(packageDir, "src", "export", "html");
			const viewer = fs.readFileSync(path.join(assetDir, "viewer.generated.js"));
			const manifest = JSON.parse(fs.readFileSync(path.join(assetDir, "viewer.generated.json"), "utf8"));
			expect(`sha256-${createHash("sha256").update(viewer).digest("base64")}`).toBe(manifest.integrity);
			const escapedViewer = viewer.toString("utf8").replace(/<\/script/gi, match => `<\\/${match.slice(2)}`);
			const expectedDigest = createHash("sha256").update(escapedViewer).digest("hex");
			const scriptDigests = Array.from(document.querySelectorAll("script:not([src]):not(#session-data)"), script =>
				createHash("sha256")
					.update(script.textContent ?? "")
					.digest("hex"),
			);
			expect(scriptDigests).toContain(expectedDigest);
		},
		30_000,
	);
});
