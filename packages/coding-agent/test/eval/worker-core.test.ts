import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type RejectionInterceptor, WorkerCore } from "@oh-my-pi/pi-coding-agent/eval/js/worker-core";
import type {
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { postmortem } from "@oh-my-pi/pi-utils";

interface WorkerHarness {
	send(message: WorkerInbound): void;
	onMessage(handler: (message: WorkerOutbound) => void): () => void;
}

function createWorkerHarness(
	mode: "inline" | "isolated" = "inline",
	interceptUnhandledRejections: RejectionInterceptor = postmortem.interceptUnhandledRejections,
): WorkerHarness {
	const hostListeners = new Set<(message: WorkerOutbound) => void>();
	const workerListeners = new Set<(message: WorkerInbound) => void>();
	const transport: Transport = {
		send: message => {
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(message);
			});
		},
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	new WorkerCore(
		transport,
		mode === "inline" ? { mode, interceptUnhandledRejections } : { mode, interceptUnhandledRejections },
	);
	return {
		send(message) {
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(message);
			});
		},
		onMessage(handler) {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
	};
}

function waitForMessage(
	harness: WorkerHarness,
	predicate: (message: WorkerOutbound) => boolean,
): Promise<WorkerOutbound> {
	const { promise, resolve } = Promise.withResolvers<WorkerOutbound>();
	let unsubscribe = (): void => {};
	unsubscribe = harness.onMessage(message => {
		if (!predicate(message)) return;
		unsubscribe();
		resolve(message);
	});
	return promise;
}

async function initializeWorker(harness: WorkerHarness, snapshot: SessionSnapshot): Promise<void> {
	const ready = waitForMessage(harness, message => message.type === "ready");
	harness.send({ type: "init", snapshot });
	expect((await ready).type).toBe("ready");
}

function installFatalCapture(): {
	fatal: unknown[];
	uninstall: () => void;
} {
	const fatal: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		fatal.push(reason);
	};
	const onUncaught = (err: Error): void => {
		fatal.push(err);
	};
	process.on("unhandledRejection", onUnhandled);
	process.on("uncaughtException", onUncaught);
	return {
		fatal,
		uninstall: () => {
			process.off("unhandledRejection", onUnhandled);
			process.off("uncaughtException", onUncaught);
		},
	};
}

