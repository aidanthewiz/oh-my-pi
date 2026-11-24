/**
 * Regression test for issue #7058: on Windows, puppeteer-core deletes its temp
 * Chrome profile with an unretried `rm()` from an eager process-exit hook, so an
 * EBUSY on the still-locked profile surfaces as an unhandled rejection that
 * crashes OMP. OMP now owns the profile directory and removes it itself with a
 * lock-tolerant, warn-and-leave cleanup.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonRejectedError } from "@oh-my-pi/pi-coding-agent/daemon/client";
import * as daemonClient from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient, DaemonOp, OpenRequest, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import * as browserAttach from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import * as browserLaunch from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { removeUserDataDir, seedOwnedProfilePreferences } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { type BrowserHandle, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	ensureSharedBrowser,
	restartSharedBrowser,
	sharedBrowserDaemonName,
} from "@oh-my-pi/pi-coding-agent/tools/browser/shared-daemon";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import * as piUtils from "@oh-my-pi/pi-utils";

async function makeProfileDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
	await Bun.write(path.join(dir, "SingletonLock"), "lock");
	await Bun.write(path.join(dir, "Default", "Preferences"), "{}");
	return dir;
}

const BROKER_CHROME_PID = 4242;

/** Current daemon double: stable unit identity, per-open leases and generation-aware stop/restart. */
function fakeSharedBroker(
	projectDir: string,
	wsEndpoint: string,
	hooks: {
		onDescribe?: () => Promise<void>;
		onStop?: () => Promise<UnitSnapshot["state"] | undefined>;
		onStart?: () => Promise<void>;
	} = {},
): { client: DaemonClient; starts: number; restore(): void } {
	let daemon: UnitSnapshot | undefined;
	let retained: OpenRequest | undefined;
	const spies: Array<{ mockRestore(): void }> = [];
	const launch = async (request: OpenRequest): Promise<UnitSnapshot> => {
		broker.starts++;
		const now = Date.now();
		const launched: UnitSnapshot = {
			id: "fake",
			kind: request.kind,
			scope: request.scope,
			key: request.key,
			label: request.label ?? request.key,
			generation: `generation-${broker.starts}`,
			state: "ready",
			pids: [BROKER_CHROME_PID],
			createdAt: now,
			startedAt: now,
			readyAt: now,
			readyMatch: `DevTools listening on ${wsEndpoint}`,
			restartCount: 0,
			outputBytes: 0,
			leases: 1,
			policy: {
				hold: "leases",
				idleMs: 0,
				onIdle: "stop",
				restart: "no",
				survive: "exec",
				...request.policy,
			},
			supervised: true,
		};
		daemon = launched;
		await hooks.onStart?.();
		return launched;
	};
	const unknown = () => new DaemonRejectedError("Unknown unit");
	const client = {
		onCompletion: () => () => {},
		onReconnect: () => () => {},
		close() {},
		release: async () => {},
		async open(request: OpenRequest) {
			if (request.scope.kind !== "project" || request.scope.dir !== projectDir)
				throw new Error("Unexpected browser project scope");
			retained = request;
			if (daemon && daemon.state !== "exited" && daemon.state !== "failed") {
				if (request.replace) throw new DaemonRejectedError("Unit is still live");
				return { created: false, unit: daemon, lease: `lease-${crypto.randomUUID()}` };
			}
			return { created: true, unit: await launch(request), lease: `lease-${crypto.randomUUID()}` };
		},
		async request(operation: DaemonOp) {
			switch (operation.op) {
				case "describe": {
					const snapshot = daemon;
					await hooks.onDescribe?.();
					if (!snapshot) throw unknown();
					return { op: "describe", unit: snapshot };
				}
				case "list": {
					const snapshot = daemon;
					await hooks.onDescribe?.();
					return { op: "list", units: snapshot ? [snapshot] : [] };
				}
				case "stop": {
					if (!daemon) throw unknown();
					if (operation.generation !== undefined && operation.generation !== daemon.generation)
						throw new DaemonRejectedError("Stale generation");
					daemon = { ...daemon, state: (await hooks.onStop?.()) ?? "exited" };
					return { op: "stop", unit: daemon };
				}
				case "restart":
					if (!daemon || !retained) throw unknown();
					if (daemon.state !== "exited" && daemon.state !== "failed")
						throw new DaemonRejectedError("Unit is still live");
					return { op: "restart", unit: await launch(retained) };
				case "logs":
					return { op: "logs", text: "", cursor: 0 };
				default:
					throw new Error(`Unexpected daemon op ${operation.op}`);
			}
		},
	} as unknown as DaemonClient;
	const broker = {
		client,
		starts: 0,
		restore() {
			for (const spy of spies) spy.mockRestore();
		},
	};
	spies.push(
		spyOn(daemonClient, "daemonClient").mockResolvedValue(client),
		spyOn(browserLaunch, "resolveSharedBrowserLaunchSpec").mockResolvedValue({
			executablePath: "/fake/chrome",
			args: [],
		}),
		spyOn(browserAttach, "probeCdpStatus").mockResolvedValue(200),
	);
	return broker;
}

