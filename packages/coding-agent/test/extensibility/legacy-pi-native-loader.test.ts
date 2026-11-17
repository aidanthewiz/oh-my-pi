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

async function runConsumer(fixture: string, program: string): Promise<void> {
	const home = path.join(fixture, "home");
	const temp = path.join(fixture, "tmp");
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
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(exitCode, `${fixture}: ${stdout}\n${stderr}`).toBe(0);
	} finally {
		clearTimeout(watchdog);
	}
}

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
			let nativeErrors: unknown;
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
						'  const fileOptions = { with: { type: "file" } };',
						'  const { default: variable } = await import("./shared.js", fileOptions);',
						"  const evaluations = [];",
						'  const attributesWithGetters = { get mode() { evaluations.push("mode"); return "owned"; }, get type() { evaluations.push("type"); return "file"; } };',
						'  const makeOptions = () => { evaluations.push("factory"); return { get with() { evaluations.push("with"); return attributesWithGetters; } }; };',
						'  const { default: getter } = await import("./shared.js?getter=1#owned-native", makeOptions());',
						"  const emptyOptions = {};",
						'  const ordinary = await import("./shared.js", emptyOptions);',
						"  const emptyAttributes = {};",
						'  const computedOrdinary = await import("./shared.js", { ["with"]: { ...emptyAttributes } });',
						'  const hiddenType = Object.defineProperty({}, "type", { get() { throw new Error("Non-enumerable type must not be read"); } });',
						'  const hiddenOrdinary = await import("./shared.js", { with: hiddenType });',
						'  const sentinel = new RangeError("owned import options");',
						"  const failed = async invoke => {",
						"    let pending;",
						"    try { pending = invoke(); } catch (error) { return { sync: true, sameError: error === sentinel, name: error.name, message: error.message }; }",
						"    try { await pending; return { fulfilled: true }; } catch (error) { return { sync: false, sameError: error === sentinel, name: error.name, message: error.message }; }",
						"  };",
						"  const errors = await Promise.all([",
						'    failed(() => import("./shared.js", (() => { throw sentinel; })())),',
						'    failed(() => import("./shared.js", { get with() { throw sentinel; } })),',
						'    failed(() => import("./shared.js", { with: { get type() { throw sentinel; } } })),',
						'    failed(() => import("./shared.js", null)),',
						'    failed(() => import("./shared.js", { with: null })),',
						'    failed(() => import("./shared.js", { with: { type: 0, get later() { throw sentinel; } } })),',
						'    failed(() => import("./shared.js", { with: { type: "owned-invalid-loader" } })),',
						"  ]);",
						"  return {",
						'    label: renderLabel({ label: "owned-loader", counter: 21 }),',
						"    base: token.base,",
						"    entryPath: fileURLToPath(import.meta.url),",
						"    sameOrdinaryObject: ordinary.default === shared && computedOrdinary.default === shared && hiddenOrdinary.default === shared,",
						"    sameOrdinaryToken: ordinary.token === token && computedOrdinary.token === token && hiddenOrdinary.token === token,",
						"    ordinaryLabel: ordinary.renderLabel({ label: 'owned-loader', counter: 21 }),",
						"    evaluations, errors,",
						...(kind === "commonjs" ? ["    sameRequiredObject: shared === required,"] : []),
						"    files: Object.entries({ direct, queried, fragmented, aliased, packaged, fileUrl, dynamic, spread, computed, variable, getter }).map(([kind, file]) => ({",
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
				await runConsumer(fixture, program);
				const result = JSON.parse(fs.readFileSync(output, "utf8"));
				expect(result.initial.label).toBe("OWNED-LOADER:2a");
				expect(result.initial.base).toBe(21);
				expect(result.initial.entryPath).toBe(entry);
				expect(result.firstUse).toBe(1);
				expect(result.initial.sameOrdinaryObject).toBeTrue();
				expect(result.initial.sameOrdinaryToken).toBeTrue();
				expect(result.initial.ordinaryLabel).toBe("OWNED-LOADER:2a");
				expect(result.initial.evaluations).toEqual(["factory", "with", "mode", "type"]);
				if (mode === "native") nativeErrors = result.initial.errors;
				else expect(result.initial.errors).toEqual(nativeErrors);
				expect(result.initial.errors.slice(0, 3).map((error: { sameError: boolean }) => error.sameError)).toEqual([
					true,
					true,
					true,
				]);
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
						"variable",
						"getter",
					].map(kind => ({ kind, path: shared, sha256: initialDigest })),
				);
				if (mode === "legacy") {
					expect(result.after.label).toBe(reload ? "OWNED-LOADER:54" : "OWNED-LOADER:2a");
					expect(result.after.base).toBe(reload ? 63 : 21);
					expect(result.after.entryPath).toBe(entry);
					expect(result.secondUse).toBe(reload ? 1 : 2);
					expect(result.sameEntry).toBe(!reload);
					expect(result.sameToken).toBe(!reload);
					expect(result.after.sameOrdinaryObject).toBeTrue();
					expect(result.after.sameOrdinaryToken).toBeTrue();
					expect(result.after.ordinaryLabel).toBe(reload ? "OWNED-LOADER:54" : "OWNED-LOADER:2a");
					expect(result.after.evaluations).toEqual(["factory", "with", "mode", "type"]);
					expect(result.after.errors).toEqual(nativeErrors);
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
							"variable",
							"getter",
						].map(kind => ({ kind, path: shared, sha256: editedDigest })),
					);
				}
			}
		},
		30_000,
	);

	it.each([
		["import", undefined],
		["import", false],
		["import", true],
		["export", undefined],
		["export", false],
		["export", true],
	] as const)(
		"keeps erased inline-only %s targets native with verbatimModuleSyntax=%s",
		async (declaration, verbatimModuleSyntax) => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-erased-inline-loader-")));
			roots.push(root);
			for (const mode of ["native", "legacy"] as const) {
				const fixture = path.join(root, mode);
				for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
					fs.mkdirSync(directory);
				}
				fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
				fs.writeFileSync(
					path.join(fixture, "tsconfig.json"),
					JSON.stringify({ compilerOptions: { verbatimModuleSyntax } }),
				);
				const types = path.join(fixture, "types.ts");
				const bytes = "export const = ;\n";
				fs.writeFileSync(types, bytes);
				const entry = path.join(fixture, "entry.ts");
				fs.writeFileSync(
					entry,
					[
						`${declaration} { type Shape, type Other } from "./types.ts";`,
						'export const read = options => import("./types.ts", options);',
						"export default 42;",
					].join("\n"),
				);
				const output = path.join(fixture, "result.json");
				const program = path.join(fixture, "consumer.mjs");
				fs.writeFileSync(
					program,
					`
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
globalThis.fetch = Object.assign(async () => { throw Error("Owned inline-loader consumer refuses network"); }, { preconnect() { throw Error("Owned inline-loader consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(pathToFileURL(entry).href)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry)`};
const evaluations = [];
const throughOptions = await loaded.read({ get with() { evaluations.push("with"); return { get type() { evaluations.push("type"); return "file"; } }; } });
const typesUrl = pathToFileURL(${JSON.stringify(types)}).href;
const asset = await import(typesUrl, { with: { type: "file" } });
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({ value: loaded.default, path: fs.realpathSync(asset.default), bytes: fs.readFileSync(asset.default, "utf8"), dynamicPath: fs.realpathSync(throughOptions.default), dynamicBytes: fs.readFileSync(throughOptions.default, "utf8"), evaluations }));
`,
				);
				await runConsumer(fixture, program);
				expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual({
					value: 42,
					path: types,
					bytes,
					dynamicPath: types,
					dynamicBytes: bytes,
					evaluations: ["with", "type"],
				});
			}
		},
		30_000,
	);
});
