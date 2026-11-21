import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerRuntimeDir } from "../../src/launch/paths";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
} from "../../src/launch/protocol";
import * as terminalOutput from "../../src/launch/terminal-output";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/** Start an in-process broker for `projectDir`, scoping its environment to the call. */
function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = daemonBrokerRuntimeDir(runtimeDir);
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

describe("daemon broker log snapshots", () => {
	it.each([false, true])(
		"matches an anchored readiness line after startup output (pty: %s)",
		async pty => {
			using tempDir = TempDir.createSync("@omp-launch-ready-lines-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const previousTitle = process.title;
			const broker = startBroker(projectDir, runtimeDir);
			try {
				const started = await client.request({
					op: "start",
					spec: {
						name: "ready-lines",
						application: process.execPath,
						args: ["-e", "process.stdout.write('booting\\nREADY\\n'); process.stdin.resume();"],
						env: {},
						cwd: projectDir,
						pty,
						ready: { log: "^READY$", timeoutMs: 1_000 },
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				if (started.op !== "start") throw new Error("unexpected start result");
				expect(started.readyTimedOut).toBeFalse();
				expect(started.daemon.state).toBe("ready");
				expect(started.daemon.readyMatch).toBe("READY");
			} finally {
				await client.request({ op: "stop", name: "ready-lines", timeoutMs: 2_000 }).catch(() => undefined);
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker;
				setProcessName(previousTitle);
			}
		},
		10_000,
	);

	it("matches an anchored wait pattern across output chunks after startup output", async () => {
		using tempDir = TempDir.createSync("@omp-launch-wait-lines-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "wait-lines",
					application: process.execPath,
					args: [
						"-e",
						`process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => process.stdout.write(chunk));
process.stdout.write("booting\\n");`,
					],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "booting", timeoutMs: 1_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();

			await client.request({ op: "send", name: "wait-lines", data: "RE" });
			const partial = await client.request({
				op: "wait",
				name: "wait-lines",
				for: "exit",
				pattern: "^RE$",
				timeoutMs: 1_000,
			});
			if (partial.op !== "wait") throw new Error("unexpected wait result");
			expect(partial.timedOut).toBeFalse();
			expect(partial.matched).toBe("RE");

			await client.request({ op: "send", name: "wait-lines", data: "ADY\n" });
			const completed = await client.request({
				op: "wait",
				name: "wait-lines",
				for: "exit",
				pattern: "^READY$",
				timeoutMs: 1_000,
			});
			if (completed.op !== "wait") throw new Error("unexpected wait result");
			expect(completed.timedOut).toBeFalse();
			expect(completed.matched).toBe("READY");
		} finally {
			await client.request({ op: "stop", name: "wait-lines", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 10_000);

	it("returns the cursor captured with the PTY bytes rendered in the response", async () => {
		using tempDir = TempDir.createSync("@omp-launch-cursor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("READY\\n");
process.stdin.on("data", () => process.stdout.write("AFTER-SNAPSHOT\\n"));
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const renderStarted = Promise.withResolvers<void>();
		const releaseRender = Promise.withResolvers<void>();
		const renderTerminalOutput = terminalOutput.renderTerminalOutput;
		vi.spyOn(terminalOutput, "renderTerminalOutput").mockImplementation(async (output, options) => {
			renderStarted.resolve();
			await releaseRender.promise;
			return renderTerminalOutput(output, options);
		});

		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "cursor",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					ready: { log: "READY", timeoutMs: 5_000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			expect(started.readyTimedOut).toBeFalse();

			const snapshotPromise = client.request({
				op: "logs",
				name: "cursor",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
				renderTerminalRows: true,
			} as DaemonOperation);
			await renderStarted.promise;
			await client.request({ op: "send", name: "cursor", data: "race\r" });
			const observed = await client.request({
				op: "wait",
				name: "cursor",
				for: "exit",
				pattern: "AFTER-SNAPSHOT",
				timeoutMs: 1_000,
			});
			if (observed.op !== "wait") throw new Error("unexpected wait result");
			expect(observed.timedOut).toBeFalse();
			releaseRender.resolve();

			const snapshot = await snapshotPromise;
			if (snapshot.op !== "logs") throw new Error("unexpected logs result");
			expect(snapshot.terminalRows?.join("\n")).not.toContain("AFTER-SNAPSHOT");

			const followed = await client.request({
				op: "logs",
				name: "cursor",
				lines: 20,
				head: false,
				follow: true,
				cursor: snapshot.cursor,
				timeoutMs: 1_000,
				renderTerminalRows: true,
			} as DaemonOperation);
			if (followed.op !== "logs") throw new Error("unexpected follow result");
			expect(followed.timedOut).toBeFalse();
			expect(followed.text).toContain("AFTER-SNAPSHOT");
		} finally {
			releaseRender.resolve();
			await client.request({ op: "stop", name: "cursor", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
			vi.restoreAllMocks();
		}
	}, 20_000);

	it("reports PTY and pipe writes without claiming application delivery", async () => {
		using tempDir = TempDir.createSync("@omp-launch-input-boundary-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "line-reader.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	for (;;) {
		const newline = input.indexOf("\\n");
		if (newline < 0) return;
		const line = input.slice(0, newline).replace(/\\r$/, "");
		input = input.slice(newline + 1);
		process.stdout.write("LINE:" + Buffer.byteLength(line) + "\\n");
	}
});
process.stdout.write("READY\\n");
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const names = ["interactive-pty", "machine-pipe"];
		try {
			for (const [name, usePty] of [
				[names[0], true],
				[names[1], false],
			] as const) {
				const started = await client.request({
					op: "start",
					spec: {
						name,
						application: process.execPath,
						args: [scriptPath],
						env: {},
						cwd: projectDir,
						pty: usePty,
						ready: { log: "READY", timeoutMs: 5_000 },
						restart: "no",
						persist: false,
						detached: false,
					},
				});
				if (started.op !== "start") throw new Error("unexpected start result");
				expect(started.readyTimedOut).toBeFalse();
			}

			const shortWrite = await client.request({ op: "send", name: names[0], data: "short\n" });
			if (shortWrite.op !== "send") throw new Error("unexpected send result");
			expect(shortWrite).toMatchObject({
				bytesWritten: 6,
				transport: "pty",
				delivery: "broker_write_only",
			});
			const shortObserved = await client.request({
				op: "wait",
				name: names[0],
				for: "exit",
				pattern: "LINE:5",
				timeoutMs: 2_000,
			});
			if (shortObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(shortObserved.timedOut).toBeFalse();

			const originalPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			try {
				const signalWrite = await client.request({ op: "send", name: names[0], signal: "SIGINT" });
				if (signalWrite.op !== "send") throw new Error("unexpected send result");
				expect(signalWrite).toMatchObject({
					bytesWritten: 1,
					transport: "pty",
					delivery: "broker_write_only",
				});
				const combinedWrite = await client.request({
					op: "send",
					name: names[0],
					data: "abc",
					signal: "SIGINT",
				});
				if (combinedWrite.op !== "send") throw new Error("unexpected send result");
				expect(combinedWrite).toMatchObject({
					bytesWritten: 4,
					transport: "pty",
					delivery: "broker_write_only",
				});
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
			}

			const largeLineBytes = 8 * 1_024;
			const largeLine = `${"x".repeat(largeLineBytes)}\n`;
			const pipeWrite = await client.request({ op: "send", name: names[1], data: largeLine });
			if (pipeWrite.op !== "send") throw new Error("unexpected send result");
			expect(pipeWrite).toMatchObject({
				bytesWritten: largeLineBytes + 1,
				transport: "pipe",
				delivery: "broker_write_only",
			});
			const pipeObserved = await client.request({
				op: "wait",
				name: names[1],
				for: "exit",
				pattern: `LINE:${largeLineBytes}`,
				timeoutMs: 2_000,
			});
			if (pipeObserved.op !== "wait") throw new Error("unexpected wait result");
			expect(pipeObserved.timedOut).toBeFalse();
		} finally {
			for (const name of names) {
				await client.request({ op: "stop", name, timeoutMs: 2_000 }).catch(() => undefined);
			}
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
	// A supervised program that probes the terminal (cursor position here) blocks
	// on the reply; nothing behind the broker's PTY answered, so it hung until its
	// own timeout. The broker now replies, and the reply bytes reach the program's
	// stdin without being echoed back into the captured log.
	it("answers terminal queries emitted by a supervised PTY", async () => {
		using tempDir = TempDir.createSync("@omp-launch-terminal-query-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "terminal-query.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", chunk => {
	input += chunk;
	const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(input);
	if (!match) return;
	process.stdout.write("CPR:" + match[1] + ":" + match[2] + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\x1b[6n");
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "terminal-query",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");

			const completed = await client.request({
				op: "wait",
				name: "terminal-query",
				for: "exit",
				timeoutMs: 2_000,
			});
			if (completed.op !== "wait") throw new Error("unexpected wait result");
			expect(completed.timedOut).toBeFalse();
			expect(completed.daemon.exitCode).toBe(0);

			const logs = await client.request({
				op: "logs",
				name: "terminal-query",
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (logs.op !== "logs") throw new Error("unexpected logs result");
			// Coordinates come from whichever terminal answered the probe. The
			// broker's headless responder reports home (1;1): it is the only
			// answer on POSIX and under current ConPTY, which forwards the probe.
			// Older inbox conhost answers from the console's real cursor
			// position before the probe reaches the broker, so Windows accepts
			// any report. Pin POSIX exactly — a regression where the responder
			// stopped answering while something else did would otherwise pass.
			expect(logs.text).toMatch(process.platform === "win32" ? /CPR:\d+:\d+/u : /CPR:1:1/u);
			expect(logs.text).not.toContain("\x1b[1;1R");
		} finally {
			await client.request({ op: "stop", name: "terminal-query", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("starts a replacement daemon under the same name with an empty log", async () => {
		using tempDir = TempDir.createSync("@omp-launch-replace-log-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const echoScript = path.join(projectDir, "echo.ts");
		await Bun.write(
			echoScript,
			`process.stdout.write("first ready\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => process.stdout.write("got: " + chunk));
`,
		);
		const secondScript = path.join(projectDir, "second.ts");
		await Bun.write(secondScript, `process.stdout.write("second ready\\n");\nprocess.stdin.resume();\n`);
		const silentScript = path.join(projectDir, "silent.ts");
		await Bun.write(silentScript, `process.stdin.resume();\n`);
		const start = (scriptPath: string, readyLog?: string) =>
			client.request({
				op: "start",
				spec: {
					name: "svc",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: readyLog ? { log: readyLog, timeoutMs: 5_000 } : undefined,
					restart: "no",
					persist: false,
					detached: false,
				},
				replace: true,
			});
		const logs = async () => {
			const result = await client.request({
				op: "logs",
				name: "svc",
				lines: 100,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			if (result.op !== "logs") throw new Error("unexpected logs result");
			return result;
		};

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const first = await start(echoScript, "first ready");
			if (first.op !== "start") throw new Error("unexpected start result");
			expect(first.readyTimedOut).toBeFalse();
			await client.request({ op: "send", name: "svc", data: "hello\n" });
			const echoed = await client.request({
				op: "wait",
				name: "svc",
				for: "exit",
				pattern: "got: hello",
				timeoutMs: 5_000,
			});
			if (echoed.op !== "wait") throw new Error("unexpected wait result");
			expect(echoed.timedOut).toBeFalse();

			const second = await start(secondScript, "second ready");
			if (second.op !== "start") throw new Error("unexpected start result");
			expect(second.readyTimedOut).toBeFalse();
			expect(second.daemon.pid).not.toBe(first.daemon.pid);
			const secondLogs = await logs();
			expect(secondLogs.text).toBe("second ready\n");
			expect(secondLogs.cursor).toBe(Buffer.byteLength("second ready\n", "utf8"));

			const third = await start(silentScript);
			if (third.op !== "start") throw new Error("unexpected start result");
			const thirdLogs = await logs();
			expect(thirdLogs.text).toBe("");
			expect(thirdLogs.cursor).toBe(0);
		} finally {
			await client.request({ op: "stop", name: "svc", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("does not replace another session's live daemon", async () => {
		using tempDir = TempDir.createSync("@omp-launch-foreign-replace-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(scriptPath, "process.stdin.resume();\n");
		const spec = {
			name: "shared-name",
			application: process.execPath,
			args: [scriptPath],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no" as const,
			persist: false,
			detached: false,
		};
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			const started = await client.request({ op: "start", spec, owner: "first-session" });
			if (started.op !== "start") throw new Error("unexpected start result");
			await expect(
				client.request({ op: "start", spec, owner: "second-session", replace: true }),
			).rejects.toBeInstanceOf(Error);
			for (const owner of ["second-session", null]) {
				await expect(
					client.request({ op: "stop", name: spec.name, timeoutMs: 2_000, owner }),
				).rejects.toBeInstanceOf(Error);
				const current = await client.request({ op: "describe", name: spec.name });
				if (current.op !== "describe") throw new Error("unexpected describe result");
				expect(current.daemon.id).toBe(started.daemon.id);
				expect(current.daemon.pid).toBe(started.daemon.pid);
				expect(current.daemon.owner).toBe("first-session");
				expect(current.daemon.state).not.toBe("exited");
			}
			const stopped = await client.request({
				op: "stop",
				name: spec.name,
				timeoutMs: 2_000,
				owner: "first-session",
			});
			if (stopped.op !== "stop") throw new Error("unexpected stop result");
			expect(stopped.daemon.state).toBe("exited");
		} finally {
			await client.request({ op: "stop", name: spec.name, timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
});
