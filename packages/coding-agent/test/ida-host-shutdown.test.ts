import { expect, mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import { IpcConnection, ipcEndpoint } from "@oh-my-pi/pi-natives";
import * as os from "node:os";
import * as path from "node:path";
import type { DisasmHost } from "../src/disasm/host";
import type { HostResponse } from "../src/disasm/protocol";

type Gate<T> = PromiseWithResolvers<T>;

interface SocketClient {
	socket: IpcConnection;
	send(frame: { id: number; op: string; [key: string]: unknown }, timeoutMs?: number): Promise<HostResponse>;
	cancel(id: number, target: number): void;
}

// Network failures must not leave a listener, lock, or temporary endpoint alive.
function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`IDA host ${label} timed out`)), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

async function connect(endpoint: string): Promise<SocketClient> {
	const socket = await IpcConnection.connect(endpoint, { framing: "lines", timeoutMs: 5_000 });
	const pending = new Map<number, Gate<HostResponse>>();
	socket.start(
		line => {
			const frame = JSON.parse(line) as HostResponse;
			pending.get(frame.id)?.resolve(frame);
			pending.delete(frame.id);
		},
		reason => {
			for (const response of pending.values())
				response.reject(new Error(reason ?? "IDA connection closed before response"));
			pending.clear();
		},
	);
	return {
		socket,
		send(frame: { id: number; op: string; [key: string]: unknown }, timeoutMs?: number): Promise<HostResponse> {
			const response = Promise.withResolvers<HostResponse>();
			pending.set(frame.id, response);
			socket.send(JSON.stringify(frame));
			return bounded(response.promise, `response ${frame.id}`, timeoutMs);
		},
		cancel(id: number, target: number): void {
			socket.send(JSON.stringify({ id, op: "cancel", target }));
		},
	};
}

