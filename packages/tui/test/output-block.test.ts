import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { renderMarkdownCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { CachedOutputBlock, renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { OverlayPanel, PanelRows } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

describe("renderOutputBlock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps tool and overlay frame rows inside a one-column viewport", async () => {
		const theme = (await getThemeByName("dark"))!;
		const panel = new OverlayPanel("Heading");
		const body = new PanelRows();
		body.setLines(["x"]);
		panel.addChild(body);

		const frames = [
			renderOutputBlock({ width: 1, header: "Heading", sections: [{ lines: ["x"] }] }, theme),
			panel.render(1),
		];
		for (const rows of frames) {
			expect(Math.max(...rows.map(line => visibleWidth(line)))).toBe(1);
		}
	});

	it("draws footer meta inside the bottom border at full width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{ width: 30, applyBg: false, footerMeta: "Wall 0.16s", sections: [{ lines: ["out"] }] },
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.at(-1)).toContain("Wall 0.16s");
		expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
		expect(lines.some(line => line.startsWith("│") && line.includes("Wall"))).toBe(false);
	});

	it("wraps footer meta that overflows the border into body rows instead of clipping it", async () => {
		const theme = (await getThemeByName("dark"))!;
		const meta = "Wall: 1.2s/5m · Artifact: a123 · Exit: 7";
		const lines = renderOutputBlock(
			{ width: 40, applyBg: false, footerMeta: meta, sections: [{ lines: ["out"] }] },
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.every(line => visibleWidth(line) <= 40)).toBe(true);
		const body = lines.filter(line => line.startsWith("│")).join(" ");
		expect(body).toContain("Artifact: a123");
		expect(body).toContain("Exit: 7");
	});

	it("updates visible footer facts when a cached result changes", async () => {
		const theme = (await getThemeByName("dark"))!;
		const block = new CachedOutputBlock();
		const initial = { width: 40, applyBg: false, footerMeta: "Exit: 0", sections: [{ lines: ["out"] }] };
		expect(stripVTControlCharacters(block.render(initial, theme).join("\n"))).toContain("Exit: 0");
		const changed = block.render({ ...initial, footerMeta: "Artifact: retained-output · Exit: 7" }, theme);
		const plain = stripVTControlCharacters(changed.join("\n"));
		expect(plain).toContain("Artifact: retained-output");
		expect(plain).toContain("Exit: 7");
		expect(plain).not.toContain("Exit: 0");
		expect(changed.every(line => visibleWidth(line) <= 40)).toBe(true);
	});

	it("budgets collapsed Markdown rows against the padded block width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderMarkdownCell(
			{
				content: "x".repeat(27),
				contentMaxLines: 1,
				status: "complete",
				title: "Read",
				width: 30,
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.every(line => visibleWidth(line) <= 30)).toBe(true);
		expect(lines.join("\n")).toContain("x".repeat(26));
		expect(lines.join("\n")).toContain("1 more line");
	});
});
