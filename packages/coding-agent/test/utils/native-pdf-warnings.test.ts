import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	result: {
		content: string;
		ok: boolean;
		error?: string;
	};
	consoleErrors: string[];
}

const probePath = path.resolve(import.meta.dir, "..", "fixtures", "native-pdf-warning-probe.ts");

describe("native PDF conversion warnings", () => {
	it("extracts text from a tagged Screen annotation PDF without terminal errors", async () => {
		const proc = Bun.spawn([process.execPath, probePath], {
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
		const probe = JSON.parse(stdout) as ProbeResult;
		expect(probe.result.ok, probe.result.error).toBe(true);
		expect(probe.result.content).toContain("Tagged PDF repro text");
		expect(probe.consoleErrors).toEqual([]);
	});
});
