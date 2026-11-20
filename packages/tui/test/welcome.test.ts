import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { pickWeightedTip, WelcomeComponent } from "@oh-my-pi/pi-tui/prompt/welcome";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { visibleWidth } from "../src";

describe("WelcomeComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("weights [NEW] tips above ordinary tips in selection", () => {
		// Data-independent: tips.txt may legitimately carry zero "[NEW]" tips, so
		// exercise the weighting contract on a synthetic list.
		const tips = ["plain one", "shiny thing [NEW]", "plain two"] as const;

		const counts = new Map<string, number>();
		const samples = 10_000;
		for (let i = 0; i < samples; i++) {
			const tip = pickWeightedTip(tips, (i + 0.5) / samples); // sweep the selection domain uniformly
			counts.set(tip, (counts.get(tip) ?? 0) + 1);
		}

		let newMax = 0;
		let ordinaryMax = 0;
		for (const [tip, count] of counts) {
			if (/\[NEW\]\s*$/.test(tip)) newMax = Math.max(newMax, count);
			else ordinaryMax = Math.max(ordinaryMax, count);
		}

		// A "[NEW]" tip carries a >1 weight, so it covers strictly more of the
		// uniform selection domain than any single ordinary tip.
		expect(newMax).toBeGreaterThan(0);
		expect(newMax).toBeGreaterThan(ordinaryMax);
		expect(pickWeightedTip([], 0.5)).toBe("");
	});

	it("keeps the product identity visible without overflowing narrow or wide terminals", () => {
		const welcome = new WelcomeComponent("18.5.0", "Coreforge", "Aidan");
		for (const columns of [16, 24, 32, 50, 80, 140]) {
			const rows = welcome.render(columns).map(row => Bun.stripANSI(row).trimEnd());
			expect(rows.join("\n")).toContain("Coreforge");
			expect(rows.join("\n")).toContain("v18.5.0");
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
		}
	});

	it("keeps the Coreforge mark on wide native cards and the brand on narrow cards", () => {
		const welcome = new WelcomeComponent("18.5.0", "Coreforge", "Aidan");
		const cx = { cols: 80, dark: true, reduceMotion: false, supports: () => true, feature: () => true };
		const wide = JSON.stringify(welcome.describe(cx));
		const narrow = JSON.stringify(welcome.describe({ ...cx, cols: 24 }));

		expect(wide).toContain("⣠⠞⢁⣴⣦⡀");
		expect(wide).toContain("Welcome back, Aidan!");
		expect(wide).toContain("Coreforge");
		expect(wide).toContain("v18.5.0");
		expect(narrow).not.toContain("⣠⠞⢁⣴⣦⡀");
		expect(narrow).toContain("Coreforge");
		expect(narrow).toContain("v18.5.0");
	});
});
