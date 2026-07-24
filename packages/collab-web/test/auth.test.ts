import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getRelayBrowserToken } from "../src/lib/auth";
import { RetryableRelayAuthorizationError } from "../src/lib/relay-auth";

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function memoryStorage(): Storage {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: key => values.get(key) ?? null,
		key: index => [...values.keys()][index] ?? null,
		removeItem: key => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
}

beforeEach(() => {
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() });
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
	vi.restoreAllMocks();
});

describe("relay browser authorization", () => {
	it("classifies transient relay responses for reconnect retry", async () => {
		globalThis.fetch = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;

		await expect(getRelayBrowserToken(() => {})).rejects.toBeInstanceOf(RetryableRelayAuthorizationError);
	});

	it("cancels a stalled relay request when the socket closes", async () => {
		globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected an abort signal");
			return new Promise<Response>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}) as unknown as typeof fetch;
		const controller = new AbortController();
		const authorization = getRelayBrowserToken(() => {}, controller.signal);

		controller.abort(new Error("authorization cancelled"));
		await expect(authorization).rejects.toThrow("authorization cancelled");
	});
});
