import { beforeAll, describe, expect, it } from "bun:test";
import { Container, Text, TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";

const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const DOWN = "\x1b[B";
const PERMISSIONS = ["Deny", "Approve once", "Allow for the rest of this session"];
const COMMAND_TAIL = "COMMAND_TAIL_79";
const COMMAND_ARGUMENT = Array.from(
	{ length: 200 },
	(_, index) => `segment_${index.toString().padStart(3, "0")}_`,
).join("");
const TITLE = `AWS approval\nCommand: aws s3api get-object --key ${COMMAND_ARGUMENT}${COMMAND_TAIL}\nProfile: audit\nAccount: 123456789012\nPartition: aws-us-gov`;
const SAFETY_DETAILS = `Safety checks: ${"Reject any unverified account or partition. ".repeat(30)}SAFETY_TAIL`;

beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Failed to load dark theme");
	setThemeInstance(dark);
});

function child(root: NativeNode, key: string): NativeNode {
	const found = root.c?.find(candidate => "k" in candidate && candidate.key === key);
	if (!found || !("k" in found)) throw new Error(`Missing native child ${key}`);
	return found;
}

function nativeText(root: NativeNode): string {
	if (root.k !== "text") throw new Error("Expected native text");
	const text = root.p?.text ?? root.p?.spans;
	return typeof text === "string" ? text : (text?.map(part => part.t).join("") ?? "");
}

function appendPage(seen: string[], rows: string[]): void {
	let overlap = Math.min(seen.length, rows.length);
	while (overlap > 0 && !rows.slice(0, overlap).every((row, index) => row === seen[seen.length - overlap + index])) {
		overlap--;
	}
	seen.push(...rows.slice(overlap));
}

function fixture(columns: number, rows: number, title = TITLE) {
	const terminal = new VirtualTerminal(columns, rows);
	const picked: string[] = [];
	let cancelled = 0;
	const selector = new HookSelectorComponent(
		title,
		PERMISSIONS,
		value => picked.push(value),
		() => cancelled++,
		{ tui: new TUI(terminal), titleStyle: "destructive" },
	);
	return { terminal, selector, picked, cancellations: () => cancelled };
}

