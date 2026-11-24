import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { shadowSnapshotDigest } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
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
	it("keeps state and reports a late bridge rejection once without killing the worker", async () => {
		const workerUrl = pathToFileURL(path.resolve(import.meta.dir, "../../src/eval/js/worker-core.ts")).href;
		const browserPrelude = await Bun.file(path.resolve(import.meta.dir, "../../src/tools/browser/prelude.js")).text();
		const probe = `
import { WorkerCore } from ${JSON.stringify(workerUrl)};
process.once("uncaughtException", () => process.exit(17));
const messages = [];
const listeners = new Set();
const waiters = [];
const transport = {
	send(message) {
		messages.push(message);
		for (const waiter of [...waiters]) {
			if (waiter.predicate(message)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(message);
			}
		}
	},
	onMessage(handler) { listeners.add(handler); return () => listeners.delete(handler); },
	close() {},
};
const send = message => { for (const listener of listeners) listener(message); };
const waitFor = predicate => {
	const { promise, resolve } = Promise.withResolvers();
	waiters.push({ predicate, resolve });
	return promise;
};
const snapshot = { cwd: process.cwd(), sessionId: "late-bridge",
	preludes: [{ name: "browser", exports: ["browser"], source: ${JSON.stringify(browserPrelude)} }] };
const core = new WorkerCore(transport, { mode: "isolated" });
const lateBridge = Promise.withResolvers();
globalThis.__omp_late_bridge_gate = lateBridge.promise;
send({ type: "init", snapshot });
const first = waitFor(message => message.type === "result" && message.runId === "first");
send({ type: "run", runId: "first", filename: "[first].js", snapshot,
	code: 'var kept = 42; void globalThis.__omp_late_bridge_gate.then(() => {' +
		'Array.from({length: 13}, () => browser.tab("main").waitForDownload());' +
		'}); throw new Error("Tab is busy");' });
await first;
let callCount = 0;
const allCalls = waitFor(message =>
	message.type === "tool-call" && message.runId === "first" && ++callCount === 13);
lateBridge.resolve();
await allCalls;
delete globalThis.__omp_late_bridge_gate;
for (let index = 0; index < 257; index++) {
	const runId = "evict-" + index;
	const result = waitFor(message => message.type === "result" && message.runId === runId);
	send({ type: "run", runId, filename: "[" + runId + "].js", snapshot, code: "" });
	await result;
}
const calls = messages.filter(message => message.type === "tool-call");
if (calls.length !== 13) throw new Error("expected thirteen pending browser calls");
const rejectCall = async pending => {
	const warning = waitFor(message => message.type === "log" && message.meta?.filename === "[first].js");
	send({ type: "tool-reply", id: pending.id, reply: { ok: false,
		error: { name: "ToolError", message: "timed out" } } });
	await warning;
};
for (const pending of calls.slice(0, 12)) await rejectCall(pending);
const gateCall = waitFor(message => message.type === "tool-call" && message.runId === "second");
const second = waitFor(message => message.type === "result" && message.runId === "second");
send({ type: "run", runId: "second", filename: "[second].js", snapshot,
	code: 'await __omp_call_tool__("read", {}); print(kept);' });
const gate = await gateCall;
await rejectCall(calls[12]);
send({ type: "tool-reply", id: gate.id, reply: { ok: true, value: null } });
await second;
for (const runId of ["third", "fourth"]) {
	const result = waitFor(message => message.type === "result" && message.runId === runId);
	send({ type: "run", runId, filename: "[" + runId + "].js", snapshot, code: "print(kept);" });
	await result;
}
core.dispose();
console.log(JSON.stringify(messages));
`;
		await using dir = await fs.mkdtempDisposable(path.join(os.tmpdir(), "omp-late-rejection-"));
		const probePath = path.join(dir.path, "probe.ts");
		await Bun.write(probePath, probe);
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: process.cwd(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const messages: WorkerOutbound[] = JSON.parse(stdout);
		expect(
			messages.filter(message => message.type === "result" && !message.runId.startsWith("evict-")),
		).toMatchObject([
			{ runId: "first", ok: false },
			{ runId: "second", ok: true },
			{ runId: "third", ok: true },
			{ runId: "fourth", ok: true },
		]);
		const text = messages.filter(message => message.type === "text");
		const notices = text.filter(message => message.chunk.includes("[first].js"));
		expect(notices).toHaveLength(11);
		expect(notices.filter(message => message.runId === "second")).toHaveLength(10);
		expect(notices.filter(message => message.runId === "third")).toHaveLength(1);
		expect(text.filter(message => message.chunk.includes("more late rejections"))).toMatchObject([
			{ runId: "second", chunk: expect.stringContaining("2 more late rejections") },
		]);
		expect(text.filter(message => message.chunk === "42\n")).toHaveLength(3);
	});

	it("delivers a completion handle id after its creating cell finishes", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: `late-handle-${crypto.randomUUID()}`, localRoots: {} };
		await initializeWorker(harness, snapshot);
		const toolCall = waitForMessage(
			harness,
			message => message.type === "tool-call" && message.name === "__completion__",
		);
		const firstResult = waitForMessage(
			harness,
			message => message.type === "result" && message.runId === "create-handle",
		);
		try {
			harness.send({
				type: "run",
				runId: "create-handle",
				code: 'var lateHandle = completion("hi"); print("started");',
				filename: "[create-handle].js",
				snapshot,
			});
			const call = await toolCall;
			expect(await firstResult).toMatchObject({ type: "result", ok: true });
			if (call.type !== "tool-call") throw new Error("expected completion bridge call");
			harness.send({ type: "tool-reply", id: call.id, reply: { ok: true, value: { id: "late-1" } } });

			const text = waitForMessage(harness, message => message.type === "text" && message.runId === "read-handle");
			const result = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "read-handle",
			);
			harness.send({
				type: "run",
				runId: "read-handle",
				code: "print((await globalThis.lateHandle).id);",
				filename: "[read-handle].js",
				snapshot,
			});
			expect(await text).toMatchObject({ chunk: "late-1\n" });
			expect(await result).toMatchObject({ ok: true });
		} finally {
			harness.send({ type: "close" });
		}
	});

	it.each(["completion", "agent"] as const)(
		"delivers a rejected late %s allocation to the awaiting successor cell",
		async helper => {
			const harness = createWorkerHarness();
			const snapshot = { cwd: process.cwd(), sessionId: `late-rejected-${crypto.randomUUID()}`, localRoots: {} };
			await initializeWorker(harness, snapshot);
			const toolCall = waitForMessage(
				harness,
				message => message.type === "tool-call" && message.name === `__${helper}__`,
			);
			const firstResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "create-rejected",
			);
			try {
				harness.send({
					type: "run",
					runId: "create-rejected",
					code: `var rejectedHandle = ${helper}("hi"); print("started");`,
					filename: "[create-rejected].js",
					snapshot,
				});
				const call = await toolCall;
				expect(await firstResult).toMatchObject({ type: "result", ok: true });
				if (call.type !== "tool-call") throw new Error("expected handle allocation");
				const waiting = waitForMessage(
					harness,
					message =>
						message.type === "text" && message.runId === "catch-rejected" && message.chunk === "waiting\n",
				);
				const text = waitForMessage(
					harness,
					message =>
						message.type === "text" &&
						message.runId === "catch-rejected" &&
						message.chunk.startsWith("ToolError:"),
				);
				const secondResult = waitForMessage(
					harness,
					message => message.type === "result" && message.runId === "catch-rejected",
				);
				harness.send({
					type: "run",
					runId: "catch-rejected",
					code: "print('waiting'); try { await rejectedHandle; } catch (error) { print(error.name + ': ' + error.message); }",
					filename: "[catch-rejected].js",
					snapshot,
				});
				await waiting;
				harness.send({
					type: "tool-reply",
					id: call.id,
					reply: { ok: false, error: { name: "ToolError", message: "allocation cancelled", isToolError: true } },
				});
				expect(await text).toMatchObject({ chunk: "ToolError: allocation cancelled\n" });
				expect(await secondResult).toMatchObject({ ok: true });
			} finally {
				harness.send({ type: "close" });
			}
		},
	);

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

			// Re-init the second core while the first still owns the realm. The
			// same-realm harness delivers this on a microtask; a setCwd throw here
			// used to become a process-fatal unhandledRejection / uncaughtException.
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
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const storeCall = waitForMessage(message => message.type === "tool-call" && message.runId === "store-error-run");
const storeResult = waitForMessage(message => message.type === "result" && message.runId === "store-error-run");
send({
	type: "run", runId: "store-error-run", snapshot, filename: "[store-error-run].js",
	code: 'try { await tool.fail({}); } catch (error) { globalThis.__omp_reused_error = error; } "stored";',
});
const failedToolCall = await storeCall;
send({
	type: "tool-reply", id: failedToolCall.id,
	reply: { ok: false, error: { name: "ToolError", message: "stored tool failure", isToolError: true } },
});
const stored = await storeResult;

