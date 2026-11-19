import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { retireRustExecutables } from "./ci-qualification-engine";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
	const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cf-rust-retirement-")));
	roots.push(workspace);
	const target = path.join(workspace, "target");
	await fs.mkdir(target);
	return { workspace, target };
}
async function executable(file: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return file;
}

async function qualificationAdmission(mode: string, shard?: string) {
	const receipts = await fs.mkdtemp(path.join(os.tmpdir(), "cf-qualification-admission-"));
	roots.push(receipts);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: receipts,
		TMPDIR: receipts,
		...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
	};
	if (shard !== undefined) env.OMP_TEST_SHARD = shard;
	env.QUALIFICATION_RECEIPT_DIR = receipts;
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", path.join(import.meta.dir, "ci-qualification-engine.ts"), mode],
		{ cwd: receipts, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const exitCode = await child.exited;
	const result = await Bun.file(path.join(receipts, `result-${mode}.json`)).json();
	return { exitCode, result };
}

async function producerFixture(producerAttempt: unknown = "1") {
	const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cf-producer-rerun-"));
	roots.push(workspace);
	const platform = `${process.platform}-${process.arch}`;
	const repo = path.resolve(import.meta.dir, "..");
	const git = (args: string[]) => {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	const sourceSha = git(["rev-parse", "HEAD"]);
	const gitDir = git(["rev-parse", "--absolute-git-dir"]);
	const generatedSources = [
		{
			sourcePath: "packages/coding-agent/src/cli/cf-version.generated.ts",
			artifactPath: "qualification-effective-source/cf-version.generated.ts",
		},
		{
			sourcePath: "packages/stats/src/embedded-client.generated.txt",
			artifactPath: "qualification-effective-source/embedded-client.generated.txt",
		},
	];
	const paths = [
		`packages/coding-agent/binaries/omp-${platform}`,
		`packages/natives/native/pi_natives.${platform}.node`,
		"LICENSE",
		"THIRD-PARTY-NOTICES.txt",
		...generatedSources.map(file => file.artifactPath),
	];
	const files: { path: string; sha256: string; size: number }[] = [];
	for (const relative of paths) {
		const text = `synthetic qualification input: ${relative}\n`;
		const file = path.join(workspace, relative);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, text);
		files.push({
			path: relative,
			sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"),
			size: Buffer.byteLength(text),
		});
	}
	const manifest = {
		schemaVersion: 1,
		sourceSha,
		platform,
		runId: "12345",
		runAttempt: producerAttempt,
		files,
		generatedSources,
		effectiveSource: {
			"native-effective": {},
			"binary-effective": {
				files: generatedSources.map(file => ({
					...files.find(input => input.path === file.artifactPath)!,
					path: file.sourcePath,
				})),
			},
		},
		versions: {},
		config: {},
	};
	await fs.mkdir(path.join(workspace, "scripts"));
	await fs.copyFile(
		path.join(import.meta.dir, "ci-qualification-engine.ts"),
		path.join(workspace, "scripts/ci-qualification-engine.ts"),
	);
	await fs.writeFile(path.join(workspace, "qualification-inputs.json"), JSON.stringify(manifest));
	return { workspace, sourceSha, gitDir, platform, manifest };
}

async function verifyProducerFixture(fixture: Awaited<ReturnType<typeof producerFixture>>, consumerAttempt = "2") {
	const receipts = path.join(fixture.workspace, "receipts");
	const child = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			path.join(fixture.workspace, "scripts/ci-qualification-engine.ts"),
			"verify-inputs",
			fixture.platform,
			fixture.sourceSha,
		],
		{
			cwd: fixture.workspace,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: fixture.workspace,
				TMPDIR: fixture.workspace,
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				GIT_DIR: fixture.gitDir,
				GIT_WORK_TREE: fixture.workspace,
				SOURCE_SHA: fixture.sourceSha,
				GITHUB_RUN_ID: "12345",
				GITHUB_RUN_ATTEMPT: consumerAttempt,
				QUALIFICATION_RECEIPT_DIR: receipts,
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
	const result = await Bun.file(path.join(receipts, "result-verify-inputs.json")).json();
	return { exitCode, stderr, result, receipts };
}

