import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { acquireBrowser, holdBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import {
	acquireTab,
	getTabsMapForTest,
	releaseTab,
	runInTab,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { pickTernBlock, type TernBlockEntry } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/blocks";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

const PANE = 3;

/** The window's browser blocks as the `blocks` op lists them. */
const BLOCKS = [
	{ block: 5, url: "https://docs.example/a", title: "Docs A", owner: null, shown: false, driven: false },
	{ block: 6, url: "https://docs.example/b", title: "Docs B", owner: PANE, shown: true, driven: true },
	{ block: 7, url: "https://docs.example/c", title: "Docs C", owner: null, shown: true, driven: false },
];

let daemon: FakeDaemon | undefined;
const opened: string[] = [];

afterEach(async () => {
	for (const name of opened.splice(0)) await releaseTab(name, { kill: false }).catch(() => undefined);
	await daemon?.close();
	daemon = undefined;
});

/**
 * A Tern window with {@link BLOCKS}; a PiP `open` makes block 9 (listed while
 * open). `state` reports `shown`; `release` answers `release` (an older Tern:
 * `invalid`). Once `closed` holds a block, every op on it answers `not_found`.
 */
async function startWindow(opts: { shown: boolean; release?: FakeAnswer; closed?: Set<number> }): Promise<FakeDaemon> {
	let seq = 0;
	let pip = false;
	daemon = await startFakeDaemon((op): FakeAnswer => {
		if (typeof op.block === "number" && opts.closed?.has(op.block)) {
			return { error: { kind: "not_found", message: `no browser block ${op.block} in this window` } };
		}
		switch (op.op) {
			case "blocks": {
				const own = { block: 9, url: "about:blank", title: "", owner: PANE, shown: true, driven: true };
				const blocks = pip ? [...BLOCKS, own] : BLOCKS;
				return { ok: { blocks: blocks.filter(entry => !opts.closed?.has(entry.block)) } };
			}
			case "open":
				pip = true;
				return { ok: { block: 9, url: "about:blank" } };
			case "events": {
				// A PiP's initial about:blank load; an adopted block's old events are skipped by `next`.
				const events = op.after === 0 && op.block === 9 ? [{ seq: ++seq, type: "loaded", url: "about:blank" }] : [];
				return { ok: { events, next: seq + (op.block === 9 ? 0 : 40), dropped: 0 } };
			}
			case "state": {
				const block = BLOCKS.find(entry => entry.block === op.block);
				return {
					ok: {
						url: block?.url ?? "about:blank",
						title: block?.title ?? "",
						loading: false,
						shown: opts.shown,
						width: 800,
						height: 600,
					},
				};
			}
			case "eval":
				// The kit's `frames`: no child frames.
				return { ok: { value: { value: [] } } };
			case "release":
				return opts.release ?? { ok: {} };
			default:
				return { ok: {} };
		}
	});
	return daemon;
}

async function ternBrowser(fake: FakeDaemon) {
	return await acquireBrowser({ kind: "tern", socketPath: fake.socketPath, pane: PANE }, { cwd: "/tmp" });
}

function opsFor(fake: FakeDaemon, block: number): string[] {
	return fake.requests.filter(request => request.op.block === block).map(request => String(request.op.op));
}

function entry(block: number, fields: Partial<TernBlockEntry>): TernBlockEntry {
	return { block, url: "https://x.example/", title: "", owner: null, shown: undefined, driven: undefined, ...fields };
}

describe("pickTernBlock", () => {
	it("matches an id exactly, else a URL/title substring in any case", () => {
		const blocks = [entry(12, { url: "https://a.example/12" }), entry(4, { title: "GitHub Issues" })];
		expect(pickTernBlock(blocks, "4")?.block).toBe(4);
		expect(pickTernBlock(blocks, "github")?.block).toBe(4);
		expect(pickTernBlock(blocks, "A.EXAMPLE")?.block).toBe(12);
		expect(pickTernBlock(blocks, "missing")).toBeUndefined();
	});

	it("prefers a block on screen, then the user's own, then the first", () => {
		const hidden = entry(1, { shown: false, driven: false });
		const shownDriven = entry(2, { shown: true, driven: true });
		const shownOwn = entry(3, { shown: true, driven: false });
		expect(pickTernBlock([hidden, shownDriven, shownOwn], "x.example")?.block).toBe(3);
		expect(pickTernBlock([hidden, shownDriven], "x.example")?.block).toBe(2);
		// An older Tern says neither: the first match.
		expect(pickTernBlock([entry(8, {}), entry(9, {})], "x.example")?.block).toBe(8);
	});

	it("never matches a block another omp tab drives", () => {
		const blocks = [entry(1, { shown: true }), entry(2, { shown: false })];
		expect(pickTernBlock(blocks, "x.example", new Map([[1, "docs"]]))?.block).toBe(2);
		expect(pickTernBlock(blocks, "1", new Map([[1, "docs"]]))).toBeUndefined();
	});
});

describe("Tern block adoption", () => {
	it("drives the matching block without opening one, and releases it on close without closing it", async () => {
		const fake = await startWindow({ shown: true });
		const browser = await ternBrowser(fake);
		opened.push("adopt-release");
		const { tab } = await acquireTab("adopt-release", browser, { target: "docs", timeoutMs: 5_000 });
		expect(tab.targetId).toBe("7");
		expect(tab.info.url).toBe("https://docs.example/c");
		await releaseTab("adopt-release", { kill: false });
		const ops = fake.requests.map(request => String(request.op.op));
		expect(ops).not.toContain("open");
		expect(ops).not.toContain("close");
		// Only the options the caller gave: no dialog policy, no viewport.
		expect(opsFor(fake, 7)).not.toContain("dialogs");
		expect(opsFor(fake, 7)).not.toContain("viewport");
		expect(opsFor(fake, 7)).toContain("scripts");
		expect(opsFor(fake, 7).at(-1)).toBe("release");
	});

	it("clears its scripts instead on a Tern without release", async () => {
		const fake = await startWindow({
			shown: true,
			release: { error: { kind: "invalid", message: 'unknown web call "release"' } },
		});
		const browser = await ternBrowser(fake);
		opened.push("adopt-old");
		await acquireTab("adopt-old", browser, { target: "6", timeoutMs: 5_000 });
		await releaseTab("adopt-old", { kill: false });
		const last = fake.requests.filter(request => request.op.block === 6).at(-1)?.op;
		expect(last).toEqual({ op: "scripts", block: 6, scripts: [] });
		expect(opsFor(fake, 6)).not.toContain("close");
	});

	it("closes a tab whose block the window no longer has and says how to reopen it", async () => {
		const closed = new Set<number>();
		const fake = await startWindow({ shown: true, closed });
		const browser = await ternBrowser(fake);
		opened.push("pip-gone");
		await acquireTab("pip-gone", browser, { timeoutMs: 5_000 });
		closed.add(9);
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated(),
		};
		const failure = await runInTab("pip-gone", {
			code: "return await tab.title();",
			timeoutMs: 5_000,
			session,
		}).catch((error: unknown) => error);
		expect(String(failure)).toContain(
			'Tab "pip-gone" is gone: its Tern browser block 9 is no longer in this Tern window',
		);
		expect(String(failure)).toContain('browser.targets({ app: "tern" })');
		expect(getTabsMapForTest().has("pip-gone")).toBe(false);
		await expect(runInTab("pip-gone", { code: "return 1;", timeoutMs: 5_000, session })).rejects.toThrow(
			/Tab "pip-gone" was killed: its Tern browser block 9 is no longer in this Tern window/,
		);
	});

	it("fails a target no block matches, listing the window's blocks, and touches none", async () => {
		const fake = await startWindow({ shown: true });
		const browser = await ternBrowser(fake);
		const failure = await acquireTab("adopt-none", browser, { target: "nowhere", timeoutMs: 5_000 }).catch(
			(error: unknown) => error,
		);
		expect(String(failure)).toContain('5 "Docs A" https://docs.example/a (docked, not on screen)');
		expect(String(failure)).toContain(
			'6 "Docs B" https://docs.example/b (picture-in-picture over block 3, on screen',
		);
		expect(fake.requests.map(request => String(request.op.op))).toEqual(["blocks"]);
	});

	it("keeps pending adoptions exclusive without blocking a different block", async () => {
		const arrived = Promise.withResolvers<number>();
		let heldId: number | undefined;
		const agents = new Map<number, string>();
		daemon = await startFakeDaemon((op, id) => {
			if (op.op === "blocks") return { ok: { blocks: BLOCKS } };
			if (op.op === "events" && heldId === undefined) {
				heldId = id;
				arrived.resolve(Number(op.block));
				return null;
			}
			if (op.op === "events") return { ok: { events: [], next: 1 } };
			if (op.op === "state") return { ok: { url: `https://owned.invalid/${op.block}`, loading: false } };
			if (op.op === "eval") return { ok: { value: { value: [] } } };
			if (op.op === "agent") agents.set(Number(op.block), String(op.value));
			if (op.op === "release") agents.delete(Number(op.block));
			return { ok: {} };
		});
		const fake = daemon;
		const browser = await ternBrowser(fake);
		holdBrowser(browser);
		opened.push("pending-owner-a", "pending-owner-b");
		const first = acquireTab("pending-owner-a", browser, { target: "docs", userAgent: "a", timeoutMs: 5_000 });
		try {
			expect(await arrived.promise).toBe(7);
			const second = await acquireTab("pending-owner-b", browser, {
				target: "docs",
				userAgent: "b",
				timeoutMs: 5_000,
			});
			expect(second.tab.targetId).toBe("6");
			fake.answer(heldId!, { ok: { events: [], next: 1 } });
			const adopted = await first;
			expect(adopted.tab.targetId).toBe("7");
			await releaseTab("pending-owner-a");
			expect(agents.get(6)).toBe("b");
		} finally {
			if (heldId !== undefined) fake.answer(heldId, { ok: { events: [], next: 1 } });
			await first.catch(() => undefined);
			await releaseBrowser(browser, { kill: false });
		}
	});

	it("recovers a failed adoption and preserves exclusivity across reopen", async () => {
		let failScripts = true;
		daemon = await startFakeDaemon(op => {
			if (op.op === "blocks") return { ok: { blocks: BLOCKS } };
			if (op.op === "events") return { ok: { events: [], next: 1 } };
			if (op.op === "state") return { ok: { url: "https://owned.invalid/", loading: false } };
			if (op.op === "eval") return { ok: { value: { value: [] } } };
			if (op.op === "scripts" && failScripts) {
				failScripts = false;
				return { error: { kind: "failed", message: "synthetic script failure" } };
			}
			return { ok: {} };
		});
		const browser = await ternBrowser(daemon);
		holdBrowser(browser);
		opened.push("failed-adoption", "recovered-adoption", "reopen-conflict");
		try {
			await expect(acquireTab("failed-adoption", browser, { target: "7", timeoutMs: 5_000 })).rejects.toBeInstanceOf(
				Error,
			);
			const recovered = await acquireTab("recovered-adoption", browser, { target: "7", timeoutMs: 5_000 });
			expect(recovered.tab.targetId).toBe("7");
			const reloaded = await acquireTab("recovered-adoption", browser, {
				target: "7",
				dialogs: "dismiss",
				timeoutMs: 5_000,
			});
			expect(reloaded.created).toBe(true);
			expect(reloaded.tab.targetId).toBe("7");
			await expect(acquireTab("reopen-conflict", browser, { target: "7", timeoutMs: 5_000 })).rejects.toBeInstanceOf(
				Error,
			);
		} finally {
			await releaseBrowser(browser, { kill: false });
		}
	});

	it("does not reuse an adopted block before its release completes", async () => {
		const arrived = Promise.withResolvers<void>();
		let releaseId: number | undefined;
		daemon = await startFakeDaemon((op, id) => {
			if (op.op === "blocks") return { ok: { blocks: BLOCKS } };
			if (op.op === "events") return { ok: { events: [], next: 1 } };
			if (op.op === "state") return { ok: { url: "https://owned.invalid/", loading: false } };
			if (op.op === "eval") return { ok: { value: { value: [] } } };
			if (op.op === "release" && releaseId === undefined) {
				releaseId = id;
				arrived.resolve();
				return null;
			}
			return { ok: {} };
		});
		const fake = daemon;
		const browser = await ternBrowser(fake);
		holdBrowser(browser);
		opened.push("closing-adoption", "closing-conflict", "after-close");
		await acquireTab("closing-adoption", browser, { target: "7", timeoutMs: 5_000 });
		const closing = releaseTab("closing-adoption");
		try {
			await arrived.promise;
			await expect(
				acquireTab("closing-conflict", browser, { target: "7", timeoutMs: 5_000 }),
			).rejects.toBeInstanceOf(Error);
		} finally {
			if (releaseId !== undefined) fake.answer(releaseId, { ok: {} });
			await closing;
			try {
				await releaseTab("closing-conflict");
				const after = await acquireTab("after-close", browser, { target: "7", timeoutMs: 5_000 });
				expect(after.tab.targetId).toBe("7");
			} finally {
				await releaseBrowser(browser, { kill: false });
			}
		}
	});
});
