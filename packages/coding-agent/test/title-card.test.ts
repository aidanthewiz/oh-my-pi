import { describe, expect, it } from "bun:test";
import {
	renderSessionTitle,
	parseCardReply,
	parseCardTitleReply,
	splitCardTitle,
} from "@oh-my-pi/pi-coding-agent/utils/title-card";

describe("portable session cards", () => {
	const reply = '<title nf="nf-md-flask" emoji="🧪" code="FLAKY">Fix flaky park tests</title>';
	const card = { code: "FLAKY", emoji: "🧪", nf: "nf-md-flask" };

	it("retains both candidates while presentation follows the current sink", () => {
		const parsed = parseCardTitleReply(reply)!;
		expect(parsed).toEqual({ title: "Fix flaky park tests", card });
		for (const nerd of [false, true]) {
			expect(renderSessionTitle(parsed.title, parsed.card, "boring", nerd)).toBe(parsed.title);
			expect(renderSessionTitle(parsed.title, parsed.card, "emoji", nerd)).toBe("🧪 FLAKY: Fix flaky park tests");
			expect(renderSessionTitle(parsed.title, parsed.card, "nf+emoji", nerd)).toBe(
				`${nerd ? "\u{f0093}" : "🧪"} FLAKY: Fix flaky park tests`,
			);
			expect(renderSessionTitle(parsed.title, parsed.card, "nf+emoji", nerd, true)).toBe(
				"🧪 FLAKY: Fix flaky park tests",
			);
		}
		expect(parsed.card).toEqual(card);
	});

	it("degrades malformed candidates independently without inferring private-use glyphs", () => {
		expect(parseCardTitleReply('<title nf="nf-md-not_a_glyph" emoji="🧪" code="FLAKY">Fix tests</title>')).toEqual({
			title: "Fix tests",
			card: { code: "FLAKY", emoji: "🧪" },
		});
		expect(parseCardTitleReply('<title nf="nf-md-flask" emoji="flask" code="FLAKY">Fix tests</title>')).toEqual({
			title: "Fix tests",
			card: { code: "FLAKY", nf: "nf-md-flask" },
		});
		expect(parseCardTitleReply('<title nf="nf-md-flask" emoji="🧪" code="TOOLONG">Fix tests</title>')).toEqual({
			title: "Fix tests",
		});
		expect(parseCardReply("\u{f0093} FLAKY")).toBeUndefined();
		expect(renderSessionTitle("Fix tests", { code: "FLAKY", nf: "nf-md-flask" }, "nf+emoji", true, true)).toBe(
			"Fix tests",
		);
	});

	it("normalizes candidates and generated line headings without nesting them", () => {
		expect(parseCardReply("nf-md-text-box 📝 blur: Rewrite text")).toEqual({
			code: "BLUR",
			emoji: "📝",
			nf: "nf-md-text_box",
		});
		expect(parseCardTitleReply('<title emoji="🗄" code="seed">Create seed data</title>')).toEqual({
			title: "Create seed data",
			card: { code: "SEED", emoji: "🗄️" },
		});
		expect(parseCardTitleReply("<title>🧪 FLAKY: Fix tests</title>")).toEqual({
			title: "Fix tests",
			card: { code: "FLAKY", emoji: "🧪" },
		});
		expect(parseCardTitleReply('<title nf="nf-md-flask" emoji="🧪" code="FLAKY">🔥 NEW: Fix tests</title>')).toEqual({
			title: "Fix tests",
			card,
		});
		expect(parseCardTitleReply("<title>Fix: the parser</title>")).toEqual({ title: "Fix: the parser" });
	});

	it("reconciles generated casing and rejects declined or invalid titles", () => {
		expect(
			parseCardTitleReply('<title emoji="🦀" code="VMM">Port tinyvmm to arm64</title>', "port TinyVMM to arm64"),
		).toEqual({ title: "Port TinyVMM to arm64", card: { code: "VMM", emoji: "🦀" } });
		for (const text of ["<title/>", '<title emoji="🧪" code="X" />', "No task", "<title>..</title>"]) {
			expect(parseCardTitleReply(text)).toBeNull();
		}
		for (const text of ["FLAKY", "🧪", "🧪 FLAKIEST", "Card 🧪 FLAKY", "#️⃣ HASH", "🧪🧪 FLAKY"]) {
			expect(parseCardReply(text)).toBeUndefined();
		}
	});
});

describe("splitCardTitle", () => {
	it("takes apart a card title headed by an emoji or a Nerd Fonts glyph", () => {
		expect(splitCardTitle("🧪 FLAKY: Fix flaky park tests")).toEqual({
			icon: "🧪",
			code: "FLAKY",
			title: "Fix flaky park tests",
		});
		expect(splitCardTitle("\u{f0093} FLAKY: Fix flaky park tests")?.icon).toBe("\u{f0093}");
	});

	it.each([
		["a plain title", "Fix flaky park tests"],
		["an ASCII prefix before a colon", "Fix BUG: the parser"],
		["a lowercase code", "🧪 flaky: Fix flaky park tests"],
		["a code longer than 6", "🧪 FLAKIEST: Fix flaky park tests"],
	])("leaves %s whole", (_case, title) => {
		expect(splitCardTitle(title)).toBeUndefined();
	});
});

describe("portable legacy title presentation", () => {
	it("strips only an unusable private-use heading at the OS sink", () => {
		expect(renderSessionTitle("\u{f0093} FLAKY: Fix tests", undefined, "nf+emoji", true, true)).toBe("Fix tests");
		expect(renderSessionTitle("🧪 FLAKY: Fix tests", undefined, "boring", false, true)).toBe("🧪 FLAKY: Fix tests");
		expect(renderSessionTitle("Manual title", undefined, "emoji", true, true)).toBe("Manual title");
	});
});
