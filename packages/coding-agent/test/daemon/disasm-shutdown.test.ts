import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { isolateDaemonForSmokeTest } from "../../src/daemon/client";
import type { ModuleContext, ModuleTunnel, ModuleUnit } from "../../src/daemon/module";
import { disasmModule } from "../../src/daemon/modules/disasm";
import type { DisasmUnitParams, HostResponse } from "../../src/disasm/protocol";
import { DisasmWorker } from "../../src/disasm/supervisor";

function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

class Client implements ModuleTunnel {
	readonly client = { connectionId: crypto.randomUUID(), pid: process.pid, build: "test" };
	readonly pending = new Map<number, PromiseWithResolvers<HostResponse>>();
	closed = false;
	#onData: ((chunk: Uint8Array) => void) | undefined;
	#onClose: (() => void) | undefined;
	readonly #encoder = new TextEncoder();

	send(data: string | Uint8Array): boolean {
		const text = typeof data === "string" ? data : new TextDecoder().decode(data);
		for (const line of text.trim().split("\n")) {
			const response = JSON.parse(line) as HostResponse;
			this.pending.get(response.id)?.resolve(response);
			this.pending.delete(response.id);
		}
		return true;
	}

	drained(): Promise<void> {
		return Promise.resolve();
	}
	start(onData: (chunk: Uint8Array) => void, onClose: () => void): void {
		this.#onData = onData;
		this.#onClose = onClose;
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#onClose?.();
		for (const response of this.pending.values()) response.reject(new Error("Disassembler tunnel closed"));
		this.pending.clear();
	}
	request(frame: { id: number; op: string; [key: string]: unknown }, timeoutMs?: number): Promise<HostResponse> {
		const response = Promise.withResolvers<HostResponse>();
		this.pending.set(frame.id, response);
		this.#onData?.(this.#encoder.encode(`${JSON.stringify(frame)}\n`));
		return bounded(response.promise, `response ${frame.id}`, timeoutMs);
	}
	cancel(target: number): void {
		this.#onData?.(this.#encoder.encode(`${JSON.stringify({ id: 999, op: "cancel", target })}\n`));
	}
}

class ControlledWorker {
	readonly opening = Promise.withResolvers<void>();
	readonly openGate = Promise.withResolvers<void>();
	readonly executing = Promise.withResolvers<AbortSignal>();
	readonly execGate = Promise.withResolvers<void>();
	readonly exit = Promise.withResolvers<number>();
	readonly exited = this.exit.promise;
	readonly closeCalls: boolean[] = [];
	readonly pid = process.pid;
	readonly adopted = false;
	readonly ref = "sample";
	readonly idbPath = "sample.i64";
	readonly info = { module: "sample", format: "test", arch: "test", bitness: 64 };
	readonly current = null;
	lastUsed = 0;
	opened = false;
	running = true;
	busy = false;
	needsSave = false;
	lock: { release(): void } | undefined;
	#rejectExecution: ((error: Error) => void) | undefined;

	constructor(
		readonly stuck = false,
		readonly failClose = false,
	) {}
	onActivity(): void {}
	async open(): Promise<void> {
		this.opening.resolve();
		await this.openGate.promise;
		this.opened = true;
	}
	async request(method: string, _params: object, options: { signal?: AbortSignal }): Promise<string> {
		if (method !== "exec" || !options.signal) throw new Error("Expected interruptible exec");
		options.signal.throwIfAborted();
		this.executing.resolve(options.signal);
		this.busy = true;
		try {
			if (this.stuck) {
				await new Promise<never>((_, reject) => {
					this.#rejectExecution = reject;
					options.signal!.addEventListener("abort", () => reject(new Error("Execution interrupted")), {
						once: true,
					});
				});
			} else await this.execGate.promise;
			this.needsSave = true;
			return "mutation complete";
		} finally {
			this.busy = false;
		}
	}
	async close({ save }: { save: boolean }): Promise<void> {
		this.closeCalls.push(save);
		await this.kill();
		if (this.failClose) throw new Error("Deliberate close failure");
	}
	async kill(): Promise<void> {
		this.running = false;
		this.lock?.release();
		this.exit.resolve(0);
	}
	unblock(): void {
		this.openGate.resolve();
		this.execGate.resolve();
		this.#rejectExecution?.(new Error("Test cleanup"));
	}
}

