import { describe, expect, test } from "bun:test";
import * as vm from "node:vm";
import { gzipSync } from "node:zlib";
import { type Document, type Element, type Event, type HTMLElement, parseHTML } from "@oh-my-pi/pi-utils/dom";
import { Marked } from "@oh-my-pi/pi-utils/marked";

const [templateHtml, shellHtml, templateJs, shareLoaderJs] = await Promise.all([
	Bun.file(new URL("../src/export/html/template.html.txt", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/shell.html", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/template.js", import.meta.url)).text(),
	Bun.file(new URL("../src/export/html/share-loader.js", import.meta.url)).text(),
]);
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index);
const keyFragment = `#${Buffer.from(keyBytes).toString("base64url")}`;
const shareUrl = `https://export.invalid/s/synthetic_skip_01?view=trace${keyFragment}`;
const transcriptText = "Synthetic transcript $& literal";
const browserToken = "s".repeat(43);
const sessionData = {
	header: {
		type: "session",
		version: 3,
		id: "synthetic-skip",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: "/synthetic",
		title: "Synthetic skip fixture",
	},
	entries: [
		{
			type: "message",
			id: "user-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: transcriptText }], timestamp: 1 },
		},
	],
	leafId: "user-1",
	trace: { summary: { requests: 0, toolCalls: 0, subagents: 0 } },
};

async function sealSession(): Promise<Uint8Array> {
	const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 32);
	const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gzipSync(JSON.stringify(sessionData))),
	);
	const sealed = new Uint8Array(iv.length + ciphertext.length);
	sealed.set(iv);
	sealed.set(ciphertext, iv.length);
	return sealed;
}

interface ViewerFixture {
	document: Document;
	location: URL;
	content: HTMLElement;
	scrollBlock(): string | undefined;
	copiedUrl(): string | undefined;
	ready(): Promise<void>;
	skip(): { control: Element; event: Event };
}

function createViewer(url: string, sealed?: Uint8Array, waitForBlob?: Promise<void>): ViewerFixture {
	const { document, window } = parseHTML(templateHtml.replace("</body>", `${shellHtml}</body>`));
	const location = new URL(url);
	Object.defineProperty(window, "location", { value: location, configurable: true });
	Object.defineProperty(window, "matchMedia", {
		value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
		configurable: true,
	});
	const themeSelect = document.getElementById("theme-select")!;
	let themeValue = "auto";
	Object.defineProperty(themeSelect, "value", {
		get: () => themeValue,
		set: next => {
			themeValue = String(next);
		},
		configurable: true,
	});
	const content = document.getElementById("content")!;
	let scrollBlock: string | undefined;
	Object.defineProperty(content, "scrollIntoView", {
		value(options: { block?: string }) {
			scrollBlock = options.block;
		},
		configurable: true,
	});
	document.getElementById("session-data")!.textContent = Buffer.from(JSON.stringify(sessionData)).toBase64();
	let copiedUrl: string | undefined;
	const context = vm.createContext({
		window,
		document,
		location,
		ompMarkdown: { Marked },
		hljs: {
			getLanguage: () => false,
			highlight: () => ({ value: "" }),
			highlightAuto: () => ({ value: "" }),
		},
		URL,
		URLSearchParams,
		TextDecoder,
		Uint8Array,
		atob,
		crypto,
		Response,
		Blob,
		DecompressionStream,
		navigator: {
			clipboard: {
				async writeText(text: string) {
					copiedUrl = text;
				},
			},
		},
		localStorage: { getItem: () => null, setItem() {} },
		sessionStorage: {
			getItem: () => JSON.stringify({ accessToken: browserToken, expiresAt: Number.MAX_SAFE_INTEGER }),
			removeItem() {},
		},
		history: {
			replaceState(_state: unknown, _title: string, next: string | URL) {
				location.href = String(next);
			},
		},
		setTimeout: () => 0,
		clearTimeout() {},
		fetch: async (input: string, options?: RequestInit) => {
			const target = new URL(input, location);
			if (
				target.origin !== location.origin ||
				target.search !== "" ||
				target.hash !== "" ||
				new Headers(options?.headers).get("Authorization") !== `Bearer ${browserToken}`
			) {
				throw new Error("Unexpected fixture request");
			}
			if (target.pathname === "/auth/browser/session") return new Response(null, { status: 204 });
			if (target.pathname !== "/s/synthetic_skip_01/raw" || !sealed) {
				throw new Error("Unexpected fixture request");
			}
			if (waitForBlob) await waitForBlob;
			return new Response(sealed);
		},
	});
	if (sealed) vm.runInContext(shareLoaderJs, context);
	vm.runInContext(templateJs, context);
	const pending: unknown = Reflect.get(window, "__OMP_SESSION_DATA__");
	return {
		document,
		location,
		content,
		scrollBlock: () => scrollBlock,
		copiedUrl: () => copiedUrl,
		async ready() {
			if (pending) await pending;
			await Promise.resolve();
		},
		skip() {
			const control = document.querySelector(".skip-link")!;
			control.focus();
			const event = new window.Event("click", { bubbles: true, cancelable: true });
			control.dispatchEvent(event);
			return { control, event };
		},
	};
}