test("pre-open cancellation stays socket-local and shutdown saves accepted mutation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ida-host-"));
	const endpoint = ipcEndpoint(root, "host");
	const openEntered = Promise.withResolvers<void>();
	const openGate = Promise.withResolvers<FakeWorker>();
	const execEntered = Promise.withResolvers<AbortSignal | undefined>();
	const execGate = Promise.withResolvers<void>();
	const closeCalls: boolean[] = [];
	class FakeWorker {
		needsSave = false;
		lock?: { release(): void };
		static async start(
			_backend: unknown,
			_loc: unknown,
			_runtime: unknown,
			lock: { release(): void },
		): Promise<FakeWorker> {
			openEntered.resolve();
			const worker = await openGate.promise;
			worker.lock = lock;
			return worker;
		}
		async request(method: string, _params: object, options: { signal?: AbortSignal }) {
			if (method !== "exec") throw new Error(`unexpected worker request: ${method}`);
			if (options.signal?.aborted) throw new Error("cancelled before open");
			execEntered.resolve(options.signal);
			await execGate.promise;
			this.needsSave = true;
			return "mutation complete";
		}
		async close({ save }: { save: boolean }): Promise<void> {
			closeCalls.push(save);
			this.lock?.release();
			throw new Error("deliberate close failure");
		}
	}
	mock.module(import.meta.resolve("../src/disasm/supervisor.ts"), () => ({ DisasmWorker: FakeWorker }));
	let host: DisasmHost | undefined;
	const clients: SocketClient[] = [];
	try {
		// The worker mock must be installed before the host imports its supervisor.
		const { DisasmHost } = await import("../src/disasm/host");
		const idb = path.join(root, "sample.i64");
		await fs.writeFile(idb, "fake database");
		host = new DisasmHost({
			backend: "ida",
			projectDir: root,
			endpoint,
			loc: {
				id: "sample",
				dir: root,
				sourcePath: idb,
				stagedPath: idb,
				kind: "inplace",
				openPath: idb,
				isNew: false,
				lockTarget: idb,
			},
			runtime: { pythonPath: "unused", env: {} },
			idleCloseMs: 0,
		});
		await bounded(host.listen(), "listen");
		await bounded(openEntered.promise, "worker start");
		const first = await connect(endpoint);
		clients.push(first);
		const second = await connect(endpoint);
		clients.push(second);
		const cancelled = first.send({ id: 1, op: "call", method: "exec", params: {} });
		void cancelled.catch(() => undefined);
		// A ping on the same socket proves the call frame was accepted before cancellation.
		expect(await first.send({ id: 2, op: "ping" })).toEqual({ id: 2, ok: true, result: "pong" });
		const mutation = second.send({ id: 3, op: "call", method: "exec", params: {} });
		void mutation.catch(() => undefined);
		expect(await second.send({ id: 4, op: "ping" })).toEqual({ id: 4, ok: true, result: "pong" });
		first.cancel(9, 3);
		first.cancel(10, 1);
		expect(await first.send({ id: 5, op: "ping" })).toEqual({ id: 5, ok: true, result: "pong" });
		openGate.resolve(new FakeWorker());
		expect(await cancelled).toEqual({ id: 1, ok: false, error: "cancelled before open" });

		first.cancel(11, 1);
		const signal = await bounded(execEntered.promise, "exec admission");
		expect(signal?.aborted).toBe(false);
		const stopping = host.shutdown();
		expect(closeCalls).toEqual([]);
		execGate.resolve();
		expect(await mutation).toEqual({ id: 3, ok: true, result: "mutation complete" });
		await bounded(stopping, "shutdown");
		expect(closeCalls).toEqual([true]);
		if (process.platform !== "win32") {
			expect(
				await fs.stat(endpoint).then(
					() => true,
					() => false,
				),
			).toBe(false);
		}
	} finally {
		openGate.resolve(new FakeWorker());
		execGate.resolve();
		for (const client of clients) client.socket.destroy();
		try {
			if (host) await bounded(host.shutdown(), "cleanup");
		} finally {
			mock.restore();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);

test("shutdown interrupts a stuck accepted call and closes the worker", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ida-host-"));
	const endpoint = ipcEndpoint(root, "host");
	const entered = Promise.withResolvers<AbortSignal>();
	const closeCalls: boolean[] = [];
	class StuckWorker {
		needsSave = true;
		lock?: { release(): void };
		static async start(
			_backend: unknown,
			_loc: unknown,
			_runtime: unknown,
			lock: { release(): void },
		): Promise<StuckWorker> {
			const worker = new StuckWorker();
			worker.lock = lock;
			return worker;
		}
		async request(method: string, _params: object, options: { signal?: AbortSignal }): Promise<never> {
			const signal = options.signal;
			if (method !== "exec" || !signal) throw new Error("expected interruptible exec");
			entered.resolve(signal);
			const interrupted = Promise.withResolvers<never>();
			signal.addEventListener("abort", () => interrupted.reject(new Error("exec interrupted")), { once: true });
			if (signal.aborted) interrupted.reject(new Error("exec interrupted"));
			return interrupted.promise;
		}
		async close({ save }: { save: boolean }): Promise<void> {
			closeCalls.push(save);
			this.lock?.release();
		}
	}
	mock.module(import.meta.resolve("../src/disasm/supervisor.ts"), () => ({ DisasmWorker: StuckWorker }));
	let host: DisasmHost | undefined;
	let client: SocketClient | undefined;
	try {
		const { DisasmHost } = await import("../src/disasm/host");
		const idb = path.join(root, "sample.i64");
		await fs.writeFile(idb, "fake database");
		host = new DisasmHost({
			backend: "ida",
			projectDir: root,
			endpoint,
			loc: {
				id: "sample",
				dir: root,
				sourcePath: idb,
				stagedPath: idb,
				kind: "inplace",
				openPath: idb,
				isNew: false,
				lockTarget: idb,
			},
			runtime: { pythonPath: "unused", env: {} },
			idleCloseMs: 0,
		});
		await bounded(host.listen(), "listen");
		client = await connect(endpoint);
		const stuck = client.send({ id: 1, op: "call", method: "exec", params: {} }, 35_000);
		void stuck.catch(() => undefined);
		const signal = await bounded(entered.promise, "exec admission");
		vi.useFakeTimers();
		const stopping = host.shutdown();
		vi.advanceTimersByTime(29_999);
		expect(signal.aborted).toBe(false);
		expect(closeCalls).toEqual([]);
		vi.advanceTimersByTime(1);
		await Promise.resolve();
		await Promise.resolve();
		expect(signal.aborted).toBe(true);
		vi.useRealTimers();
		expect(await stuck).toEqual({ id: 1, ok: false, error: "exec interrupted" });
		await bounded(stopping, "shutdown");
		expect(closeCalls).toEqual([true]);
		if (process.platform !== "win32") {
			expect(
				await fs.stat(endpoint).then(
					() => true,
					() => false,
				),
			).toBe(false);
		}
	} finally {
		vi.useRealTimers();
		client?.socket.destroy();
		try {
			if (host) await bounded(host.shutdown(), "cleanup");
		} finally {
			mock.restore();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}, 15_000);