async function openUnit(root: string, worker: ControlledWorker): Promise<{ unit: ModuleUnit; file: string }> {
	const file = path.join(root, "sample.i64");
	await fs.writeFile(file, "synthetic database");
	vi.spyOn(DisasmWorker, "spawn").mockImplementation(async (_backend, _loc, _runtime, lock) => {
		worker.lock = lock;
		return worker as unknown as DisasmWorker;
	});
	const context: ModuleContext = {
		stateDir: root,
		spawn: () => {
			throw new Error("Unexpected real worker spawn");
		},
		adoptChild: () => undefined,
		changed: () => {},
		unit: () => undefined,
	};
	await disasmModule.init?.(context);
	const params: DisasmUnitParams = {
		backend: "ida",
		loc: {
			id: "sample",
			dir: root,
			sourcePath: file,
			stagedPath: file,
			kind: "inplace",
			openPath: file,
			isNew: false,
			lockTarget: file,
		},
		runtime: { pythonPath: "unused", env: {} },
		idleCloseMs: 0,
		maxOpen: 4,
	};
	const unit = await disasmModule.open(context, {
		unitId: "shutdown-test",
		scope: { kind: "global" },
		key: "sample",
		params,
		client: { connectionId: "owner", pid: process.pid, build: "test" },
	});
	await bounded(worker.opening.promise, "worker open");
	return { unit, file };
}

test("pre-open cancellation stays tunnel-local and shutdown saves the accepted mutation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disasm-shutdown-"));
	const restoreDaemon = await isolateDaemonForSmokeTest();
	const worker = new ControlledWorker(false, true);
	let unit: ModuleUnit | undefined;
	const first = new Client();
	const second = new Client();
	try {
		const opened = await openUnit(root, worker);
		unit = opened.unit;
		await unit.attach(first, undefined);
		await unit.attach(second, undefined);
		const cancelled = first.request({ id: 1, op: "call", method: "exec", params: {} });
		expect((await first.request({ id: 2, op: "status" })).ok).toBe(true);
		const mutation = second.request({ id: 3, op: "call", method: "exec", params: {} });
		expect((await second.request({ id: 4, op: "status" })).ok).toBe(true);
		first.cancel(3);
		first.cancel(1);
		expect((await first.request({ id: 5, op: "status" })).ok).toBe(true);
		worker.openGate.resolve();
		expect((await cancelled).ok).toBe(false);
		const signal = await bounded(worker.executing.promise, "accepted execution");
		expect(signal.aborted).toBe(false);
		const stopping = unit.stop("test shutdown");
		expect(worker.closeCalls).toEqual([]);
		worker.execGate.resolve();
		expect(await mutation).toEqual({ id: 3, ok: true, result: "mutation complete" });
		await bounded(stopping, "shutdown");
		expect(worker.closeCalls).toEqual([true]);
		expect(first.closed && second.closed).toBe(true);
		const lock = tryAcquireFileLock(opened.file);
		expect(lock).not.toBeNull();
		lock?.release();
	} finally {
		worker.unblock();
		await bounded(unit?.stop("cleanup") ?? Promise.resolve(), "cleanup");
		first.close();
		second.close();
		vi.restoreAllMocks();
		await restoreDaemon();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);

test("shutdown interrupts a stuck accepted call after its grace and releases the worker", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disasm-shutdown-"));
	const restoreDaemon = await isolateDaemonForSmokeTest();
	const worker = new ControlledWorker(true);
	worker.needsSave = true;
	worker.openGate.resolve();
	let unit: ModuleUnit | undefined;
	const client = new Client();
	try {
		const opened = await openUnit(root, worker);
		unit = opened.unit;
		await unit.attach(client, undefined);
		const request = client.request({ id: 1, op: "call", method: "exec", params: {} }, 35_000);
		const signal = await bounded(worker.executing.promise, "accepted execution");
		vi.useFakeTimers();
		const stopping = unit.stop("test shutdown");
		vi.advanceTimersByTime(29_999);
		expect(signal.aborted).toBe(false);
		expect(worker.closeCalls).toEqual([]);
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(signal.aborted).toBe(true);
		vi.useRealTimers();
		expect((await request).ok).toBe(false);
		await bounded(stopping, "shutdown");
		expect(worker.closeCalls).toEqual([true]);
		expect(client.closed).toBe(true);
		const lock = tryAcquireFileLock(opened.file);
		expect(lock).not.toBeNull();
		lock?.release();
	} finally {
		vi.useRealTimers();
		worker.unblock();
		await bounded(unit?.stop("cleanup") ?? Promise.resolve(), "cleanup");
		client.close();
		vi.restoreAllMocks();
		await restoreDaemon();
		await fs.rm(root, { recursive: true, force: true });
	}
}, 15_000);
