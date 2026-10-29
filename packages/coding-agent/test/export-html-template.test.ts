import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTemplate, resolveBundledHtmlAssetPath } from "../src/export/html/template-assets";

interface TemplateProbeResult {
	chars: number;
	bytes: number;
	sha256: string;
	stableCache: boolean;
	assetsRemoved: number;
}

const bundleDistUrl = new URL("../scripts/bundle-dist.ts", import.meta.url).href;
const templateProbePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(tempRoot, "compiled-template-probe");
let bundlePath: string;

/** Probe result every bundle shape must reproduce: the composed source template, byte for byte. */
function expectedProbeResult(): TemplateProbeResult {
	const template = getTemplate();
	return {
		chars: template.length,
		bytes: Buffer.byteLength(template),
		sha256: new Bun.CryptoHasher("sha256").update(template).digest("hex"),
		stableCache: true,
		assetsRemoved: 0,
	};
}

const expectedTemplate = expectedProbeResult();

async function runProbe(command: string[]): Promise<TemplateProbeResult> {
	const proc = Bun.spawn(command, {
		cwd: unrelatedCwd,
		stdin: "ignore",
		stderr: "pipe",
		stdout: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return JSON.parse(stdout) as TemplateProbeResult;
}

beforeAll(async () => {
	fs.mkdirSync(unrelatedCwd);
	const bundle = await Bun.build({
		entrypoints: [templateProbePath],
		outdir: bundleDir,
		target: "bun",
	});
	expect(bundle.success, bundle.logs.map(log => log.message).join("\n")).toBe(true);
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	expect(entrypoint).toBeDefined();
	bundlePath = entrypoint!.path;

	const compiled = await Bun.build({
		entrypoints: [templateProbePath],
		target: "bun",
		compile: { outfile: compiledPath },
	});
	expect(compiled.success, compiled.logs.map(log => log.message).join("\n")).toBe(true);
	if (process.platform === "darwin") {
		const sign = Bun.spawn(["codesign", "--force", "--sign", "-", compiledPath], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const [signExitCode, signStderr] = await Promise.all([sign.exited, new Response(sign.stderr).text()]);
		expect(signExitCode, signStderr).toBe(0);
	}
}, 120_000);

afterAll(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("keeps Windows drive-letter asset paths as filesystem paths", () => {
		const windowsAssetPath = "C:\\repo\\packages\\coding-agent\\src\\export\\html\\template.css";
		expect(resolveBundledHtmlAssetPath(windowsAssetPath, "C:\\repo\\packages\\coding-agent\\src\\export\\html")).toBe(
			windowsAssetPath,
		);
	});

	test("preserves exact bytes in a normal bundle launched from an unrelated directory", async () => {
		expect(await runProbe([process.execPath, bundlePath])).toEqual(expectedTemplate);
	});

	test("production normal bundle packs every HTML export asset", async () => {
		const productionBundleDir = path.join(tempRoot, "production-bundle");
		const staleAssetPath = path.join(productionBundleDir, "template-stale.css");
		const bundleRunnerPath = path.join(tempRoot, "bundle-dist-runner.ts");
		await Bun.write(staleAssetPath, "stale");
		await Bun.write(
			bundleRunnerPath,
			`import { bundleDist } from ${JSON.stringify(bundleDistUrl)};\nawait bundleDist(${JSON.stringify(productionBundleDir)});\n`,
		);
		const build = Bun.spawn([process.execPath, bundleRunnerPath], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [buildStdout, buildStderr, buildExitCode] = await Promise.all([
			new Response(build.stdout).text(),
			new Response(build.stderr).text(),
			build.exited,
		]);
		expect(buildExitCode, `${buildStdout}\n${buildStderr}`).toBe(0);
		expect(await Bun.file(staleAssetPath).exists()).toBe(false);

		const packRoot = path.join(tempRoot, "production-package");
		const packDir = path.join(packRoot, "packages", "coding-agent");
		const repoRoot = path.resolve(packageDir, "../..");
		const rootManifestPath = path.join(repoRoot, "package.json");
		const rootManifest = await Bun.file(rootManifestPath).json();
		await Bun.write(path.join(packRoot, "package.json"), Bun.file(rootManifestPath));
		await Bun.write(path.join(packRoot, "bun.lock"), Bun.file(path.join(repoRoot, "bun.lock")));
		const workspacePatterns = Array.isArray(rootManifest.workspaces)
			? rootManifest.workspaces
			: rootManifest.workspaces.packages;
		for (const pattern of workspacePatterns) {
			const glob = new Bun.Glob(path.join(pattern, "package.json"));
			for await (const manifestPath of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
				await Bun.write(path.join(packRoot, manifestPath), Bun.file(path.join(repoRoot, manifestPath)));
			}
		}
		for (const entry of await fs.promises.readdir(productionBundleDir)) {
			await Bun.write(path.join(packDir, "dist", entry), Bun.file(path.join(productionBundleDir, entry)));
		}
		const proc = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const packedAssets = Array.from(
			stdout.matchAll(
				/^packed \S+ (dist\/(?:template-[^.]+\.(?:css|html|js)|tool-views\.generated-[^.]+\.js|(?:marked|highlight)\.min-[^.]+\.js))$/gm,
			),
			match => match[1],
		);
		expect(packedAssets).toHaveLength(6);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.css$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.html$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/template-[^.]+\.js$/.test(filePath))).toHaveLength(1);
		expect(packedAssets.filter(filePath => /^dist\/tool-views\.generated-[^.]+\.js$/.test(filePath))).toHaveLength(1);
		expect(
			packedAssets.filter(filePath => /^dist\/(?:marked|highlight)\.min-[^.]+\.js$/.test(filePath)),
		).toHaveLength(2);
	}, 30_000);

	test("serves the cached normal-bundle template after its asset files are removed", async () => {
		expect(await runProbe([process.execPath, bundlePath, "--remove-assets-after-first-use"])).toEqual({
			...expectedTemplate,
			assetsRemoved: 6,
		});
	});

	test("preserves exact bytes in a compiled bundle launched from an unrelated directory", async () => {
		expect(await runProbe([compiledPath])).toEqual(expectedTemplate);
	});
});
