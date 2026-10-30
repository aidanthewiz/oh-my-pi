import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { getTemplate, resolveBundledHtmlAssetPath } from "../src/export/html/template-assets";

const bundleDistUrl = new URL("../scripts/bundle-dist.ts", import.meta.url).href;
const probePath = path.resolve(import.meta.dir, "fixtures", "html-export-template-probe.ts");
const packageDir = path.resolve(import.meta.dir, "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-html-template-"));
const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
const bundleDir = path.join(tempRoot, "bundle");
const compiledPath = path.join(tempRoot, "compiled-template-probe");
let bundlePath: string;

async function runProbe(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { cwd: unrelatedCwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	return stdout;
}

beforeAll(async () => {
	await fs.mkdir(unrelatedCwd);
	const bundle = await Bun.build({ entrypoints: [probePath], outdir: bundleDir, target: "bun" });
	if (!bundle.success) throw new AggregateError(bundle.logs, "Template probe bundle failed");
	const entrypoint = bundle.outputs.find(output => output.kind === "entry-point");
	if (!entrypoint) throw new Error("Template probe emitted no entry point");
	bundlePath = entrypoint.path;
	const compiled = await Bun.build({
		entrypoints: [probePath],
		target: "bun",
		compile: { outfile: compiledPath },
	});
	if (!compiled.success) throw new AggregateError(compiled.logs, "Compiled template probe failed");
	if (process.platform === "darwin") {
		const sign = Bun.spawn(["codesign", "--force", "--sign", "-", compiledPath], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([sign.exited, new Response(sign.stderr).text()]);
		expect(exitCode, stderr).toBe(0);
	}
}, 120_000);

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("HTML export template", () => {
	test("keeps Windows drive-letter asset paths as filesystem paths", () => {
		const asset = "C:\\repo\\packages\\coding-agent\\src\\export\\html\\viewer.generated.js";
		expect(resolveBundledHtmlAssetPath(asset, "C:\\repo\\packages\\coding-agent\\src\\export\\html")).toBe(asset);
	});

	test("delivers an offline viewer from source without remote script dependencies", async () => {
		const html = getTemplate();
		const { document } = parseHTML(html);
		expect(document.querySelectorAll("script[src]")).toHaveLength(0);
		expect(document.querySelector("#session-data")).not.toBeNull();
		expect(await runProbe([process.execPath, probePath])).toBe(html);
	});

	test("normal and compiled bundles preserve offline HTML from an unrelated directory", async () => {
		const expected = getTemplate();
		expect(await runProbe([process.execPath, bundlePath])).toBe(expected);
		expect(await runProbe([compiledPath])).toBe(expected);
	});

	test("keeps a normal bundle usable after relocation without its source checkout", async () => {
		const relocated = path.join(tempRoot, "relocated");
		await fs.cp(bundleDir, relocated, { recursive: true });
		expect(await runProbe([process.execPath, path.join(relocated, path.basename(bundlePath))])).toBe(getTemplate());
	});

	test("serves the cached viewer after its owned bundle sidecars are removed", async () => {
		const disposable = path.join(tempRoot, "cached");
		await fs.cp(bundleDir, disposable, { recursive: true });
		expect(
			await runProbe([
				process.execPath,
				path.join(disposable, path.basename(bundlePath)),
				"--remove-assets-after-first-use",
				disposable,
			]),
		).toBe(getTemplate());
	});

	test("ships the generated viewer with the production package and removes obsolete sidecars", async () => {
		const productionDir = path.join(tempRoot, "production-bundle");
		const staleAsset = path.join(productionDir, "template-stale.css");
		await Bun.write(staleAsset, "obsolete viewer sidecar");
		const runner = path.join(tempRoot, "bundle-dist-runner.ts");
		await Bun.write(
			runner,
			`import { bundleDist } from ${JSON.stringify(bundleDistUrl)};\nawait bundleDist(${JSON.stringify(productionDir)});\n`,
		);
		const proc = Bun.spawn([process.execPath, runner], {
			cwd: packageDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		expect(await Bun.file(staleAsset).exists()).toBe(false);

		const repoRoot = path.resolve(packageDir, "../..");
		const packRoot = path.join(tempRoot, "production-package");
		const packDir = path.join(packRoot, "packages", "coding-agent");
		const rootManifestPath = path.join(repoRoot, "package.json");
		const rootManifest = await Bun.file(rootManifestPath).json();
		await Bun.write(path.join(packRoot, "package.json"), Bun.file(rootManifestPath));
		await Bun.write(path.join(packRoot, "bun.lock"), Bun.file(path.join(repoRoot, "bun.lock")));
		const workspacePatterns = Array.isArray(rootManifest.workspaces)
			? rootManifest.workspaces
			: rootManifest.workspaces.packages;
		for (const pattern of workspacePatterns) {
			const glob = new Bun.Glob(path.join(pattern, "package.json"));
			for await (const manifest of glob.scan({ cwd: repoRoot, onlyFiles: true })) {
				await Bun.write(path.join(packRoot, manifest), Bun.file(path.join(repoRoot, manifest)));
			}
		}
		await fs.cp(productionDir, path.join(packDir, "dist"), { recursive: true });
		const pack = Bun.spawn([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
			cwd: packDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [packOut, packErr, packExit] = await Promise.all([
			new Response(pack.stdout).text(),
			new Response(pack.stderr).text(),
			pack.exited,
		]);
		expect(packExit, packErr).toBe(0);
		const packed = Array.from(packOut.matchAll(/^packed \S+ (.+)$/gm), match => match[1]);
		const assets = (await fs.readdir(productionDir)).filter(name => /^viewer\..+\.js$/.test(name));
		if (assets.length === 0) throw new Error("Production package omitted the offline viewer");
		for (const asset of assets) expect(packed).toContain(`dist/${asset}`);
	}, 60_000);
});
