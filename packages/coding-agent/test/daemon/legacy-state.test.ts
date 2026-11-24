import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeDaemonClient, daemonClient, isolateDaemonForSmokeTest, probeDaemon } from "../../src/daemon/client";
import { DAEMON_DIR_ENV, GLOBAL_SCOPE } from "../../src/daemon/protocol";
import { readStoredUnits } from "../../src/daemon/store";
import { isAlive } from "../fixtures/daemon-harness";

test("leaves unsupported legacy records and their live owner untouched", async () => {
	const restoreDaemon = await isolateDaemonForSmokeTest();
	const root = process.env[DAEMON_DIR_ENV];
	if (!root) throw new Error("Missing private daemon root");
	const currentDir = path.join(root, "run", "daemon");
	const legacyDir = path.join(root, "run", "daemons", "0123456789abcdef", "broker-v5");
	const recordDir = path.join(legacyDir, "daemons", "legacy-service");
	await fs.mkdir(recordDir, { recursive: true });
	await fs.mkdir(currentDir, { recursive: true });
	const legacyOwner = Bun.spawn([process.execPath, "--no-env-file", "-e", "setInterval(() => {}, 1000)"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		env: {},
	});
	const files = new Map<string, string>([
		[path.join(legacyDir, "broker.pid"), JSON.stringify({ pid: legacyOwner.pid, instanceId: "legacy-owner" })],
		[path.join(legacyDir, "scope.json"), JSON.stringify({ projectDir: root })],
		[
			path.join(recordDir, "meta.json"),
			JSON.stringify({
				daemon: {
					id: "legacy-generation",
					name: "legacy-service",
					pid: legacyOwner.pid,
					state: "running",
					createdAt: 1,
					startedAt: 1,
					restartCount: 0,
					outputBytes: 0,
					persist: true,
					detached: true,
				},
			}),
		],
		[
			path.join(recordDir, "spec.json"),
			JSON.stringify({
				name: "legacy-service",
				application: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				cwd: root,
				env: {},
				pty: false,
				restart: "no",
				persist: true,
				detached: true,
			}),
		],
	]);
	let currentPid: number | undefined;
	try {
		for (const [file, content] of files) await fs.writeFile(file, content, { mode: 0o600 });
		process.env[DAEMON_DIR_ENV] = currentDir;
		const client = await daemonClient();
		currentPid = client.welcome.daemon.pid;
		expect(currentPid).not.toBe(legacyOwner.pid);
		const opened = await client.open({
			kind: "proc",
			scope: GLOBAL_SCOPE,
			key: "current-service",
			proc: { application: process.execPath, args: ["-e", "process.exit(0)"], cwd: root, env: {}, pty: false },
		});
		await client.request({ op: "wait", unit: opened.unit.id, for: "exit", timeoutMs: 5_000 });
		const online = await client.request({ op: "list" });
		expect(online.units.map(unit => unit.key)).toEqual(["current-service"]);
		expect(readStoredUnits(path.join(currentDir, "daemon.db")).map(unit => unit.key)).toEqual(["current-service"]);
		for (const [file, content] of files) expect(await fs.readFile(file, "utf8")).toBe(content);
		expect(isAlive(legacyOwner.pid)).toBe(true);
	} finally {
		await closeDaemonClient();
		const current = await probeDaemon();
		if (current) {
			await current.request({ op: "shutdown" }).catch(() => undefined);
			current.close();
		}
		if (currentPid !== undefined && isAlive(currentPid)) {
			try {
				process.kill(currentPid, "SIGKILL");
			} catch {}
		}
		if (legacyOwner.exitCode === null) legacyOwner.kill("SIGKILL");
		await legacyOwner.exited;
		process.env[DAEMON_DIR_ENV] = root;
		await restoreDaemon();
	}
}, 20_000);
