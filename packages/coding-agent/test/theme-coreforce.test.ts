import { describe, expect, it } from "bun:test";
import { type } from "arktype";
import { getSeriesColor } from "../../utils/src/vendor/mermaid-ascii/xychart/colors";
import { defaultThemes } from "../src/modes/theme/defaults";
import coreforceTheme from "../src/modes/theme/defaults/coreforce.json" with { type: "json" };
import {
	getMarkdownTheme,
	getThemeByName,
	setMarkdownMermaidRendering,
	setThemeInstance,
} from "../src/modes/theme/theme";
import themeSchema from "../src/modes/theme/theme-schema.json" with { type: "json" };

const requiredColorKeys = themeSchema.properties.colors.required as string[];
const colorSchema = Object.fromEntries(requiredColorKeys.map(key => [key, "string | number"]));
const themeValidator = type({
	name: "string",
	colors: colorSchema,
});

describe("coreforce theme", () => {
	it("contains every required color and passes the theme validator", () => {
		const missingKeys = requiredColorKeys.filter(key => !(key in coreforceTheme.colors));
		expect(missingKeys).toEqual([]);

		const parsed = themeValidator(coreforceTheme);
		expect(parsed).not.toBeInstanceOf(type.errors);
		expect(defaultThemes.coreforce).toEqual(coreforceTheme);
	});

	it("uses the active theme accent and light/dark polarity for Mermaid chart series", async () => {
		const themes = [
			["coreforce", false, "#000000"],
			["light", true, "#ffffff"],
		] as const;
		for (const [name, isLight, backgroundPolarity] of themes) {
			const activeTheme = await getThemeByName(name);
			expect(activeTheme).toBeDefined();
			expect(activeTheme!.isLight).toBe(isLight);
			setThemeInstance(activeTheme!);
			setMarkdownMermaidRendering(true);

			const markdownTheme = getMarkdownTheme();
			const rendered = markdownTheme.resolveMermaidAscii?.("xychart-beta\n  x-axis [A]\n  bar [10]\n  bar [20]");
			expect(rendered).toBeDefined();
			const accent = activeTheme!.getColorHex("accent");
			const ansiMode = activeTheme!.getColorMode() === "truecolor" ? "ansi-16m" : "ansi-256";
			const accentAnsi = Bun.color(accent, ansiMode);
			const seriesOne = Bun.color(getSeriesColor(1, accent, backgroundPolarity), ansiMode);
			expect(accentAnsi).not.toBeNull();
			expect(seriesOne).not.toBeNull();
			expect(rendered).toContain(accentAnsi!);
			expect(rendered).toContain(seriesOne!);
		}
	});
});