const reuseCall = waitForMessage(message => message.type === "tool-call" && message.runId === "reuse-error-run");
const reuseResult = waitForMessage(message => message.type === "result" && message.runId === "reuse-error-run");
send({
	type: "run", runId: "reuse-error-run", snapshot, filename: "[reuse-error-run].js",
	code: 'void Promise.reject(globalThis.__omp_reused_error); await tool.capture({}); "done";',
});
const captureCall = await reuseCall;
await waitForRejection();
send({ type: "tool-reply", id: captureCall.id, reply: { ok: true, value: "captured" } });
const reused = await reuseResult;

const handledResult = waitForMessage(message => message.type === "result" && message.runId === "handled-error-run");
send({
	type: "run", runId: "handled-error-run", snapshot, filename: "[handled-error-run].js",
	code: 'await Promise.reject(globalThis.__omp_reused_error).catch(() => print("recovered"));',
});
const handled = await handledResult;
const recoveryOutput = outbound.filter(message => message.type === "text" && message.runId === "handled-error-run")
	.map(message => message.chunk).join("");
const warnings = outbound.filter(message => message.type === "log" && message.level === "warn");
delete globalThis.__omp_reused_error;
await finish({ stored, reused, handled, recoveryOutput, warnings },
	stored.ok && !reused.ok && handled.ok && recoveryOutput === "recovered\\n" && warnings.length === 0);
