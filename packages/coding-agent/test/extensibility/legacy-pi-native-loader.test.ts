import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const loaderUrl = pathToFileURL(
	path.resolve(import.meta.dir, "../../src/extensibility/plugins/legacy-pi-compat.ts"),
).href;
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("legacy native-loader isolation", () => {
	it.each([
		["esm", true],
		["esm", false],
		["commonjs", true],
		["commonjs", false],
	] as const)(
		"preserves runtime and native file consumers for %s with reload=%s",
		async (kind, reload) => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-native-loader-")));
			roots.push(root);
			for (const mode of ["native", "legacy"] as const) {
				const fixture = path.join(root, mode);
				const home = path.join(fixture, "home");
				const temp = path.join(fixture, "tmp");
				for (const directory of [fixture, home, temp]) fs.mkdirSync(directory);
				fs.writeFileSync(
					path.join(fixture, "package.json"),
					JSON.stringify({
						name: "owned-native-loader",
						version: "1.0.0",
						type: kind === "esm" ? "module" : "commonjs",
						exports: { "./shared": "./shared.js" },
						imports: { "#owned-file": "./shared.js" },
					}),
				);
				const shared = path.join(fixture, "shared.js");
				const helperSource = (base: number) =>
					[
						`const token = { uses: 0, base: ${base} };`,
						`function renderLabel(values) { return values.label.toUpperCase() + ":" + (values.counter + ${base}).toString(16); }`,
						...(kind === "esm"
							? ["export { renderLabel, token };", "export default { renderLabel, token };"]
							: ["module.exports = { renderLabel, token };"]),
					].join("\n");
				const initialSource = helperSource(21);
				const editedSource = helperSource(63);
				fs.writeFileSync(shared, initialSource);
				if (kind === "commonjs") {
					fs.writeFileSync(path.join(fixture, "required.cjs"), 'module.exports = require("./shared.js");\n');
				}
				const entry = path.join(fixture, "entry.mjs");
				fs.writeFileSync(
					entry,
					[
						'import * as fs from "node:fs";',
						'import { createHash } from "node:crypto";',
						'import { fileURLToPath } from "node:url";',
						'import shared, { renderLabel, token } from "./shared.js";',
						'import direct from "./shared.js" with { type: "file" };',
						'import queried from "./shared.js?consumer=1" with { type: "file" };',
						'import fragmented from "./shared.js?consumer=1#owned-native" with { type: "file" };',
						'import aliased from "#owned-file" with { type: "file" };',
						'import packaged from "owned-native-loader/shared" with { type: "file" };',
						`import fileUrl from ${JSON.stringify(pathToFileURL(shared).href)} with { type: "file" };`,
						...(kind === "commonjs" ? ['import required from "./required.cjs";'] : []),
						"export { token };",
						"export const advance = () => ++token.uses;",
						"export default async function inspect() {",
						'  const { default: dynamic } = await import("./shared.js", { with: { type: "file" } });',
						'  const attributes = { type: "file" };',
						'  const { default: spread } = await import("./shared.js", { with: { ...attributes } });',
						'  const { default: computed } = await import("./shared.js", { ["with"]: { ["type"]: "file" } });',
						"  return {",
						'    label: renderLabel({ label: "owned-loader", counter: 21 }),',
						"    base: token.base,",
						"    entryPath: fileURLToPath(import.meta.url),",
						...(kind === "commonjs" ? ["    sameRequiredObject: shared === required,"] : []),
						"    files: Object.entries({ direct, queried, fragmented, aliased, packaged, fileUrl, dynamic, spread, computed }).map(([kind, file]) => ({",
						"      kind,",
						"      path: fs.realpathSync(file),",
						'      sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex"),',
						"    })),",
						"  };",
						"}",
					].join("\n"),
				);
				const output = path.join(fixture, "result.json");
				const program = path.join(fixture, "consumer.mjs");
				fs.writeFileSync(
					program,
					`
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
globalThis.fetch = Object.assign(async () => { throw Error("Owned native-loader consumer refuses network"); }, { preconnect() { throw Error("Owned native-loader consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
// Each fresh child imports only its selected loader; no prior module cache is shared.
const load = ${mode === "native" ? "() => import(pathToFileURL(entry).href)" : `(await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule.bind(null, entry, { reload: ${reload} })`};
const first = await load();
const result = { initial: await first.default(), firstUse: first.advance() };
if (${JSON.stringify(mode)} === "legacy") {
  fs.writeFileSync(${JSON.stringify(shared)}, ${JSON.stringify(editedSource)});
  const second = await load();
  result.after = await second.default();
  result.secondUse = second.advance();
  result.sameEntry = first === second;
  result.sameToken = first.token === second.token;
}
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(result));
`,
				);
				const proc = Bun.spawn([process.execPath, "--no-env-file", program], {
					cwd: fixture,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						USERPROFILE: home,
						TMPDIR: temp,
						TMP: temp,
						TEMP: temp,
						PI_CONFIG_DIR: ".omp",
						BUN_OPTIONS: "",
						TERM: "dumb",
						NO_COLOR: "1",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				// The native child cannot use fake timers; this only bounds a wedged process.
				const watchdog = setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}, 10_000);
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
				expect(exitCode, `${mode}: ${stdout}\n${stderr}`).toBe(0);
				const result = JSON.parse(fs.readFileSync(output, "utf8"));
				expect(result.initial.label).toBe("OWNED-LOADER:2a");
				expect(result.initial.base).toBe(21);
				expect(result.initial.entryPath).toBe(entry);
				expect(result.firstUse).toBe(1);
				if (kind === "commonjs") expect(result.initial.sameRequiredObject, mode).toBeTrue();
				const initialDigest = createHash("sha256").update(initialSource).digest("hex");
				expect(result.initial.files).toEqual(
					[
						"direct",
						"queried",
						"fragmented",
						"aliased",
						"packaged",
						"fileUrl",
						"dynamic",
						"spread",
						"computed",
					].map(kind => ({ kind, path: shared, sha256: initialDigest })),
				);
				if (mode === "legacy") {
					expect(result.after.label).toBe(reload ? "OWNED-LOADER:54" : "OWNED-LOADER:2a");
					expect(result.after.base).toBe(reload ? 63 : 21);
					expect(result.after.entryPath).toBe(entry);
					expect(result.secondUse).toBe(reload ? 1 : 2);
					expect(result.sameEntry).toBe(!reload);
					expect(result.sameToken).toBe(!reload);
					if (kind === "commonjs") expect(result.after.sameRequiredObject, mode).toBeTrue();
					const editedDigest = createHash("sha256").update(editedSource).digest("hex");
					expect(result.after.files).toEqual(
						[
							"direct",
							"queried",
							"fragmented",
							"aliased",
							"packaged",
							"fileUrl",
							"dynamic",
							"spread",
							"computed",
						].map(kind => ({ kind, path: shared, sha256: editedDigest })),
					);
				}
			}
		},
		30_000,
	);
});
