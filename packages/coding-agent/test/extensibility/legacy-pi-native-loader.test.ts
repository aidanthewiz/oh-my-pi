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

	// Static imports would contaminate native controls and cannot exercise runtime import options.

	it.each([
		["mjs", "module", true],
		["mjs", "module", false],
		["mjs", "parameter", true],
		["mjs", "parameter", false],
		["cjs", "module", true],
		["cjs", "module", false],
		["cjs", "parameter", true],
		["cjs", "parameter", false],
	] as const)(
		"preserves dynamic imports with %s %s globalThis bindings and reload=%s",
		async (extension, binding, reload) => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-import-binding-")));
			roots.push(root);
			for (const mode of ["native", "legacy"] as const) {
				const fixture = path.join(root, mode);
				for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
					fs.mkdirSync(directory);
				}
				fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
				const helper = path.join(fixture, "helper.mjs");
				fs.writeFileSync(helper, "export default 42;");
				const entry = path.join(fixture, `entry.${extension}`);
				fs.writeFileSync(
					entry,
					[
						binding === "module" ? "#!/usr/bin/env bun\nconst globalThis = {};" : "",
						"const \\u005F_ompLegacyPiImportWithOptions = null;",
						`${extension === "mjs" ? "export const load" : "module.exports.load"} = (options${binding === "parameter" ? ", globalThis = {}" : ""}) => import("./helper.mjs", options);`,
					].join("\n"),
				);
				const program = path.join(fixture, "consumer.mjs");
				fs.writeFileSync(
					program,
					`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned import-binding consumer refuses network"); }, { preconnect() { throw Error("Owned import-binding consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry, { reload: ${reload} })`};
const load = loaded.load ?? loaded.default.load;
assert.equal((await load({})).default, 42);
assert.equal(fs.realpathSync((await load({ with: { type: "file" } })).default), ${JSON.stringify(helper)});
let reads = 0;
const sentinel = new RangeError("owned binding options");
const pending = load({ get with() { reads++; throw sentinel; } });
assert(pending instanceof Promise);
await assert.rejects(pending, error => error === sentinel);
assert.equal(reads, 1);
`,
				);
				await runConsumer(fixture, program);
			}
		},
		30_000,
	);

	it.each([
		["mjs", "static"],
		["mjs", "dynamic"],
		["cjs", "static"],
		["cjs", "dynamic"],
	] as const)("keeps cached %s %s siblings isolated from a new lazy closure", async (extension, activation) => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-warm-closure-")));
		roots.push(root);
		for (const mode of ["native", "legacy"] as const) {
			const fixture = path.join(root, mode);
			for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
				fs.mkdirSync(directory);
			}
			fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
			const warm = path.join(fixture, `warm.${extension}`);
			fs.writeFileSync(
				warm,
				`let uses = 0; ${extension === "mjs" ? "export default" : "module.exports ="} { next: () => ++uses };`,
			);
			fs.writeFileSync(path.join(fixture, "good.mjs"), "export default 42;");
			fs.writeFileSync(path.join(fixture, "linked.mjs"), `import warm from "./warm.${extension}"; export { warm };`);
			if (extension === "cjs") {
				fs.writeFileSync(path.join(fixture, "required.cjs"), 'module.exports = require("./warm.cjs");');
			}
			const entry = path.join(fixture, "entry.mjs");
			fs.writeFileSync(
				entry,
				[
					activation === "static"
						? `import * as warm from "./warm.${extension}"; export { warm };`
						: `export const warm = options => import("./warm.${extension}", options);`,
					'export const good = options => import("./good.mjs", options);',
					'export const linked = options => import("./linked.mjs", options);',
					...(extension === "cjs"
						? ['export const required = options => import("./required.cjs", options);']
						: []),
				].join("\n"),
			);
			const program = path.join(fixture, "consumer.mjs");
			fs.writeFileSync(
				program,
				`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned warm-closure consumer refuses network"); }, { preconnect() { throw Error("Owned warm-closure consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry, { reload: false })`};
const cached = ${activation === "static" ? "loaded.warm" : "await loaded.warm({})"};
assert.equal(cached.default.next(), 1);
fs.writeFileSync(${JSON.stringify(warm)}, ${JSON.stringify(extension === "mjs" ? "export const = ;" : "module.exports = ;")});
assert.equal((await loaded.good({})).default, 42);
const same = ${activation === "static" ? "loaded.warm" : "await loaded.warm({ with: {} })"};
assert.equal(same, cached);
assert.equal(same.default.next(), 2);
assert.equal((await loaded.linked({})).warm, cached.default);
assert.equal(cached.default.next(), 3);
${extension === "cjs" ? "assert.equal((await loaded.required({})).default, cached.default); assert.equal(cached.default.next(), 4);" : ""}
`,
			);
			await runConsumer(fixture, program);
		}
	});

	it.each([
		["static", true],
		["static", false],
		["dynamic", true],
		["dynamic", false],
	] as const)(
		"keeps cached %s ESM identity for late synchronous require with reload=%s",
		async (activation, reload) => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cached-esm-require-")));
			roots.push(root);
			for (const mode of ["native", "legacy"] as const) {
				const fixture = path.join(root, mode);
				for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
					fs.mkdirSync(directory);
				}
				fs.writeFileSync(
					path.join(fixture, "package.json"),
					JSON.stringify({ type: "module", imports: { "#warm": "./warm.mjs" } }),
				);
				const warm = path.join(fixture, "warm.mjs");
				fs.writeFileSync(warm, "let uses = 0; export const next = () => ++uses;");
				fs.writeFileSync(path.join(fixture, "late.cjs"), 'module.exports = require("./warm.mjs");');
				fs.writeFileSync(path.join(fixture, "alias.cjs"), 'module.exports = require("#warm");');
				const entry = path.join(fixture, "entry.mjs");
				fs.writeFileSync(
					entry,
					[
						activation === "static"
							? 'import * as warm from "./warm.mjs"; export { warm };'
							: 'export const warm = options => import("./warm.mjs", options);',
						'export const late = options => import("./late.cjs", options);',
						'export const alias = options => import("./alias.cjs", options);',
					].join("\n"),
				);
				const program = path.join(fixture, "consumer.mjs");
				fs.writeFileSync(
					program,
					`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned cached ESM consumer refuses network"); }, { preconnect() { throw Error("Owned cached ESM consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry, { reload: ${reload} })`};
const cached = ${activation === "static" ? "loaded.warm" : "await loaded.warm({})"};
assert.equal(cached.next(), 1);
fs.writeFileSync(${JSON.stringify(warm)}, "export const = ;");
assert.equal((await loaded.late({})).default, cached);
assert.equal(cached.next(), 2);
assert.equal((await loaded.alias({})).default, cached);
assert.equal(cached.next(), 3);
`,
				);
				await runConsumer(fixture, program);
			}
		},
		30_000,
	);

	it.each(["namespace", "override"] as const)("preserves cached ESM %s require interop", async interop => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cached-esm-interop-")));
		roots.push(root);
		for (const mode of ["native", "legacy"] as const) {
			const fixture = path.join(root, mode);
			for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
				fs.mkdirSync(directory);
			}
			fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
			const warm = path.join(fixture, "warm.mjs");
			fs.writeFileSync(
				warm,
				[
					"let uses = 0; export const token = { next: () => ++uses };",
					interop === "override" ? 'export { token as "module.exports" };' : "export const __esModule = false;",
				].join("\n"),
			);
			fs.writeFileSync(path.join(fixture, "late.cjs"), 'module.exports = require("./warm.mjs");');
			const entry = path.join(fixture, "entry.mjs");
			fs.writeFileSync(
				entry,
				'import * as warm from "./warm.mjs"; export { warm }; export const late = options => import("./late.cjs", options);',
			);
			const program = path.join(fixture, "consumer.mjs");
			fs.writeFileSync(
				program,
				`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned ESM interop consumer refuses network"); }, { preconnect() { throw Error("Owned ESM interop consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry)`};
assert.equal(loaded.warm.token.next(), 1);
fs.writeFileSync(${JSON.stringify(warm)}, "export const = ;");
const required = (await loaded.late({})).default;
assert.equal(required, ${interop === "override" ? "loaded.warm.token" : "loaded.warm"});
assert.equal(loaded.warm.__esModule, ${interop === "override"});
assert.equal(loaded.warm.token.next(), 2);
`,
			);
			await runConsumer(fixture, program);
		}
	});

	it("keeps pending ESM evaluation unavailable to require and reuses its settled namespace", async () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-pending-esm-require-")));
		roots.push(root);
		for (const mode of ["native", "legacy"] as const) {
			const fixture = path.join(root, mode);
			for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
				fs.mkdirSync(directory);
			}
			fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
			fs.writeFileSync(
				path.join(fixture, "warm.mjs"),
				"globalThis.__ownedCachedEsmGate.enter(); await globalThis.__ownedCachedEsmGate.wait; export const token = {};",
			);
			for (const filename of ["late.cjs", "after.cjs"]) {
				fs.writeFileSync(path.join(fixture, filename), 'module.exports = require("./warm.mjs");');
			}
			const entry = path.join(fixture, "entry.mjs");
			fs.writeFileSync(
				entry,
				[
					'export const warm = options => import("./warm.mjs", options);',
					'export const late = options => import("./late.cjs", options);',
					'export const after = options => import("./after.cjs", options);',
				].join("\n"),
			);
			const program = path.join(fixture, "consumer.mjs");
			fs.writeFileSync(
				program,
				`
import assert from "node:assert/strict";
globalThis.fetch = Object.assign(async () => { throw Error("Owned pending ESM consumer refuses network"); }, { preconnect() { throw Error("Owned pending ESM consumer refuses network"); } });
const { promise: entered, resolve: enter } = Promise.withResolvers();
const { promise: wait, resolve: release } = Promise.withResolvers();
globalThis.__ownedCachedEsmGate = { enter, wait };
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry)`};
const pending = loaded.warm({});
await entered;
await assert.rejects(loaded.late({}), TypeError);
release();
const cached = await pending;
assert.equal((await loaded.after({})).default, cached);
assert.equal((await loaded.after({})).default.token, cached.token);
`,
			);
			await runConsumer(fixture, program);
		}
	});

	it.each(["mjs", "cjs"] as const)(
		"refreshes reachable unconsumed %s helpers on repeated nonreloading entry loads",
		async extension => {
			const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cold-helper-refresh-")));
			roots.push(root);
			for (const mode of ["native", "legacy"] as const) {
				const fixture = path.join(root, mode);
				for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
					fs.mkdirSync(directory);
				}
				fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
				const cold = path.join(fixture, `cold.${extension}`);
				const fresh = path.join(fixture, `fresh.${extension}`);
				const orphan = path.join(fixture, `orphan.${extension}`);
				fs.writeFileSync(orphan, extension === "mjs" ? "export const obsolete = 1;" : "module.exports = 1;");
				const counter = "globalThis.__ownedColdLoads = (globalThis.__ownedColdLoads ?? 0) + 1;";
				fs.writeFileSync(
					cold,
					counter +
						(extension === "mjs"
							? 'import "./orphan.mjs"; export default 1;'
							: 'require("./orphan.cjs"); module.exports = 1;'),
				);
				const required = `require("./cold.${extension}")${extension === "mjs" ? ".default" : ""}`;
				fs.writeFileSync(path.join(fixture, "optional.cjs"), `module.exports = { read: () => ${required} };`);
				fs.writeFileSync(path.join(fixture, "late.cjs"), `module.exports = ${required};`);
				const warm = path.join(fixture, "warm.mjs");
				fs.writeFileSync(warm, "let uses = 0; export default { next: () => ++uses };");
				const entry = path.join(fixture, "entry.mjs");
				fs.writeFileSync(
					entry,
					'import optional from "./optional.cjs"; import warm from "./warm.mjs"; export { optional, warm }; export const late = options => import("./late.cjs", options);',
				);
				const nextSource =
					counter +
					(extension === "mjs"
						? 'import { value } from "./fresh.mjs"; export default value;'
						: 'module.exports = require("./fresh.cjs");');
				const program = path.join(fixture, "consumer.mjs");
				fs.writeFileSync(
					program,
					`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned cold-helper consumer refuses network"); }, { preconnect() { throw Error("Owned cold-helper consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loadEntry = async () => ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry, { reload: false })`};
const loaded = await loadEntry();
assert.equal(loaded.warm.next(), 1);
assert.equal(globalThis.__ownedColdLoads ?? 0, 0);
fs.writeFileSync(${JSON.stringify(cold)}, ${JSON.stringify(nextSource)});
fs.writeFileSync(${JSON.stringify(fresh)}, ${JSON.stringify(extension === "mjs" ? "export const value = 2;" : "module.exports = 2;")});
fs.writeFileSync(${JSON.stringify(orphan)}, ${JSON.stringify(extension === "mjs" ? "export const = ;" : "module.exports = ;")});
fs.writeFileSync(${JSON.stringify(warm)}, "export const = ;");
const repeated = await loadEntry();
assert.equal(repeated, loaded);
assert.equal(repeated.warm.next(), 2);
assert.equal(globalThis.__ownedColdLoads ?? 0, 0);
assert.equal((await repeated.late({})).default, 2);
assert.equal(globalThis.__ownedColdLoads, 1);
assert.equal(repeated.optional.read(), 2);
assert.equal(globalThis.__ownedColdLoads, 1);
assert.equal(repeated.warm.next(), 3);
`,
				);
				await runConsumer(fixture, program);
			}
		},
	);

	it.each([
		["LF", "\n"],
		["CRLF", "\r\n"],
		["CR", "\r"],
		["LS", "\u2028"],
		["PS", "\u2029"],
	] as const)("preserves native %s hashbang termination with lexical bridge bindings", async (_name, terminator) => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-hashbang-bridge-")));
		roots.push(root);
		for (const mode of ["native", "legacy"] as const) {
			const fixture = path.join(root, mode);
			for (const directory of [fixture, path.join(fixture, "home"), path.join(fixture, "tmp")]) {
				fs.mkdirSync(directory);
			}
			fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
			const helper = path.join(fixture, "helper.mjs");
			fs.writeFileSync(helper, "export default 42;");
			const entry = path.join(fixture, "entry.mjs");
			fs.writeFileSync(
				entry,
				`#!/usr/bin/env bun${terminator}const globalThis = {}; const __ompLegacyPiImportWithOptions = null; export const load = (options, globalThis = {}) => import("./helper.mjs", options);`,
			);
			const program = path.join(fixture, "consumer.mjs");
			fs.writeFileSync(
				program,
				`
import assert from "node:assert/strict";
import fs from "node:fs";
globalThis.fetch = Object.assign(async () => { throw Error("Owned hashbang consumer refuses network"); }, { preconnect() { throw Error("Owned hashbang consumer refuses network"); } });
const entry = ${JSON.stringify(entry)};
const loaded = ${mode === "native" ? "await import(entry)" : `await (await import(${JSON.stringify(loaderUrl)})).loadLegacyPiModule(entry)`};
assert.equal((await loaded.load({})).default, 42);
assert.equal(fs.realpathSync((await loaded.load({ with: { type: "file" } })).default), ${JSON.stringify(helper)});
`,
			);
			await runConsumer(fixture, program);
		}
	});
});