function expectSafeSkip(viewer: ViewerFixture) {
	const { control, event } = viewer.skip();
	// This DOM has no native hyperlink navigation. An uncanceled href would navigate in a browser.
	expect(event.defaultPrevented || !control.hasAttribute("href")).toBe(true);
	expect(viewer.content).toHaveProperty("hidden", false);
	expect(viewer.document.activeElement).toBe(viewer.content);
	expect(viewer.scrollBlock()).toBe("start");
}

function expectTranscript(viewer: ViewerFixture) {
	expect(viewer.content).toHaveProperty("hidden", false);
	expect(viewer.document.getElementById("transcript-tab")!.getAttribute("aria-pressed")).toBe("true");
	expect(viewer.document.getElementById("trace-tab")!.getAttribute("aria-pressed")).toBe("false");
	expect(viewer.document.getElementById("messages")!.textContent).toContain(transcriptText);
}

describe("export skip navigation", () => {
	test("ExportViewer-skip-share: reveals trace-hidden content and preserves decryptable current and copied URLs", async () => {
		const sealed = await sealSession();
		const viewer = createViewer(shareUrl, sealed);
		await viewer.ready();
		expect(viewer.content).toHaveProperty("hidden", true);
		expectSafeSkip(viewer);
		expectTranscript(viewer);
		expect(viewer.location.hash).toBe(keyFragment);
		expect(viewer.location.searchParams.has("view")).toBe(false);
		viewer.document.querySelector(".copy-link-btn")!.click();
		await Promise.resolve();
		const copied = new URL(viewer.copiedUrl()!);
		expect(copied.hash).toBe(keyFragment);
		expect(copied.searchParams.get("targetId")).toBe("user-1");
		for (const url of [viewer.location.href, copied.href]) {
			const reload = createViewer(url, sealed);
			await reload.ready();
			expectTranscript(reload);
			expect(reload.location.hash).toBe(keyFragment);
		}
	});

	test("ExportViewer-skip-pending: protects the fragment and focuses visible content before share boot", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const viewer = createViewer(shareUrl, await sealSession(), gate);
		try {
			expect(viewer.document.getElementById("messages")!.textContent).not.toContain(transcriptText);
			expectSafeSkip(viewer);
			expect(viewer.location.hash).toBe(keyFragment);
		} finally {
			release();
			await viewer.ready();
		}
		expectTranscript(viewer);
		expect(viewer.location.searchParams.has("view")).toBe(false);
		expectSafeSkip(viewer);
		expectTranscript(viewer);
		expect(viewer.location.hash).toBe(keyFragment);
	});

	test("ExportViewer-skip-static: preserves a standalone bookmark while revealing and focusing transcript", async () => {
		const viewer = createViewer("https://export.invalid/export.html?view=trace#saved-bookmark");
		await viewer.ready();
		expect(viewer.content).toHaveProperty("hidden", true);
		expectSafeSkip(viewer);
		expectTranscript(viewer);
		expect(viewer.location.hash).toBe("#saved-bookmark");
		expect(viewer.location.searchParams.has("view")).toBe(false);
	});

	test("ExportViewer-wrong-key: does not expose or replay plaintext for a different valid-length key", async () => {
		const wrongKey = Buffer.from(new Uint8Array(32).fill(77)).toString("base64url");
		const viewer = createViewer(`https://export.invalid/s/synthetic_skip_01#${wrongKey}`, await sealSession());
		await expect(viewer.ready()).rejects.toThrow();
		await Promise.resolve();
		expect(viewer.document.getElementById("messages")!.textContent).not.toContain(transcriptText);
		expect(viewer.document.querySelector(".user-message")).toBeNull();
		expect(viewer.document.querySelector(".copy-link-btn")).toBeNull();
		expect(viewer.location.hash).toBe(`#${wrongKey}`);
	});
});
