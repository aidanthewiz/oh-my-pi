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
