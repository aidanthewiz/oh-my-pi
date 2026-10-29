/**
 * Regression tests for issue #10022: the project-shared broker-owned Chromium
 * (`omp.browser.headless`) retains page targets created by omp processes that
 * ended abnormally, because tab ownership was tracked only in per-process
 * memory. `orphan-registry` records ownership durably and reaps targets whose
 * owning process is gone.
 *
 * The contract under test:
 *  - a dead owner's targets are collected for reaping, a live owner's are not;
 *  - this process's own targets are never reaped (a live session keeps its tabs);
 *  - a conservative grace window keeps a just-crashed owner's fresh records;
 *  - confirmed closures are removed, while transient failures remain durable
 *    and are retried on the next reap.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import {
	CdpTargetCloseTimeoutError,
	closeCdpTarget,
	collectOrphanTargets,
	forgetSharedTarget,
	reapOrphanSharedTargets,
	recordSharedTarget,
	resetOrphanRegistryForTest,
	type SharedTargetScope,
} from "@oh-my-pi/pi-coding-agent/tools/browser/orphan-registry";
import type { Browser } from "puppeteer-core";

const DAEMON_NAME = "omp.browser.headless";

/** Unique per-test scope so registry dirs never collide across the suite. */
function makeScope(): SharedTargetScope {
	const projectDir = path.join("/tmp", `omp-orphan-test-${crypto.randomUUID()}`);
	return { projectDir, daemonName: DAEMON_NAME };
}

function registryDir(scope: SharedTargetScope): string {
	return path.join(daemonRuntimeDir(scope.projectDir), `${scope.daemonName}.targets`);
}

