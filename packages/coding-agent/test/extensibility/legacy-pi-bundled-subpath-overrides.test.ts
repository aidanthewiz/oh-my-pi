import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import { __buildLegacyPiPackageRootOverrides } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir } from "@oh-my-pi/pi-utils";
import { __renderLegacyPiVirtualModule, collectBundledPiEntries } from "../../scripts/legacy-pi-virtual-module";
import type { BundledPiEntry } from "../../scripts/legacy-pi-virtual-module";

const bundledEntries = await collectBundledPiEntries();
const bundledModuleKeys = new Set(bundledEntries.map(entry => entry.key));

async function runRegistryProbe(entries: BundledPiEntry[], source: string): Promise<unknown> {
	// Bare package imports in the generated registry need the workspace links.
	const packageRoot = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");
	const registryPath = path.join(packageRoot, `.probe-legacy-pi-${Bun.randomUUIDv7()}.ts`);
	await Bun.write(registryPath, `${__renderLegacyPiVirtualModule(entries)}\n${source}\n`);
	try {
		// Runtime-selected registry filename: static imports cannot exercise its generated module.
		const registry = await import(url.pathToFileURL(registryPath).href);
		return registry.observed;
	} finally {
		await fs.rm(registryPath, { force: true });
	}
}

// Regression for issue #3442: extension validation in compiled-binary mode
// failed to resolve `@earendil-works/pi-ai/oauth` because the override map
// only covered bare package roots — every non-wildcard subpath fell through
// to `Bun.resolveSync`, which bunfs can't satisfy on Bun 1.3.14+, then the
// `rewriteLegacyPiImports` catch left the original specifier in place and
// Bun's native resolver couldn't find a peer install. The build plugin now
// derives every module key from current package exports, so subpaths route to
// the same `omp-legacy-pi-bundled:` virtual namespace as package roots without
// a generated registry or duplicate key list.
describe("legacy pi compat compiled-mode subpath overrides (issue #3442)", () => {
	it("does not evaluate unrelated host modules while loading the registry", async () => {
		using tempDir = TempDir.createSync("@omp-legacy-pi-loaders-");
		const alphaPath = path.join(tempDir.path(), "alpha.ts");
		const betaPath = path.join(tempDir.path(), "beta.ts");
		const registryPath = path.join(tempDir.path(), "registry.ts");
		await Bun.write(alphaPath, 'Reflect.set(globalThis, "__alphaLoads", 1);\nexport const value = "alpha";\n');
		await Bun.write(betaPath, 'Reflect.set(globalThis, "__betaLoads", 1);\nexport const value = "beta";\n');
		const registry = __renderLegacyPiVirtualModule([
			{ key: "alpha", binding: "bundledAlpha", importSpecifier: url.pathToFileURL(alphaPath).href },
			{ key: "beta", binding: "bundledBeta", importSpecifier: url.pathToFileURL(betaPath).href },
		]);
		await Bun.write(
			registryPath,
			`${registry}
export const beforeAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const beforeBeta = Reflect.get(globalThis, "__betaLoads") ?? 0;
await BUNDLED_PI_MODULE_LOADERS.alpha();
export const afterAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const betaAfterAlpha = Reflect.get(globalThis, "__betaLoads") ?? 0;
await BUNDLED_PI_MODULE_LOADERS.beta();
export const finalAlpha = Reflect.get(globalThis, "__alphaLoads") ?? 0;
export const finalBeta = Reflect.get(globalThis, "__betaLoads") ?? 0;
`,
		);
		Reflect.deleteProperty(globalThis, "__alphaLoads");
		Reflect.deleteProperty(globalThis, "__betaLoads");
		try {
			// The generated registry has a runtime-selected temp path; importing it is the loading boundary under test.
			const observed = await import(url.pathToFileURL(registryPath).href);
			expect([
				observed.beforeAlpha,
				observed.beforeBeta,
				observed.afterAlpha,
				observed.betaAfterAlpha,
				observed.finalAlpha,
				observed.finalBeta,
			]).toEqual([0, 0, 1, 0, 1, 1]);
		} finally {
			Reflect.deleteProperty(globalThis, "__alphaLoads");
			Reflect.deleteProperty(globalThis, "__betaLoads");
		}
	});

	it("loads utility root-wildcard subpaths used by external image-link extensions", async () => {
		const keys = ["@oh-my-pi/pi-utils/lru", "@oh-my-pi/pi-utils/marked"] as const;
		const entries = bundledEntries.filter(entry => (keys as readonly string[]).includes(entry.key));
		expect(entries.map(entry => entry.key).sort()).toEqual([...keys]);

		const observed = await runRegistryProbe(
			entries,
			`const { Lexer } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/marked"]();
const { LRUCache } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/lru"]();
const cache = new LRUCache({ max: 1 });
cache.set("image", "photo.png");
const paragraph = Lexer.lex("[photo.png](file:///tmp/photo.png)")[0];
export const observed = {
	cachedImage: cache.get("image"),
	link: paragraph.tokens.map(token => ({ type: token.type, text: token.text, href: token.href })),
};`,
		);
		expect(observed).toEqual({
			cachedImage: "photo.png",
			link: [{ type: "link", text: "photo.png", href: "file:///tmp/photo.png" }],
		});
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		for (const key of keys) expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("loads exported .js utility aliases from the same host modules", async () => {
		const keys = [
			"@oh-my-pi/pi-utils/lru",
			"@oh-my-pi/pi-utils/lru.js",
			"@oh-my-pi/pi-utils/marked",
			"@oh-my-pi/pi-utils/marked.js",
		];
		const entries = bundledEntries.filter(entry => keys.includes(entry.key));
		expect(entries.map(entry => entry.key).sort()).toEqual(keys);

		const observed = await runRegistryProbe(
			entries,
			`const marked = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/marked"]();
const markedJs = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/marked.js"]();
const lru = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/lru"]();
const lruJs = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-utils/lru.js"]();
const cache = new lruJs.LRUCache({ max: 1 });
cache.set("image", "photo.png");
export const observed = {
	sharedLexer: markedJs.Lexer === marked.Lexer,
	sharedCache: lruJs.LRUCache === lru.LRUCache,
	text: markedJs.Lexer.lex(cache.get("image"))[0].text,
};`,
		);
		expect(observed).toEqual({ sharedLexer: true, sharedCache: true, text: "photo.png" });
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		for (const key of keys) expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("actually loads the shim's shared Pi translation through the bundled registry", async () => {
		// The legacy shim performs the same Pi arg translation as the modern
		// bridge and imports the shared helpers rather than copying them. Those
		// use the explicit single-segment `providers/cursor-pi-args` target; wildcard
		// exports may also match nested paths, whose registry coverage is tested below.
		//
		// Executing the generated registry is the contract — a key present in the
		// override map still proves nothing if the module cannot be imported.
		const key = "@oh-my-pi/pi-ai/providers/cursor-pi-args";
		const entry = bundledEntries.find(candidate => candidate.key === key);
		expect(entry).toBeDefined();

		expect(
			await runRegistryProbe(
				[entry!],
				`const mod = await BUNDLED_PI_MODULE_LOADERS[${JSON.stringify(key)}]();
export const observed = [mod.piEscapeRegexLiteral("a.b*c"), mod.piJoinPath("src", "*.ts")];`,
			),
		).toEqual(["a\\.b\\*c", path.join("src", "*.ts")]);

		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("loads catalog root and provider-model exports from the bundled graph", async () => {
		const root = bundledEntries.find(entry => entry.key === "@oh-my-pi/pi-catalog");
		const provider = bundledEntries.find(entry => entry.key === "@oh-my-pi/pi-catalog/provider-models");
		if (!root || !provider) throw new Error("Catalog imports are missing from the bundled registry");

		const observed = await runRegistryProbe(
			[root, provider],
			`const catalog = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-catalog"]();
const providers = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-catalog/provider-models"]();
const result = await catalog.createModelManager(providers.anthropicModelManagerOptions()).refresh("offline");
export const observed = result.models.some(model => model.id === "claude-fable-5");`,
		);
		expect(observed).toBe(true);
	});

	it("loads catalog build exports through the bundled registry in compiled mode", async () => {
		const key = "@oh-my-pi/pi-catalog/build";
		const entry = bundledEntries.find(candidate => candidate.key === key);
		if (!entry) throw new Error("Catalog build import is missing from the bundled registry");

		const observed = await runRegistryProbe(
			[entry],
			`const { buildModel } = await BUNDLED_PI_MODULE_LOADERS[${JSON.stringify(key)}]();
export const observed = buildModel({
	id: "custom-model",
	name: "OpenAI: Sample (latest)",
	api: "openai-completions",
	provider: "custom",
	baseUrl: "https://api.example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
}).name;`,
		);
		expect(observed).toBe("Sample");
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("loads pi-tui native/* modules through the bundled registry in compiled mode (issue #14834)", async () => {
		// `native/*` was only reachable through pi-tui's root `./*` catch-all, which
		// the generator skips, so extensions importing it failed inside the binary.
		const keys = ["@oh-my-pi/pi-tui/native/overlay", "@oh-my-pi/pi-tui/native/spans"] as const;
		const entries = bundledEntries.filter(entry => (keys as readonly string[]).includes(entry.key));
		expect(entries.map(entry => entry.key).sort()).toEqual([...keys]);

		const observed = await runRegistryProbe(
			entries,
			`const { actionBar, actionButton } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/native/overlay"]();
const { plainLine } = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/native/spans"]();
export const observed = { role: actionBar([actionButton("Go", "go")]).p.role, line: plainLine("\\x1b[1ma\\n b\\x1b[0m") };`,
		);
		expect(observed).toEqual({ role: "omp.actions", line: "a b" });
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		for (const key of keys) expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});

	it("serves pi-tui root-level, nested, and index spellings from the host graph (issue #15659)", async () => {
		// pi-tui's root `./*` catch-all and `x/index` spellings used to stay out of
		// the registry, so a compiled extension loaded those specifiers from its
		// own node_modules and saw a second `TERMINAL` / theme record.
		const keys = [
			"@oh-my-pi/pi-tui/terminal-capabilities",
			"@oh-my-pi/pi-tui/chat/svg-figure",
			"@oh-my-pi/pi-tui/theme",
			"@oh-my-pi/pi-tui/theme/index",
		] as const;
		const entries = bundledEntries.filter(entry => (keys as readonly string[]).includes(entry.key));
		expect(entries.map(entry => entry.key).sort()).toEqual([...keys].sort());

		const observed = await runRegistryProbe(
			entries,
			`const theme = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/theme"]();
const themeIndex = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/theme/index"]();
const svg = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/chat/svg-figure"]();
const caps = await BUNDLED_PI_MODULE_LOADERS["@oh-my-pi/pi-tui/terminal-capabilities"]();
export const observed = {
	theme: theme.setThemeInstance === themeIndex.setThemeInstance,
	svg: typeof svg.svgFigurePalette,
	caps: typeof caps.setTerminalImageProtocol,
};`,
		);
		expect(observed).toEqual({ theme: true, svg: "function", caps: "function" });
		const overrides = __buildLegacyPiPackageRootOverrides(true, bundledModuleKeys);
		for (const key of keys) expect(overrides[key]).toBe(`omp-legacy-pi-bundled:${key}`);
	});
});
