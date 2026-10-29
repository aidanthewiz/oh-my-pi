import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyPlacementLine,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { type HistoryBatch, TUI } from "@oh-my-pi/pi-tui/tui";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

// Direct-placement contract: a straddling image block must be re-anchored at
// its first visible row with the source rectangle clipped to the visible
// slice, and a placement id whose cells reached native scrollback must never
// be re-used (Kitty replace semantics strip the old placement everywhere,
// scrollback included — the permanently cropped images on WezTerm).

const originalProtocol = TERMINAL.imageProtocol;
const originalTerminalId = terminal.id;
const originalGraphics = { ...getKittyGraphics() };
let originalCellDims: CellDimensions;
const MULTIPLEXER_ENV_KEYS = [
	"TMUX",
	"STY",
	"ZELLIJ",
	"HERDR_ENV",
	"CMUX_WORKSPACE_ID",
	"CMUX_SURFACE_ID",
	"CMUX_REMOTE_TRANSPORT",
] as const;
const originalMultiplexerEnv = Object.fromEntries(MULTIPLEXER_ENV_KEYS.map(key => [key, Bun.env[key]]));

beforeEach(() => {
	for (const key of MULTIPLEXER_ENV_KEYS) delete Bun.env[key];
	originalCellDims = getCellDimensions();
	setCellDimensions({ widthPx: 10, heightPx: 10 });
	terminal.imageProtocol = ImageProtocol.Kitty;
	terminal.id = "wezterm";
	setKittyGraphics({ unicodePlaceholders: false });
});

afterEach(() => {
	setCellDimensions(originalCellDims);
	terminal.imageProtocol = originalProtocol;
	terminal.id = originalTerminalId;
	setKittyGraphics(originalGraphics);
	for (const key of MULTIPLEXER_ENV_KEYS) {
		const value = originalMultiplexerEnv[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
});

describe("kitty direct-placement wire format", () => {
	it("round-trips the exact line Image renders for a direct placement", () => {
		const budget = new ImageBudget(8, () => {});
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget, imageKey: "roundtrip" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = budget.acquireId("roundtrip");
		budget.beginPass();
		const lines = image.render(40);
		budget.endPass();
		expect(lines.length).toBe(6);
		const parsed = parseKittyDirectPlacementLine(lines[lines.length - 1]!);
		expect(parsed).toEqual({ imageId, placementId: imageId, columns: 4, rows: 6 });
	});

	it("rejects non-placement image lines", () => {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\")).toBeNull();
		// Transmit-and-display and plain text never match.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\")).toBeNull();
		expect(parseKittyDirectPlacementLine("plain text")).toBeNull();
	});

	it("recognizes passthrough placements so tmux redraws can delete the old image", () => {
		const line = `\x1b7\x1b[3A${wrapTmuxPassthrough("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\")}\x1b8`;
		expect(parseKittyDirectPlacementLine(line)).toEqual({ imageId: 5, placementId: 5, columns: 4, rows: 4 });
	});

	it("encodes the anchored, clipped, and last-row-only placement forms", () => {
		const base = { imageId: 7, columns: 4, rows: 6, imageHeightPx: 60 };
		// Whole block visible (last line at viewport row 9): full anchored form.
		expect(encodeKittyPlacementLine({ ...base, placementId: 1, screenRow: 9 })).toBe(
			"\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8",
		);
		// Straddling (last line at row 3): two rows hidden above, four visible —
		// the source slice starts at 60*2/6 = 20px.
		expect(encodeKittyPlacementLine({ ...base, placementId: 2, screenRow: 3 })).toBe(
			"\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8",
		);
		// Only the last row visible: no cursor movement, bottom slice only.
		expect(encodeKittyPlacementLine({ ...base, placementId: 3, screenRow: 0 })).toBe(
			"\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\",
		);
	});
});

/** A multi-row graphic for exercising viewport ownership against the terminal engine. */
function image(budget: ImageBudget): Image {
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: 4, maxHeightCells: 4, budget, imageKey: "placement" },
		{ widthPx: 40, heightPx: 40 },
	);
}

class CapturingVirtualTerminal extends VirtualTerminal {
	#writes = "";

	override write(data: string): void {
		this.#writes += data;
		super.write(data);
	}

	takeWrites(): string {
		const writes = this.#writes;
		this.#writes = "";
		return writes;
	}
}

