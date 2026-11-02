import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CF_COMMAND } from "@oh-my-pi/pi-coding-agent/cli/cf-version";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import { getActiveProfile, setProfile } from "@oh-my-pi/pi-utils/dirs";

const originalProfile = getActiveProfile();
const roots: string[] = [];
const sessionId = "019ea530-0000-7000-0000-000000000000";
const powerShell = Bun.which("pwsh") ?? Bun.which("powershell");
const posixShell = Bun.which("sh");

afterEach(() => {
	setProfile(originalProfile);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "resume-command-"));
	roots.push(root);
	const custom = join(root, "sessions ' $HOME $(touch injected) & spaces");
	const fallback = join(root, "default-sessions");
	const sessionFile = join(custom, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	mkdirSync(custom);
	mkdirSync(fallback);
	for (const [directory, checkpoint] of [
		[custom, "retained-checkpoint"],
		[fallback, "wrong-default-checkpoint"],
	]) {
		writeFileSync(
			join(directory, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
			[
				JSON.stringify({ type: "session", id: sessionId }),
				JSON.stringify({ type: "custom", data: { checkpoint } }),
			].join("\n"),
		);
	}
	const driver = join(root, "resume-driver.mjs");
	writeFileSync(
		driver,
		`import * as fs from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const directory = value("--session-dir") ?? process.env.DEFAULT_SESSION_DIR;
const selector = value("--resume");
const filename = selector?.endsWith(".jsonl") ? selector
	: join(directory, fs.readdirSync(directory).find(name => name.endsWith("_" + selector + ".jsonl")) ?? "");
const rows = fs.readFileSync(filename, "utf8").split("\\n").map(JSON.parse);
console.log(JSON.stringify({ id: rows[0].id, checkpoint: rows[1].data.checkpoint, profile: value("--profile") ?? null }));
`,
	);
	return { root, sessionFile, fallback, driver };
}

describe("runnable resume commands", () => {
	for (const profile of [undefined, "personal"]) {
		it.skipIf(!posixShell || process.platform === "win32")(
			`opens the retained custom-directory checkpoint${profile ? " with its profile" : ""}`,
			async () => {
				setProfile(profile);
				const { root, sessionFile, fallback, driver } = fixture();
				const executable = join(root, CF_COMMAND);
				writeFileSync(executable, `#!/usr/bin/env bun\nimport ${JSON.stringify(driver)};\n`, { mode: 0o700 });
				const child = Bun.spawn([posixShell!, "-c", resumeCommand(sessionFile, "linux")], {
					cwd: root,
					env: {
						PATH: [root, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
						DEFAULT_SESSION_DIR: fallback,
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const output = await new Response(child.stdout).text();
				expect(await child.exited).toBe(0);
				expect(JSON.parse(output)).toEqual({
					id: sessionId,
					checkpoint: "retained-checkpoint",
					profile: profile ?? null,
				});
				expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
			},
		);
	}

	it.skipIf(!powerShell)(
		"preserves literal custom directories through PowerShell without executing their contents",
		async () => {
			setProfile("personal");
			const { root, sessionFile, fallback, driver } = fixture();
			const runtime = `'${process.execPath.replace(/'/g, "''")}'`;
			const script = `'${driver.replace(/'/g, "''")}'`;
			const command = `function ${CF_COMMAND} { & ${runtime} ${script} @args }; ${resumeCommand(sessionFile, "win32")}`;
			const child = Bun.spawn([powerShell!, "-NoProfile", "-NonInteractive", "-Command", command], {
				cwd: root,
				env: { ...process.env, DEFAULT_SESSION_DIR: fallback },
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await new Response(child.stdout).text();
			expect(await child.exited).toBe(0);
			expect(JSON.parse(output)).toEqual({ id: sessionId, checkpoint: "retained-checkpoint", profile: "personal" });
			expect(await Bun.file(join(root, "injected")).exists()).toBe(false);
		},
	);
});
