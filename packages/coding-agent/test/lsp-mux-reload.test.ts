import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { daemonClient, isolateDaemonForSmokeTest } from "../src/daemon/client";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as lspClient from "../src/lsp/client";
import type { ServerConfig } from "../src/lsp/types";

const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	// Bound asynchronous server retirement well below the five-minute idle grace.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isRunning(pid)) return true;
		await Bun.sleep(25);
	}
	return !isRunning(pid);
}

describe("LSP reload through the daemon module", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("stops the server of a superseded shared client instead of leaving it idle", async () => {
		const tempDir = TempDir.createSync("@omp-lsp-mux-reload-");
		const restoreDaemon = await isolateDaemonForSmokeTest();
		const shared = lspClient.holdSharedLsp(true);
		try {
			await daemonClient();

			const config: ServerConfig = {
				command: process.execPath,
				args: ["run", fixturePath],
				fileTypes: [".ts"],
				rootMarkers: [],
			};
			const client = await lspClient.getOrCreateClient(config, tempDir.path());
			const serverPid = client.proc.pid;
			if (serverPid === undefined) throw new Error("mux handshake reported no server pid");
			expect(isRunning(serverPid)).toBe(true);

			expect(await lspClient.shutdownClientInstance(client)).toBe(true);
			expect(isRunning(serverPid)).toBe(true);
			const reattached = await lspClient.getOrCreateClient(config, tempDir.path());
			expect(reattached.proc.pid).toBe(serverPid);

			const reloaded: ServerConfig = { ...config, initOptions: { reloaded: true } };
			expect(await lspClient.shutdownStaleClients(tempDir.path(), [reloaded])).toEqual([process.execPath]);
			expect(await waitForProcessExit(serverPid, 3_000)).toBe(true);
		} finally {
			shared.release();
			await lspClient.shutdownAll();
			await restoreDaemon();
			tempDir.removeSync();
		}
	}, 15_000);
});
