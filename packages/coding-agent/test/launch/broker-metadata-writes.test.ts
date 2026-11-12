import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { FileLock, IpcServer } from "@oh-my-pi/pi-natives";
import * as path from "node:path";
import type { PsScope } from "@oh-my-pi/pi-tui/apps/ps-data";
import { TempDir } from "@oh-my-pi/pi-utils";
import { collectScope } from "../../src/cli/ps-data";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";
import { daemonBrokerEndpoint, daemonBrokerRuntimeDir } from "../../src/launch/paths";

function startBroker(projectDir: string, runtimeDir: string): { listening: Promise<boolean>; finished: Promise<void> } {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = daemonBrokerRuntimeDir(runtimeDir);
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const listening = Promise.withResolvers<boolean>();
	const finished = startDaemonBrokerFromEnvironment({ onListening: () => listening.resolve(true) });
	if (previousProjectDir === undefined) delete process.env[DAEMON_PROJECT_DIR_ENV];
	else process.env[DAEMON_PROJECT_DIR_ENV] = previousProjectDir;
	if (previousRuntimeDir === undefined) delete process.env[DAEMON_RUNTIME_DIR_ENV];
	else process.env[DAEMON_RUNTIME_DIR_ENV] = previousRuntimeDir;
	if (previousGrace === undefined) delete process.env[DAEMON_IDLE_GRACE_ENV];
	else process.env[DAEMON_IDLE_GRACE_ENV] = previousGrace;
	return { listening: listening.promise, finished };
}

