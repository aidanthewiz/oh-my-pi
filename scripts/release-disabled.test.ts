import { expect, test } from "bun:test";
import * as path from "node:path";

test("release command fails fast when repository workflow is absent", async () => {
	const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "release.ts"), "watch"], {
		cwd: path.resolve(import.meta.dir, ".."),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);

	expect(exitCode).toBe(1);
	expect(stdout).toBe("");
	expect(stderr).toContain("Release automation is disabled in this repository");
});

test("Coreforce releases build native addons from fork sources", async () => {
	const workflow = await Bun.file(path.join(import.meta.dir, "..", ".github", "workflows", "cf-release.yml")).text();

	expect(workflow).toContain('bun scripts/bazel-natives.ts "$target"');
	expect(workflow).not.toContain('npm view "@oh-my-pi/pi-natives-');
	for (const target of [
		"darwin-arm64",
		"darwin-x64-baseline",
		"linux-x64-baseline",
		"linux-x64-modern",
		"linux-arm64",
		"win32-x64-baseline",
	]) {
		expect(workflow).toContain(target);
	}
});
