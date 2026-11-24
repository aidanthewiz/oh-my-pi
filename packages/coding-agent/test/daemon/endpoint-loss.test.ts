import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeDaemonClient, daemonClient, isolateDaemonForSmokeTest, probeDaemon } from "../../src/daemon/client";
import { daemonEndpoint, daemonTokenPath } from "../../src/daemon/paths";
import { DAEMON_DIR_ENV } from "../../src/daemon/protocol";
import { isAlive, waitFor } from "../fixtures/daemon-harness";

describe.skipIf(process.platform === "win32")("daemon runtime directory loss", () => {
	it.each(["deleted", "replaced"] as const)(
		"retires its old endpoint after the runtime directory is %s",
		async loss => {
			const restoreDaemon = await isolateDaemonForSmokeTest();
			const root = process.env[DAEMON_DIR_ENV];
			if (!root) throw new Error("Private daemon root was not installed");
			const runtimeDir = path.join(root, "long-private-runtime-".repeat(8));
			await fs.mkdir(runtimeDir);
			process.env[DAEMON_DIR_ENV] = runtimeDir;
			const endpoint = daemonEndpoint();
			const owned = new Set<number>();
			try {
				const client = await daemonClient();
				const originalPid = client.welcome.daemon.pid;
				owned.add(originalPid);
				const originalToken = await fs.readFile(daemonTokenPath(), "utf8");
				const sentinel = path.join(runtimeDir, "replacement-owned.txt");
				if (loss === "deleted") await fs.rm(runtimeDir, { recursive: true, force: true });
				else {
					await fs.rename(runtimeDir, `${runtimeDir}.retired`);
					await fs.mkdir(runtimeDir);
					await fs.writeFile(sentinel, "replacement owner");
				}
				await waitFor(() => !isAlive(originalPid), "old runtime owner to exit", 10_000);
				if (loss === "replaced") expect(await fs.readFile(sentinel, "utf8")).toBe("replacement owner");
				const replacement = await client.request({ op: "ping" });
				owned.add(replacement.pid);
				expect(replacement.pid).not.toBe(originalPid);
				expect(await fs.readFile(daemonTokenPath(), "utf8")).not.toBe(originalToken);
			} finally {
				await closeDaemonClient();
				const current = await probeDaemon();
				if (current) {
					owned.add(current.welcome.daemon.pid);
					await current.request({ op: "shutdown" }).catch(() => undefined);
					current.close();
				}
				for (const pid of owned) {
					if (isAlive(pid)) {
						try {
							process.kill(pid, "SIGKILL");
						} catch {}
					}
				}
				await fs.rm(endpoint, { force: true }).catch(() => undefined);
				process.env[DAEMON_DIR_ENV] = root;
				await restoreDaemon();
			}
		},
		20_000,
	);
});