describe("daemon metadata writes", () => {
	it("does not rewrite settled history on subscriber changes or broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-broker-metadata-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const metadataPath = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", "historical", "meta.json");
		await fs.mkdir(projectDir);
		await Bun.write(
			metadataPath,
			JSON.stringify({
				daemon: {
					name: "historical",
					id: "historical",
					state: "exited",
					owner: "shared-session",
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
				spec: {
					name: "historical",
					application: process.execPath,
					args: [],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			}),
		);
		const initialClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const initialBroker = startBroker(projectDir, runtimeDir);
		try {
			await initialBroker.listening;
			await initialClient.request({ op: "ping" });
		} finally {
			await initialClient.request({ op: "shutdown" }).catch(() => undefined);
			initialClient.close();
			await initialBroker.finished;
		}
		// The initial recovery migrates the legacy layout (spec embedded in
		// meta.json) to spec.json + small metadata. Shutdown flushes all queued
		// metadata writes before establishing the stable inode baseline.
		const specPath = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", "historical", "spec.json");
		expect(await Bun.file(metadataPath).json()).not.toHaveProperty("spec");
		expect(await Bun.file(specPath).json()).toMatchObject({ cwd: projectDir });
		const inode = (await fs.stat(metadataPath)).ino;
		const specInode = (await fs.stat(specPath)).ino;
		const first = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const second = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			first.onCompletion("shared-session", () => undefined);
			second.onCompletion("shared-session", () => undefined);
			for (let index = 0; index < 3; index++) {
				await first.request({ op: "ping" });
				await second.request({ op: "ping" });
			}
			await first.request({ op: "shutdown" });
			first.close();
			second.close();
			await broker.finished;
		} finally {
			await first.request({ op: "shutdown" }).catch(() => undefined);
			first.close();
			second.close();
			await broker.finished;
		}
		expect((await fs.stat(metadataPath)).ino).toBe(inode);
		expect((await fs.stat(specPath)).ino).toBe(specInode);

		const restartClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const restarted = startBroker(projectDir, runtimeDir);
		try {
			await restarted.listening;
			await restartClient.request({ op: "ping" });
			await restartClient.request({ op: "shutdown" });
			await restarted.finished;
			expect((await fs.stat(metadataPath)).ino).toBe(inode);
		} finally {
			restartClient.close();
			await restarted.finished;
		}

		const relaunchClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const relaunchBroker = startBroker(projectDir, runtimeDir);
		try {
			await relaunchBroker.listening;
			relaunchClient.onCompletion("shared-session", () => undefined);
			await relaunchClient.request({ op: "restart", name: "historical" });
			const metadata = (await Bun.file(metadataPath).json()) as { completionEvents: boolean };
			expect(metadata.completionEvents).toBe(true);
		} finally {
			await relaunchClient.request({ op: "shutdown" }).catch(() => undefined);
			relaunchClient.close();
			await relaunchBroker.finished;
		}
	}, 20_000);

	it("writes the launch spec once and keeps lifecycle metadata free of it", async () => {
		using tempDir = TempDir.createSync("@omp-broker-spec-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const daemonDir = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", "lifecycle");
		const specPath = path.join(daemonDir, "spec.json");
		const metadataPath = path.join(daemonDir, "meta.json");
		await fs.mkdir(projectDir);
		const marker = "SPEC_ONLY_MARKER_".repeat(64);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		let specStat: { ino: number; mtimeMs: number } | undefined;
		try {
			await broker.listening;
			const started = await client.request({
				op: "start",
				spec: {
					name: "lifecycle",
					application: process.execPath,
					args: ["-e", "setTimeout(() => {}, 200)"],
					env: { OMP_SPEC_TEST_MARKER: marker, ANTHROPIC_API_KEY: "SYNTHETIC_MANAGED_CREDENTIAL" },
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			specStat = await fs.stat(specPath);
			// starting -> running (pid) -> exited: each transition persists metadata only.
			const waited = await client.request({ op: "wait", name: "lifecycle", for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.daemon.state).toBe("exited");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
		}
		const after = await fs.stat(specPath);
		expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: specStat!.ino, mtimeMs: specStat!.mtimeMs });
		expect(await Bun.file(specPath).json()).toMatchObject({ env: { OMP_SPEC_TEST_MARKER: marker } });
		expect(await Bun.file(specPath).text()).not.toContain("SYNTHETIC_MANAGED_CREDENTIAL");
		expect(await Bun.file(specPath).json()).not.toHaveProperty("env.ANTHROPIC_API_KEY");
		const metadata = await Bun.file(metadataPath).text();
		expect(metadata).not.toContain("SPEC_ONLY_MARKER_");
		expect(metadata).not.toContain("SYNTHETIC_MANAGED_CREDENTIAL");
		expect(JSON.parse(metadata)).toMatchObject({ daemon: { state: "exited" } });
	}, 20_000);

	it("persists a terminal state after a transient metadata rename denial", async () => {
		using tempDir = TempDir.createSync("@omp-broker-rename-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const metadataPath = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", "rename", "meta.json");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		const rename = fs.rename;
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		let denials = 0;
		const deniedPublication = Promise.withResolvers<void>();
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (
				denials < 2 &&
				target === metadataPath &&
				(await fs.readFile(source, "utf8")).includes('"state":"exited"')
			) {
				// Simulate Windows replacement semantics for this broker's final write.
				Object.defineProperty(process, "platform", { value: "win32" });
				const code = denials++ === 0 ? "EEXIST" : "EPERM";
				deniedPublication.resolve();
				throw Object.assign(new Error("rename denied by reader"), { code });
			}
			return rename(source, target);
		});
		try {
			await broker.listening;
			await client.request({
				op: "start",
				spec: {
					name: "rename",
					application: process.execPath,
					args: ["-e", "process.exit(0)"],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			await deniedPublication.promise;
			const waited = await client.request({ op: "wait", name: "rename", for: "exit", timeoutMs: 10_000 });
			if (waited.op !== "wait") throw new Error("unexpected wait result");
			expect(waited.daemon.state).toBe("exited");
		} finally {
			try {
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				await broker.finished;
			} finally {
				if (platform) Object.defineProperty(process, "platform", platform);
				renameSpy.mockRestore();
			}
		}
		expect(await Bun.file(metadataPath).json()).toMatchObject({ daemon: { state: "exited" } });
	}, 20_000);

	it("lists split-layout and legacy records in `omp ps` offline and while the broker is live", async () => {
		using tempDir = TempDir.createSync("@omp-broker-ps-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const writeRecord = async (name: string, layout: "split" | "legacy") => {
			const daemon = {
				name,
				id: name,
				state: "exited",
				owner: "ps-session",
				createdAt: 1,
				startedAt: 1,
				exitedAt: 2,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
			};
			const spec = {
				name,
				application: process.execPath,
				args: ["-e", name],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			};
			const dir = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", name);
			if (layout === "legacy") {
				await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon, spec }));
				return;
			}
			await Bun.write(path.join(dir, "spec.json"), JSON.stringify(spec));
			await Bun.write(path.join(dir, "meta.json"), JSON.stringify({ daemon }));
		};
		await writeRecord("split", "split");
		await writeRecord("legacy", "legacy");
		const rows = async (brokerPid: number | undefined) => {
			const scope: PsScope = {
				kind: "project",
				runtimeDir: daemonBrokerRuntimeDir(runtimeDir),
				projectDir,
				brokerPid,
			};
			const report = await collectScope(scope);
			return report.daemons
				.map(row => ({ name: row.snapshot.name, command: row.command, cwd: row.cwd, supervised: row.supervised }))
				.sort((a, b) => a.name.localeCompare(b.name));
		};
		const expected = (supervised: boolean) =>
			["legacy", "split"].map(name => ({
				name,
				command: `${process.execPath} -e ${name}`,
				cwd: projectDir,
				supervised,
			}));

		expect(await rows(undefined)).toEqual(expected(false));

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			await client.request({ op: "ping" });
			// The in-process broker serves the scope; recovery migrated "legacy" to the split layout.
			expect(await rows(process.pid)).toEqual(expected(true));
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
		}
		const legacyDir = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", "legacy");
		expect(await Bun.file(path.join(legacyDir, "meta.json")).json()).not.toHaveProperty("spec");
		expect(await Bun.file(path.join(legacyDir, "spec.json")).json()).toMatchObject({ cwd: projectDir });
		expect(await rows(undefined)).toEqual(expected(false));
	}, 20_000);
	it.each([
		{ olderScope: "", detached: true },
		{ olderScope: "broker-v3", detached: true },
		{ olderScope: "broker-v3", detached: false },
		{ olderScope: "broker-v4", detached: true },
		{ olderScope: "broker-v4", detached: false },
	])(
		"preserves a live older daemon during upgrade ($olderScope/$detached)",
		async ({ olderScope, detached }) => {
			using tempDir = TempDir.createSync("@omp-broker-upgrade-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const spec = {
				name: "survivor",
				application: process.execPath,
				args: ["-e", "setInterval(() => {}, 1000)"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no" as const,
				persist: true,
				detached,
			};
			const legacyDir = path.join(runtimeDir, olderScope, "daemons", spec.name);
			const versionedDir = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons", spec.name);
			const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			await Bun.write(
				path.join(legacyDir, "meta.json"),
				JSON.stringify({
					daemon: {
						name: spec.name,
						id: crypto.randomUUID(),
						state: "running",
						pid: child.pid,
						createdAt: Date.now(),
						startedAt: Date.now(),
						restartCount: 0,
						outputBytes: 0,
						persist: true,
						detached,
					},
					spec,
				}),
			);
			await Bun.write(path.join(legacyDir, "output.log"), "legacy output\n");
			const beforeMetadata = await Bun.file(path.join(legacyDir, "meta.json")).text();
			const broker = startBroker(projectDir, runtimeDir);
			try {
				if (!detached) {
					await expect(broker.finished).rejects.toThrow(/live non-detached daemon/u);
					expect(await Bun.file(path.join(legacyDir, "meta.json")).text()).toBe(beforeMetadata);
					expect(await Bun.file(path.join(legacyDir, "output.log")).text()).toBe("legacy output\n");
					expect(await fs.exists(versionedDir)).toBe(false);
					expect(child.exitCode).toBeNull();
					return;
				}
				await broker.listening;
				const described = await client.request({ op: "describe", name: spec.name });
				if (described.op !== "describe") throw new Error(`Unexpected response ${described.op}`);
				expect(described.daemon.pid).toBe(child.pid);
				expect(described.daemon.state).toBe("running");
				expect(await fs.exists(legacyDir)).toBe(false);
				expect(await fs.exists(versionedDir)).toBe(true);
				const logs = await client.request({
					op: "logs",
					name: spec.name,
					lines: 10,
					head: false,
					follow: false,
					timeoutMs: 1_000,
				});
				if (logs.op !== "logs") throw new Error(`Unexpected response ${logs.op}`);
				expect(logs.text).toContain("legacy output");
				await expect(client.request({ op: "start", spec })).rejects.toThrow(/already running/);
				const stopped = await client.request({ op: "stop", name: spec.name, timeoutMs: 2_000 });
				if (stopped.op !== "stop") throw new Error(`Unexpected response ${stopped.op}`);
				expect(stopped.daemon.state).toBe("exited");
			} finally {
				if (detached) await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
				if (detached) await broker.finished;
				else await broker.finished.catch(() => undefined);
				child.kill();
				await child.exited;
			}
		},
		20_000,
	);
	it.each(["", "broker-v3", "broker-v4"])(
		"refuses an upgrade while an older broker owns scope '%s'",
		async olderScope => {
			using tempDir = TempDir.createSync("@omp-broker-upgrade-lease-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			const olderRuntimeDir = path.join(runtimeDir, olderScope);
			await fs.mkdir(olderRuntimeDir, { recursive: true });
			const untouchedRecord = path.join(runtimeDir, "daemons", "unversioned-record", "meta.json");
			const untouchedContent = '{"mustRemainUnchanged":true}';
			await Bun.write(untouchedRecord, untouchedContent);
			const lock = FileLock.tryAcquire(path.join(olderRuntimeDir, "broker.pid"));
			if (!lock.acquired) throw new Error("Expected isolated legacy broker lease");
			try {
				const broker = startBroker(projectDir, runtimeDir);
				await expect(broker.finished).rejects.toThrow(/older daemon broker still owns/);
				expect(await fs.exists(path.join(daemonBrokerRuntimeDir(runtimeDir), "broker.pid"))).toBe(false);
				expect(await Bun.file(untouchedRecord).text()).toBe(untouchedContent);
			} finally {
				lock.release();
			}
		},
	);

	it.each(["", "broker-v3", "broker-v4"])(
		"waits for an older client in scope '%s' after its broker exits",
		async olderScope => {
			using tempDir = TempDir.createSync("@omp-broker-upgrade-client-");
			const projectDir = path.join(tempDir.path(), "project");
			const runtimeDir = path.join(tempDir.path(), "runtime");
			await fs.mkdir(projectDir);
			await Bun.write(
				path.join(runtimeDir, olderScope, "clients", `${process.pid}-old.json`),
				JSON.stringify({ pid: process.pid, id: `${process.pid}-old`, projectDir }),
			);
			const broker = startBroker(projectDir, runtimeDir);
			await expect(broker.finished).rejects.toThrow(/older daemon client still owns/);
			expect(await fs.exists(path.join(daemonBrokerRuntimeDir(runtimeDir), "broker.pid"))).toBe(false);
		},
	);

	it("resumes an interrupted v4 migration without replacing records already adopted by v5", async () => {
		using tempDir = TempDir.createSync("@omp-broker-v4-interrupted-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const legacy = path.join(runtimeDir, "broker-v4", "daemons");
		const current = path.join(daemonBrokerRuntimeDir(runtimeDir), "daemons");
		for (const name of ["adopted", "pending"]) {
			await Bun.write(
				path.join(legacy, name, "meta.json"),
				JSON.stringify({
					daemon: {
						name,
						id: `${name}-generation`,
						state: "exited",
						exitCode: 0,
						createdAt: 1,
						startedAt: 1,
						restartCount: 0,
						outputBytes: 0,
						persist: true,
						detached: false,
					},
					spec: {
						name,
						application: process.execPath,
						args: ["-e", "process.exit(0)"],
						env: {},
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: true,
						detached: false,
					},
				}),
			);
			await Bun.write(path.join(legacy, name, "output.log"), `${name} history\n`);
		}
		await fs.mkdir(current, { recursive: true });
		await fs.rename(path.join(legacy, "adopted"), path.join(current, "adopted"));
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		try {
			await broker.listening;
			const list = await client.request({ op: "list" });
			if (list.op !== "list") throw new Error("unexpected list result");
			expect(list.daemons.map(daemon => daemon.id).sort()).toEqual(["adopted-generation", "pending-generation"]);
			for (const name of ["adopted", "pending"]) {
				expect(await Bun.file(path.join(current, name, "output.log")).text()).toBe(`${name} history\n`);
				expect(await fs.exists(path.join(legacy, name))).toBe(false);
			}
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker.finished;
			process.title = previousTitle;
		}
	}, 20_000);

	it("refuses a live older broker that predates the native lease", async () => {
		using tempDir = TempDir.createSync("@omp-broker-upgrade-socket-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		await fs.mkdir(runtimeDir);
		const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		await Bun.write(path.join(runtimeDir, "broker.pid"), JSON.stringify({ pid: child.pid }));
		const server = await IpcServer.listen(daemonBrokerEndpoint(runtimeDir), { framing: "lines" }, socket =>
			socket.destroy(),
		);
		try {
			const broker = startBroker(projectDir, runtimeDir);
			await expect(broker.finished).rejects.toThrow(/older daemon broker still owns/);
			expect(await fs.exists(path.join(daemonBrokerRuntimeDir(runtimeDir), "broker.pid"))).toBe(false);
		} finally {
			await server.close();
			child.kill();
			await child.exited;
		}
	});

	it("lists an unversioned broker's records without contacting the incompatible v3 socket", async () => {
		using tempDir = TempDir.createSync("@omp-broker-legacy-ps-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		const name = "old-service";
		const spec = {
			name,
			application: process.execPath,
			args: [],
			env: {},
			cwd: projectDir,
			pty: false,
			restart: "no",
			persist: false,
			detached: false,
		};
		await fs.mkdir(projectDir);
		await Bun.write(
			path.join(runtimeDir, "daemons", name, "meta.json"),
			JSON.stringify({
				daemon: {
					name,
					id: name,
					state: "exited",
					createdAt: 1,
					startedAt: 1,
					exitedAt: 2,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
				spec,
			}),
		);
		const scope: PsScope = { kind: "project", runtimeDir, projectDir, brokerPid: process.pid };
		const report = await collectScope(scope);
		expect(report.daemons.map(row => ({ name: row.snapshot.name, supervised: row.supervised }))).toEqual([
			{ name, supervised: false },
		]);
		expect(await fs.exists(daemonBrokerRuntimeDir(runtimeDir))).toBe(false);
	}, 10_000);
	it("discovers old project and global scopes in explicit, default and all-process listings", async () => {
		using tempDir = TempDir.createSync("@omp-broker-upgrade-ps-");
		const home = tempDir.path();
		const projectDir = path.join(home, "project");
		await fs.mkdir(projectDir);
		const daemonRoot = path.join(home, ".omp", "run", "daemons");
		const key = Bun.hash
			.wyhash(await fs.realpath(projectDir))
			.toString(16)
			.padStart(16, "0");
		const projectRuntime = path.join(daemonRoot, key);
		const globalRuntime = path.join(daemonRoot, "global", "legacy-service");
		const writeRecord = async (runtimeDir: string, name: string) => {
			await Bun.write(
				path.join(runtimeDir, "daemons", name, "meta.json"),
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
						cwd: projectDir,
						pty: false,
						restart: "no",
						persist: true,
						detached: true,
					},
				}),
			);
		};
		await writeRecord(projectRuntime, "project-worker");
		await writeRecord(globalRuntime, "global-worker");
		await Bun.write(path.join(projectRuntime, "scope.json"), JSON.stringify({ projectDir }));
		const inspect = Bun.spawnSync({
			cmd: [
				process.execPath,
				"-e",
				`const { collectReports } = await import(process.env.PS_DATA_URL);
				const project = await collectReports(false, { dir: process.env.PS_PROJECT });
				const globals = await collectReports(false, {});
				const all = await collectReports(true, {});
				console.log(JSON.stringify({
					project: project.flatMap(report => report.daemons.map(row => row.snapshot.name)),
					globals: globals.flatMap(report => report.daemons.map(row => row.snapshot.name)),
					all: all.flatMap(report => report.daemons.map(row => row.snapshot.name)),
				}));`,
			],
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				PI_CONFIG_DIR: ".omp",
				OMP_PROFILE: "",
				PI_PROFILE: "",
				PI_CODING_AGENT_DIR: "",
				XDG_STATE_HOME: "",
				PS_DATA_URL: new URL("../../src/cli/ps-data.ts", import.meta.url).href,
				PS_PROJECT: projectDir,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		if (inspect.exitCode !== 0) throw new Error(new TextDecoder().decode(inspect.stderr));
		const rows = JSON.parse(new TextDecoder().decode(inspect.stdout));
		expect(rows).toEqual({
			project: ["project-worker"],
			globals: ["global-worker"],
			all: ["project-worker", "global-worker"],
		});
	}, 10_000);
});
