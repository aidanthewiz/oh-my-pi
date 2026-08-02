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
