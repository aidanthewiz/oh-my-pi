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
			const proc = spawnPrintCli(home, ["--provider", "anthropic", "--model", "gpt-4o", "hi"], {
				ANTHROPIC_API_KEY: "test-key",
				OPENAI_API_KEY: "test-key",
			});
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
			const proc = spawnPrintCli(home, ["hi"], { ANTHROPIC_API_KEY: "test-key" });
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

/** Closed local port: every request through it is refused at once. */
const DEAD_PROXY = "http://127.0.0.1:9";

/**
 * `omp -p` in an isolated `home`. A missed selector or stale default awaits one
 * online discovery pass over every provider catalog before it reports; routing
 * all requests through a dead proxy fails that pass at once, so resolution runs
 * against the bundled catalog instead of waiting on the network.
 */
function spawnPrintCli(home: string, args: string[], env: Record<string, string>) {
	return Bun.spawn(
		[
			process.execPath,
			path.resolve(import.meta.dir, "../src/cli.ts"),
			"--no-title",
			"--no-lsp",
			"--no-extensions",
			"--no-tools",
			"--no-session",
			"-p",
			...args,
		],
		{
			cwd: home,
			env: {
				PATH: process.env.PATH,
				HOME: home,
				USERPROFILE: home,
				TMPDIR: process.env.TMPDIR,
				NO_COLOR: "1",
				HTTP_PROXY: DEAD_PROXY,
				HTTPS_PROXY: DEAD_PROXY,
				ANTHROPIC_BASE_URL: DEAD_PROXY,
				...env,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

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
