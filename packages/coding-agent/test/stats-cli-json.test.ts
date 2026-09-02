import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const cliEntry = path.join(import.meta.dir, "..", "src", "cli.ts");

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-stats-cli-json-");
});

afterEach(async () => {
	await tempDir.remove();
});

describe("stats --json", () => {
	it("writes parseable JSON without a human sync summary", async () => {
		const proc = Bun.spawn([process.execPath, cliEntry, "stats", "--json"], {
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				BUN_OPTIONS: "--no-env-file",
				HOME: tempDir.path(),
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: tempDir.path(),
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);

		expect(exitCode).toBe(0);
		expect(() => JSON.parse(output)).not.toThrow();
		expect(JSON.parse(output).overall.totalRequests).toBe(0);
		expect(output).not.toContain("Synced ");
		expect(error).toContain("Syncing session files...");
	});
});
