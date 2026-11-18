import { appendFile } from "node:fs/promises";
import * as path from "node:path";

export function createAwsSecretInputNativeGuardLauncher(neutralCwd: string): string {
	const quote = (value: string) => `'${value.replace(/'/gu, "'\\''")}'`;
	return [
		"#!/bin/sh",
		"omp_guard_cwd=$(pwd -P) || exit 126",
		`cd ${quote(neutralCwd)} || exit 126`,
		`exec ${quote(process.execPath)} --no-env-file --no-install ${quote(import.meta.filename)} --fixture-cwd "$omp_guard_cwd" "$@"`,
		"",
	].join("\n");
}

if (import.meta.main) {
	const expected = [
		"--robot",
		"test",
		"--stdin",
		"--agent",
		"omp",
		"--dialect",
		"posix",
		"--format",
		"json",
		"--omp-bridge-output",
	];
	const args = process.argv.slice(2);
	const cwd = args[1];
	const argv = args.slice(2);
	const command = await Bun.stdin.text();
	const home = process.env.HOME;
	if (
		args[0] !== "--fixture-cwd" ||
		!cwd ||
		!path.isAbsolute(cwd) ||
		!Bun.deepEquals(argv, expected) ||
		command.length > 262_144 ||
		!home ||
		!path.isAbsolute(home)
	) {
		console.log(JSON.stringify({ decision: "deny", rule_id: "fixture.argv", reason: "Invalid guard invocation" }));
		process.exit(1);
	}
	const decision = command.includes("aws-secret-input-guard-deny")
		? "deny"
		: command.includes("consumer-secret-input-guard-deny")
			? "deny"
			: command.includes("secret-input-guard-ask")
				? "ask"
				: "allow";
	const reason = "Synthetic secret-input command policy";
	await appendFile(path.join(home, "guard-public.jsonl"), `${JSON.stringify({ command, cwd, decision, reason })}\n`);
	console.log(JSON.stringify({ decision, rule_id: "fixture.aws-secret-input", reason }));
	process.exit(decision === "allow" ? 0 : 1);
}