`);
		expect(output).toMatchObject({
			stored: { runId: "store-error-run", ok: true },
			reused: {
				runId: "reuse-error-run",
				ok: false,
				error: {
					name: "ToolError",
					message: "Unhandled rejection (missing await?): stored tool failure",
					isToolError: true,
				},
			},
			handled: { runId: "handled-error-run", ok: true },
			recoveryOutput: "recovered\n",
			warnings: [],
		});
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("[Unhandled Rejection]");
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
	const premature = outbound.some(message => message.runId === runId && message.type === "result");
	send({ type: "tool-reply", id: call.id, reply: { ok: false, error: { message: "delayed host failure" } } });
	const result = await completed;
	outcomes.push({
		mode, premature, ok: result.ok, error: result.error?.message,
		successEnvelope: outbound.some(message => message.runId === runId &&
			message.type === "result" && "value" in message),
	});
}
await finish(outcomes, outcomes.every(result => !result.premature && !result.ok && !result.successEnvelope));
`);
		expect(output).toEqual(
			["cell", "invocation"].map(mode => ({
				mode,
				premature: false,
				ok: false,
				error: "Unhandled rejection (missing await?): delayed host failure",
				successEnvelope: false,
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
				code: 'void tool.first({}).then(() => tool.second({})).catch(() => print("recovered"));',
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

	it("fails a tool invocation with a floated read rejection before publishing success", async () => {
		const { output, stderr, exitCode } = await runWorkerCoreRejectionProbe(`
const registered = waitForMessage(message => message.type === "result" && message.runId === "register-tools");
send({
	type: "run", runId: "register-tools", snapshot,
	code: 'const missingReadPath = ' + JSON.stringify(process.cwd() + "/omp-missing-tool-" + crypto.randomUUID()) + ';' +
		'tool(() => { void read(missingReadPath); return "floated"; }, { name: "floatedRead" });' +
		'tool(async () => { try { await read(missingReadPath); } catch { return "caught"; } }, { name: "caughtRead" });' +
		'tool(async () => { await read("package.json"); return "awaited"; }, { name: "awaitedRead" });' +
		'tool(async () => { await read(missingReadPath); return "unreachable"; }, { name: "failedRead" });',
	filename: "[register-tools].js",
});
await registered;
const results = {};
for (const name of ["floatedRead", "caughtRead", "awaitedRead", "failedRead"]) {
	const pending = waitForMessage(message => message.type === "result" && message.runId === name);
	send({ type: "tool", runId: name, op: "call", name, args: {} });
	results[name] = await pending;
}
const result = {
	floatedFailed: results.floatedRead.ok === false &&
		results.floatedRead.error?.message.includes("Unhandled rejection (missing await?)"),
	floatedHasValue: "value" in results.floatedRead,
	caughtValue: results.caughtRead.value?.value,
	awaitedValue: results.awaitedRead.value?.value,
	caughtEnvelopeOk: results.caughtRead.value?.ok === true,
	awaitedEnvelopeOk: results.awaitedRead.value?.ok === true,
	caughtOk: results.caughtRead.ok,
	awaitedOk: results.awaitedRead.ok,
	failedOk: results.failedRead.ok,
	failedHasValue: "value" in results.failedRead,
};
await finish(result, result.floatedFailed && !result.floatedHasValue && result.caughtOk && result.awaitedOk && result.caughtEnvelopeOk && result.awaitedEnvelopeOk && !result.failedOk && !result.failedHasValue);
`);
		expect(output).toEqual({
			floatedFailed: true,
			floatedHasValue: false,
			caughtValue: "caught",
			awaitedValue: "awaited",
			caughtEnvelopeOk: true,
			awaitedEnvelopeOk: true,
			caughtOk: true,
			awaitedOk: true,
			failedOk: false,
			failedHasValue: false,
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

	it("reads local:// spills from the local root of the run's snapshot, not the first one", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-b-"));
		await Bun.write(path.join(dirA, "5.log"), "from A");
		await Bun.write(path.join(dirB, "5.log"), "from B");
		const harness = createWorkerHarness();
		const probe = globalThis as { __omp_spill_probe?: unknown };
		const run = async (runId: string, root: string) => {
			const result = waitForMessage(harness, message => message.type === "result" && message.runId === runId);
			harness.send({
				type: "run",
				runId,
				code: `globalThis.__omp_spill_probe = await read("local://5.log");`,
				filename: `[${runId}].js`,
				snapshot: { cwd: process.cwd(), sessionId: "spill-roots", localRoots: { local: root } },
			});
			expect(await result).toMatchObject({ type: "result", runId, ok: true });
			return probe.__omp_spill_probe;
		};
		try {
			await initializeWorker(harness, {
				cwd: process.cwd(),
				sessionId: "spill-roots",
				localRoots: { local: dirA },
			});
			expect(await run("spill-a", dirA)).toBe("from A");
			expect(await run("spill-b", dirB)).toBe("from B");
		} finally {
			delete probe.__omp_spill_probe;
			harness.send({ type: "close" });
			await fs.rm(dirA, { recursive: true, force: true });
			await fs.rm(dirB, { recursive: true, force: true });
		}
	});

	it("keeps a suspended run on its own local:// root while an overlapping run uses another", async () => {
		const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-a-"));
		const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "omp-local-b-"));
		await Bun.write(path.join(dirA, "5.log"), "from A");
		await Bun.write(path.join(dirB, "5.log"), "from B");
		const harness = createWorkerHarness();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const probe = globalThis as {
			__omp_roots_gate?: { entered(): void; wait: Promise<void> };
			__omp_roots_probe?: Record<string, unknown>;
		};
		probe.__omp_roots_gate = { entered: () => entered.resolve(), wait: gate.promise };
		probe.__omp_roots_probe = {};
		const snapshot = (root: string): SessionSnapshot => ({
			cwd: process.cwd(),
			sessionId: "spill-roots-overlap",
			localRoots: { local: root },
		});
		try {
			await initializeWorker(harness, snapshot(dirA));
			const holdResult = waitForMessage(harness, message => message.type === "result" && message.runId === "hold");
			harness.send({
				type: "run",
				runId: "hold",
				code: `globalThis.__omp_roots_gate.entered(); await globalThis.__omp_roots_gate.wait; globalThis.__omp_roots_probe.hold = await read("local://5.log");`,
				filename: "[roots-hold].js",
				snapshot: snapshot(dirA),
			});
			await entered.promise;

			const overlapResult = waitForMessage(
				harness,
				message => message.type === "result" && message.runId === "overlap",
			);
			harness.send({
				type: "run",
				runId: "overlap",
				code: `globalThis.__omp_roots_probe.overlap = await read("local://5.log");`,
				filename: "[roots-overlap].js",
				snapshot: snapshot(dirB),
			});
			expect(await overlapResult).toMatchObject({ type: "result", runId: "overlap", ok: true });

			gate.resolve();
			expect(await holdResult).toMatchObject({ type: "result", runId: "hold", ok: true });
			expect(probe.__omp_roots_probe).toEqual({ overlap: "from B", hold: "from A" });
		} finally {
			gate.resolve();
			delete probe.__omp_roots_gate;
			delete probe.__omp_roots_probe;
			harness.send({ type: "close" });
			await fs.rm(dirA, { recursive: true, force: true });
			await fs.rm(dirB, { recursive: true, force: true });
		}
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

	it("returns a safe snapshot only while the JavaScript runtime is idle", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "shadow-snapshot-worker" };
		await initializeWorker(harness, snapshot);
		const reply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "snapshot-1",
		);
		harness.send({ type: "shadow-snapshot", id: "snapshot-1", snapshot });
		const message = await reply;
		if (message.type !== "shadow-snapshot") throw new Error("expected shadow snapshot reply");
		expect(message.eligible).toBe(true);
		expect(message.snapshot?.revision).toBe(0);
	});

	it("starts a real cell only when the retained snapshot still matches", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "atomic-shadow-worker" };
		await initializeWorker(harness, snapshot);
		const snapshotReply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "atomic-snapshot",
		);
		harness.send({ type: "shadow-snapshot", id: "atomic-snapshot", snapshot });
		const captured = await snapshotReply;
		if (captured.type !== "shadow-snapshot" || !captured.snapshot) throw new Error("expected snapshot");
		const admission = waitForMessage(
			harness,
			message => message.type === "shadow-run" && message.id === "atomic-run",
		);
		const result = waitForMessage(harness, message => message.type === "result" && message.runId === "atomic-run-id");
		harness.send({
			type: "run-if-snapshot-matches",
			id: "atomic-run",
			runId: "atomic-run-id",
			code: "globalThis.atomicShadowValue = true;",
			filename: "atomic-shadow.ts",
			snapshot,
			expectedRevision: captured.snapshot.revision,
			expectedDigest: shadowSnapshotDigest(captured.snapshot),
		});
		expect(await admission).toMatchObject({ eligible: true });
		expect(await result).toMatchObject({ ok: true });
	});

	it("rejects an atomic run after retained state changes", async () => {
		const harness = createWorkerHarness();
		const snapshot = { cwd: process.cwd(), sessionId: "atomic-shadow-mismatch" };
		await initializeWorker(harness, snapshot);
		const capturedReply = waitForMessage(
			harness,
			message => message.type === "shadow-snapshot" && message.id === "mismatch-snapshot",
		);
		harness.send({ type: "shadow-snapshot", id: "mismatch-snapshot", snapshot });
		const captured = await capturedReply;
		if (captured.type !== "shadow-snapshot" || !captured.snapshot) throw new Error("expected snapshot");
		const mutationResult = waitForMessage(
			harness,
			message => message.type === "result" && message.runId === "mutation",
		);
		harness.send({
			type: "run",
			runId: "mutation",
			code: "globalThis.atomicMismatch = true;",
			filename: "mutation.ts",
			snapshot,
		});
		await mutationResult;
		const rejected = waitForMessage(
			harness,
			message => message.type === "shadow-run" && message.id === "mismatch-run",
		);
		harness.send({
			type: "run-if-snapshot-matches",
			id: "mismatch-run",
			runId: "should-not-run",
			code: "throw new Error('must not execute');",
			filename: "mismatch.ts",
			snapshot,
			expectedRevision: captured.snapshot.revision,
			expectedDigest: shadowSnapshotDigest(captured.snapshot),
		});
		expect(await rejected).toMatchObject({ eligible: false });
	});
});
