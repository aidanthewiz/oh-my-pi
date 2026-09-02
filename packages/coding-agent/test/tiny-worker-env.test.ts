import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { tinyWorkerEnvOverlay } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

describe("tinyWorkerEnvOverlay", () => {
	it("maps non-default settings onto the worker env vars when neither is already set", () => {
		expect(tinyWorkerEnvOverlay({}, "cuda", "fp16")).toEqual({
			PI_TINY_DEVICE: "cuda",
			PI_TINY_DTYPE: "fp16",
		});
	});

	it("lets a present env var win over the persisted setting", () => {
		expect(tinyWorkerEnvOverlay({ PI_TINY_DEVICE: "cpu" }, "cuda", "fp16")).toEqual({ PI_TINY_DTYPE: "fp16" });
		expect(tinyWorkerEnvOverlay({ PI_TINY_DTYPE: "q8" }, "cuda", "fp16")).toEqual({ PI_TINY_DEVICE: "cuda" });
	});

	it("omits a var when its setting is the default sentinel or unset", () => {
		expect(tinyWorkerEnvOverlay({}, "default", "default")).toEqual({});
		expect(tinyWorkerEnvOverlay({}, undefined, undefined)).toEqual({});
	});
});

describe("trusted worker launch policy", () => {
	it("preserves launcher policy through source and compiled worker re-entry", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-policy-"));
		try {
			const home = path.join(root, "home");
			const project = path.join(root, "project");
			const agentDir = path.join(home, ".omp", "profiles", "coreforge", "agent");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(project, { recursive: true });
			const emptyEnvFile = path.join(root, "empty.env");
			const trustedBunOptions = `--env-file="${emptyEnvFile}"`;
			await fs.writeFile(emptyEnvFile, "");
			await fs.writeFile(path.join(project, ".env"), "BUN_OPTIONS=--smol\nPROJECT_ONLY_SECRET=from-project\n");
			await fs.writeFile(
				path.join(agentDir, ".env"),
				"AZURE_CORE_COLLECT_TELEMETRY=yes\nGREPTILE_TELEMETRY_DISABLED=0\nBUN_OPTIONS=--smol\n",
			);

			const envUrl = url.pathToFileURL(path.join(import.meta.dir, "..", "..", "utils", "src", "env.ts")).href;
			const workerClientUrl = url.pathToFileURL(
				path.join(import.meta.dir, "..", "src", "subprocess", "worker-client.ts"),
			).href;
			const workerProbe = path.join(root, "worker-probe.ts");
			await Bun.write(
				workerProbe,
				[
					`import { filterChildShellEnv } from ${JSON.stringify(envUrl)};`,
					`const child = filterChildShellEnv(Bun.env, ${JSON.stringify(project)}, {`,
					'  AZURE_CORE_COLLECT_TELEMETRY: "yes",',
					'  GREPTILE_TELEMETRY_DISABLED: "0",',
					"});",
					"process.stdout.write(JSON.stringify({",
					"  azure: child.AZURE_CORE_COLLECT_TELEMETRY,",
					"  greptile: child.GREPTILE_TELEMETRY_DISABLED,",
					"  product: child.OMP_CF_PRODUCT_VERSION,",
					"  bunOptions: child.BUN_OPTIONS,",
					"  project: child.PROJECT_ONLY_SECRET,",
					"}));",
				].join("\n"),
			);
			const parentProbe = path.join(root, "parent-probe.ts");
			await Bun.write(
				parentProbe,
				[
					`import { resolveWorkerSpawnCmd, workerEnvFromParent } from ${JSON.stringify(workerClientUrl)};`,
					"const workerEnv = workerEnvFromParent({",
					'  AZURE_CORE_COLLECT_TELEMETRY: "yes",',
					'  GREPTILE_TELEMETRY_DISABLED: "0",',
					'  OMP_CF_PRODUCT_VERSION: "forged-worker",',
					'  BUN_OPTIONS: "--smol",',
					"});",
					'const command = resolveWorkerSpawnCmd("__omp_worker_policy_probe").cmd;',
					`const proc = Bun.spawn([process.execPath, ${JSON.stringify(workerProbe)}], {`,
					`  cwd: ${JSON.stringify(project)}, env: workerEnv, stdout: "pipe", stderr: "pipe",`,
					"});",
					"const [stdout, stderr, exitCode] = await Promise.all([",
					"  new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,",
					"]);",
					"if (exitCode !== 0) throw new Error(stderr);",
					"process.stdout.write(JSON.stringify({",
					"  command,",
					"  worker: {",
					"    azure: workerEnv.AZURE_CORE_COLLECT_TELEMETRY,",
					"    greptile: workerEnv.GREPTILE_TELEMETRY_DISABLED,",
					"    product: workerEnv.OMP_CF_PRODUCT_VERSION,",
					"    bunOptions: workerEnv.BUN_OPTIONS,",
					"    project: workerEnv.PROJECT_ONLY_SECRET,",
					"  },",
					"  child: JSON.parse(stdout),",
					"}));",
				].join("\n"),
			);

			const proc = Bun.spawn([process.execPath, "--no-env-file", parentProbe], {
				cwd: project,
				env: {
					PATH: process.env.PATH,
					HOME: home,
					OMP_PROFILE: "coreforge",
					OMP_DOTENV_OVERRIDE: "1",
					OMP_CF_PRODUCT_VERSION: "test-product",
					AZURE_CORE_COLLECT_TELEMETRY: "no",
					GREPTILE_TELEMETRY_DISABLED: "1",
					BUN_OPTIONS: trustedBunOptions,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			const result = JSON.parse(stdout);
			expect(result.command[1]).toBe("--no-env-file");
			expect(result.worker).toEqual({
				azure: "no",
				greptile: "1",
				product: "test-product",
				bunOptions: trustedBunOptions,
			});
			expect(result.worker.project).toBeUndefined();
			expect(result.child).toMatchObject({
				azure: "no",
				greptile: "1",
				product: "test-product",
			});
			expect(result.child.bunOptions).toContain(trustedBunOptions);
			expect(result.child.bunOptions).toContain("--no-env-file");
			expect(result.child.project).toBeUndefined();
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
