import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { TUI, type TuiPaint } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { streamSocketEndpoint } from "../../src/stream/paths";
import { StreamPublisher } from "../../src/stream/publisher";
import { STREAM_LOCAL_PROTO, type StreamSessionFrame } from "../../src/stream/protocol";
import { StreamRedactor } from "../../src/stream/redactor";
import { gateNativeDeliveryUntilEof } from "./ipc-delivery";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function localStreamer(
	initialFrames: object[] = [{ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" }],
): Promise<{ cwd: string; peer: Promise<IpcConnection>; closed: Promise<void> }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publisher-control-"));
	const endpoint = await streamSocketEndpoint(cwd);
	const peer = Promise.withResolvers<IpcConnection>();
	const closed = Promise.withResolvers<void>();
	let connection: IpcConnection | undefined;
	const server = await IpcServer.listen(endpoint, { framing: "lines" }, conn => {
		connection = conn;
		conn.start(
			line => {
				if (JSON.parse(line).t !== "hello") return;
				for (const frame of initialFrames) conn.send(JSON.stringify(frame));
				peer.resolve(conn);
			},
			() => closed.resolve(),
		);
	});
	cleanup.push(async () => {
		connection?.destroy();
		await server.close();
		await fs.rm(cwd, { recursive: true, force: true });
	});
	return { cwd, peer: peer.promise, closed: closed.promise };
}

describe("StreamPublisher", () => {
	it("delivers final chat and viewer payloads before detaching after native EOF", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-publisher-eof-"));
		const endpoint = await streamSocketEndpoint(cwd);
		const accepted = Promise.withResolvers<IpcConnection>();
		const server = await IpcServer.listen(endpoint, { framing: "lines" }, conn => {
			conn.start(
				line => {
					if (JSON.parse(line).t !== "hello") return;
					conn.send(JSON.stringify({ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" }));
					accepted.resolve(conn);
				},
				() => {},
			);
		});
		let peer: IpcConnection | undefined;
		cleanup.push(async () => {
			peer?.destroy();
			await server.close();
			await fs.rm(cwd, { recursive: true, force: true });
		});
		const gate = gateNativeDeliveryUntilEof();
		try {
			const chats: unknown[] = [];
			const statuses: unknown[] = [];
			const detached = Promise.withResolvers<void>();
			const publisher = await StreamPublisher.connect({
				cwd,
				sessionId: "eof",
				title: "EOF",
				tui: new TUI(new VirtualTerminal(80, 24)),
				redactor: new StreamRedactor([], []),
				onChat: message => chats.push(message),
				onStatus: status => {
					statuses.push(status);
					if (status === null) detached.resolve();
				},
			});
			expect(publisher).not.toBeNull();
			peer = await accepted.promise;
			const first = { id: 1, name: "viewer", text: "final chat one", ts: 1700000000000 };
			const second = { id: 2, name: "viewer", text: "final chat two", ts: 1700000000001 };
			gate.arm();
			for (const frame of [
				{ t: "chat", msg: first },
				{ t: "viewers", n: 9 },
				{ t: "chat", msg: second },
			]) {
				peer.send(JSON.stringify(frame));
			}
			peer.end();
			await detached.promise;
			expect(chats).toEqual([first, second]);
			expect(statuses).toEqual([{ viewers: 0 }, { viewers: 9 }, null]);
		} finally {
			gate.restore();
		}
	});

	it.each(["dispose", "bye"])("suppresses queued actions after %s", async action => {
		const fixture = await localStreamer();
		const chats: unknown[] = [];
		const statuses: unknown[] = [];
		let publisher: StreamPublisher | null = null;
		publisher = await StreamPublisher.connect({
			cwd: fixture.cwd,
			sessionId: "cancel",
			title: "Cancel",
			tui: new TUI(new VirtualTerminal(80, 24)),
			redactor: new StreamRedactor([], []),
			onChat: message => {
				chats.push(message);
				if (action === "dispose") publisher?.dispose();
			},
			onStatus: status => statuses.push(status),
		});
		expect(publisher).not.toBeNull();
		const peer = await fixture.peer;
		const first = { id: 1, name: "viewer", text: "cancel now", ts: 1700000000000 };
		const second = { id: 2, name: "viewer", text: "must not appear", ts: 1700000000001 };
		const frames = [
			...(action === "bye" ? [{ t: "bye", reason: "stream ended" }] : []),
			{ t: "chat", msg: first },
			{ t: "viewers", n: 99 },
			{ t: "chat", msg: second },
		];
		for (const frame of frames) peer.send(JSON.stringify(frame));
		peer.end();
		await fixture.closed;
		expect(chats).toEqual(action === "dispose" ? [first] : []);
		expect(statuses).toEqual([{ viewers: 0 }, null]);
	});

	it("rejects a protocol mismatch before collecting secrets or dispatching queued chat", async () => {
		const message = { id: 1, name: "viewer", text: "untrusted", ts: 1700000000000 };
		const fixture = await localStreamer([
			{ t: "welcome", proto: -1, channel: "invalid", url: "invalid" },
			{ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" },
			{ t: "chat", msg: message },
		]);
		const chats: unknown[] = [];
		const statuses: unknown[] = [];
		let secretLoads = 0;
		const publisher = await StreamPublisher.connectLazy({
			cwd: fixture.cwd,
			sessionId: "invalid",
			title: "Invalid",
			tui: new TUI(new VirtualTerminal(80, 24)),
			loadRedactor: async () => {
				secretLoads++;
				return new StreamRedactor([], []);
			},
			onChat: message => chats.push(message),
			onStatus: status => statuses.push(status),
		});
		await fixture.closed;
		expect(publisher).toBeNull();
		expect(secretLoads).toBe(0);
		expect(chats).toEqual([]);
		expect(statuses).toEqual([]);
	});

	it("drains final chat during lazy redactor initialization without reviving a closed publisher", async () => {
		const fixture = await localStreamer();
		const loading = Promise.withResolvers<void>();
		const redactor = Promise.withResolvers<StreamRedactor>();
		const chats: unknown[] = [];
		const statuses: unknown[] = [];
		const tui = new TUI(new VirtualTerminal(80, 24));
		let subscribed = false;
		const addPaintListener = tui.addPaintListener.bind(tui);
		spyOn(tui, "addPaintListener").mockImplementation(listener => {
			subscribed = true;
			const unsubscribe = addPaintListener(listener);
			return () => {
				subscribed = false;
				unsubscribe();
			};
		});
		const gate = gateNativeDeliveryUntilEof();
		try {
			const connecting = StreamPublisher.connectLazy({
				cwd: fixture.cwd,
				sessionId: "lazy",
				title: "Lazy",
				tui,
				loadRedactor: () => {
					loading.resolve();
					return redactor.promise;
				},
				onChat: message => chats.push(message),
				onStatus: status => statuses.push(status),
			});
			await loading.promise;
			const peer = await fixture.peer;
			const message = { id: 7, name: "viewer", text: "last lazy chat", ts: 1700000000000 };
			gate.arm();
			peer.send(JSON.stringify({ t: "chat", msg: message }));
			peer.end();
			await gate.closed;
			redactor.resolve(new StreamRedactor([], []));
			expect(await connecting).toBeNull();
			expect(chats).toEqual([message]);
			expect(statuses).toEqual([{ viewers: 0 }, null]);
			expect(subscribed).toBe(false);
		} finally {
			gate.restore();
		}
	});

	it("publishes viewport deltas and ordered resets, then detaches when the streamer closes", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stream-publisher-"));
		const endpoint = await streamSocketEndpoint(cwd);
		const frames: StreamSessionFrame[] = [];
		const frameWaiters: Array<{ count: number; resolve: () => void }> = [];
		const waitForFrameCount = (count: number): Promise<void> => {
			if (frames.length >= count) return Promise.resolve();
			const waiter = Promise.withResolvers<void>();
			frameWaiters.push({ count, resolve: waiter.resolve });
			return waiter.promise;
		};
		let peer: IpcConnection | undefined;
		const server = await IpcServer.listen(endpoint, { framing: "lines" }, conn => {
			peer = conn;
			conn.start(
				line => {
					const frame = JSON.parse(line) as StreamSessionFrame;
					frames.push(frame);
					for (let index = frameWaiters.length - 1; index >= 0; index--) {
						const waiter = frameWaiters[index]!;
						if (frames.length < waiter.count) continue;
						frameWaiters.splice(index, 1);
						waiter.resolve();
					}
					if (frame.t === "hello") {
						conn.send(JSON.stringify({ t: "welcome", proto: STREAM_LOCAL_PROTO, channel: "test", url: "test" }));
					}
				},
				() => {},
			);
		});
		cleanup.push(async () => {
			peer?.destroy();
			await server.close();
			await fs.rm(cwd, { recursive: true, force: true });
		});

		const tui = new TUI(new VirtualTerminal(80, 24));
		let listener: ((paint: TuiPaint) => void) | null = null;
		const originalAddPaintListener = tui.addPaintListener.bind(tui);
		spyOn(tui, "addPaintListener").mockImplementation(next => {
			listener = next;
			const unsubscribe = originalAddPaintListener(next);
			return () => {
				listener = null;
				unsubscribe();
			};
		});
		const statuses: Array<{ viewers: number } | null> = [];
		const detached = Promise.withResolvers<void>();
		const publisher = await StreamPublisher.connect({
			cwd,
			sessionId: "session-1",
			title: "publisher-test",
			tui,
			redactor: await StreamRedactor.load(cwd, ["secret-[a-z]+"]),
			onStatus: status => {
				statuses.push(status);
				if (status === null) detached.resolve();
			},
		});
		expect(publisher).not.toBeNull();
		expect(listener).not.toBeNull();

		const paint = (viewport: readonly string[], options?: { reset?: boolean; history?: readonly string[] }): void => {
			listener?.({
				history: options?.history ?? [],
				viewport,
				reset: options?.reset ?? false,
				alt: false,
				columns: 80,
				rows: 24,
			});
		};
		paint(["\x1b[31msecret-token\x1b[0m", "two", "three", "four"]);
		await waitForFrameCount(2);
		paint(["\x1b[31msecret-token\x1b[0m", "TWO", "three", "four"]);
		await waitForFrameCount(3);
		paint(["ONE", "TWO", "THREE", "FOUR"]);
		await waitForFrameCount(4);
		paint(["new", "screen"], { reset: true, history: ["committed"] });
		await waitForFrameCount(7);

		expect(frames[0]).toEqual({
			t: "hello",
			proto: STREAM_LOCAL_PROTO,
			sessionId: "session-1",
			title: "publisher-test",
			cols: 80,
			rows: 24,
		});
		const payload = frames.filter(frame => frame.t !== "hello");
		expect(payload[0]).toEqual({ t: "viewport", rows: ["••••••", "two", "three", "four"] });
		expect(payload[1]).toEqual({ t: "patch", ops: [[1, "TWO"]], rows: 4 });
		expect(payload[2]).toEqual({ t: "viewport", rows: ["ONE", "TWO", "THREE", "FOUR"] });
		expect(payload.slice(3, 6)).toEqual([
			{ t: "reset" },
			{ t: "history", rows: ["committed"] },
			{ t: "viewport", rows: ["new", "screen"] },
		]);

		peer?.destroy();
		await detached.promise;
		expect(listener).toBeNull();
		expect(statuses).toEqual([{ viewers: 0 }, null]);
	});
});
