import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isolateDaemonForSmokeTest } from "../../src/daemon/client";
import { DAEMON_DIR_ENV, GLOBAL_SCOPE, type DaemonOp, type ProcSpec } from "../../src/daemon/protocol";
import { DaemonStore } from "../../src/daemon/store";
import { UnitTable, type UnitConnection } from "../../src/daemon/units";
import * as terminalOutput from "../../src/launch/terminal-output";

let root: string;
let restoreDaemon: (() => Promise<void>) | undefined;
let store: DaemonStore;
let units: UnitTable;
const connection: UnitConnection = {
	client: { connectionId: "output-parity", pid: process.pid, build: "test" },
	closed: false,
	send() {},
};

beforeEach(async () => {
	restoreDaemon = await isolateDaemonForSmokeTest();
	const dir = process.env[DAEMON_DIR_ENV];
	if (!dir) throw new Error("Missing private runtime directory");
	root = dir;
	store = DaemonStore.open(path.join(root, "daemon.db"));
	units = new UnitTable({ store, modules: [], resumed: false, onLivenessChange() {} });
	await units.start();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await units.shutdown();
	store.close();
	await restoreDaemon?.();
});

function proc(script: string, pty = false, ready?: string): ProcSpec {
	return {
		application: process.execPath,
		args: ["-e", script],
		env: {},
		cwd: root,
		pty,
		...(ready ? { ready: { log: ready, timeoutMs: 5_000 } } : {}),
	};
}

function open(key: string, script: string, pty = false, ready?: string, replace = false) {
	return units.open(connection, { kind: "proc", scope: GLOBAL_SCOPE, key, proc: proc(script, pty, ready), replace });
}

function logs(key: string, options: Partial<Extract<DaemonOp, { op: "logs" }>> = {}) {
	return units.logs({ op: "logs", unit: key, lines: 100, head: false, follow: false, timeoutMs: 1_000, ...options });
}