function composedFixture(columns: number, rows: number) {
	const terminal = new VirtualTerminal(columns, rows);
	const composer = new Composer({
		terminal,
		preferences: { quiet: true },
		tuiOptions: { renderScheduler: new VirtualRenderScheduler() },
	});
	const status = createStartupStatusLine({
		settings: { preset: "custom", leftSegments: [], rightSegments: [], showHookStatus: true },
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
	status.setHookStatus("fixture", "STATUS FOOTER");
	composer.setStatusComponent(status);
	const transcript = new TranscriptContainer();
	transcript.addChild(new Text("Earlier transcript", 0, 0));
	const editor = new Container();
	const lower = new Text("HOOK BELOW ONE\nHOOK BELOW TWO", 0, 0);
	const picked: string[] = [];
	let cancelled = 0;
	const selector = new HookSelectorComponent(
		`${TITLE}\n${SAFETY_DETAILS}`,
		PERMISSIONS,
		value => picked.push(value),
		() => cancelled++,
		{
			tui: composer.ui,
			titleStyle: "destructive",
			getHeight: () => {
				const below = composer.rowsBelow(editor);
				return below === undefined ? undefined : terminal.rows - below;
			},
		},
	);
	editor.addChild(selector);
	composer.setRuntimeChildren([transcript, editor, lower]);
	composer.ui.setFocus(selector);
	composer.start({ playWelcomeIntro: false });
	const frame = () =>
		composer.renderFrame({ columns: terminal.columns, rows: terminal.rows }).viewport.map(row => Bun.stripANSI(row));
	return {
		terminal,
		composer,
		status,
		lower,
		selector,
		picked,
		frame,
		cancellations: () => cancelled,
		dispose: () => {
			selector.dispose();
			composer.stop();
			status.dispose();
		},
	};
}

function context(cols: number, scroll = true): DescribeContext {
	return { cols, reduceMotion: false, dark: true, supports: () => true, feature: name => name === "scroll" && scroll };
}

describe("selector detail viewport", () => {
	it("keeps a no-match filter editable after terminal growth so Deny remains reachable", () => {
		const h = fixture(80, 7, "Choose\nDetails");
		try {
			h.selector.render(80);
			h.selector.handleInput("zz");
			h.selector.render(80);
			h.terminal.resize(80, 24);
			h.selector.render(80);
			h.selector.handleInput("\x7f");
			h.selector.handleInput("\x7f");
			h.selector.handleInput("\n");
			expect(h.picked).toEqual(["Deny"]);
			expect(h.cancellations()).toBe(0);
		} finally {
			h.selector.dispose();
		}
	});

	it.each(["j", "k", "h", "l"])("keeps %s as search text instead of navigation after terminal growth", key => {
		const terminal = new VirtualTerminal(80, 7);
		const picked: string[] = [];
		const changes: number[] = [];
		const selector = new HookSelectorComponent(
			"Choose\nDetails",
			["Deny", "Grant j", "Grant k", "Grant h", "Grant l"],
			value => picked.push(value),
			() => {},
			{
				tui: new TUI(terminal),
				slider: {
					segments: [{ label: "Low" }, { label: "Middle" }, { label: "High" }],
					index: 1,
					onChange: index => changes.push(index),
				},
			},
		);
		try {
			selector.render(80);
			selector.handleInput("Grant ");
			selector.render(80);
			terminal.resize(80, 24);
			selector.render(80);
			selector.handleInput(key);
			selector.handleInput("\n");
			expect(picked).toEqual([`Grant ${key}`]);
			expect(changes).toEqual([]);
		} finally {
			selector.dispose();
		}
	});

	it("pages every approval detail in the real composer above lower widgets and the status footer without consent", () => {
		const h = composedFixture(28, 8);
		try {
			const seen: string[] = [];
			for (let page = 0; page < 300; page++) {
				const frame = h.frame();
				expect(frame[0]).toContain("AWS approval");
				expect(frame.slice(-3).map(row => row.trim())).toEqual([
					"HOOK BELOW ONE",
					"HOOK BELOW TWO",
					"STATUS FOOTER",
				]);
				expect(frame.join("\n")).toContain("Deny");
				for (const row of frame) expect(visibleWidth(row)).toBeLessThanOrEqual(28);
				seen.push(frame[1]!.slice(2, -2).replace(/[│█]\s*$/, ""));
				h.selector.handleInput(PAGE_DOWN);
			}
			const read = seen.join("").replace(/\s+/g, "");
			expect(read).toContain(`Command:awss3apiget-object--key${COMMAND_ARGUMENT}${COMMAND_TAIL}`);
			expect(read).toContain("Profile:audit");
			expect(read).toContain("Account:123456789012");
			expect(read).toContain("Partition:aws-us-gov");
			expect(read).toContain(SAFETY_DETAILS.replace(/\s+/g, ""));
			expect(h.picked).toEqual([]);
			expect(h.cancellations()).toBe(0);
			h.selector.handleInput(PAGE_UP);
			h.selector.handleInput("\n");
			expect(h.picked).toEqual(["Deny"]);
		} finally {
			h.dispose();
		}
	});

	it("remeasures changing lower chrome on the first resize frame and keeps every permission reachable", () => {
		const h = composedFixture(52, 18);
		try {
			expect(h.frame().join("\n")).toContain("AWS approval");
			h.selector.handleInput(PAGE_DOWN);
			h.lower.setText("HOOK BELOW ONE\nHOOK BELOW TWO\nHOOK BELOW THREE");
			h.status.setHookStatus("second", "STATUS SECOND");
			h.terminal.resize(24, 10);
			const resize = h.composer.renderResizeFrame({ columns: 24, rows: 10 }).map(row => Bun.stripANSI(row));
			expect(resize.join("\n")).toContain("AWS approval");
			const frame = h.frame();
			expect(frame.join("\n")).toContain("AWS approval");
			expect(frame.slice(-5).map(row => row.trim())).toEqual([
				"HOOK BELOW ONE",
				"HOOK BELOW TWO",
				"HOOK BELOW THREE",
				"STATUS FOOTER",
				"STATUS SECOND",
			]);
			h.selector.handleInput(DOWN);
			expect(h.frame().join("\n")).toContain("Approve once");
			h.selector.handleInput(DOWN);
			const seen: string[] = [];
			for (let page = 0; page < 300; page++) {
				const selected = h.frame();
				expect(selected).toHaveLength(10);
				expect(selected.slice(-5).map(row => row.trim())).toEqual([
					"HOOK BELOW ONE",
					"HOOK BELOW TWO",
					"HOOK BELOW THREE",
					"STATUS FOOTER",
					"STATUS SECOND",
				]);
				for (const row of selected) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
				const body = selected.slice(1, 4).map(row =>
					row
						.slice(2, -2)
						.replace(/[│█]\s*$/, "")
						.trim(),
				);
				if (page === 0) expect(body.join("").replace(/\s+/g, "")).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
				appendPage(seen, body);
				h.selector.handleInput(PAGE_DOWN);
			}
			const read = seen.join("").replace(/\s+/g, "");
			expect(read).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
			expect(read).toContain(`Command:awss3apiget-object--key${COMMAND_ARGUMENT}${COMMAND_TAIL}`);
			expect(read).toContain("Profile:audit");
			expect(read).toContain("Account:123456789012");
			expect(read).toContain("Partition:aws-us-gov");
			expect(read).toContain(SAFETY_DETAILS.replace(/\s+/g, ""));
			expect(h.picked).toEqual([]);
			h.selector.handleInput("\x1b[A");
			expect(h.frame().join("\n")).toContain("Approve once");
			h.selector.handleInput(DOWN);
			expect(
				h
					.frame()
					.slice(1, 4)
					.map(row => row.slice(2, -2).replace(/[│█]\s*$/, ""))
					.join("")
					.replace(/\s+/g, ""),
			).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
			h.selector.handleInput("\n");
			expect(h.picked).toEqual([PERMISSIONS[2]!]);
			h.selector.handleInput("\x1b");
			expect(h.cancellations()).toBe(1);
		} finally {
			h.dispose();
		}
	});

	it("keeps empty search feedback readable and restores consent after clearing the query", () => {
		const h = composedFixture(52, 18);
		try {
			h.frame();
			h.lower.setText("HOOK BELOW ONE\nHOOK BELOW TWO\nHOOK BELOW THREE");
			h.status.setHookStatus("second", "STATUS SECOND");
			h.terminal.resize(24, 10);
			h.frame();
			h.selector.handleInput(DOWN);
			h.selector.handleInput(DOWN);
			h.frame();
			const query = "unmatched";
			h.selector.handleInput(query);
			const filtered = h.frame();
			expect(
				filtered
					.slice(1, 4)
					.join("")
					.replace(/[│█\s]/g, ""),
			).toContain("Nomatchingoptions");
			h.selector.handleInput("\n");
			expect(h.picked).toEqual([]);
			for (const _character of query) h.selector.handleInput("\x7f");
			h.frame();
			h.selector.handleInput(DOWN);
			h.selector.handleInput(DOWN);
			expect(
				h
					.frame()
					.slice(1, 4)
					.join("")
					.replace(/[│█\s]/g, ""),
			).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
			h.selector.handleInput("\n");
			expect(h.picked).toEqual([PERMISSIONS[2]!]);
		} finally {
			h.dispose();
		}
	});

	it("pages an oversized selected scope with its details and rejects consent when no body row fits", () => {
		const h = composedFixture(52, 18);
		try {
			h.frame();
			h.lower.setText("HOOK BELOW ONE\nHOOK BELOW TWO\nHOOK BELOW THREE");
			h.status.setHookStatus("second", "STATUS SECOND");
			h.terminal.resize(24, 9);
			h.selector.handleInput(DOWN);
			h.selector.handleInput(DOWN);
			const seen: string[] = [];
			for (let page = 0; page < 300; page++) {
				const frame = h.frame();
				expect(frame).toHaveLength(9);
				expect(frame.slice(-5).map(row => row.trim())).toEqual([
					"HOOK BELOW ONE",
					"HOOK BELOW TWO",
					"HOOK BELOW THREE",
					"STATUS FOOTER",
					"STATUS SECOND",
				]);
				for (const row of frame) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
				const body = frame.slice(1, 3).map(row =>
					row
						.slice(2, -2)
						.replace(/[│█]\s*$/, "")
						.trim(),
				);
				appendPage(seen, body);
				h.selector.handleInput(PAGE_DOWN);
			}
			const read = seen.join("").replace(/\s+/g, "");
			expect(read).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
			expect(read).toContain(COMMAND_TAIL);
			expect(read).toContain("Profile:audit");
			expect(read).toContain("Account:123456789012");
			expect(read).toContain("Partition:aws-us-gov");
			expect(read).toContain(SAFETY_DETAILS.replace(/\s+/g, ""));
			h.terminal.resize(24, 7);
			expect(h.frame()).toHaveLength(7);
			h.selector.handleInput("\n");
			expect(h.picked).toEqual([]);
			h.terminal.resize(52, 18);
			expect(h.frame().join("\n")).toContain(PERMISSIONS[2]!);
			h.selector.handleInput(PAGE_DOWN);
			const roomy = h.frame();
			expect(roomy.join("\n")).toContain(PERMISSIONS[2]!);
			expect(roomy.slice(-5).map(row => row.trim())).toEqual([
				"HOOK BELOW ONE",
				"HOOK BELOW TWO",
				"HOOK BELOW THREE",
				"STATUS FOOTER",
				"STATUS SECOND",
			]);
			h.selector.handleInput("\n");
			expect(h.picked).toEqual([PERMISSIONS[2]!]);
		} finally {
			h.dispose();
		}
	});

	it("keeps the complete session consent readable in a standalone selector after resizing", () => {
		const { selector, terminal, picked, cancellations } = fixture(52, 18);
		selector.render(52);
		for (let page = 0; page < 30; page++) selector.handleInput(PAGE_DOWN);
		terminal.resize(24, 9);
		expect(selector.render(24).length).toBeLessThanOrEqual(9);
		selector.handleInput(DOWN);
		selector.handleInput(DOWN);
		const content = selector
			.renderContent(20)
			.map(row => Bun.stripANSI(row))
			.join("")
			.replace(/\s+/g, "");
		expect(content).toContain(PERMISSIONS[2]!.replace(/\s+/g, ""));
		expect(picked).toEqual([]);
		selector.handleInput("\n");
		expect(picked).toEqual([PERMISSIONS[2]!]);
		selector.handleInput("\x1b");
		expect(cancellations()).toBe(1);
	});

	it("describes a full sanitized native scroller beside permission controls and forwards repeated page requests", () => {
		const { selector, terminal, picked } = fixture(32, 12, `${TITLE}\nIdentity:\tverified\x07`);
		const cx = context(32);
		const first = selector.describe(cx);
		const details = child(first, "details");
		const text = child(details, "detail");
		expect(nativeText(text)).toContain(`${COMMAND_TAIL}\nProfile: audit`);
		expect(nativeText(text)).toContain("Identity:   verified");
		expect(nativeText(text)).not.toContain("\x07");
		expect(text.p).toMatchObject({ wrap: "char" });
		expect(details.p?.max?.h).toMatch(/^\d+lines$/);
		expect(child(first, "list").p).toMatchObject({ selected: "0", shrink: 0 });
		selector.handleInput(PAGE_DOWN);
		const paged = selector.describe(cx);
		expect(child(child(paged, "details"), "detail").scroll).toEqual({ by: "page-down", n: 1 });
		expect(child(selector.describe(cx), "list").p).toMatchObject({ selected: "0" });
		selector.handleInput(PAGE_DOWN);
		expect(child(child(selector.describe(cx), "details"), "detail").scroll).toEqual({ by: "page-down", n: 2 });
		terminal.resize(32, 7);
		expect(child(selector.describe(cx), "details").p?.max?.h).not.toBe(details.p?.max?.h);
		expect(picked).toEqual([]);
		selector.handleNativeEvent({ type: "select", key: "details/detail", item: "2" });
		expect(picked).toEqual([]);
		selector.handleNativeEvent({ type: "select", key: "list", item: "0" });
		expect(picked).toEqual(["Deny"]);
	});

	it("pages native fallback clients without scroll support instead of retaining a stale detail description", () => {
		const { selector, picked } = fixture(28, 8);
		const cx = context(28, false);
		const read: string[] = [];
		for (let page = 0; page < 300; page++) {
			const details = child(selector.describe(cx), "details");
			const text = details.c?.[0];
			if (!text || !("k" in text)) throw new Error("Missing fallback detail text");
			read.push(nativeText(text));
			selector.handleInput(PAGE_DOWN);
		}
		expect(
			read
				.join("")
				.replace(/\s+/g, "")
				.replace(/[│█]/g, ""),
		).toContain(COMMAND_TAIL);
		expect(read.join("\n")).toContain("Account: 123456789012");
		expect(picked).toEqual([]);
		selector.handleInput("\x1b");
	});

	it("resets timeout on detail paging and leaves the external editor and cancellation paths active", () => {
		const terminal = new VirtualTerminal(32, 10);
		const picked: string[] = [];
		let resets = 0;
		let edited = 0;
		let cancelled = 0;
		const selector = new HookSelectorComponent(
			TITLE,
			PERMISSIONS,
			value => picked.push(value),
			() => cancelled++,
			{
				tui: new TUI(terminal),
				timeout: 60_000,
				onTimeoutReset: () => resets++,
				onExternalEditor: () => edited++,
			},
		);
		try {
			selector.render(32);
			selector.handleInput(PAGE_DOWN);
			selector.handleInput(PAGE_UP);
			selector.handleInput("\x07");
			expect(resets).toBe(3);
			expect(edited).toBe(1);
			expect(picked).toEqual([]);
			selector.handleInput("\x1b");
			expect(cancelled).toBe(1);
			expect(picked).toEqual([]);
		} finally {
			selector.dispose();
		}
	});

	it("keeps a non-overflowing ordinary detail readable natively rather than clipping it into a picker subtitle", () => {
		const picked: string[] = [];
		const selector = new HookSelectorComponent(
			"Sign in\nProfile: audit",
			PERMISSIONS,
			value => picked.push(value),
			() => {},
		);
		const described = selector.describe(context(80));
		expect(nativeText(child(child(described, "details"), "detail"))).toBe("Profile: audit");
		selector.handleInput(PAGE_DOWN);
		selector.handleInput(DOWN);
		selector.handleInput("\n");
		expect(picked).toEqual(["Approve once"]);
	});
});
