import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import * as daemonClients from "../../src/daemon/client";
import { canonicalProjectDir, daemonDbPath } from "../../src/daemon/paths";
import { projectScope, type DaemonCompletionEvent } from "../../src/daemon/protocol";
import { readStoredUnits } from "../../src/daemon/store";
import {
	hasLiveOwnedService,
	listServices,
	sendService,
	startService,
	stopService,
	waitForOwnedServiceCompletion,
} from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";
import { ToolAbortError } from "../../src/tools/tool-errors";
import { BashTool } from "../../src/tools/bash";

let cleanupDaemon: (() => Promise<void>) | undefined;
beforeEach(async () => {
	cleanupDaemon = await daemonClients.isolateDaemonForSmokeTest();
});
afterEach(async () => {
	vi.restoreAllMocks();
	await cleanupDaemon?.();
	cleanupDaemon = undefined;
});

async function restartDaemon(client: Awaited<ReturnType<typeof daemonClients.daemonClient>>) {
	const pid = client.welcome.daemon.pid;
	await daemonClients.closeDaemonClient();
	const processRef = Process.fromPid(pid);
	if (processRef?.status() === "running") process.kill(pid, "SIGKILL");
	return daemonClients.daemonClient();
}

describe("session-owned supervised services", () => {
	it("does not begin daemon acquisition or register callbacks for an already disposed session", async () => {
		const registerDisposeCallback = vi.fn();
		const registerSessionChangeCallback = vi.fn();
		const acquisition = vi.spyOn(daemonClients, "daemonClient");
		try {
			await expect(
				listServices({
					cwd: process.cwd(),
					hasUI: false,
					settings: Settings.isolated(),
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					isDisposed: () => true,
					registerDisposeCallback,
					registerSessionChangeCallback,
				}),
			).rejects.toBeInstanceOf(ToolAbortError);
			expect(acquisition).not.toHaveBeenCalled();
			expect(registerDisposeCallback).not.toHaveBeenCalled();
			expect(registerSessionChangeCallback).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
		}
	});

	it("does not launch a service when cancellation occurs during daemon connection", async () => {
		using tempDir = TempDir.createSync("@omp-service-connect-abort-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		const client = await daemonClients.daemonClient();
		try {
			const controller = new AbortController();
			const pending = client.request(
				{
					op: "open",
					kind: "proc",
					scope: projectScope(await canonicalProjectDir(projectDir)),
					key: "cancelled-service",
					owner: "cancelled-session",
					proc: {
						application: process.execPath,
						args: ["-e", "process.exit(3)"],
						env: {},
						cwd: projectDir,
						pty: false,
					},
					policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
				},
				controller.signal,
			);
			controller.abort();
			await expect(pending).rejects.toThrow();
			const result = await client.request({ op: "list" });
			expect(result.units.find(unit => unit.key === "cancelled-service")).toBeUndefined();
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	for (const invalidation of ["cancel", "dispose", "switch"] as const) {
		it(`does not attach an owner or send RPC when acquisition finishes after ${invalidation}`, async () => {
			using tempDir = TempDir.createSync("@omp-service-acquisition-");
			const projectDir = path.join(tempDir.path(), "project");
			await fs.mkdir(projectDir);
			const client = await daemonClients.daemonClient();
			let sessionId = "original-session";
			const disposeCallbacks = new Set<() => void>();
			const changeCallbacks = new Set<() => void>();
			const session: ToolSession = {
				cwd: projectDir,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionId: () => sessionId,
				registerDisposeCallback: callback => {
					disposeCallbacks.add(callback);
					return () => disposeCallbacks.delete(callback);
				},
				registerSessionChangeCallback: callback => {
					changeCallbacks.add(callback);
					return () => changeCallbacks.delete(callback);
				},
			};
			const acquired = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			try {
				const subscribe = vi.spyOn(client, "onCompletion");
				const rpc = vi.spyOn(client, "request");
				const acquisition = vi.spyOn(daemonClients, "daemonClient").mockImplementation(async () => {
					acquired.resolve();
					await release.promise;
					return client;
				});
				const pending = listServices(session, invalidation === "cancel" ? controller.signal : undefined);
				const rejected = pending.then(
					() => undefined,
					(error: unknown) => error,
				);
				await acquired.promise;
				expect(disposeCallbacks.size).toBe(1);
				expect(changeCallbacks.size).toBe(1);
				if (invalidation === "cancel") controller.abort();
				else if (invalidation === "dispose") {
					for (const callback of disposeCallbacks) callback();
					disposeCallbacks.clear();
				} else {
					sessionId = "other-session";
					for (const callback of changeCallbacks) callback();
					sessionId = "original-session";
					for (const callback of changeCallbacks) callback();
				}
				release.resolve();
				expect(await rejected).toBeInstanceOf(ToolAbortError);
				expect(subscribe).not.toHaveBeenCalled();
				expect(rpc).not.toHaveBeenCalled();
				expect(hasLiveOwnedService(session)).toBe(false);
				if (invalidation === "dispose") {
					await expect(listServices(session)).rejects.toBeInstanceOf(ToolAbortError);
					expect(acquisition).toHaveBeenCalledTimes(1);
					expect(disposeCallbacks.size).toBe(0);
					expect(changeCallbacks.size).toBe(0);
				} else {
					await listServices(session);
					await listServices(session);
					expect(subscribe).toHaveBeenCalledTimes(1);
					expect(disposeCallbacks.size).toBe(1);
					expect(changeCallbacks.size).toBe(1);
				}
				await listServices({
					cwd: projectDir,
					hasUI: false,
					settings: Settings.isolated(),
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					getSessionId: () => "live-session",
				});
				expect(subscribe).toHaveBeenCalledTimes(invalidation === "dispose" ? 1 : 2);
			} finally {
				release.resolve();
				vi.restoreAllMocks();
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
			}
		}, 15_000);
	}

	for (const invalidation of ["steer", "dispose", "switch"] as const) {
		it(`readiness steering preserves ${invalidation === "steer" ? "the live service" : `${invalidation} cancellation`}`, async () => {
			using tempDir = TempDir.createSync("@omp-service-ready-interrupt-");
			const projectDir = path.join(tempDir.path(), "project");
			await fs.mkdir(projectDir);
			const client = await daemonClients.daemonClient();
			let sessionId = "original-session";
			let disposed = false;
			const disposeCallbacks = new Set<() => void>();
			const changeCallbacks = new Set<() => void>();
			const session: ToolSession = {
				cwd: projectDir,
				hasUI: false,
				settings: Settings.isolated(),
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getSessionId: () => sessionId,
				isDisposed: () => disposed,
				registerDisposeCallback: callback => {
					disposeCallbacks.add(callback);
					return () => disposeCallbacks.delete(callback);
				},
				registerSessionChangeCallback: callback => {
					changeCallbacks.add(callback);
					return () => changeCallbacks.delete(callback);
				},
			};
			const waiting = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const steering = new AbortController();
			try {
				const request = client.request.bind(client);
				vi.spyOn(client, "request").mockImplementation(async (operation, signal, validate) => {
					if (operation.op === "wait" && operation.for === "ready") {
						waiting.resolve();
						await release.promise;
					}
					return request(operation, signal, validate);
				});
				const outcome = startService(
					session,
					{
						name: "pending-ready",
						command: "read answer",
						shell: { shell: "/bin/sh", args: ["-c"], env: {} },
						pty: false,
						ready: { log: "never-ready", timeout: 5 },
					},
					undefined,
					steering.signal,
				).then(
					result => ({ ok: true as const, result }),
					(error: unknown) => ({ ok: false as const, error }),
				);
				await waiting.promise;
				steering.abort();
				if (invalidation === "dispose") {
					disposed = true;
					for (const callback of disposeCallbacks) callback();
				} else if (invalidation === "switch") {
					sessionId = "other-session";
					for (const callback of changeCallbacks) callback();
					sessionId = "original-session";
					for (const callback of changeCallbacks) callback();
				}
				release.resolve();
				const settled = await outcome;
				if (invalidation === "steer") {
					if (!settled.ok) throw settled.error;
					expect(settled.result.readyInterrupted).toBe(true);
					expect(settled.result.readyTimedOut).toBe(false);
					expect(hasLiveOwnedService(session)).toBe(true);
					const services = await request({ op: "list" });
					expect(services.units.find(unit => unit.key === "pending-ready")?.state).toBe("starting");
				} else {
					if (settled.ok) throw new Error("Invalidated service start returned success");
					expect(settled.error).toBeInstanceOf(ToolAbortError);
					expect(hasLiveOwnedService(session)).toBe(false);
				}
			} finally {
				release.resolve();
				vi.restoreAllMocks();
				await client.request({ op: "shutdown" }).catch(() => undefined);
				client.close();
			}
		}, 15_000);
	}

	it("does not restore old ownership from a response that finishes after switching sessions", async () => {
		using tempDir = TempDir.createSync("@omp-service-stale-list-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		const client = await daemonClients.daemonClient();
		let sessionId = "original-session";
		const changeCallbacks = new Set<() => void>();
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				changeCallbacks.add(callback);
				return () => changeCallbacks.delete(callback);
			},
		};
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		try {
			await startService(session, {
				name: "still-running",
				command: "echo service-ready; read answer",
				shell: { shell: "/bin/sh", args: ["-c"], env: {} },
				ready: { log: "service-ready", timeout: 5 },
			});
			expect(hasLiveOwnedService(session)).toBe(true);
			const request = client.request.bind(client);
			const delayed = vi.spyOn(client, "request").mockImplementation(async (operation, signal, validate) => {
				const result = await request(operation, signal, validate);
				if (operation.op === "list") {
					received.resolve();
					await release.promise;
				}
				return result;
			});
			const pending = listServices(session);
			const rejected = pending.then(
				() => undefined,
				(error: unknown) => error,
			);
			await received.promise;
			sessionId = "other-session";
			for (const callback of changeCallbacks) callback();
			sessionId = "original-session";
			for (const callback of changeCallbacks) callback();
			expect(hasLiveOwnedService(session)).toBe(false);
			release.resolve();
			expect(await rejected).toBeInstanceOf(ToolAbortError);
			expect(hasLiveOwnedService(session)).toBe(false);
			delayed.mockRestore();
			await listServices(session);
			expect(hasLiveOwnedService(session)).toBe(true);
		} finally {
			release.resolve();
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("delivers a failed service only to its session when another session shares the daemon", async () => {
		using tempDir = TempDir.createSync("@omp-service-completion-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		const client = await daemonClients.daemonClient();
		const settings = Settings.isolated();
		const firstCompletions: DaemonCompletionEvent[] = [];
		const secondCompletions: DaemonCompletionEvent[] = [];
		const delivered = Promise.withResolvers<string>();
		const makeSession = (sessionId: string, completions: DaemonCompletionEvent[]): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			queueLaunchCompletion: notification => {
				delivered.resolve(sessionId);
				completions.push(notification);
				return Promise.resolve();
			},
		});
		const first = makeSession("first-session", firstCompletions);
		const second = makeSession("second-session", secondCompletions);
		try {
			const started = await startService(first, {
				name: "failing-service",
				command: "echo service-ready; read answer; exit 3",
				shell: { shell: "/bin/sh", args: ["-c"], env: {} },
				ready: { log: "service-ready", timeout: 5 },
			});
			expect(started.daemon.state).toBe("ready");
			await listServices(second);
			const firstFinished = waitForOwnedServiceCompletion(first);
			await sendService(first, "failing-service", "go\n");
			expect(await delivered.promise).toBe("first-session");
			await firstFinished;
			expect(firstCompletions.map(({ unit }) => [unit.key, unit.exitCode])).toEqual([["failing-service", 3]]);
			expect(secondCompletions).toEqual([]);
			expect(started.daemon.owner).toBe("first-session");
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("rejects another session's stop without affecting the owned service", async () => {
		using tempDir = TempDir.createSync("@omp-service-stop-owner-");
		const makeSession = (id: string): ToolSession => ({
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => id,
		});
		const owner = makeSession("owner");
		const foreign = makeSession("foreign");
		const client = await daemonClients.daemonClient();
		try {
			await startService(owner, {
				name: "owned",
				command: "echo ready; read answer",
				shell: { shell: "/bin/sh", args: ["-c"], env: {} },
				ready: { log: "ready", timeout: 5 },
			});
			await expect(stopService(foreign, "owned", undefined, "foreign")).rejects.toBeInstanceOf(Error);
			expect((await listServices(owner)).find(unit => unit.key === "owned")).toMatchObject({
				owner: "owner",
				state: "ready",
			});
			expect((await stopService(owner, "owned", undefined, "owner")).state).toBe("exited");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("rejects a foreign replacement without changing the live service's bootstrap", async () => {
		using tempDir = TempDir.createSync("@omp-service-replace-owner-");
		const makeSession = (id: string): ToolSession => ({
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => id,
		});
		const owner = makeSession("owner");
		const foreign = makeSession("foreign");
		const client = await daemonClients.daemonClient();
		const params = {
			name: "seeded",
			command: "printf 'seed:%s\\n' \"$OWNER_MARK\"; read answer",
			shell: { shell: "/bin/sh", args: ["-c"], env: {} },
			ready: { log: "seed:original", timeout: 5 },
		};
		try {
			const started = await startService(owner, { ...params, seed: "export OWNER_MARK=original\n" });
			await expect(
				startService(foreign, {
					...params,
					seed: "export OWNER_MARK=foreign\n",
				}),
			).rejects.toBeInstanceOf(Error);
			expect((await client.request({ op: "describe", unit: started.daemon.id })).unit).toMatchObject({
				owner: "owner",
				state: "ready",
			});
			await client.request({ op: "restart", unit: started.daemon.id });
			const ready = await client.request({ op: "wait", unit: started.daemon.id, for: "ready", timeoutMs: 5_000 });
			expect(ready.matched).toBe(true);
			const logs = await client.request({
				op: "logs",
				unit: started.daemon.id,
				lines: 20,
				head: false,
				follow: false,
				timeoutMs: 0,
			});
			expect(logs.text).toContain("seed:original");
			expect(logs.text).not.toContain("seed:foreign");
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 20_000);

	it("replays a completion to its session when that session is resumed after a switch", async () => {
		using tempDir = TempDir.createSync("@omp-service-transition-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		let client = await daemonClients.daemonClient();
		let sessionId = "old-session";
		const callbacks: Array<() => void> = [];
		const deliveries: Array<[string, DaemonCompletionEvent]> = [];
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				callbacks.push(callback);
			},
			queueLaunchCompletion: notification => {
				deliveries.push([sessionId, notification]);
				return Promise.resolve();
			},
		};
		const switchTo = (nextSessionId: string): void => {
			sessionId = nextSessionId;
			for (const callback of callbacks) callback();
		};
		try {
			const started = await startService(session, {
				name: "old-service",
				command: "echo service-ready; read answer; exit 3",
				shell: { shell: "/bin/sh", args: ["-c"], env: {} },
				ready: { log: "service-ready", timeout: 5 },
			});
			switchTo("new-session");
			await listServices(session);
			await sendService(session, "old-service", "go\n");
			const exited = await client.request({ op: "wait", unit: started.daemon.id, for: "exit", timeoutMs: 5_000 });
			expect(exited.unit.exitCode).toBe(3);
			expect(deliveries).toEqual([]);

			switchTo("old-session");
			// Resubscribing the original owner replays its undelivered completion.
			await listServices(session);
			expect(deliveries.map(([receiver, { owner, unit }]) => [receiver, owner, unit.key, unit.exitCode])).toEqual([
				["old-session", "old-session", "old-service", 3],
			]);
			expect(callbacks).toHaveLength(1);
			await client.request({ op: "ping" });
			client = await restartDaemon(client);
			await listServices(session);
			expect(deliveries).toHaveLength(1);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("replays a detached service exit only when its original session resumes after daemon restart", async () => {
		using tempDir = TempDir.createSync("@omp-service-detached-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		let client = await daemonClients.daemonClient();
		let daemonPid: number | undefined;
		const laterCompletions: DaemonCompletionEvent[] = [];
		const resumedCompletions: DaemonCompletionEvent[] = [];
		const resumedDelivery = Promise.withResolvers<DaemonCompletionEvent>();
		const disposeOriginal: Array<() => void> = [];
		const makeSession = (
			sessionId: string,
			completions: DaemonCompletionEvent[],
			onDispose?: (callback: () => void) => void,
		): ToolSession => ({
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => sessionId,
			registerDisposeCallback: onDispose,
			queueLaunchCompletion: notification => {
				completions.push(notification);
				if (completions === resumedCompletions) resumedDelivery.resolve(notification);
				return Promise.resolve();
			},
		});
		try {
			await listServices(makeSession("original-session", [], callback => disposeOriginal.push(callback)));
			const started = await client.request({
				op: "open",
				kind: "proc",
				scope: projectScope(await canonicalProjectDir(projectDir)),
				key: "detached-service",
				owner: "original-session",
				proc: {
					application: process.execPath,
					args: [
						"-e",
						"Bun.serve({port: 0, fetch() { return new Response('ok'); } }); console.log('detached-ready');",
					],
					env: {},
					cwd: projectDir,
					pty: false,
					ready: { log: "detached-ready", timeoutMs: 5_000 },
				},
				policy: { hold: "detached" },
			});
			daemonPid = started.unit.pids[0];
			if (daemonPid === undefined) throw new Error("Expected detached process");
			for (const dispose of disposeOriginal) dispose();
			await client.request({ op: "ping" });
			client = await restartDaemon(client);
			const running = await listServices(makeSession("later-session", laterCompletions));
			expect(running.find(unit => unit.key === "detached-service")?.pids[0]).toBe(daemonPid);
			const processRef = Process.fromPid(daemonPid);
			if (!processRef) throw new Error("Recovered detached daemon disappeared");
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
			const exited = await client.request({ op: "wait", unit: started.unit.id, for: "exit", timeoutMs: 5_000 });
			expect(exited.matched).toBe(true);
			expect(laterCompletions).toEqual([]);

			const resumed = makeSession("original-session", resumedCompletions);
			await listServices(resumed);
			const completion = await resumedDelivery.promise;
			expect(completion.owner).toBe("original-session");
			expect(completion.unit.key).toBe("detached-service");
			await client.request({ op: "ping" });
			client = await restartDaemon(client);
			await listServices(resumed);
			expect(resumedCompletions).toHaveLength(1);
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			if (daemonPid !== undefined) {
				const processRef = Process.fromPid(daemonPid);
				if (processRef?.status() === "running") {
					await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 2_000 });
				}
			}
		}
	}, 20_000);

	it("starts a bash `name` service with the session identity", async () => {
		using tempDir = TempDir.createSync("@omp-service-env-");
		const projectDir = path.join(tempDir.path(), "project");
		await fs.mkdir(projectDir);
		const client = await daemonClients.daemonClient();
		const sessionFile = path.join(projectDir, "svc.jsonl");
		const session: ToolSession = {
			cwd: projectDir,
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => sessionFile,
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			getSessionId: () => "session-svc",
		};
		try {
			const result = await new BashTool(session).execute("svc-env", {
				command: `echo "env=$PI_SESSION_ID|$PI_SESSION_FILE|$PI_TOOL_CALL_ID"; read answer`,
				name: "env-service",
				pty: false,
				ready: {
					log: `env=session-svc\\|${sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\|svc-env`,
					timeout: 5,
				},
			});
			expect(result.details?.service).toMatchObject({ name: "env-service", ready: true, timedOut: false });
		} finally {
			vi.restoreAllMocks();
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("reads the owning session's local URL from a real named service", async () => {
		using tempDir = TempDir.createSync("@omp-service-url-");
		await fs.mkdir(tempDir.join("local"));
		await fs.writeFile(tempDir.join("local", "payload.txt"), "owned-service-url-payload\n");
		const client = await daemonClients.daemonClient();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getArtifactsDir: () => tempDir.path(),
			getSessionSpawns: () => "*",
			getSessionId: () => "url-service-owner",
		};
		try {
			const result = await new BashTool(session).execute("service-url", {
				command: "cat local://payload.txt; read answer",
				name: "url-service",
				pty: false,
				ready: { log: "^owned-service-url-payload$", timeout: 5 },
			});
			expect(result.details?.service).toMatchObject({ ready: true, timedOut: false });
		} finally {
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);

	it("does not inherit or persist managed model credentials from the launcher or dotenv", async () => {
		using tempDir = TempDir.createSync("@omp-service-secret-env-");
		const secret = "SYNTHETIC_MANAGED_SERVICE_CREDENTIAL";
		const previous = Bun.env.ANTHROPIC_API_KEY;
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => "secret-env-owner",
		};
		const client = await daemonClients.daemonClient();
		try {
			Bun.env.ANTHROPIC_API_KEY = secret;
			await fs.writeFile(tempDir.join(".env"), `ANTHROPIC_API_KEY=${secret}\n`);
			const result = await new BashTool(session).execute("secret-env", {
				command: 'echo "secret=$ANTHROPIC_API_KEY"; read answer',
				name: "secret-env",
				pty: false,
				ready: { log: "^secret=$", timeout: 5 },
			});
			expect(result.details?.service).toMatchObject({ ready: true, timedOut: false });
			const stored = readStoredUnits(daemonDbPath()).find(unit => unit.key === "secret-env");
			expect(stored?.proc?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(JSON.stringify(stored)).not.toContain(secret);
		} finally {
			if (previous === undefined) delete Bun.env.ANTHROPIC_API_KEY;
			else Bun.env.ANTHROPIC_API_KEY = previous;
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
		}
	}, 15_000);
});
