// Integration test — real timers are required (ts-no-test-timers exception): the
// assertion is about real child-process I/O over a real PTY, where the injected
// bytes arrive asynchronously from the platform's console host. Fake timers
// cannot drive the pty reader or the daemon's socket RPC.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { daemonClient, isolateDaemonForSmokeTest } from "../../src/daemon/client";
import { GLOBAL_SCOPE } from "../../src/daemon/protocol";

/**
 * Console-host handshake replies belong to the PTY layer, not the child.
 * In particular, a Windows cursor report must not become application input.
 */
describe("supervised PTY startup input", () => {
	it("reports only the client's byte as the program's first input", async () => {
		using tempDir = TempDir.createSync("@omp-launch-pty-stdin-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "first-read.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
	process.stdout.write("STDIN:" + JSON.stringify(chunk) + "\\n");
	process.exit(0);
});
process.stdout.write("READY\\n");
`,
		);

		const restoreDaemon = await isolateDaemonForSmokeTest();
		const client = await daemonClient();
		try {
			const started = await client.request({
				op: "open",
				kind: "proc",
				scope: GLOBAL_SCOPE,
				key: "first-read",
				proc: {
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: true,
					ready: { log: "READY", timeoutMs: 5_000 },
				},
			});
			expect(started.unit.readyAt).toBeDefined();

			await client.request({ op: "send", unit: started.unit.id, data: "q" });

			const completed = await client.request({ op: "wait", unit: started.unit.id, for: "exit", timeoutMs: 6_000 });
			expect(completed.matched).toBe(true);
			expect(completed.unit.exitCode).toBe(0);

			const logs = await client.request({
				op: "logs",
				unit: started.unit.id,
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 1_000,
			});
			expect(logs.text).toContain('STDIN:"q"');
			expect(logs.text).not.toContain('STDIN:"\\u001b');
		} finally {
			await client.request({ op: "stop", unit: "first-read", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await restoreDaemon();
		}
	}, 20_000);
});
