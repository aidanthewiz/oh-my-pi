import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { daemonClient, DaemonRejectedError } from "../../src/daemon/client";
import { GLOBAL_SCOPE, type ProcSpec } from "../../src/daemon/protocol";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

let harness: IsolatedDaemon;
beforeEach(async () => {
	harness = await IsolatedDaemon.create();
});
afterEach(async () => {
	vi.restoreAllMocks();
	await harness.dispose();
});

function waitingProcess(): ProcSpec {
	return {
		application: process.execPath,
		args: ["-e", "console.log('ready'); process.stdin.once('data', () => process.exit(1));"],
		env: {},
		cwd: harness.dir,
		pty: false,
		ready: { log: "ready", timeoutMs: 5_000 },
	};
}

describe("daemon generation-bound waits", () => {
	it("rejects a pattern wait instead of following an automatic replacement generation", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const opened = await client.open({
			kind: "proc",
			scope: GLOBAL_SCOPE,
			key: "restarting",
			proc: waitingProcess(),
			policy: { restart: "on-failure" },
		});
		harness.track(...opened.unit.pids);
		let settled = false;
		const pending = client.request({
			op: "wait",
			unit: opened.unit.id,
			for: "exit",
			pattern: "^never$",
			timeoutMs: 10_000,
		});
		void pending.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await client.request({ op: "ping" });
		expect(settled).toBe(false);
		await client.request({ op: "send", unit: opened.unit.id, data: "exit\n" });
		await expect(pending).rejects.toBeInstanceOf(DaemonRejectedError);
		await waitFor(async () => {
			const { unit } = await client.request({ op: "describe", unit: opened.unit.id });
			return unit.restartCount > 0;
		}, "replacement generation");
	}, 20_000);

	it("settles an unmatched pattern when its original process exits", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const opened = await client.open({ kind: "proc", scope: GLOBAL_SCOPE, key: "once", proc: waitingProcess() });
		harness.track(...opened.unit.pids);
		const pending = client.request({
			op: "wait",
			unit: opened.unit.id,
			for: "exit",
			pattern: "^never$",
			timeoutMs: 10_000,
		});
		await client.request({ op: "send", unit: opened.unit.id, data: "exit\n" });
		const result = await pending;
		expect(result.matched).toBe(false);
		expect(result.unit).toMatchObject({ generation: opened.unit.generation, state: "failed", exitCode: 1 });
	}, 20_000);

	it("removes the server-side wait when its client aborts", async () => {
		const client = await daemonClient();
		harness.track(client.welcome.daemon.pid);
		const opened = await client.open({ kind: "proc", scope: GLOBAL_SCOPE, key: "quiet", proc: waitingProcess() });
		harness.track(...opened.unit.pids);
		const ids: string[] = [];
		const randomUUID = crypto.randomUUID.bind(crypto);
		vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
			const id = randomUUID();
			ids.push(id);
			return id;
		});
		const controller = new AbortController();
		const pending = client.request(
			{
				op: "wait",
				unit: opened.unit.id,
				for: "exit",
				pattern: "^never$",
				timeoutMs: 60_000,
			},
			controller.signal,
		);
		void pending.catch(() => {});
		await client.request({ op: "ping" });
		const requestId = ids[0];
		if (!requestId) throw new Error("Wait request had no correlation id");
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(Error);
		await client.request({ op: "ping" });
		expect(await client.request({ op: "cancel", requestId })).toEqual({ cancelled: false });
	}, 20_000);
});
