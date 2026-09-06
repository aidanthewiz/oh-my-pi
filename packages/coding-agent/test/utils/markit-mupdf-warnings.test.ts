import { describe, expect, it } from "bun:test";
import * as path from "node:path";

interface ProbeResult {
	result: {
		content: string;
		ok: boolean;
		error?: string;
	};
	events: Array<{
		level: string;
		message: string;
		context?: Record<string, unknown>;
	}>;
	consoleErrors: string[];
}

const probePath = path.resolve(import.meta.dir, "..", "fixtures", "markit-mupdf-warning-probe.ts");

describe("markit MuPDF warnings", () => {
	it("routes recoverable PDF warnings to the file logger", async () => {
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
		expect(
			probe.events.some(
				event =>
					event.level === "debug" &&
					event.message === "mupdf wasm output" &&
					event.context?.stream === "stderr" &&
					String(event.context.message).includes("Screen annotations"),
			),
		).toBe(true);
	});
});
