import { beforeAll, describe, expect, it } from "bun:test";
import { TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import type { DescribeContext, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { HookSelectorComponent } from "@oh-my-pi/pi-tui/overlays/hook-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "./virtual-terminal";

const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const PERMISSIONS = ["Deny", "Approve once", "Allow for the rest of this session"];
const COMMAND_TAIL = "COMMAND_TAIL_79";
const TITLE = `AWS approval\nCommand: aws s3api get-object --key ${"x".repeat(2400)}${COMMAND_TAIL}\nProfile: audit\nAccount: 123456789012\nPartition: aws-us-gov`;

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

function context(cols: number, scroll = true): DescribeContext {
	return { cols, reduceMotion: false, dark: true, supports: () => true, feature: name => name === "scroll" && scroll };
}

describe("selector detail viewport", () => {
	it("pages through an unbroken command and identity on a short narrow terminal without selecting permission", () => {
		const { selector, picked, cancellations } = fixture(28, 8);
		const seen: string[] = [];
		for (let page = 0; page < 300; page++) {
			const rendered = selector.render(28);
			expect(rendered.length).toBeLessThanOrEqual(8);
			for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(28);
			const content = selector.renderContent(24).map(row => Bun.stripANSI(row));
			const frame = content.join("\n");
			expect(frame).toContain("Deny");
			expect(frame).toContain("Approve once");
			seen.push(content[0]!);
			selector.handleInput(PAGE_DOWN);
		}
		const read = seen
			.join("")
			.replace(/\s+/g, "")
			.replace(/[│█]/g, "");
		expect(read).toContain(`Command:awss3apiget-object--key${"x".repeat(2400)}${COMMAND_TAIL}`);
		expect(read).toContain("Profile:audit");
		expect(read).toContain("Account:123456789012");
		expect(read).toContain("Partition:aws-us-gov");
		expect(picked).toEqual([]);
		expect(cancellations()).toBe(0);
		selector.handleInput(PAGE_UP);
		selector.handleInput("\n");
		expect(picked).toEqual(["Deny"]);
	});

	it("keeps the session permission reachable after paging and resizing, and preserves cancel", () => {
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
		expect(content).toContain("Allowfortherestofthissession");
		expect(picked).toEqual([]);
		selector.handleInput(PAGE_UP);
		selector.handleInput("\n");
		expect(picked).toEqual([PERMISSIONS[2]!]);
		selector.handleInput(UP);
		terminal.resize(70, 20);
		const frames: string[] = [];
		for (let page = 0; page < 60; page++) {
			selector.handleInput(PAGE_DOWN);
			frames.push(Bun.stripANSI(selector.render(70).join("\n")));
		}
		expect(frames.join("\n")).toContain("Partition: aws-us-gov");
		selector.handleInput("\x1b");
		expect(cancellations()).toBe(1);
		expect(picked).toEqual([PERMISSIONS[2]!]);
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
