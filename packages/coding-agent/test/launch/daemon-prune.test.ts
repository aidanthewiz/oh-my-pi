import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { pruneDeadDaemonRuntimeDirs } from "../../src/launch/presence";

const STALE = new Date(Date.now() - 30 * 60_000);
let deadPid = 0;

async function scope(
	root: string,
	name: string,
	init: { pid?: number | "dead"; clients?: number[]; stale?: boolean },
): Promise<string> {
	const dir = path.join(root, name);
	await fs.mkdir(path.join(dir, "clients"), { recursive: true });
	if (init.pid !== undefined) {
		const pid = init.pid === "dead" ? deadPid : init.pid;
		await Bun.write(path.join(dir, "broker.pid"), JSON.stringify({ pid, instanceId: name }));
	}
	for (const clientPid of init.clients ?? []) {
		await Bun.write(
			path.join(dir, "clients", `${clientPid}-x.json`),
			JSON.stringify({ pid: clientPid, id: `${clientPid}-x`, projectDir: dir }),
		);
	}
	if (init.stale) await fs.utimes(dir, STALE, STALE);
	return dir;
}

describe("pruneDeadDaemonRuntimeDirs", () => {
	beforeAll(async () => {
		// A definitely-dead PID: spawn a process and reap it.
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		deadPid = proc.pid;
	});

	it("removes only scopes with a dead broker, no live clients, and past the stale grace", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		await fs.mkdir(daemons, { recursive: true });

		const current = await scope(daemons, "aaaaaaaaaaaaaaaa", { pid: "dead", stale: true });
		await scope(daemons, "bbbbbbbbbbbbbbbb", { pid: "dead", stale: true });
		await scope(daemons, "cccccccccccccccc", { pid: process.pid, stale: true });
		await scope(daemons, "dddddddddddddddd", { clients: [process.pid], stale: true });
		await scope(daemons, "eeeeeeeeeeeeeeee", { pid: "dead" });
		// Machine-global daemon container must never be swept as a project scope.
		await fs.mkdir(path.join(daemons, "global", "some-service"), { recursive: true });
		await fs.utimes(path.join(daemons, "global"), STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		const remaining = new Set(await fs.readdir(daemons));
		expect(remaining.has("bbbbbbbbbbbbbbbb")).toBe(false); // pruned
		expect(remaining.has("aaaaaaaaaaaaaaaa")).toBe(true); // never prunes itself
		expect(remaining.has("cccccccccccccccc")).toBe(true); // live broker
		expect(remaining.has("dddddddddddddddd")).toBe(true); // live client presence
		expect(remaining.has("eeeeeeeeeeeeeeee")).toBe(true); // within stale grace
		expect(remaining.has("global")).toBe(true); // non-scope name skipped
	});

	it("prunes stale v3 scopes but preserves siblings with a live versioned broker", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-v3-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const currentRoot = await scope(daemons, "aaaaaaaaaaaaaaaa", { stale: true });
		const current = await scope(currentRoot, "broker-v3", { pid: process.pid });
		const dead = await scope(daemons, "bbbbbbbbbbbbbbbb", {});
		await scope(dead, "broker-v3", { pid: "dead" });
		await fs.utimes(dead, STALE, STALE);
		const live = await scope(daemons, "cccccccccccccccc", {});
		await scope(live, "broker-v3", { pid: process.pid });
		await fs.utimes(live, STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(dead)).toBe(false);
		expect(await fs.exists(live)).toBe(true);
		expect(await fs.exists(currentRoot)).toBe(true);
	});

	it("retains aged scopes with a live versioned client or an unversioned detached child", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-survivor-");
		const daemons = path.join(tempDir.path(), "run", "daemons");
		const current = path.join(await scope(daemons, "aaaaaaaaaaaaaaaa", {}), "broker-v3");
		const client = await scope(daemons, "bbbbbbbbbbbbbbbb", {});
		await scope(client, "broker-v3", { clients: [process.pid] });
		await fs.utimes(client, STALE, STALE);
		const detached = await scope(daemons, "cccccccccccccccc", {});
		const name = "legacy-survivor";
		await Bun.write(
			path.join(detached, "daemons", name, "meta.json"),
			JSON.stringify({
				daemon: {
					name,
					id: name,
					state: "running",
					pid: process.pid,
					createdAt: 1,
					startedAt: 1,
					restartCount: 0,
					outputBytes: 0,
					persist: true,
					detached: true,
				},
				spec: {
					name,
					application: process.execPath,
					args: [],
					env: {},
					cwd: tempDir.path(),
					pty: false,
					restart: "no",
					persist: true,
					detached: true,
				},
			}),
		);
		await fs.utimes(detached, STALE, STALE);

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(client)).toBe(true);
		expect(await fs.exists(detached)).toBe(true);
	});

	it("does not sweep sibling machine-global service runtimes", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-global-");
		const globalRoot = path.join(tempDir.path(), "run", "daemons", "global");
		const current = await scope(globalRoot, "current-service", { pid: "dead", stale: true });
		const sibling = await scope(globalRoot, "persistent-service", { pid: "dead", stale: true });

		await pruneDeadDaemonRuntimeDirs(current);

		expect(await fs.exists(sibling)).toBe(true);
	});

	it("never sweeps outside the daemons container when a runtime dir is relocated (issue #8721)", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-tmpdir-");
		// Simulate the smoke test relocating its runtime dir directly under a
		// shared temp root full of unrelated, aged directories.
		const fakeTmp = tempDir.path();
		for (const name of ["tmux-1000", "ssh-XVn1oP", "my-build-tree"]) {
			await fs.mkdir(path.join(fakeTmp, name, "src"), { recursive: true });
			await fs.utimes(path.join(fakeTmp, name), STALE, STALE);
		}
		const runtimeDir = path.join(fakeTmp, "omp-daemon-smoke-run-xxxx");
		await fs.mkdir(runtimeDir, { recursive: true });

		await pruneDeadDaemonRuntimeDirs(runtimeDir);

		const remaining = new Set(await fs.readdir(fakeTmp));
		expect(remaining.has("tmux-1000")).toBe(true);
		expect(remaining.has("ssh-XVn1oP")).toBe(true);
		expect(remaining.has("my-build-tree")).toBe(true);
	});

	it("does nothing when the runtime root does not exist", async () => {
		using tempDir = TempDir.createSync("@omp-daemon-prune-missing-");
		const current = path.join(tempDir.path(), "run", "daemons", "hash0000000000000");
		await expect(pruneDeadDaemonRuntimeDirs(current)).resolves.toBeUndefined();
	});
});
