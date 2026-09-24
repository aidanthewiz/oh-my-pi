import { afterEach, describe, expect, it, vi } from "bun:test";
import { CollabSocket } from "../../src/collab/relay-client";

const NativeWebSocket = globalThis.WebSocket;

class ScriptedWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: ScriptedWebSocket[] = [];

	readonly url: string;
	binaryType = "arraybuffer";
	bufferedAmount = 0;
	sent: unknown[] = [];
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onopen: ((event: Event) => void) | null = null;
	readyState = ScriptedWebSocket.CONNECTING;

	constructor(url: string | URL) {
		this.url = String(url);
		ScriptedWebSocket.instances.push(this);
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	open(): void {
		this.readyState = ScriptedWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}
	relayMessage(data: string): void {
		this.onmessage?.(new MessageEvent("message", { data }));
	}

	relayClose(code: number, reason: string): void {
		this.readyState = ScriptedWebSocket.CLOSED;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}

	close(code = 1000, reason = "closed"): void {
		if (this.readyState === ScriptedWebSocket.CLOSED) return;
		this.relayClose(code, reason);
	}
}

function installScriptedWebSocket(): void {
	ScriptedWebSocket.instances = [];
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: ScriptedWebSocket });
}

function restoreNativeWebSocket(): void {
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: NativeWebSocket });
}

function guestSocket(key: CryptoKey): CollabSocket {
	return new CollabSocket({
		wsUrl: "ws://localhost:8788/r/transient-network-room",
		role: "guest",
		key,
	});
}

function instance(index: number): ScriptedWebSocket {
	const ws = ScriptedWebSocket.instances[index];
	if (!ws) throw new Error(`WebSocket instance ${index} was not created`);
	return ws;
}

afterEach(() => {
	restoreNativeWebSocket();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("CollabSocket guest room recovery", () => {
	it("retries a host-closed room and missing-room races until the host returns", async () => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const closes: Array<{ reason: string; willReconnect: boolean }> = [];
		const socket = guestSocket(key);
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

		try {
			socket.connect();
			instance(0).open();
			instance(0).relayClose(4001, "room closed");
			expect(closes).toEqual([{ reason: "room closed", willReconnect: true }]);

			vi.advanceTimersByTime(1_000);
			instance(1).open();
			instance(1).relayClose(4004, "no such room");
			expect(closes.at(-1)).toEqual({ reason: "no such room", willReconnect: true });

			vi.advanceTimersByTime(1_000);
			expect(ScriptedWebSocket.instances).toHaveLength(2);
			vi.advanceTimersByTime(1_000);
			instance(2).open();
			expect(socket.isOpen).toBe(true);
		} finally {
			socket.close();
		}
	});

	it("keeps a missing room terminal on the initial join", async () => {
		vi.useFakeTimers();
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const closes: Array<{ reason: string; willReconnect: boolean }> = [];
		const socket = guestSocket(key);
		socket.onClose = (reason, willReconnect) => closes.push({ reason, willReconnect });

		socket.connect();
		instance(0).open();
		instance(0).relayClose(4004, "no such room");

		expect(closes).toEqual([{ reason: "no such room", willReconnect: false }]);
		vi.advanceTimersByTime(30_000);
		expect(ScriptedWebSocket.instances).toHaveLength(1);
	});

	it("ignores a rejected authentication attempt after close and reconnect", async () => {
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const stale = Promise.withResolvers<string>();
		const current = Promise.withResolvers<string>();
		let authAttempt = 0;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/auth-reconnect-room",
			role: "guest",
			key,
			getAuthToken: () => (++authAttempt === 1 ? stale.promise : current.promise),
		});
		const closes: string[] = [];
		socket.onClose = reason => closes.push(reason);

		try {
			socket.connect();
			socket.close();
			closes.length = 0;
			socket.connect();
			current.resolve("current-token");
			await current.promise;
			instance(0).open();
			expect(instance(0).sent).toEqual([JSON.stringify({ t: "auth", token: "current-token" })]);
			instance(0).relayMessage(JSON.stringify({ t: "auth-ok" }));
			expect(socket.isOpen).toBe(true);

			stale.reject(new Error("stale authentication"));
			await stale.promise.catch(() => undefined);
			expect(socket.isOpen).toBe(true);
			expect(closes).toEqual([]);
		} finally {
			socket.close();
		}
	});

	it("ignores a fulfilled authentication attempt after close and reconnect", async () => {
		installScriptedWebSocket();
		const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
		const stale = Promise.withResolvers<string>();
		const current = Promise.withResolvers<string>();
		let authAttempt = 0;
		const socket = new CollabSocket({
			wsUrl: "ws://localhost:8788/r/auth-reconnect-room",
			role: "guest",
			key,
			getAuthToken: () => (++authAttempt === 1 ? stale.promise : current.promise),
		});

		try {
			socket.connect();
			socket.close();
			socket.connect();
			current.resolve("current-token");
			await current.promise;
			expect(ScriptedWebSocket.instances).toHaveLength(1);

			stale.resolve("stale-token");
			await stale.promise;
			expect(ScriptedWebSocket.instances).toHaveLength(1);
			instance(0).open();
			expect(instance(0).sent).toEqual([JSON.stringify({ t: "auth", token: "current-token" })]);
		} finally {
			socket.close();
		}
	});
});
