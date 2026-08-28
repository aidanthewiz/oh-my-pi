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

	expect(workflow).toContain('bun scripts/bazel-natives.ts "${targets[@]}"');
	expect(workflow).not.toContain('npm view "@oh-my-pi/pi-natives-');
	expect(workflow).not.toContain("curl -fsSL -o omp-darwin-arm64");
	expect(workflow).toContain('--pattern "omp-darwin-arm64"');
	expect(workflow).toContain("Reclaim disk for Windows native cross-build");
	expect(workflow).toContain("if: matrix.target == 'win32-x64'");
	expect(workflow).toContain("sudo rm -rf /usr/local/lib/android /opt/hostedtoolcache/CodeQL");
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
	expect(workflow).toContain('coreforge-pi-natives-${{ matrix.target }}-${RELEASE_TAG}.tgz');
	expect(workflow).toContain("pattern: native-*");
	expect(workflow).toContain('node -e \'require("./package/pi_natives.darwin-arm64.node")\'');
});