describe("TypeScript qualification partition admission", () => {
	for (const shard of [undefined, "", "1", "0/3", "4/3", "1/2", "2/4", "01/3", "1/03", " 1/3", "1/3\n"]) {
		test(`rejects ${JSON.stringify(shard)} before executing partitioned tests and records failure`, async () => {
			const { exitCode, result } = await qualificationAdmission("typescript-tests", shard);
			expect(exitCode).not.toBe(0);
			expect(result.passed).toBe(false);
			expect(result.error).toContain("typescript-tests requires OMP_TEST_SHARD to be exactly 1/3, 2/3, or 3/3");
			expect(result.commands).toEqual([]);
		});
	}

	for (const mode of ["typescript", "typescript-smoke"]) {
		for (const shard of ["", "1/3"]) {
			test(`${mode} rejects inherited shard ${JSON.stringify(shard)}`, async () => {
				const { exitCode, result } = await qualificationAdmission(mode, shard);
				expect(exitCode).not.toBe(0);
				expect(result.passed).toBe(false);
				expect(result.error).toContain(`${mode} requires OMP_TEST_SHARD to be unset`);
				expect(result.commands).toEqual([]);
			});
		}
	}

	for (const [mode, shard] of [
		["typescript-tests", "1/3"],
		["typescript-tests", "2/3"],
		["typescript-tests", "3/3"],
		["typescript-smoke", undefined],
		["typescript", undefined],
	] as const) {
		test(`${mode} ${shard ?? "unpartitioned"} still requires exact source identity`, async () => {
			const { exitCode, result } = await qualificationAdmission(mode, shard);
			expect(exitCode).not.toBe(0);
			expect(result.passed).toBe(false);
			expect(result.error).toContain("SOURCE_SHA must be the exact PR head SHA");
			expect(result.commands).toEqual([]);
		});
	}
});

