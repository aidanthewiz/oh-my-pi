import { afterEach, expect, test } from "bun:test";
import { identiconLines } from "@oh-my-pi/pi-coding-agent/cli/git-tui/avatar";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

test("author identicons are deterministic and offline", () => {
	let fetched = false;
	globalThis.fetch = (() => {
		fetched = true;
		throw new Error("unexpected network request");
	}) as unknown as typeof fetch;

	const colorize = (hex: string, text: string): string => `${hex}:${text}`;
	const first = identiconLines("author@example.com", colorize);
	const second = identiconLines(" AUTHOR@example.com ", colorize);

	expect(first).toEqual(second);
	expect(first).toHaveLength(3);
	expect(fetched).toBeFalse();
});