describe("native process output parity", () => {
	it.each([false, true])(
		"matches anchored readiness after startup output (pty: %s)",
		async pty => {
			const result = await open(
				"ready-lines",
				"process.stdout.write('booting\\nREADY\\n'); process.stdin.resume();",
				pty,
				"^READY$",
			);
			expect(result.unit).toMatchObject({ state: "ready", readyMatch: "READY" });
		},
		15_000,
	);

	it("matches an anchored wait across separate output writes", async () => {
		await open(
			"wait-lines",
			"process.stdin.setEncoding('utf8'); process.stdin.on('data', data => process.stdout.write(data)); console.log('booting');",
			false,
			"booting",
		);
		await units.send({ op: "send", unit: "wait-lines", data: "RE" });
		const partial = await units.wait({
			op: "wait",
			unit: "wait-lines",
			for: "exit",
			pattern: "^RE$",
			timeoutMs: 5_000,
		});
		expect(partial).toMatchObject({ matched: true, match: "RE" });
		await units.send({ op: "send", unit: "wait-lines", data: "ADY\n" });
		const completed = await units.wait({
			op: "wait",
			unit: "wait-lines",
			for: "exit",
			pattern: "^READY$",
			timeoutMs: 5_000,
		});
		expect(completed).toMatchObject({ matched: true, match: "READY" });
	}, 15_000);

	it("keeps the log cursor bound to bytes captured before asynchronous PTY rendering", async () => {
		await open(
			"cursor",
			"process.stdin.setEncoding('utf8'); process.stdin.on('data', () => console.log('AFTER-SNAPSHOT')); console.log('READY');",
			true,
			"READY",
		);
		const rendering = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const render = terminalOutput.renderTerminalOutput;
		vi.spyOn(terminalOutput, "renderTerminalOutput").mockImplementation(async (output, options) => {
			rendering.resolve();
			await release.promise;
			return render(output, options);
		});
		const pending = logs("cursor");
		try {
			await rendering.promise;
			await units.send({ op: "send", unit: "cursor", data: "race\r" });
			const observed = await units.wait({
				op: "wait",
				unit: "cursor",
				for: "exit",
				pattern: "AFTER-SNAPSHOT",
				timeoutMs: 5_000,
			});
			expect(observed.matched).toBe(true);
			release.resolve();
			const snapshot = await pending;
			expect(snapshot.terminalOutput).not.toContain("AFTER-SNAPSHOT");
			const followed = await logs("cursor", { follow: true, cursor: snapshot.cursor });
			expect(followed.text).toContain("AFTER-SNAPSHOT");
		} finally {
			release.resolve();
			await pending.catch(() => undefined);
		}
	}, 20_000);

	it("accepts PTY and pipe input without waiting for the application to consume it", async () => {
		const gate = path.join(root, "read-input.gate");
		const script = `
const fs = require('node:fs');
process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let input = '';
process.stdin.on('data', data => { input += data; });
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(gate)})) return;
  for (;;) {
    const newline = input.indexOf('\\n');
    if (newline < 0) return;
    const line = input.slice(0, newline).replace(/\\r$/, '');
    input = input.slice(newline + 1);
    console.log('LINE:' + Buffer.byteLength(line));
  }
}, 5);
console.log('READY');
`;
		await open("interactive", script, true, "READY");
		await open("machine", script, false, "READY");
		await units.send({ op: "send", unit: "interactive", data: "short\n" });
		await units.send({ op: "send", unit: "machine", data: `${"x".repeat(8_192)}\n` });
		expect((await logs("interactive")).text).not.toContain("LINE:");
		expect((await logs("machine")).text).not.toContain("LINE:");
		await fs.writeFile(gate, "consume");
		expect(
			(await units.wait({ op: "wait", unit: "interactive", for: "exit", pattern: "LINE:5", timeoutMs: 5_000 }))
				.matched,
		).toBe(true);
		expect(
			(await units.wait({ op: "wait", unit: "machine", for: "exit", pattern: "LINE:8192", timeoutMs: 5_000 }))
				.matched,
		).toBe(true);
	}, 20_000);

	it("answers a supervised program's terminal query without echoing the answer into its log", async () => {
		await open(
			"terminal-query",
			`
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let input = '';
process.stdin.on('data', chunk => {
  input += chunk;
  const match = /\\x1b\\[(\\d+);(\\d+)R/.exec(input);
  if (!match) return;
  console.log('CPR:' + match[1] + ':' + match[2]);
  process.exit(0);
});
process.stdout.write('READY\\x1b[6n');
`,
			true,
		);
		const completed = await units.wait({ op: "wait", unit: "terminal-query", for: "exit", timeoutMs: 5_000 });
		expect(completed).toMatchObject({ matched: true, unit: { exitCode: 0 } });
		const output = await logs("terminal-query");
		expect(output.text).toMatch(process.platform === "win32" ? /CPR:\d+:\d+/u : /CPR:1:1/u);
		expect(output.text).not.toContain("\x1b[1;1R");
	}, 20_000);

	it("starts a replacement with a fresh output log and cursor", async () => {
		const first = await open(
			"replace",
			"console.log('first ready'); process.stdin.setEncoding('utf8'); process.stdin.on('data', data => console.log('got: ' + data));",
			false,
			"first ready",
		);
		await units.send({ op: "send", unit: first.unit.id, data: "hello\n" });
		expect(
			(await units.wait({ op: "wait", unit: first.unit.id, for: "exit", pattern: "got: hello", timeoutMs: 5_000 }))
				.matched,
		).toBe(true);
		const second = await open(
			"replace",
			"console.log('second ready'); process.stdin.resume();",
			false,
			"second ready",
			true,
		);
		expect(second.unit.pids[0]).not.toBe(first.unit.pids[0]);
		const output = await logs("replace");
		expect(output.text).toBe("second ready\n");
		expect(output.cursor).toBe(Buffer.byteLength(output.text));
		await open("replace", "process.stdin.resume();", false, undefined, true);
		expect(await logs("replace")).toMatchObject({ text: "", cursor: 0 });
	}, 20_000);

	it("lists live units first and retains the ten most recent terminal units", async () => {
		await open("active", "process.stdin.resume();");
		for (let index = 0; index < 12; index++) {
			const key = `ended-${index}`;
			await open(key, "process.exit(0);");
			await units.wait({ op: "wait", unit: key, for: "exit", timeoutMs: 5_000 });
		}
		const listed = units.list({ op: "list", scope: GLOBAL_SCOPE, kind: "proc" }).units;
		expect(listed[0]?.key).toBe("active");
		const history = listed.slice(1);
		expect(new Set(history.map(unit => unit.key))).toEqual(
			new Set(Array.from({ length: 10 }, (_, index) => `ended-${index + 2}`)),
		);
		const exits = history.map(unit => unit.exitedAt);
		expect(exits).toEqual([...exits].sort((left, right) => (right ?? 0) - (left ?? 0)));
	}, 20_000);
});
