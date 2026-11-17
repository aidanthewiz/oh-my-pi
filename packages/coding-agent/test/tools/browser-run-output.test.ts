import { describe, expect, it } from "bun:test";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { type HandleOpGuard, toActionableHandle } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import { EventEmitter, type ElementHandle } from "puppeteer-core";

// Regression coverage for the invisible-output failure mode: `console.log` and
// `print` reach the runtime as `onText` chunks, which the browser
// embedders used to route to the debug log only — the tool result showed a bare
// "Ran code on tab" while the displayed text vanished.
describe("browser run output — stream text reaches the tool result", () => {
	it("surfaces buffered stream text as a display entry on finish", () => {
		const output = new RunOutput();
		output.pushText("plain string via print()\n");
		output.pushText("console.log line\n");

		expect(output.finish()).toEqual([{ type: "text", text: "plain string via print()\nconsole.log line" }]);
	});

	it("adds nothing for views, whose text is already in the stream", () => {
		const output = new RunOutput();
		output.pushText("{ a: 1 }\n");
		output.pushDisplay({ type: "view", text: "{ a: 1 }\n", view: { kind: "json", value: { a: 1 } } });

		expect(output.finish()).toEqual([{ type: "text", text: "{ a: 1 }" }]);
	});

	it("flushes pending text before pre-built entries (screenshot captions) and emits images verbatim", () => {
		const output = new RunOutput();
		output.pushText("shot incoming\n");
		output.push({ type: "image", data: "aGk=", mimeType: "image/png" });
		output.pushDisplay({ type: "image", data: "eW8=", mimeType: "image/webp" });

		expect(output.finish()).toEqual([
			{ type: "text", text: "shot incoming" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
			{ type: "image", data: "eW8=", mimeType: "image/webp" },
		]);
	});

	it("returns no entries when nothing was displayed", () => {
		expect(new RunOutput().finish()).toEqual([]);
	});
});

// The tool docs promise `.fill()` on handles from tab.id()/tab.ref()/tab.waitFor();
// raw puppeteer ElementHandles only expose `.type()`. `input.fill is not a function`
// was a live failure.
describe("browser handle enrichment — fill()", () => {
	it("adds a fill() that clears the current value before typing", async () => {
		const node = { value: "old", focused: false };
		const stub = {
			evaluate: async (fn: (el: unknown) => unknown) =>
				fn({
					get value() {
						return node.value;
					},
					set value(v: string) {
						node.value = v;
					},
					focus: () => {
						node.focused = true;
					},
					matches: () => false,
				}),
			frame: {
				page: () => ({
					keyboard: {
						type: async (text: string) => {
							node.value += text;
						},
					},
				}),
			},
		} as unknown as ElementHandle;

		await toActionableHandle(stub).fill("fresh");

		expect(node.focused).toBe(true);
		expect(node.value).toBe("fresh");
	});
});

describe("browser handle enrichment — guarded actions", () => {
	// handle.click() resolves a stable, unoccluded click point (boundingBox + the
	// actionability probe), checks the page has not replaced the element, then verifies delivery.
	const clickableStub = (mousePress: () => Promise<void>, extra: Record<string, unknown> = {}): ElementHandle => {
		const page = Object.assign(new EventEmitter(), {
			mouse: { move: async () => {}, down: mousePress, up: async () => {} },
			isClosed: () => false,
			mainFrame: () => frame,
		});
		const frame = { page: () => page };
		return {
			boundingBox: async () => ({ x: 10, y: 10, width: 20, height: 20 }),
			evaluate: async () => ({ ok: true, x: 20, y: 20 }),
			evaluateHandle: async () => ({
				evaluate: async (fn: (state: unknown) => unknown) =>
					fn({ detached: false, delivered: () => true, stop: () => {} }),
				dispose: async () => {},
			}),
			frame,
			type: async () => {},
			dispose: async () => {},
			...extra,
		} as unknown as ElementHandle;
	};

	it("retires a cancelled click before rejecting and refuses a duplicate dispatch", async () => {
		let clicks = 0;
		let disposed = false;
		let cacheCleared = false;
		const started = Promise.withResolvers<void>();
		const stalled = Promise.withResolvers<void>();
		const deadline = new AbortController();
		const stub = clickableStub(
			() => {
				clicks++;
				started.resolve();
				return stalled.promise;
			},
			{
				dispose: async () => {
					disposed = true;
				},
			},
		);
		const guard: HandleOpGuard = (_label, fn) => fn(deadline.signal);
		const handle = toActionableHandle(stub, guard, async () => {
			cacheCleared = true;
		});
		const action = handle.click();
		await started.promise;
		deadline.abort(new DOMException("Action deadline", "TimeoutError"));

		await expect(action).rejects.toThrow();
		expect(disposed).toBe(true);
		expect(cacheCleared).toBe(true);
		await expect(handle.click()).rejects.toThrow();
		expect(clicks).toBe(1);
	});

	it("stops handle.type() before dispatching more characters after timeout", async () => {
		const typed: string[] = [];
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const firstFinished = Promise.withResolvers<void>();
		const stub = {
			type: async () => {},
			evaluate: async (fn: (el: unknown) => unknown) => {
				fn({ focus: () => {}, matches: () => false });
			},
			frame: {
				page: () => ({
					keyboard: {
						type: async (character: string) => {
							firstStarted.resolve();
							await releaseFirst.promise;
							typed.push(character);
							firstFinished.resolve();
						},
					},
				}),
			},
			dispose: async () => {},
		} as unknown as ElementHandle;
		const deadline = new AbortController();
		const guard: HandleOpGuard = (_label, fn) => fn(deadline.signal);
		const action = toActionableHandle(stub, guard).type("abc");

		await firstStarted.promise;
		deadline.abort(new Error("action deadline"));
		await expect(action).rejects.toThrow();
		releaseFirst.resolve();
		await firstFinished.promise;

		expect(typed).toEqual(["a"]);
	});

	it("guards drag and touch input methods, not just click/type", async () => {
		const makeStalled = (method: string): ElementHandle =>
			({
				[method]: () => Promise.withResolvers<void>().promise, // stalled CDP input
				type: async () => {},
				evaluate: async () => {},
				dispose: async () => {},
			}) as unknown as ElementHandle;
		const guard: HandleOpGuard = (_label, fn) => fn(AbortSignal.timeout(50));

		const drag = toActionableHandle(makeStalled("drag"), guard) as unknown as Record<string, () => Promise<void>>;
		await expect(drag.drag!()).rejects.toThrow();
		const touch = toActionableHandle(makeStalled("touchStart"), guard) as unknown as Record<
			string,
			() => Promise<void>
		>;
		await expect(touch.touchStart!()).rejects.toThrow();
	});

	it("rewraps a cached handle from its original methods for each browser run", async () => {
		let clicks = 0;
		const stub = clickableStub(async () => {
			clicks++;
		});
		const firstGuard: HandleOpGuard = (_label, fn) => fn(AbortSignal.abort(new Error("first run ended")));
		const secondGuard: HandleOpGuard = (_label, fn) => fn(new AbortController().signal);

		toActionableHandle(stub, firstGuard);
		await toActionableHandle(stub, secondGuard).click();

		expect(clicks).toBe(1);
	});

	it("does not dispatch through a handle retained after its browser run ended", async () => {
		let clicks = 0;
		const stub = {
			click: async () => {
				clicks++;
			},
			type: async () => {},
			evaluate: async () => {},
		} as unknown as ElementHandle;
		const guard: HandleOpGuard = (_label, fn) => fn(AbortSignal.abort(new Error("run ended")));

		await expect(toActionableHandle(stub, guard).click()).rejects.toThrow();
		expect(clicks).toBe(0);
	});
});
