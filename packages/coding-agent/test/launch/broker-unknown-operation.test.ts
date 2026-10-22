import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonOperation,
} from "../../src/launch/protocol";
import { daemonBrokerEndpoint, daemonBrokerRuntimeDir } from "../../src/launch/paths";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

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

describe("broker unknown operations", () => {
	it("rejects an operation it cannot parse on the caller's request instead of stranding it until the client timeout", async () => {
		using tempDir = TempDir.createSync("@omp-launch-unknown-op-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			// After `omp update`, a newer client can reach a broker that predates one of its operations.
			// A rejection without the request id leaves the call pending until the connection closes
			// or the client's 30 s timeout fires, instead of surfacing the broker's error.
			const fromNewerClient = { op: "from-a-newer-omp" } as unknown as DaemonOperation;
			const error = await client.request(fromNewerClient).then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
			expect(error).toBeInstanceOf(DaemonBrokerRejectedError);

			// The rejection is scoped to that request; the connection keeps serving known operations.
			expect((await client.request({ op: "ping" })).op).toBe("ping");
			const brokerRuntimeDir = daemonBrokerRuntimeDir(runtimeDir);
			const token = await Bun.file(path.join(brokerRuntimeDir, "broker.token")).text();
			const socket = await IpcConnection.connect(daemonBrokerEndpoint(brokerRuntimeDir), {
				framing: "lines",
				timeoutMs: 2_000,
			});
			const handshake = Promise.withResolvers<{ id: string; ok: boolean; error: string }>();
			const timer = setTimeout(() => handshake.reject(new Error("Legacy handshake timed out")), 2_000);
			let response: { id: string; ok: boolean; error: string };
			try {
				socket.start(
					line => handshake.resolve(JSON.parse(line)),
					reason => handshake.reject(new Error(reason ?? "Legacy handshake closed")),
				);
				socket.send(
					JSON.stringify({
						id: "legacy-shutdown",
						protocolVersion: 3,
						token: token.trim(),
						operation: { op: "shutdown" },
					}),
				);
				response = await handshake.promise;
			} finally {
				clearTimeout(timer);
				socket.destroy();
			}
			expect(response).toMatchObject({ id: "legacy-shutdown", ok: false });
			expect((await client.request({ op: "ping" })).op).toBe("ping");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			process.title = previousTitle;
		}
	}, 10_000);
});
