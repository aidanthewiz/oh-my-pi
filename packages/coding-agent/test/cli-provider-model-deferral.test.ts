import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("print-mode suggestions for a provider-qualified miss", () => {
	test("never lists other providers' models", async () => {
		const home = path.join(os.tmpdir(), `pi-cli-qualified-hint-${Snowflake.next()}`);
		fs.mkdirSync(home, { recursive: true });
		try {
			const proc = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../src/cli.ts"),
					"--no-title",
					"--no-lsp",
					"--no-extensions",
					"--no-tools",
					"--no-session",
					"-p",
					"--provider",
					"anthropic",
					"--model",
					"gpt-4o",
					"hi",
				],
				{
					cwd: home,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						USERPROFILE: home,
						TMPDIR: process.env.TMPDIR,
						NO_COLOR: "1",
						ANTHROPIC_API_KEY: "test-key",
						OPENAI_API_KEY: "test-key",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
			expect(exitCode).toBe(1);
			expect(stderr).toContain("anthropic/gpt-4o");
			expect(stderr).not.toContain("openai/");
		} finally {
			removeSyncWithRetries(home);
		}
	}, 60_000);
});

describe("print mode with a stale configured default", () => {
	test("warns on stderr naming the stale default and the model that runs instead", async () => {
		const home = path.join(os.tmpdir(), `pi-cli-stale-default-${Snowflake.next()}`);
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(
			path.join(agentDir, "config.yml"),
			"modelRoles:\n  default: anthropic/claude-sonnet-9-9\nretry:\n  enabled: false\n",
		);
		try {
			const proc = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../src/cli.ts"),
					"--no-title",
					"--no-lsp",
					"--no-extensions",
					"--no-tools",
					"--no-session",
					"-p",
					"hi",
				],
				{
					cwd: home,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						USERPROFILE: home,
						TMPDIR: process.env.TMPDIR,
						NO_COLOR: "1",
						ANTHROPIC_API_KEY: "test-key",
						// The fallback model's request never reaches Anthropic; the test stops the run once the warning is out.
						ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = await readUntil(proc.stderr, text => (text.match(/anthropic\/[\w.-]+/g) ?? []).length >= 2);
			proc.kill();
			await proc.exited;
			const names = stderr.match(/anthropic\/[\w.-]+/g) ?? [];
			expect(names[0]).toBe("anthropic/claude-sonnet-9-9");
			expect(names[1]).toMatch(/^anthropic\/claude-/);
			expect(names[1]).not.toBe(names[0]);
		} finally {
			removeSyncWithRetries(home);
		}
	}, 60_000);
});

async function readUntil(stream: ReadableStream<Uint8Array>, doneReading: (text: string) => boolean): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (!doneReading(text)) {
			const { value, done } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		reader.releaseLock();
	}
	return text;
}
