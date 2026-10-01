import { expect, mock, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { IdaHost } from "../src/ida/host";
import type { IdaHostResponse } from "../src/ida/protocol";

type Gate<T> = PromiseWithResolvers<T>;

interface SocketClient {
	socket: net.Socket;
	send(frame: { id: number; op: string; [key: string]: unknown }): Promise<IdaHostResponse>;
	cancel(id: number, target: number): void;
}

// Network failures must not leave a listener, lock, or temporary endpoint alive.
function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: NodeJS.Timeout;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`IDA host ${label} timed out`)), 5_000);
		}),
	]).finally(() => clearTimeout(timer));
}

async function connect(endpoint: string): Promise<SocketClient> {
	const socket = net.createConnection(endpoint);
	const pending = new Map<number, Gate<IdaHostResponse>>();
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", (chunk: string) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
			const frame = JSON.parse(buffer.slice(0, end)) as IdaHostResponse;
			buffer = buffer.slice(end + 1);
			pending.get(frame.id)?.resolve(frame);
			pending.delete(frame.id);
		}
	});
	socket.on("close", () => {
		for (const response of pending.values()) response.reject(new Error("IDA socket closed before response"));
		pending.clear();
	});
	socket.on("error", error => {
		for (const response of pending.values()) response.reject(error);
		pending.clear();
	});
	try {
		await bounded(
			new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			}),
			"connection",
		);
	} catch (error) {
		socket.destroy();
		throw error;
	}
	return {
		socket,
		send(frame: { id: number; op: string; [key: string]: unknown }): Promise<IdaHostResponse> {
			const response = Promise.withResolvers<IdaHostResponse>();
			pending.set(frame.id, response);
			socket.write(`${JSON.stringify(frame)}\n`);
			return bounded(response.promise, `response ${frame.id}`);
		},
		cancel(id: number, target: number): void {
			socket.write(`${JSON.stringify({ id, op: "cancel", target })}\n`);
		},
	};
}

test("pre-open cancellation stays socket-local and shutdown saves accepted mutation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ida-host-"));
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\omp-ida-host-${process.pid}-${path.basename(root)}`
			: path.join(root, "host.sock");
	const openEntered = Promise.withResolvers<void>();
	const openGate = Promise.withResolvers<FakeWorker>();
	const execEntered = Promise.withResolvers<AbortSignal | undefined>();
	const execGate = Promise.withResolvers<void>();
	const closeCalls: boolean[] = [];
	class FakeWorker {
		needsSave = false;
		lock?: { release(): void };
		static async start(_loc: unknown, _runtime: unknown, lock: { release(): void }): Promise<FakeWorker> {
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
	mock.module(import.meta.resolve("../src/ida/supervisor.ts"), () => ({ IdaWorker: FakeWorker }));
	let host: IdaHost | undefined;
	const clients: SocketClient[] = [];
	try {
		// The worker mock must be installed before the host imports its supervisor.
		const { IdaHost } = await import("../src/ida/host");
		const idb = path.join(root, "sample.i64");
		await fs.writeFile(idb, "fake database");
		host = new IdaHost({
			endpoint,
			loc: {
				id: "sample",
				dir: root,
				sourcePath: idb,
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
