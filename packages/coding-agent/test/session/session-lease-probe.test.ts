import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { FileSessionStorage, isSessionLeaseHeld } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const SESSION_STORAGE_MODULE = path.join(import.meta.dir, "../../src/session/session-storage.ts");
const CLI = path.join(import.meta.dir, "../../src/cli.ts");

function uniqueId(label: string): string {
	return `lease-probe-${label}-${process.pid}-${Bun.nanoseconds()}`;
}

/**
 * Run a script in another process with this test's environment, so it meets
 * the same private session-owner directory (exported when session-storage loads).
 */
function spawnScript(tempDir: TempDir, name: string, body: string[], args: string[]) {
	const script = tempDir.join(name);
	return Bun.write(
		script,
		[`import { FileSessionStorage } from ${JSON.stringify(SESSION_STORAGE_MODULE)};`, ...body].join("\n"),
	).then(() =>
		Bun.spawn([process.execPath, script, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: process.env,
		}),
	);
}

/** Another process that claims `sessionId` like a writing omp, reports `claimed`, and holds it until stdin closes. */
async function spawnOwner(tempDir: TempDir, sessionId: string) {
	const child = await spawnScript(
		tempDir,
		"owner.ts",
		[
			"const release = new FileSessionStorage().claimSession(process.argv[2], process.argv[3]);",
			'process.stdout.write(release ? "claimed\\n" : "refused\\n");',
			"for await (const _ of console) {}",
		],
		[sessionId, tempDir.join("owner-session.jsonl")],
	);
	const reader = child.stdout.getReader();
	const { value } = await reader.read();
	reader.releaseLock();
	expect(new TextDecoder().decode(value).trim()).toBe("claimed");
	return child;
}

/**
 * Hold the first claim until the probe acknowledges it, then race the
 * remaining claims against free-running probes.
 */
async function raceProbeAgainstClaims(tempDir: TempDir, sessionId: string, rounds: number) {
	const child = await spawnScript(
		tempDir,
		"claimer.ts",
		[
			"const [id, sessionPath, rounds] = process.argv.slice(2);",
			"const storage = new FileSessionStorage();",
			"let failures = 0;",
			"const first = storage.claimSession(id, sessionPath);",
			"if (!first) failures++;",
			"try {",
			'	process.stdout.write(first ? "claimed\\n" : "refused\\n");',
			"	const commands = console[Symbol.asyncIterator]();",
			"	const { done, value } = await commands.next();",
			'	if (done || value !== "race") throw new Error("Missing probe acknowledgment");',
			"} finally { first?.(); }",
			"for (let i = 1; i < Number(rounds); i++) {",
			"	const release = storage.claimSession(id, sessionPath);",
			"	if (release) release();",
			"	else failures++;",
			"}",
			'process.stdout.write(JSON.stringify({ failures }) + "\\n");',
		],
		[sessionId, tempDir.join("claimer-session.jsonl"), String(rounds)],
	);
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	try {
		let status = "";
		while (!status.includes("\n")) {
			const { done, value } = await reader.read();
			if (done) throw new Error(`Claimer exited before readiness: ${await new Response(child.stderr).text()}`);
			status += decoder.decode(value, { stream: true });
		}
		const newline = status.indexOf("\n");
		expect(status.slice(0, newline).trim()).toBe("claimed");
		let stdout = status.slice(newline + 1);
		let probes = 0;
		let sawHeld = 0;
		const probe = () => {
			probes++;
			const held = isSessionLeaseHeld(sessionId);
			if (held) sawHeld++;
			return held;
		};
		expect(probe()).toBe(true);
		child.stdin.write("race\n");
		child.stdin.end();
		let exited = false;
		void child.exited.then(() => {
			exited = true;
		});
		while (!exited) {
			for (let i = 0; i < 500; i++) probe();
			await scheduler.yield();
		}
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			stdout += decoder.decode(value, { stream: true });
		}
		stdout += decoder.decode();
		expect(child.exitCode, await new Response(child.stderr).text()).toBe(0);
		expect(probe()).toBe(false);
		const { failures } = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { failures: number };
		return { failures, probes, sawHeld };
	} finally {
		child.stdin.end();
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		reader.releaseLock();
	}
}

describe("session lease probe", () => {
	it("reports a lease another process holds, and frees it when that process exits", async () => {
		using tempDir = TempDir.createSync("@omp-lease-probe-");
		const sessionId = uniqueId("owner");
		expect(isSessionLeaseHeld(sessionId)).toBe(false);

		const owner = await spawnOwner(tempDir, sessionId);
		expect(isSessionLeaseHeld(sessionId)).toBe(true);

		owner.stdin.end();
		await owner.exited;
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	}, 30_000);

	it("counts a lease this process holds as held", () => {
		using tempDir = TempDir.createSync("@omp-lease-self-");
		const sessionId = uniqueId("self");
		const release = new FileSessionStorage().claimSession(sessionId, tempDir.join("self.jsonl"));
		expect(release).not.toBeNull();
		expect(isSessionLeaseHeld(sessionId)).toBe(true);
		release?.();
		expect(isSessionLeaseHeld(sessionId)).toBe(false);
	});

	it("never makes a concurrent claim fail", async () => {
		using tempDir = TempDir.createSync("@omp-lease-race-");
		const { failures, probes, sawHeld } = await raceProbeAgainstClaims(tempDir, uniqueId("claim"), 3000);
		expect(failures).toBe(0);
		expect(sawHeld).toBeGreaterThan(0);
		expect(probes).toBeGreaterThan(sawHeld);
	}, 60_000);

	it("`omp session lease --json` lists held ids and treats free and garbage ids as not held", async () => {
		using tempDir = TempDir.createSync("@omp-lease-cli-");
		const heldId = uniqueId("held");
		// Not a plain token, so claim and probe must agree on the hashed lease name.
		const hashedHeldId = `${uniqueId("hashed")} with space/../x`;
		const owner = await spawnOwner(tempDir, heldId);
		const hashedOwner = await spawnOwner(tempDir, hashedHeldId);
		try {
			const ids = [heldId, uniqueId("free"), "../../etc/passwd", "", "-dash", "x".repeat(300), hashedHeldId];
			const result = Bun.spawnSync([process.execPath, CLI, "session", "lease", "--json", "--", ...ids], {
				env: { ...process.env, PI_CODING_AGENT_DIR: tempDir.join("agent") },
			});
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toEqual({ held: [heldId, hashedHeldId], unknown: [] });
		} finally {
			for (const child of [owner, hashedOwner]) {
				child.stdin.end();
				await child.exited;
			}
		}
	}, 60_000);
});
