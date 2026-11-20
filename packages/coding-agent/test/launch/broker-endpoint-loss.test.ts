// Integration test — real timers are required (ts-no-test-timers exception): native IPC, process
// shutdown, and replacement broker startup cannot run on fake timers.
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { daemonBrokerRuntimeDir } from "../../src/launch/paths";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string, onListening: () => void): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "1000";
	const broker = startDaemonBrokerFromEnvironment({ endpointCheckMs: 50, onListening });
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Broker lifecycle did not settle")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function cleanUpReplacement(pidPath: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const raw = await fs.readFile(pidPath, "utf8").catch(error => {
			if (isEnoent(error)) return undefined;
			throw error;
		});
		if (raw === undefined) return;
		const { pid } = JSON.parse(raw) as { pid: number };
		if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid owned broker PID");
		if (pid === process.pid) return;
		if (Date.now() >= deadline) {
			try {
				process.kill(pid, "SIGKILL");
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
			}
			throw new Error("Owned replacement broker did not exit after its client closed");
		}
		await Bun.sleep(25);
	}
}

describe.skipIf(process.platform === "win32")("daemon broker runtime dir loss", () => {
	it.each(["deleted", "replaced"] as const)(
		"hands the scope to a new broker after its runtime dir is %s",
		async loss => {
			using tempDir = TempDir.createSync("@omp-launch-endpoint-loss-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime", "long-private-root-".repeat(8));
			const brokerDir = daemonBrokerRuntimeDir(runtimeDir);
			const pidPath = path.join(brokerDir, "broker.pid");
			const tokenPath = path.join(brokerDir, "broker.token");
			const successorLease = JSON.stringify({ pid: process.pid, successor: true });
			await fs.mkdir(projectDir);

			const previousTitle = process.title;
			// Create the client (writes broker.token) before starting the broker, which reads that token.
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 1_000 });
			const originalToken = await fs.readFile(tokenPath, "utf8");
			const listening = Promise.withResolvers<void>();
			const broker = startBroker(projectDir, brokerDir, listening.resolve);
			try {
				await within(
					Promise.race([
						listening.promise,
						broker.then(() => {
							throw new Error("Broker stopped before listening");
						}),
					]),
					5_000,
				);
				const disconnected: Promise<void>[] = [];
				const start = IpcConnection.prototype.start;
				const startSpy = spyOn(IpcConnection.prototype, "start").mockImplementation(
					function (this: IpcConnection, onLine, onClose) {
						const closed = Promise.withResolvers<void>();
						disconnected.push(closed.promise);
						start.call(this, onLine, reason => {
							try {
								onClose(reason);
							} finally {
								closed.resolve();
							}
						});
					},
				);
				try {
					expect((await client.request({ op: "ping" })).op).toBe("ping");
				} finally {
					startSpy.mockRestore();
				}

				// The relocated socket survives deletion of this long private runtime path.
				if (loss === "deleted") {
					await fs.rm(runtimeDir, { recursive: true, force: true });
				} else {
					await fs.rename(runtimeDir, `${runtimeDir}.retired`);
					await fs.mkdir(brokerDir, { recursive: true });
					await fs.writeFile(pidPath, successorLease);
				}
				await within(broker, 5_000);
				// Server shutdown can finish before the peer's close callback is delivered.
				await within(Promise.all(disconnected), 5_000);
				if (loss === "replaced") {
					expect(await fs.readFile(pidPath, "utf8")).toBe(successorLease);
					await fs.rm(pidPath);
				}

				// The same client reconnects: it recreates the token, spawns a fresh broker, and is served.
				const ping = await client.request({ op: "ping" });
				if (ping.op !== "ping") throw new Error(`unexpected daemon result ${ping.op}`);
				expect(ping.projectDir).toBe(client.projectDir);
				expect(await fs.readFile(tokenPath, "utf8")).not.toBe(originalToken);
			} finally {
				client.close();
				try {
					await within(broker, 5_000);
				} finally {
					try {
						await cleanUpReplacement(pidPath);
					} finally {
						process.title = previousTitle;
					}
				}
			}
		},
		30_000,
	);
});