describe("headless Chromium profile cleanup (issue #7058)", () => {
	afterEach(() => {
		spyOn(piUtils, "removeWithRetries").mockRestore();
		spyOn(piUtils.logger, "warn").mockRestore();
	});

	it("removes an owned profile directory", async () => {
		const dir = await makeProfileDir();
		await removeUserDataDir(dir);
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("warns and leaves the directory instead of throwing when it stays locked (EBUSY)", async () => {
		const dir = await makeProfileDir();
		const ebusy = Object.assign(new Error(`EBUSY: resource busy or locked, rm '${dir}'`), { code: "EBUSY" });
		const removeSpy = spyOn(piUtils, "removeWithRetries").mockRejectedValue(ebusy);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			// Must resolve — a cleanup failure never propagates as a crash.
			await expect(removeUserDataDir(dir)).resolves.toBeUndefined();
			expect(removeSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
		} finally {
			removeSpy.mockRestore();
			// Real removal so the fixture does not leak.
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("kills a disconnected owned-profile browser before removing its profile", async () => {
		const dir = await makeProfileDir();
		// A real live process is required to exercise native termination, not a fake timer.
		const chromium = Bun.spawn([process.execPath, "--no-env-file", "-e", "await Bun.sleep(60_000)"]);
		let closeCalls = 0;
		const handle = {
			key: "headless:1",
			kind: { kind: "headless", headless: true },
			refCount: 1,
			userDataDir: dir,
			browser: {
				connected: false,
				process: () => ({ pid: chromium.pid }),
				close: () => {
					closeCalls++;
					return Promise.withResolvers<void>().promise;
				},
			},
			stealth: { browserSession: null, override: null },
		} as unknown as BrowserHandle;

		try {
			await releaseBrowser(handle, { kill: false });
			await chromium.exited;
			expect(closeCalls).toBe(0);
			expect(fs.existsSync(dir)).toBe(false);
		} finally {
			if (chromium.exitCode === null) chromium.kill("SIGKILL");
			await chromium.exited;
		}
	});
});

describe("owned Chromium profile preferences", () => {
	it("disables password leak detection and printing while keeping a reused profile's other preferences", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
		const file = path.join(dir, "Default", "Preferences");
		const seeded = { password_manager_leak_detection: false };
		try {
			await Bun.write(
				file,
				JSON.stringify({ intl: { accept_languages: "en-US" }, profile: { exit_type: "Normal" } }),
			);
			await seedOwnedProfilePreferences(dir);
			expect(JSON.parse(await Bun.file(file).text())).toEqual({
				intl: { accept_languages: "en-US" },
				profile: { exit_type: "Normal", ...seeded },
				printing: { enabled: false },
			});

			// A profile seeded before printing was turned off already has leak detection off.
			await Bun.write(file, JSON.stringify({ profile: seeded, printing: { print_preview_sticky_settings: "{}" } }));
			await seedOwnedProfilePreferences(dir);
			expect(JSON.parse(await Bun.file(file).text())).toEqual({
				profile: seeded,
				printing: { print_preview_sticky_settings: "{}", enabled: false },
			});

			await fs.promises.rm(path.join(dir, "Default"), { recursive: true });
			await seedOwnedProfilePreferences(dir);
			expect(JSON.parse(await Bun.file(file).text())).toEqual({ profile: seeded, printing: { enabled: false } });
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("warns instead of failing the launch and leaves no staged file when the write fails", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-chrome-profile-test-"));
		const renameSpy = spyOn(fs.promises, "rename").mockRejectedValue(
			Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }),
		);
		const warnSpy = spyOn(piUtils.logger, "warn");
		try {
			await expect(seedOwnedProfilePreferences(dir)).resolves.toBeUndefined();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(await fs.promises.readdir(path.join(dir, "Default"))).toEqual([]);
		} finally {
			renameSpy.mockRestore();
			warnSpy.mockRestore();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("lets only the client that launches the shared Chrome write its Preferences when two cold starts race", async () => {
		const seed = browserLaunch.seedOwnedProfilePreferences;
		const projectDir = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-race-")),
		);
		const name = sharedBrowserDaemonName(true);
		const prefsFile = path.join(piUtils.getDaemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Preferences");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/race";
		let chromeRunning = false;
		let launchPrefs: unknown;
		let describes = 0;
		const chromeLive = Promise.withResolvers<void>();
		const seedsWhileChromeRunning: boolean[] = [];
		// One broker shared by both racing clients. Only the first `describe`
		// reply is delivered at once, so a client that asked while the profile
		// was still cold hears "no daemon" after the winner's Chrome is already
		// live on the profile.
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onDescribe() {
				if (describes++ > 0) await chromeLive.promise;
			},
			async onStart() {
				// Chromium reads Preferences once, at startup.
				launchPrefs = JSON.parse(await Bun.file(prefsFile).text());
				chromeRunning = true;
				chromeLive.resolve();
			},
		});
		const seedSpy = spyOn(browserLaunch, "seedOwnedProfilePreferences").mockImplementation(async userDataDir => {
			seedsWhileChromeRunning.push(chromeRunning);
			await seed(userDataDir);
		});
		try {
			const [winner, loser] = await Promise.all([
				ensureSharedBrowser({ projectDir, headless: true }),
				ensureSharedBrowser({ projectDir, headless: true }),
			]);
			expect(winner?.wsEndpoint).toBe(wsEndpoint);
			expect(loser?.wsEndpoint).toBe(wsEndpoint);
			expect(broker.starts).toBe(1);
			expect(launchPrefs).toEqual({
				profile: { password_manager_leak_detection: false },
				printing: { enabled: false },
			});
			// One seed, by the client that launched Chrome, before the launch. A
			// seed after the launch can rename a snapshot it read before Chrome
			// started over the live profile's Preferences.
			expect(seedsWhileChromeRunning).toEqual([false]);
		} finally {
			seedSpy.mockRestore();
			broker.restore();
			await fs.promises.rm(piUtils.getDaemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});

describe("shared Chromium session-restore state", () => {
	it("discards the previous Chrome's sessions before a cold start and never touches a live Chrome's", async () => {
		const projectDir = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-sessions-")),
		);
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(piUtils.getDaemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/sessions";
		let sessionsAtLaunch: string[] | undefined;
		let failNextDescribe: Error | undefined;
		let lookupUnavailable = false;
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onDescribe() {
				if (lookupUnavailable) throw new Error("synthetic daemon lookup unavailable");
				const failure = failNextDescribe;
				failNextDescribe = undefined;
				if (failure) throw failure;
			},
			async onStart() {
				// Chromium reopens these pages when its first window opens.
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		try {
			// A predecessor Chrome that was killed (or stopped) with pages open. The
			// first describe is lost in transit, which settles nothing: Chrome must
			// not launch until a later describe confirms the profile is free and the
			// stale session is gone.
			await Bun.write(path.join(sessionsDir, "Session_13435785841408923"), "previous chrome");
			await Bun.write(path.join(sessionsDir, "Tabs_13435784948833957"), "previous chrome");
			failNextDescribe = new Error("broker socket closed");
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(sessionsAtLaunch).toEqual([]);

			// The running Chrome records its own session; attaching to it must leave that alone.
			await Bun.write(path.join(sessionsDir, "Session_13436291949708538"), "live chrome");
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436291949708538"]);

			// A describe lost in transit, or rejected for a reason other than an
			// unknown name, proves nothing about the live Chrome, so neither may discard.
			for (const failure of [
				new Error("broker socket closed"),
				new DaemonRejectedError("Daemon authentication failed"),
			]) {
				failNextDescribe = failure;
				expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
				expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436291949708538"]);
			}
			lookupUnavailable = true;
			await expect(ensureSharedBrowser({ projectDir, headless: true })).rejects.toThrow();
			expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436291949708538"]);
			expect(broker.starts).toBe(1);
		} finally {
			broker.restore();
			await fs.promises.rm(piUtils.getDaemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});

	it("starts Chrome only while holding the profile claim, though an unclaimed client may adopt it", async () => {
		const projectDir = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-claim-")),
		);
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(piUtils.getDaemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/claim";
		let sessionsAtLaunch: string[] | undefined;
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onStart() {
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		const warnSpy = spyOn(piUtils.logger, "warn").mockImplementation(() => {});
		let lockSpy: { mockRestore(): void } | undefined;
		const holdClaimElsewhere = () => {
			lockSpy = spyOn(piUtils, "acquireFileLock").mockRejectedValue(new Error("lock held by another omp process"));
		};
		const releaseClaim = () => {
			lockSpy?.mockRestore();
			lockSpy = undefined;
		};
		try {
			// Another omp process holds the claim past the wait, so this client
			// cannot prepare the profile and must not launch Chrome on it.
			await Bun.write(path.join(sessionsDir, "Session_13435785841408923"), "previous chrome");
			holdClaimElsewhere();
			await expect(ensureSharedBrowser({ projectDir, headless: true })).rejects.toBeInstanceOf(ToolError);
			expect(broker.starts).toBe(0);
			releaseClaim();

			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(sessionsAtLaunch).toEqual([]);
			holdClaimElsewhere();
			expect((await ensureSharedBrowser({ projectDir, headless: true }))?.wsEndpoint).toBe(wsEndpoint);
			expect(broker.starts).toBe(1);
		} finally {
			releaseClaim();
			warnSpy.mockRestore();
			broker.restore();
			await fs.promises.rm(piUtils.getDaemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});

	it("restarts the shared browser without restoring the stopped Chrome's pages", async () => {
		const projectDir = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-restart-")),
		);
		const name = sharedBrowserDaemonName(true);
		const sessionsDir = path.join(piUtils.getDaemonRuntimeDir(projectDir), `${name}.profile`, "Default", "Sessions");
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/restart";
		let sessionsAtStop: string[] | undefined;
		let sessionsAtLaunch: string[] | undefined;
		let stopLeaves: UnitSnapshot["state"] = "exited";
		const broker = fakeSharedBroker(projectDir, wsEndpoint, {
			async onStop() {
				sessionsAtStop = await fs.promises.readdir(sessionsDir).catch(() => []);
				return stopLeaves;
			},
			async onStart() {
				sessionsAtLaunch = await fs.promises.readdir(sessionsDir).catch(() => []);
			},
		});
		try {
			const endpoint = await ensureSharedBrowser({ projectDir, headless: true });
			expect(endpoint.wsEndpoint).toBe(wsEndpoint);

			// The running Chrome records the pages it has open. They stay until the
			// stop is confirmed and are gone when Chrome relaunches.
			await Bun.write(path.join(sessionsDir, "Session_13436291949708538"), "live chrome");
			const restarted = await restartSharedBrowser(endpoint.lease.unit);
			expect(restarted.state).toBe("ready");
			expect(sessionsAtStop).toEqual(["Session_13436291949708538"]);
			expect(sessionsAtLaunch).toEqual([]);
			expect(broker.starts).toBe(2);

			// A stop that leaves Chrome running must neither touch its profile nor relaunch it.
			await Bun.write(path.join(sessionsDir, "Session_13436325114290429"), "live chrome");
			stopLeaves = "stopping";
			await expect(restartSharedBrowser(restarted)).rejects.toThrow("still stopping");
			expect(await fs.promises.readdir(sessionsDir)).toEqual(["Session_13436325114290429"]);
			expect(broker.starts).toBe(2);
		} finally {
			broker.restore();
			await fs.promises.rm(piUtils.getDaemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});

describe("shared Chrome process", () => {
	it("hands out the broker's Chrome process with its endpoint, started or adopted", async () => {
		const projectDir = await fs.promises.realpath(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-shared-profile-pid-")),
		);
		const wsEndpoint = "ws://127.0.0.1:9222/devtools/browser/pid";
		const broker = fakeSharedBroker(projectDir, wsEndpoint);
		try {
			expect(await ensureSharedBrowser({ projectDir, headless: false })).toMatchObject({
				wsEndpoint,
				pid: BROKER_CHROME_PID,
			});
			expect((await ensureSharedBrowser({ projectDir, headless: false }))?.pid).toBe(BROKER_CHROME_PID);
			expect(broker.starts).toBe(1);
		} finally {
			broker.restore();
			await fs.promises.rm(piUtils.getDaemonRuntimeDir(projectDir), { recursive: true, force: true });
			await fs.promises.rm(projectDir, { recursive: true, force: true });
		}
	});
});
