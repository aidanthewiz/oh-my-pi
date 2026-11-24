import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { embeddedAddonFiles } from "../scripts/embed-native";
import packageJson from "../package.json" with { type: "json" };
import { type EmbeddedAddon, embeddedAddonPath, extractEmbeddedAddons } from "../native/loader-state.js";

describe("native addon embedding", () => {
	for (const [label, contents] of [
		["a longer release stamp that starts with the expected version", `binaryPI_NATIVES_VERSION_STAMP:18.1.10\0\0`],
		["a longer legacy sentinel export that starts with the expected version", "binary__piNativesV18_1_10\0"],
		["an unstamped addon", `binaryPI_NATIVES_VERSION_STAMP:${"\0".repeat(39)}`],
	] as const) {
		it(`rejects ${label}`, async () => {
			const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
			try {
				await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), contents);

				await expect(
					embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" }),
				).rejects.toThrow("does not carry the @oh-my-pi/pi-natives@18.1.1 version stamp");
			} finally {
				await fs.rm(nativeDir, { recursive: true, force: true });
			}
		});
	}

	it("embeds identical addon bytes identically", async () => {
		const nativeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		try {
			const stamp = "PI_NATIVES_VERSION_STAMP:18.1.1\0";
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), `modern ${stamp}`.repeat(64));
			await Bun.write(path.join(nativeDir, "pi_natives.linux-x64-baseline.node"), `baseline ${stamp}`.repeat(64));
			const first = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });
			// Distinct mtimes must not leak into the embedded bytes.
			await fs.utimes(path.join(nativeDir, "pi_natives.linux-x64-modern.node"), 1, 1);
			const second = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });

			expect(second).toEqual(first);
		} finally {
			await fs.rm(nativeDir, { recursive: true, force: true });
		}
	});

	it("emits a manifest whose zstd frames the loader extracts back to the addon", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		// A pre-stamp addon whose legacy sentinel matches the version (the loader accepts it).
		const addon = "binary__piNativesV18_1_1\0";
		try {
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), addon);
			await fs.mkdir(cacheDir);
			const files = await embeddedAddonFiles({ platform: "win32", arch: "arm64", nativeDir, version: "18.1.1" });
			for (const filePath in files) {
				await Bun.write(path.join(outDir, path.basename(filePath)), files[filePath]);
			}

			// Dynamic: the manifest under test is generated into a per-test temp dir.
			const { embeddedAddon }: { embeddedAddon: EmbeddedAddon } = await import(
				path.join(outDir, "embedded-addon.js")
			);
			const extracted = embeddedAddonPath(cacheDir, embeddedAddon.files[0]);
			expect(extractEmbeddedAddons({ files: embeddedAddon.files, targetDir: cacheDir })).toEqual([extracted]);
			expect(await Bun.file(extracted).text()).toBe(addon);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it("bundles both x64 variants through a symlink after the null manifest was already imported", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-bundle-"));
		const sourceDir = path.join(root, "source");
		const nativeDir = path.join(root, "native");
		const outDir = path.join(root, "out");
		const cacheDir = path.join(root, "cache");
		const manifestPath = path.join(nativeDir, "embedded-addon.js");
		const stub = "export const embeddedAddon = null;\n";
		const addons = {
			"pi_natives.linux-x64-modern.node": "modern__piNativesV18_1_1\0",
			"pi_natives.linux-x64-baseline.node": "baseline__piNativesV18_1_1\0",
		};
		try {
			await fs.mkdir(sourceDir);
			await fs.symlink(sourceDir, nativeDir, process.platform === "win32" ? "junction" : "dir");
			await Bun.write(manifestPath, stub);
			for (const [filename, bytes] of Object.entries(addons)) {
				await Bun.write(path.join(nativeDir, filename), bytes);
			}
			// Each test creates its manifest module in a unique temporary directory.
			expect((await import(manifestPath)).embeddedAddon).toBeNull();
			const files = await embeddedAddonFiles({ platform: "linux", arch: "x64", nativeDir, version: "18.1.1" });
			const entrypoint = path.join(root, "entry.js");
			const loaderPath = path.resolve(import.meta.dir, "../native/loader-state.js");
			await Bun.write(
				entrypoint,
				`import { embeddedAddon } from ${JSON.stringify(manifestPath)};
import { extractEmbeddedAddons } from ${JSON.stringify(loaderPath)};
import * as fs from "node:fs";
fs.mkdirSync(${JSON.stringify(cacheDir)});
const extracted = extractEmbeddedAddons({
	files: embeddedAddon.files,
	targetDir: ${JSON.stringify(cacheDir)},
});
console.log(JSON.stringify(extracted.map(file =>
	fs.readFileSync(file, "utf8"))));
`,
			);
			await Bun.build({ entrypoints: [entrypoint], outdir: outDir, target: "bun", files });
			const proc = Bun.spawn([process.execPath, path.join(outDir, "entry.js")], {
				cwd: outDir,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
			expect(JSON.parse(stdout)).toEqual(Object.values(addons));
			expect(await Bun.file(manifestPath).text()).toBe(stub);
			expect((await fs.readdir(nativeDir)).sort()).toEqual(["embedded-addon.js", ...Object.keys(addons)].sort());
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	}, 30_000);

	it.skipIf(process.arch !== "x64")("extracts only the selected addon until the loader tries a fallback", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-first-run-"));
		const nativeDir = path.join(root, "native");
		const manifestDir = path.join(import.meta.dir, "../native");
		const tag = `${process.platform}-${process.arch}`;
		try {
			for (const variant of ["modern", "baseline"]) {
				await Bun.write(
					path.join(nativeDir, `pi_natives.${tag}-${variant}.node`),
					`fake ${variant} PI_NATIVES_VERSION_STAMP:${packageJson.version}\0`,
				);
			}
			const embedded = await embeddedAddonFiles({
				platform: process.platform,
				arch: process.arch,
				nativeDir,
				version: packageJson.version,
			});
			const files: Record<string, string | Uint8Array> = {};
			for (const file in embedded) files[path.join(manifestDir, path.basename(file))] = embedded[file];

			const entry = path.join(root, "entry.ts");
			await Bun.write(
				entry,
				`import { loadNative } from ${JSON.stringify(path.join(manifestDir, "loader-state.js"))};\ntry { loadNative(); } catch {}\n`,
			);
			const binary = path.join(root, process.platform === "win32" ? "probe.exe" : "probe");
			const build = await Bun.build({
				entrypoints: [entry],
				root: path.resolve(import.meta.dir, "../../.."),
				target: "bun",
				format: "esm",
				files,
				compile: { outfile: binary, autoloadBunfig: false, autoloadDotenv: false },
			});
			expect(build.success).toBe(true);

			for (const variant of ["baseline", "modern"]) {
				const cache = path.join(root, variant);
				const child = Bun.spawn([binary], {
					env: { ...process.env, PI_NATIVES_DIR: cache, PI_NATIVE_VARIANT: variant },
					stdout: "ignore",
					stderr: "ignore",
				});
				expect(await child.exited).toBe(0);
				const extracted = (await fs.readdir(path.join(cache, packageJson.version), { recursive: true }))
					.filter(file => file.endsWith(".node"))
					.sort();
				// Each extracted addon sits in its own build's `embedded-<hash>/` directory.
				expect(extracted.every(file => path.dirname(file).startsWith("embedded-"))).toBe(true);
				expect(extracted.map(file => path.basename(file)).sort()).toEqual(
					(variant === "modern"
						? [`pi_natives.${tag}-modern.node`, `pi_natives.${tag}-baseline.node`]
						: [`pi_natives.${tag}-baseline.node`]
					).sort(),
				);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