describe("Qualification producer reuse on targeted reruns", () => {
	for (const consumerAttempt of ["1", "2"]) {
		test(`consumer attempt ${consumerAttempt} verifies the original producer without relabeling it`, async () => {
			const fixture = await producerFixture();
			const { exitCode, result, receipts } = await verifyProducerFixture(fixture, consumerAttempt);
			expect(exitCode).toBe(0);
			expect(result).toMatchObject({ passed: true, runAttempt: consumerAttempt, sourceSha: fixture.sourceSha });
			expect(await Bun.file(path.join(receipts, "verified-inputs.json")).json()).toEqual(fixture.manifest);
		});
	}

	for (const producerAttempt of ["3", "0", "-1", "01", "1.5", "1\n", "", 1, null]) {
		test(`rejects invalid or future producer attempt ${JSON.stringify(producerAttempt)}`, async () => {
			const fixture = await producerFixture(producerAttempt);
			const { exitCode, result, receipts } = await verifyProducerFixture(fixture);
			expect(exitCode).not.toBe(0);
			expect(result.passed).toBe(false);
			expect(await Bun.file(path.join(receipts, "verified-inputs.json")).exists()).toBe(false);
		});
	}

	for (const consumerAttempt of ["0", "01", "1.5", "1\n", ""]) {
		test(`rejects invalid consumer attempt ${JSON.stringify(consumerAttempt)}`, async () => {
			const fixture = await producerFixture();
			const { exitCode, result } = await verifyProducerFixture(fixture, consumerAttempt);
			expect(exitCode).not.toBe(0);
			expect(result.passed).toBe(false);
		});
	}

	for (const changed of [
		{ sourceSha: "f".repeat(40) },
		{ runId: "54321" },
		{ platform: "other-platform" },
		{ schemaVersion: 2 },
	]) {
		test(`rejects mismatched producer identity ${Object.keys(changed)[0]}`, async () => {
			const fixture = await producerFixture();
			await fs.writeFile(
				path.join(fixture.workspace, "qualification-inputs.json"),
				JSON.stringify({ ...fixture.manifest, ...changed }),
			);
			const { exitCode, result, receipts } = await verifyProducerFixture(fixture);
			expect(exitCode).not.toBe(0);
			expect(result.passed).toBe(false);
			expect(await Bun.file(path.join(receipts, "verified-inputs.json")).exists()).toBe(false);
		});
	}

	test("still rejects changed artifact bytes on a later consumer attempt", async () => {
		const fixture = await producerFixture();
		await fs.appendFile(path.join(fixture.workspace, fixture.manifest.files[0]!.path), "changed");
		const { exitCode, result, receipts } = await verifyProducerFixture(fixture);
		expect(exitCode).not.toBe(0);
		expect(result.passed).toBe(false);
		expect(await Bun.file(path.join(receipts, "verified-inputs.json")).exists()).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("Unix Rust executable retirement", () => {
	test("retires a closed Cargo unit executable while retaining dependencies and build output", async () => {
		const { workspace, target } = await fixture();
		const binary = await executable(path.join(target, "debug/build/package/unit/out/suite-unit"));
		const library = path.join(target, "debug/build/package/dependency/out/libpackage.rlib");
		await fs.mkdir(path.dirname(library), { recursive: true });
		await fs.writeFile(library, "retained dependency");
		const buildOutput = path.join(target, "debug/build/package/build-script/output");
		await fs.mkdir(path.dirname(buildOutput), { recursive: true });
		await fs.writeFile(buildOutput, "retained build script output");
		await retireRustExecutables(workspace, target, [binary]);
		await expect(fs.stat(binary)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fs.readFile(library, "utf8")).toBe("retained dependency");
		expect(await fs.readFile(buildOutput, "utf8")).toBe("retained build script output");
	});

	test("rejects an escaping executable before deleting any earlier candidate", async () => {
		const { workspace, target } = await fixture();
		const inside = await executable(path.join(target, "inside"));
		const outside = await executable(path.join(workspace, "outside"));
		await expect(retireRustExecutables(workspace, target, [inside, outside])).rejects.toThrow("escapes Cargo target");
		expect((await fs.stat(inside)).isFile()).toBe(true);
		expect((await fs.stat(outside)).isFile()).toBe(true);
	});

	test("rejects a symlinked unit path into another directory", async () => {
		const { workspace, target } = await fixture();
		const outside = await executable(path.join(workspace, "other/suite"));
		await fs.symlink(path.dirname(outside), path.join(target, "linked"));
		await expect(retireRustExecutables(workspace, target, [path.join(target, "linked/suite")])).rejects.toThrow(
			"Ambiguous Cargo executable",
		);
		expect(await fs.readFile(outside, "utf8")).toBe("#!/bin/sh\nexit 0\n");
	});

	test("never retires an executable-mode shared dependency", async () => {
		const { workspace, target } = await fixture();
		const library = await executable(path.join(target, "debug/libdependency.so"));
		await expect(retireRustExecutables(workspace, target, [library])).rejects.toThrow("Retain Cargo dependency");
		expect((await fs.stat(library)).isFile()).toBe(true);
	});

	test("does not unlink a running test executable", async () => {
		const { workspace, target } = await fixture();
		const binary = path.join(target, "running-suite");
		await fs.copyFile(process.execPath, binary);
		await fs.chmod(binary, 0o755);
		const child = Bun.spawn([binary, "--no-env-file", "-e", 'console.log("ready"); setInterval(() => {}, 1000)'], {
			cwd: workspace,
			env: { HOME: workspace, TMPDIR: workspace, PATH: process.env.PATH ?? "/usr/bin:/bin" },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = child.stdout.getReader();
			const ready = await reader.read();
			reader.releaseLock();
			expect(Buffer.from(ready.value!).toString()).toContain("ready");
			await expect(retireRustExecutables(workspace, target, [binary])).rejects.toThrow("open or closure is unknown");
			expect((await fs.stat(binary)).isFile()).toBe(true);
		} finally {
			child.kill();
			await child.exited;
		}
	});
});