describe("direct placement lifecycle", () => {
	it("retires one of two live copies without deleting the other copy of the same image", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let firstVisible = true;
		tui.setFrameProvider({
			renderFrame: size => ({
				viewport: [
					...(firstVisible ? graphic.render(size.columns) : ["replacement prose", "", "", ""]),
					"between copies",
					...graphic.render(size.columns),
				],
			}),
			acknowledgeHistory() {},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const copies = term.graphicsPlacements().sort((a, b) => a.row - b.row);
			expect(copies.map(copy => copy.row)).toEqual([0, 5]);
			expect(copies[0]!.imageId).toBe(copies[1]!.imageId);
			expect(copies[0]!.placementId).not.toBe(copies[1]!.placementId);

			firstVisible = false;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual([copies[1]!]);
			expect(term.getViewport()[0]?.trimEnd()).toBe("replacement prose");
		} finally {
			tui.stop();
		}
	});

	for (const fullscreen of [false, true]) {
		it(`removes moved and hidden images from the ${fullscreen ? "alternate" : "normal"} viewport`, async () => {
			const term = new CapturingVirtualTerminal(40, 12);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = image(tui.imageBudget);
			let top = 1;
			let visible = true;
			const render = (width: number) => [
				...Array.from({ length: top }, (_, index) => `prose ${index}`),
				...(visible ? graphic.render(width) : ["replacement prose"]),
			];
			tui.setFrameProvider({ renderFrame: size => ({ viewport: render(size.columns) }), acknowledgeHistory() {} });
			if (fullscreen) tui.showOverlay({ render, invalidate() {} }, { fullscreen: true, anchor: "top-left" });
			try {
				tui.start();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([1]);
				const first = term.graphicsPlacements()[0]!;
				term.takeWrites();

				top = 2;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements().map(placement => placement.row)).toEqual([2]);
				expect(term.takeWrites()).toContain(`\x1b_Ga=d,d=i,i=${first.imageId},p=${first.placementId},q=2\x1b\\`);
				const moved = term.graphicsPlacements()[0]!;
				expect(moved.imageId).toBe(first.imageId);

				visible = false;
				tui.requestRender();
				await scheduler.settle(term);
				expect(term.graphicsPlacements()).toEqual([]);
				expect(term.getViewport()[2]?.trimEnd()).toBe("replacement prose");
				const hiddenWrites = term.takeWrites();
				expect(hiddenWrites).toContain(`\x1b_Ga=d,d=i,i=${moved.imageId},p=${moved.placementId},q=2\x1b\\`);
				expect(hiddenWrites).not.toContain("\x1b_Ga=d,d=I,");
			} finally {
				tui.stop();
			}
		});
	}

	it("deletes a live copy without deleting the same image already committed to scrollback", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let append = false;
		let acknowledged = false;
		let visible = true;
		tui.setFrameProvider({
			renderFrame: size => {
				const rows = graphic.render(size.columns);
				const history: HistoryBatch | undefined =
					append && !acknowledged
						? { id: 1, rows: [...rows, ...Array.from({ length: 16 }, (_, index) => `history ${index}`)] }
						: undefined;
				return { history, viewport: visible ? rows : ["replacement prose"] };
			},
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			append = true;
			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			visible = true;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toHaveLength(2);
			const copies = term.graphicsPlacements();
			expect(copies.map(copy => copy.imageId)).toEqual([archived[0]!.imageId, archived[0]!.imageId]);
			expect(copies[0]!.placementId).not.toBe(copies[1]!.placementId);

			visible = false;
			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});

	it("preserves replay history split into the viewport after the next live repaint", async () => {
		const term = new VirtualTerminal(40, 12);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const graphic = image(tui.imageBudget);
		let acknowledged = false;
		tui.setFrameProvider({
			renderFrame: size => ({
				history: acknowledged ? undefined : { id: 1, kind: "replay", rows: graphic.render(size.columns) },
				viewport: ["live prose"],
			}),
			acknowledgeHistory() {
				acknowledged = true;
			},
		});
		try {
			tui.start();
			await scheduler.settle(term);
			const archived = term.graphicsPlacements();
			expect(archived).toHaveLength(1);

			tui.requestRender();
			await scheduler.settle(term);
			expect(term.graphicsPlacements()).toEqual(archived);
		} finally {
			tui.stop();
		}
	});
});

describe("uncroppable image blocks", () => {
	for (const protocol of [ImageProtocol.Iterm2, ImageProtocol.Kitty]) {
		it(`does not draw a top-clipped ${protocol === ImageProtocol.Kitty ? "Kitty transmit-and-display" : "iTerm2"} image over following text`, async () => {
			terminal.imageProtocol = protocol;
			const term = new VirtualTerminal(40, 8);
			const scheduler = new VirtualRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const graphic = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: text => text },
				{ maxWidthCells: 4, maxHeightCells: 4 },
				{ widthPx: 40, heightPx: 40 },
			);
			const settled = ["table row", "table border"];
			let retired = false;
			let accepted = false;
			tui.setFrameProvider({
				renderFrame: size => {
					const block = graphic.render(size.columns);
					if (!retired) return { viewport: [...settled, ...block, "following text"] };
					return {
						history: accepted ? undefined : { id: 1, rows: settled },
						viewport: [...block.slice(2), "following text"],
					};
				},
				acknowledgeHistory() {
					accepted = true;
				},
			});
			const writes: string[] = [];
			const write = term.write.bind(term);
			term.write = data => {
				writes.push(data);
				write(data);
			};
			try {
				tui.start();
				await scheduler.settle(term);
				expect(writes.join("")).toContain(protocol);
				writes.length = 0;
				retired = true;
				tui.requestRender();
				await scheduler.settle(term);
				const output = writes.join("");
				expect(output).not.toContain(protocol);
				expect(
					term
						.getViewport()
						.map(row => row.trimEnd())
						.slice(0, 2),
				).toEqual(settled);
				expect(term.getViewport()[4]?.trimEnd()).toBe("following text");
			} finally {
				tui.stop();
			}
		});
	}
});