async function writeOwnershipFile(
	scope: SharedTargetScope,
	record: { pid: number; updatedAt: number; targets: string[] },
): Promise<void> {
	const dir = registryDir(scope);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${record.pid}.json`), JSON.stringify(record));
}

/** A pid that has been spawned and reaped, so `kill(pid, 0)` reports ESRCH. */
async function deadPid(): Promise<number> {
	// Bun's own executable is the only binary guaranteed on every platform (`true` is absent on Windows).
	const proc = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
	return proc.pid;
}

/** Minimal puppeteer Browser stub recording closes and optionally failing selected targets. */
function makeBrowser(closed: string[], failTargets: ReadonlySet<string> = new Set()): Browser {
	const destroyedHandlers = new Set<(event: { targetId: string }) => void>();
	const session = {
		send: async (method: string, params?: { targetId: string }) => {
			if (method === "Target.getTargets") {
				return { targetInfos: [...failTargets].map(targetId => ({ targetId })) };
			}
			if (method === "Target.setDiscoverTargets") return {};
			if (!params) throw new Error(`Missing params for ${method}`);
			if (failTargets.has(params.targetId)) throw new Error("transient CDP failure");
			closed.push(params.targetId);
			const { targetId } = params;
			queueMicrotask(() => {
				for (const handler of destroyedHandlers) handler({ targetId });
			});
			return { success: true };
		},
		on: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.add(handler),
		off: (_event: string, handler: (event: { targetId: string }) => void) => destroyedHandlers.delete(handler),
		detach: async () => undefined,
	};
	return {
		target: () => ({ createCDPSession: async () => session }),
	} as unknown as Browser;
}

function closeFixture(
	send: (method: string, emit: (targetId: string) => void) => Promise<unknown>,
	options: { create?: Promise<void>; detach?: () => Promise<void> } = {},
): { browser: Browser; listeners: () => number; detaches: () => number } {
	const handlers = new Set<(event: { targetId: string }) => void>();
	let detaches = 0;
	const session = {
		send: (method: string) =>
			send(method, targetId => {
				for (const handler of handlers) handler({ targetId });
			}),
		on: (_event: string, handler: (event: { targetId: string }) => void) => handlers.add(handler),
		off: (_event: string, handler: (event: { targetId: string }) => void) => handlers.delete(handler),
		detach: async () => {
			detaches++;
			await options.detach?.();
		},
	};
	return {
		browser: {
			target: () => ({
				createCDPSession: async () => {
					await options.create;
					return session;
				},
			}),
		} as unknown as Browser,
		listeners: () => handlers.size,
		detaches: () => detaches,
	};
}

describe("CDP target close confirmation", () => {
	let clock = 0;
	async function flush(): Promise<void> {
		for (let i = 0; i < 32; i++) await Promise.resolve();
	}
	async function advance(ms: number): Promise<void> {
		clock += ms;
		vi.advanceTimersByTime(ms);
		await flush();
	}
	beforeEach(() => {
		clock = 0;
		vi.useFakeTimers();
		spyOn(performance, "now").mockImplementation(() => clock);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("does not accept a close acknowledgment or another target's destruction as ownership release", async () => {
		const fixture = closeFixture(async (method, emit) => {
			if (method === "Target.closeTarget") {
				emit("somebody-elses-page");
				return { success: true };
			}
			if (method === "Target.getTargets") return { targetInfos: [{ targetId: "owned" }] };
			return {};
		});

		const close = closeCdpTarget(fixture.browser, "owned", 80);
		await flush();
		await advance(40);
		expect(await close).toBe(false);
		expect(fixture.listeners()).toBe(0);
		expect(fixture.detaches()).toBe(1);
	});

	it("accepts matching destruction even when the close response never arrives", async () => {
		const fixture = closeFixture(async (method, emit) => {
			if (method === "Target.closeTarget") {
				emit("owned");
				return await new Promise<never>(() => {});
			}
			return {};
		});

		expect(await closeCdpTarget(fixture.browser, "owned", 80)).toBe(true);
		expect(fixture.listeners()).toBe(0);
	});

	it("confirms absence after a close protocol error", async () => {
		const fixture = closeFixture(async method => {
			if (method === "Target.closeTarget") throw new Error("No target with given id");
			if (method === "Target.getTargets") return { targetInfos: [{ targetId: "unrelated" }] };
			return {};
		});

		expect(await closeCdpTarget(fixture.browser, "owned", 80)).toBe(true);
		expect(fixture.listeners()).toBe(0);
	});

	it("reserves absence time from the original budget, not from the end of discovery", async () => {
		const discovery = Promise.withResolvers<void>();
		const fixture = closeFixture(async method => {
			if (method === "Target.setDiscoverTargets") await discovery.promise;
			if (method === "Target.closeTarget") return { success: true };
			if (method === "Target.getTargets") return { targetInfos: [{ targetId: "owned" }] };
			return {};
		});
		let outcome: unknown;
		const close = closeCdpTarget(fixture.browser, "owned", 200).then(
			value => {
				outcome = value;
			},
			error => {
				outcome = error;
			},
		);
		await flush();
		await advance(150);
		discovery.resolve();
		await flush();
		await advance(0);
		expect(outcome).toBe(false);
		await close;
	});

	it.each(["Target.setDiscoverTargets", "Target.closeTarget", "Target.getTargets"])(
		"bounds a wedged %s and removes its destruction listener",
		async wedged => {
			const fixture = closeFixture(async method => {
				if (method === wedged || method === "Target.getTargets") return await new Promise<never>(() => {});
				if (method === "Target.closeTarget") return { success: false };
				return {};
			});
			let outcome: unknown;
			const close = closeCdpTarget(fixture.browser, "owned", 40).catch(error => {
				outcome = error;
			});
			await flush();
			await advance(20);
			await advance(20);
			expect(outcome).toBeInstanceOf(CdpTargetCloseTimeoutError);
			await close;
			expect(fixture.listeners()).toBe(0);
			expect(fixture.detaches()).toBe(1);
		},
	);

	it.each(["Target.setDiscoverTargets", "Target.closeTarget"])(
		"uses the reserved absence check when %s does not answer",
		async wedged => {
			const fixture = closeFixture(async method => {
				if (method === wedged) return await new Promise<never>(() => {});
				if (method === "Target.getTargets") return { targetInfos: [] };
				return {};
			});
			const close = closeCdpTarget(fixture.browser, "owned", 80);
			await flush();
			await advance(40);
			expect(await close).toBe(true);
			expect(fixture.listeners()).toBe(0);
		},
	);

	it("detaches a session acquired after the close deadline without starting discovery", async () => {
		const created = Promise.withResolvers<void>();
		let sent = false;
		const fixture = closeFixture(
			async () => {
				sent = true;
				return {};
			},
			{ create: created.promise },
		);
		let outcome: unknown;
		const close = closeCdpTarget(fixture.browser, "owned", 40).catch(error => {
			outcome = error;
		});
		await flush();
		await advance(40);
		created.resolve();
		await flush();
		expect(outcome).toBeInstanceOf(CdpTargetCloseTimeoutError);
		await close;
		expect(fixture.detaches()).toBe(1);
		expect(sent).toBe(false);
		expect(fixture.listeners()).toBe(0);
	});

	it("does not let an unresponsive detach turn confirmed absence into an unbounded close", async () => {
		const fixture = closeFixture(
			async method => (method === "Target.getTargets" ? { targetInfos: [] } : { success: false }),
			{ detach: () => new Promise<never>(() => {}) },
		);

		expect(await closeCdpTarget(fixture.browser, "owned", 40)).toBe(true);
		expect(fixture.listeners()).toBe(0);
		expect(fixture.detaches()).toBe(1);
	});
});

const scopes: SharedTargetScope[] = [];
function trackedScope(): SharedTargetScope {
	const scope = makeScope();
	scopes.push(scope);
	return scope;
}

afterEach(async () => {
	resetOrphanRegistryForTest();
	for (const scope of scopes.splice(0)) {
		await fs.rm(daemonRuntimeDir(scope.projectDir), { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("orphan-registry — ownership scan", () => {
	it("collects a dead owner's targets and leaves a live owner's untouched", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const live = 424242; // treated as alive by the injected probe below
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 0, targets: ["dead-a", "dead-b"] });
		await writeOwnershipFile(scope, { pid: live, updatedAt: 0, targets: ["live-a"] });

		const scan = await collectOrphanTargets(scope, {
			now: () => 10_000_000,
			isAlive: pid => pid === live,
		});

		expect(scan.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 0,
				targetIds: ["dead-a", "dead-b"],
			},
		]);
	});

	it("never reaps this process's own recorded targets", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "mine-1");
		await recordSharedTarget(scope, "mine-2");

		// Our own file is present on disk...
		const own = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(own.targets.sort()).toEqual(["mine-1", "mine-2"]);

		// ...but a scan (even with everything else forced dead) skips it.
		const scan = await collectOrphanTargets(scope, { now: () => 10_000_000, isAlive: () => false });
		expect(scan.owners).toEqual([]);
	});

	it("forgetSharedTarget drops one id and removes the file once empty", async () => {
		const scope = trackedScope();
		await recordSharedTarget(scope, "a");
		await recordSharedTarget(scope, "b");
		await forgetSharedTarget(scope, "a");
		const after = (await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).json()) as {
			targets: string[];
		};
		expect(after.targets).toEqual(["b"]);

		await forgetSharedTarget(scope, "b");
		expect(await Bun.file(path.join(registryDir(scope), `${process.pid}.json`)).exists()).toBe(false);
	});

	it("keeps a dead owner's records inside the conservative grace window", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, { pid: dead, updatedAt: 100_000, targets: ["fresh"] });

		const withinGrace = await collectOrphanTargets(scope, {
			now: () => 105_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(withinGrace.owners).toEqual([]);

		const pastGrace = await collectOrphanTargets(scope, {
			now: () => 130_000,
			isAlive: () => false,
			graceMs: 15_000,
		});
		expect(pastGrace.owners).toEqual([
			{
				file: path.join(registryDir(scope), `${dead}.json`),
				pid: dead,
				updatedAt: 100_000,
				targetIds: ["fresh"],
			},
		]);
	});
});

describe("orphan-registry — reap", () => {
	it("closes a dead owner's targets via CDP and deletes its ownership file", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt: Date.now() - 60_000,
			targets: ["orphan-1", "orphan-2"],
		});
		const closed: string[] = [];

		const count = await reapOrphanSharedTargets(makeBrowser(closed), scope);

		expect(count).toBe(2);
		expect(closed.sort()).toEqual(["orphan-1", "orphan-2"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});

	it("retains transient CDP failures and retries them on the next reap", async () => {
		const scope = trackedScope();
		const dead = await deadPid();
		const updatedAt = Date.now() - 60_000;
		await writeOwnershipFile(scope, {
			pid: dead,
			updatedAt,
			targets: ["closed-now", "retry-later"],
		});
		const firstClosed: string[] = [];

		const firstCount = await reapOrphanSharedTargets(makeBrowser(firstClosed, new Set(["retry-later"])), scope);

		expect(firstCount).toBe(1);
		expect(firstClosed).toEqual(["closed-now"]);
		const retained = (await Bun.file(path.join(registryDir(scope), `${dead}.json`)).json()) as {
			pid: number;
			updatedAt: number;
			targets: string[];
		};
		expect(retained).toEqual({ pid: dead, updatedAt, targets: ["retry-later"] });

		const retryClosed: string[] = [];
		const retryCount = await reapOrphanSharedTargets(makeBrowser(retryClosed), scope);

		expect(retryCount).toBe(1);
		expect(retryClosed).toEqual(["retry-later"]);
		expect(await Bun.file(path.join(registryDir(scope), `${dead}.json`)).exists()).toBe(false);
	});
});