async function runWorkerCoreRejectionProbe(
	scenario: string,
): Promise<{ output: unknown; stderr: string; exitCode: number }> {
	const workerCoreUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/eval/js/worker-core.ts")).href;
	const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../../../utils/src/postmortem.ts")).href;
	const probe = `const { WorkerCore } = await import(${JSON.stringify(workerCoreUrl)});
const postmortem = await import(${JSON.stringify(postmortemUrl)});

const outbound = [];
const inbound = new Set();
const waiters = new Set();
const transport = {
	send(message) {
		outbound.push(message);
		for (const waiter of [...waiters]) {
			if (!waiter.predicate(message)) continue;
			waiters.delete(waiter);
			waiter.resolve(message);
		}
	},
	onMessage(handler) {
		inbound.add(handler);
		return () => inbound.delete(handler);
	},
	close() {},
};
const send = message => queueMicrotask(() => {
	for (const handler of inbound) handler(message);
});
const waitForMessage = predicate => {
	const deferred = Promise.withResolvers();
	waiters.add({ predicate, resolve: deferred.resolve });
	return deferred.promise;
};
let rejectionSeen = Promise.withResolvers();
const waitForRejection = () => rejectionSeen.promise;
const resetRejection = () => {
	rejectionSeen = Promise.withResolvers();
};
const core = new WorkerCore(transport, {
	mode: "isolated",
	interceptUnhandledRejections(handler) {
		return postmortem.interceptUnhandledRejections((reason, promise) => {
			const consumed = handler(reason, promise);
			rejectionSeen.resolve();
			return consumed;
		});
	},
});
const snapshot = { cwd: process.cwd(), sessionId: "eval-rejection-ownership", localRoots: {} };
const ready = waitForMessage(message => message.type === "ready");
send({ type: "init", snapshot });
await ready;
const finish = async (result, success) => {
	const closed = waitForMessage(message => message.type === "closed");
	send({ type: "close" });
	await closed;
	console.log(JSON.stringify(result));
	process.exit(success ? 0 : 1);
};

${scenario}
`;

	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rejection-ownership-"));
	const probePath = path.join(root, "probe.ts");
	try {
		await Bun.write(probePath, probe);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const watchdog = setTimeout(() => {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 5000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (!stdout.trim()) throw new Error(`Rejection probe exited ${exitCode}: ${stderr}`);
			return { output: JSON.parse(stdout.trim()), stderr, exitCode };
		} finally {
			clearTimeout(watchdog);
		}
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

describe("WorkerCore", () => {
	it("reports same-realm cwd conflicts through the worker protocol", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "same-realm-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "same-realm-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		try {
			first.send({
				type: "run",
				runId: "hold-first-runtime",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[same-realm-first].js",
				snapshot: { cwd, sessionId: "same-realm-first", localRoots: {} },
			});
			await entered.promise;

			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second-runtime",
			);
			second.send({
				type: "run",
				runId: "overlap-second-runtime",
				code: "1 + 1;",
				filename: "[same-realm-second].js",
				snapshot: { cwd, sessionId: "same-realm-second", localRoots: {} },
			});

			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-second-runtime",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
		} finally {
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("re-init while a same-realm run is live does not crash the process", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "reinit-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "reinit-second", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-reinit",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[reinit-first].js",
				snapshot: { cwd, sessionId: "reinit-first", localRoots: {} },
			});
			await entered.promise;

			// Re-init the second core while the first still owns the realm. Production
			// inline workers deliver this on a microtask; a setCwd throw here used to
			// become a process-fatal unhandledRejection / uncaughtException.
			const reinit = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "reinit-second", localRoots: {} } });
			const reply = await reinit;
			expect(reply.type).toBe("ready");

			// Concurrent run still fails at the exclusive run boundary, via protocol.
			const result = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-after-reinit",
			);
			second.send({
				type: "run",
				runId: "overlap-after-reinit",
				code: "1 + 1;",
				filename: "[reinit-second].js",
				snapshot: { cwd, sessionId: "reinit-second", localRoots: {} },
			});
			expect(await result).toMatchObject({
				type: "result",
				runId: "overlap-after-reinit",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			// Drain microtasks so a latent fatal would surface.
			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("concurrent inits under a live same-realm run stay process-safe", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness();
		const third = createWorkerHarness();
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "init-live-first", localRoots: {} });
		await initializeWorker(second, { cwd, sessionId: "init-live-second", localRoots: {} });
		await initializeWorker(third, { cwd, sessionId: "init-live-third", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			first.send({
				type: "run",
				runId: "hold-for-multi-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait;",
				filename: "[init-live-first].js",
				snapshot: { cwd, sessionId: "init-live-first", localRoots: {} },
			});
			await entered.promise;

			const readySecond = waitForMessage(
				second,
				message => message.type === "ready" || message.type === "init-failed",
			);
			const readyThird = waitForMessage(
				third,
				message => message.type === "ready" || message.type === "init-failed",
			);
			second.send({ type: "init", snapshot: { cwd, sessionId: "init-live-second", localRoots: {} } });
			third.send({ type: "init", snapshot: { cwd, sessionId: "init-live-third", localRoots: {} } });
			expect((await readySecond).type).toBe("ready");
			expect((await readyThird).type).toBe("ready");

			const resultSecond = waitForMessage(
				second,
				message => message.type === "result" && message.runId === "overlap-second",
			);
			const resultThird = waitForMessage(
				third,
				message => message.type === "result" && message.runId === "overlap-third",
			);
			second.send({
				type: "run",
				runId: "overlap-second",
				code: "2",
				filename: "[init-live-second].js",
				snapshot: { cwd, sessionId: "init-live-second", localRoots: {} },
			});
			third.send({
				type: "run",
				runId: "overlap-third",
				code: "3",
				filename: "[init-live-third].js",
				snapshot: { cwd, sessionId: "init-live-third", localRoots: {} },
			});
			expect(await resultSecond).toMatchObject({
				type: "result",
				runId: "overlap-second",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});
			expect(await resultThird).toMatchObject({
				type: "result",
				runId: "overlap-third",
				ok: false,
				error: { message: "Cannot run code while another same-realm JS runtime is running" },
			});

			await Bun.sleep(0);
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
			third.send({ type: "close" });
		}
	});

	it("first init while a same-realm run is live fails via init-failed and recovers", async () => {
		const first = createWorkerHarness();
		const second = createWorkerHarness(); // never initialized: no runtime exists yet
		const cwd = process.cwd();
		await initializeWorker(first, { cwd, sessionId: "first-init-live-first", localRoots: {} });

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_core_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};

		const { fatal, uninstall } = installFatalCapture();
		try {
			const firstText = waitForMessage(
				first,
				message => message.type === "text" && message.runId === "hold-for-first-init",
			);
			const firstResult = waitForMessage(
				first,
				message => message.type === "result" && message.runId === "hold-for-first-init",
			);
			first.send({
				type: "run",
				runId: "hold-for-first-init",
				code: "globalThis.__omp_worker_core_gate.entered(); await globalThis.__omp_worker_core_gate.wait; __omp_session__.sessionId;",
				filename: "[first-init-live-first].js",
				snapshot: { cwd, sessionId: "first-init-live-first", localRoots: {} },
			});
			await entered.promise;

			// A fresh runtime's install would Object.assign over the live runtime's
			// globals mid-run; it must fail via the protocol instead.
			const reply = waitForMessage(second, message => message.type === "ready" || message.type === "init-failed");
			second.send({ type: "init", snapshot: { cwd, sessionId: "first-init-live-second", localRoots: {} } });
			expect(await reply).toMatchObject({
				type: "init-failed",
				error: { message: "Cannot initialize a JS runtime while another same-realm JS runtime is running" },
			});

			// The held run's globals were not clobbered: it still resolves its own
			// session bag and completes cleanly.
			gate.resolve();
			expect(await firstText).toMatchObject({
				type: "text",
				runId: "hold-for-first-init",
				chunk: "first-init-live-first\n",
			});
			expect(await firstResult).toMatchObject({ type: "result", runId: "hold-for-first-init", ok: true });

			// Once the realm is free, the same core initializes cleanly.
			await initializeWorker(second, { cwd, sessionId: "first-init-live-second", localRoots: {} });

			// Drain the microtask queue so any latent fatal would surface.
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(fatal).toEqual([]);
		} finally {
			uninstall();
			gate.resolve();
			delete (globalThis as { __omp_worker_core_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_core_gate;
			first.send({ type: "close" });
			second.send({ type: "close" });
		}
	});

	it("keeps the process cwd while another cell is mid-run", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cwd-b-"));
		const chdirs: string[] = [];
		const hostListeners = new Set<(message: WorkerOutbound) => void>();
		const workerListeners = new Set<(message: WorkerInbound) => void>();
		const transport: Transport = {
			send: message => {
				queueMicrotask(() => {
					for (const listener of hostListeners) listener(message);
				});
			},
			onMessage: handler => {
				workerListeners.add(handler);
				return () => workerListeners.delete(handler);
			},
			close: () => {},
		};
		new WorkerCore(transport, { mode: "isolated", chdir: cwd => chdirs.push(cwd) });
		const harness: WorkerHarness = {
			send(message) {
				queueMicrotask(() => {
					for (const listener of workerListeners) listener(message);
				});
			},
			onMessage(handler) {
				hostListeners.add(handler);
				return () => hostListeners.delete(handler);
			},
		};

		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		(globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } }).__omp_worker_cwd_gate = {
			entered: () => entered.resolve(),
			wait: gate.promise,
		};
		try {
			await initializeWorker(harness, { cwd: dirA, sessionId: "cwd-race", localRoots: {} });
			expect(chdirs).toEqual([dirA]);

			const holdResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-hold",
			);
			harness.send({
				type: "run",
				runId: "cwd-hold",
				code: "globalThis.__omp_worker_cwd_gate.entered(); await globalThis.__omp_worker_cwd_gate.wait;",
				filename: "[cwd-race-hold].js",
				snapshot: { cwd: dirA, sessionId: "cwd-race", localRoots: {} },
			});
			await entered.promise;

			// A second cell with a different cwd while the first is suspended must
			// not move the realm-wide process cwd out from under the live cell.
			const skipLog = waitForMessage(
				harness,
				message => message.type === "log" && message.msg.includes("kept its process cwd"),
			);
			const overlapResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-overlap",
			);
			harness.send({
				type: "run",
				runId: "cwd-overlap",
				code: "1 + 1;",
				filename: "[cwd-race-overlap].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await overlapResult).toMatchObject({ type: "result", runId: "cwd-overlap", ok: true });
			expect(chdirs).not.toContain(dirB);
			await skipLog;

			gate.resolve();
			expect(await holdResult).toMatchObject({ type: "result", runId: "cwd-hold", ok: true });

			// With the realm quiet again, the next cell lands the deferred move.
			const soloResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "cwd-solo",
			);
			harness.send({
				type: "run",
				runId: "cwd-solo",
				code: "2 + 2;",
				filename: "[cwd-race-solo].js",
				snapshot: { cwd: dirB, sessionId: "cwd-race", localRoots: {} },
			});
			expect(await soloResult).toMatchObject({ type: "result", runId: "cwd-solo", ok: true });
			expect(chdirs.at(-1)).toBe(dirB);
		} finally {
			gate.resolve();
			delete (globalThis as { __omp_worker_cwd_gate?: { entered(): void; wait: Promise<void> } })
				.__omp_worker_cwd_gate;
			harness.send({ type: "close" });
			await fs.rm(dirA, { recursive: true, force: true });
			await fs.rm(dirB, { recursive: true, force: true });
		}
	});

	it("attributes a reused error to the run that rejects its promise", async () => {
		let rejectionHandler: ((reason: unknown, promise: Promise<unknown>) => boolean) | undefined;
		const harness = createWorkerHarness("isolated", handler => {
			rejectionHandler = handler;
			return () => {
				rejectionHandler = undefined;
			};
		});
		const snapshot = { cwd: process.cwd(), sessionId: "eval-reused-error", localRoots: {} };
		await initializeWorker(harness, snapshot);

		try {
			const storeCall = waitForMessage(
				harness,
				message => message.type === "tool-call" && message.runId === "store-error-run",
			);
			const storeResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "store-error-run",
			);
			harness.send({
				type: "run",
				runId: "store-error-run",
				code: `try {
					await tool.fail({});
				} catch (error) {
					globalThis.__omp_reused_error = error;
				}
				"stored";`,
				filename: "[store-error-run].js",
				snapshot,
			});
			const failedToolCall = await storeCall;
			if (failedToolCall.type !== "tool-call") throw new Error("expected tool call");
			harness.send({
				type: "tool-reply",
				id: failedToolCall.id,
				reply: {
					ok: false,
					error: {
						name: "ToolError",
						message: "stored tool failure",
						isToolError: true,
					},
				},
			});
			expect(await storeResult).toMatchObject({
				type: "result",
				runId: "store-error-run",
				ok: true,
			});

			const reuseCall = waitForMessage(
				harness,
				message => message.type === "tool-call" && message.runId === "reuse-error-run",
			);
			const reuseResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "reuse-error-run",
			);
			harness.send({
				type: "run",
				runId: "reuse-error-run",
				code: `await tool.capture({
					promise: Promise.reject(globalThis.__omp_reused_error),
				});
				"done";`,
				filename: "[reuse-error-run].js",
				snapshot,
			});
			const captureCall = await reuseCall;
			if (captureCall.type !== "tool-call") throw new Error("expected tool call");
			const rejectedPromise = Reflect.get(captureCall.args as object, "promise");
			expect(rejectedPromise).toBeInstanceOf(Promise);
			let reason: unknown;
			await (rejectedPromise as Promise<unknown>).catch(error => {
				reason = error;
			});
			expect(rejectionHandler?.(reason, rejectedPromise as Promise<unknown>)).toBe(true);
			harness.send({
				type: "tool-reply",
				id: captureCall.id,
				reply: { ok: true, value: "captured" },
			});
			expect(await reuseResult).toMatchObject({
				type: "result",
				runId: "reuse-error-run",
				ok: false,
				error: { message: "Unhandled rejection (missing await?): stored tool failure" },
			});
		} finally {
			harness.send({ type: "close" });
		}
	});

	it("keeps cells and tool invocations alive for delayed bridge failures", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const registered = waitForMessage(message => message.type === "result" && message.runId === "register-delayed");
send({
	type: "run", runId: "register-delayed", snapshot, filename: "[register-delayed].js",
	code: 'tool(() => { void tool.remote({}); return "success"; }, { name: "delayed" });',
});
await registered;
const outcomes = [];
for (const mode of ["cell", "invocation"]) {
	const runId = "delayed-" + mode;
	const called = waitForMessage(message => message.type === "tool-call" && message.runId === runId);
	const completed = waitForMessage(message => message.type === "result" && message.runId === runId);
	send(mode === "cell"
		? { type: "run", runId, snapshot, filename: "[delayed-cell].js", code: "void tool.remote({});" }
		: { type: "tool", runId, op: "call", name: "delayed", args: {} });
	const call = await called;
	const barrierId = runId + "-barrier";
	const barrier = waitForMessage(message => message.type === "result" && message.runId === barrierId);
	send({ type: "run", runId: barrierId, snapshot, filename: "[barrier].js", code: "undefined;" });
	await barrier;
	const premature = outbound.some(message => message.runId === runId &&
		(message.type === "result" || (message.type === "display" && message.output.type === "json")));
	send({ type: "tool-reply", id: call.id, reply: { ok: false, error: { message: "delayed host failure" } } });
	const result = await completed;
	outcomes.push({
		mode, premature, ok: result.ok, error: result.error?.message,
		successDisplay: outbound.some(message => message.runId === runId &&
			message.type === "display" && message.output.type === "json"),
	});
}
await finish(outcomes, outcomes.every(result => !result.premature && !result.ok && !result.successDisplay));
`);
		expect(output).toEqual(
			["cell", "invocation"].map(mode => ({
				mode,
				premature: false,
				ok: false,
				error: "Unhandled rejection (missing await?): delayed host failure",
				successDisplay: false,
			})),
		);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("[Unhandled Rejection]");
	});

	it("drains bridge calls started by reply continuations before completing", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "chained-bridge-drain", localRoots: {} };
		await initializeWorker(harness, snapshot);
		const messages: WorkerOutbound[] = [];
		const unsubscribe = harness.onMessage(message => messages.push(message));
		try {
			const firstCall = waitForMessage(harness, message => message.type === "tool-call" && message.name === "first");
			const secondCall = waitForMessage(
				harness,
				message => message.type === "tool-call" && message.name === "second",
			);
			const completed = waitForMessage(harness, message => message.type === "result" && message.runId === "chain");
			harness.send({
				type: "run",
				runId: "chain",
				snapshot,
				filename: "[chain].js",
				code: 'void tool.first({}).then(() => tool.second({})).catch(() => display("recovered"));',
			});
			const first = await firstCall;
			if (first.type !== "tool-call") throw new Error("expected first tool call");
			harness.send({ type: "tool-reply", id: first.id, reply: { ok: true, value: null } });
			const second = await secondCall;
			if (second.type !== "tool-call") throw new Error("expected second tool call");
			const barrier = waitForMessage(harness, message => message.type === "result" && message.runId === "barrier");
			harness.send({ type: "run", runId: "barrier", snapshot, filename: "[barrier].js", code: "undefined;" });
			await barrier;
			expect(messages.some(message => message.type === "result" && message.runId === "chain")).toBe(false);
			harness.send({
				type: "tool-reply",
				id: second.id,
				reply: { ok: false, error: { message: "handled failure" } },
			});
			expect(await completed).toMatchObject({ type: "result", runId: "chain", ok: true });
			expect(messages).toContainEqual({
				type: "text",
				runId: "chain",
				chunk: "recovered\n",
			});
		} finally {
			unsubscribe();
			harness.send({ type: "close" });
		}
	});

	it("fails a tool invocation with a floated read rejection before displaying success", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const registered = waitForMessage(message => message.type === "result" && message.runId === "register-tools");
send({
	type: "run", runId: "register-tools", snapshot,
	code: 'tool(() => { void read("local://package.json:raw"); return "floated"; }, { name: "floatedRead" });' +
		'tool(async () => { try { await read("local://package.json:raw"); } catch { return "caught"; } }, { name: "caughtRead" });' +
		'tool(async () => { await read("package.json"); return "awaited"; }, { name: "awaitedRead" });',
	filename: "[register-tools].js",
});
await registered;
const results = {};
for (const name of ["floatedRead", "caughtRead", "awaitedRead"]) {
	const pending = waitForMessage(message => message.type === "result" && message.runId === name);
	send({ type: "tool", runId: name, op: "call", name, args: {} });
	results[name] = await pending;
}
const result = {
	floatedFailed: results.floatedRead.ok === false &&
		results.floatedRead.error?.message.includes("Unhandled rejection (missing await?)"),
	floatedDisplayed: outbound.some(message => message.type === "display" && message.output.type === "json" && message.runId === "floatedRead"),
	caughtValue: outbound.find(message => message.type === "display" && message.output.type === "json" && message.runId === "caughtRead")?.output.data.value,
	awaitedValue: outbound.find(message => message.type === "display" && message.output.type === "json" && message.runId === "awaitedRead")?.output.data.value,
	caughtOk: results.caughtRead.ok,
	awaitedOk: results.awaitedRead.ok,
};
await finish(result, result.floatedFailed && !result.floatedDisplayed && result.caughtOk && result.awaitedOk);
`);
		expect(output).toEqual({
			floatedFailed: true,
			floatedDisplayed: false,
			caughtValue: "caught",
			awaitedValue: "awaited",
			caughtOk: true,
			awaitedOk: true,
		});
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("[Unhandled Rejection]");
	});

	it("keeps a delayed helper rejection with its finished run while another run is live", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
globalThis.__omp_late_read_release = false;
const liveRelease = Promise.withResolvers();
const liveEntered = Promise.withResolvers();
globalThis.__omp_live_run = { entered: () => liveEntered.resolve(), release: liveRelease.promise };

const ownerResult = waitForMessage(message => message.type === "result" && message.runId === "delayed-owner");
const missingPath = process.cwd() + "/omp-missing-" + crypto.randomUUID();
send({
	type: "run",
	runId: "delayed-owner",
	code: 'globalThis.__omp_late_read_timer = setInterval(() => {' +
		'if (!globalThis.__omp_late_read_release) return;' +
		'clearInterval(globalThis.__omp_late_read_timer);' +
		'void read(' + JSON.stringify(missingPath) + ');' +
		'}, 1); "scheduled";',
	filename: "[delayed-owner].js",
	snapshot,
});
const owner = await ownerResult;

const liveResult = waitForMessage(message => message.type === "result" && message.runId === "unrelated-live-run");
send({
	type: "run",
	runId: "unrelated-live-run",
	code: 'globalThis.__omp_live_run.entered();' +
		'globalThis.__omp_late_read_release = true;' +
		'await globalThis.__omp_live_run.release;' +
		'"unrelated";',
	filename: "[unrelated-live-run].js",
	snapshot,
});
await liveEntered.promise;
await waitForRejection();
liveRelease.resolve();
const live = await liveResult;
const warning = outbound.find(message =>
	message.type === "log" &&
	message.msg === "Unhandled rejection from a finished eval cell (missing await?)" &&
	message.meta?.runId === "delayed-owner"
);

clearInterval(globalThis.__omp_late_read_timer);
delete globalThis.__omp_late_read_release;
delete globalThis.__omp_late_read_timer;
delete globalThis.__omp_live_run;
const result = { ownerOk: owner.ok, liveOk: live.ok, warning: Boolean(warning) };
await finish(result, result.ownerOk && result.liveOk && result.warning);
`);

		expect(exitCode).toBe(0);
		expect(output).toEqual({ ownerOk: true, liveOk: true, warning: true });
		expect(stderr).not.toContain("[Unhandled Rejection]");
		expect(stderr).not.toContain("[Uncaught Exception]");
	});

	it("assigns a cross-cell continuation to the run that attaches it", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const ownerResult = waitForMessage(message => message.type === "result" && message.runId === "continuation-owner");
send({
	type: "run",
	runId: "continuation-owner",
	code: 'globalThis.__omp_cross_cell_root = read("package.json");' +
		'await globalThis.__omp_cross_cell_root;' +
		'"stored";',
	filename: "[continuation-owner].js",
	snapshot,
});
const owner = await ownerResult;

const liveRelease = Promise.withResolvers();
const liveEntered = Promise.withResolvers();
globalThis.__omp_continuation_live = { entered: () => liveEntered.resolve(), release: liveRelease.promise };
const liveResult = waitForMessage(message => message.type === "result" && message.runId === "continuation-attacher");
send({
	type: "run",
	runId: "continuation-attacher",
	code: 'globalThis.__omp_continuation_live.entered();' +
		'void globalThis.__omp_cross_cell_root.then(() => {' +
			'throw new Error("cross-cell continuation");' +
		'});' +
		'await globalThis.__omp_continuation_live.release;' +
		'"unrelated";',
	filename: "[continuation-attacher].js",
	snapshot,
});
await liveEntered.promise;
await waitForRejection();
liveRelease.resolve();
const live = await liveResult;
const ownerWarning = outbound.some(message =>
	message.type === "log" &&
	message.msg === "Unhandled rejection from a finished eval cell (missing await?)" &&
	message.meta?.runId === "continuation-owner"
);

delete globalThis.__omp_cross_cell_root;
delete globalThis.__omp_continuation_live;
const expectedMessage = "Unhandled rejection (missing await?): cross-cell continuation";
const result = {
	ownerOk: owner.ok,
	attacherFailed: !live.ok && live.error?.message === expectedMessage,
	ownerWarning,
};
await finish(result, result.ownerOk && result.attacherFailed && !result.ownerWarning);
`);

		expect(exitCode).toBe(0);
		expect(output).toEqual({ ownerOk: true, attacherFailed: true, ownerWarning: false });
		expect(stderr).not.toContain("[Unhandled Rejection]");
		expect(stderr).not.toContain("[Uncaught Exception]");
	});

	it("assigns a cross-cell rejected aggregate to the cell that floats it", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const missingPath = process.cwd() + "/omp-aggregate-missing-" + crypto.randomUUID();
const ownerResult = waitForMessage(message => message.type === "result" && message.runId === "aggregate-owner");
send({
	type: "run",
	runId: "aggregate-owner",
	code: 'globalThis.__omp_aggregate_root = read(' + JSON.stringify(missingPath) + ');' +
		'try { await globalThis.__omp_aggregate_root; } catch {}' +
		'"stored";',
	filename: "[aggregate-owner].js",
	snapshot,
});
const owner = await ownerResult;

const aggregateResult = waitForMessage(message => message.type === "result" && message.runId === "aggregate-attacher");
send({
	type: "run",
	runId: "aggregate-attacher",
	code: 'void Promise.all([globalThis.__omp_aggregate_root]); "aggregate";',
	filename: "[aggregate-attacher].js",
	snapshot,
});
await waitForRejection();
const aggregate = await aggregateResult;
const ownerWarning = outbound.some(message =>
	message.type === "log" &&
	message.msg === "Unhandled rejection from a finished eval cell (missing await?)" &&
	message.meta?.runId === "aggregate-owner"
);

delete globalThis.__omp_aggregate_root;
const result = {
	ownerOk: owner.ok,
	attacherFailed:
		!aggregate.ok && aggregate.error?.message.startsWith("Unhandled rejection (missing await?):"),
	ownerWarning,
};
await finish(result, result.ownerOk && result.attacherFailed && !result.ownerWarning);
`);

		expect(exitCode).toBe(0);
		expect(output).toEqual({ ownerOk: true, attacherFailed: true, ownerWarning: false });
		expect(stderr).not.toContain("[Unhandled Rejection]");
		expect(stderr).not.toContain("[Uncaught Exception]");
	});

	it("survives concurrent same-realm setCwd in a child process with postmortem loaded", async () => {
		// Process-level oracle: the production crash was postmortem killing the process
		// after an unhandled rejection from concurrent inline setCwd. This must stay green
		// even when postmortem's fatal handlers are installed.
		const postmortemUrl = pathToFileURL(path.resolve(import.meta.dir, "../../../utils/src/postmortem.ts")).href;
		const runtimeUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/eval/js/shared/runtime.ts")).href;

		const probe = `import { pathToFileURL } from "node:url";

await import(${JSON.stringify(postmortemUrl)});
const { JsRuntime } = await import(${JSON.stringify(runtimeUrl)});

const first = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-first" });
const second = new JsRuntime({ initialCwd: process.cwd(), sessionId: "child-second" });
const gate = Promise.withResolvers();
const entered = Promise.withResolvers();

const hooks = {
	onText() {},
	onDisplay() {},
	callTool: async () => undefined,
};

second.setRunScope({ gate: gate.promise, entered: () => entered.resolve() });
const hold = second.run("entered(); await gate;", "[child-second].js", hooks);
await entered.promise;

// Historical crash path: concurrent setCwd while another same-realm runtime is live.
first.setCwd(process.cwd() + "/child-pending");
second.setCwd(process.cwd());

// Microtask delivery must not become process-fatal either.
queueMicrotask(() => {
	first.setCwd(process.cwd() + "/child-pending-2");
});
await Promise.resolve();
await Bun.sleep(0);

gate.resolve();
await hold;
first.dispose();
second.dispose();
console.log("survived concurrent setCwd");
process.exit(0);
`;

		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-same-realm-"));
		const probePath = path.join(root, "probe.ts");
		try {
			await Bun.write(probePath, probe);
			const proc = Bun.spawn([process.execPath, probePath], {
				cwd: process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env },
			});
			// Real process liveness cannot use fake timers. Bound a wedged child, but
			// clear the watchdog on the normal path so it never becomes a fixed wait.
			const watchdog = setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 5000);
			try {
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
					proc.exited,
				]);
				expect(exitCode).toBe(0);
				expect(stdout).toContain("survived concurrent setCwd");
				expect(stderr).not.toContain("[Unhandled Rejection]");
				expect(stderr).not.toContain("[Uncaught Exception]");
				expect(stderr).not.toContain("another same-realm JS runtime is running");
			} finally {
				clearTimeout(watchdog);
			}
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
