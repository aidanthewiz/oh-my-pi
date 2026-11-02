import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, setThemeInstance, theme as activeTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { styledSpans } from "@oh-my-pi/pi-tui/native/spans";

let previousTheme: Theme | undefined;
beforeEach(() => {
	previousTheme = activeTheme;
});
afterEach(async () => {
	if (previousTheme) setThemeInstance(previousTheme);
	else await initTheme(false);
});

describe("Theme.fg over styled text", () => {
	it("keeps its color on the text after a nested color ends", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const footer = theme.fg("dim", `before ${theme.fg("success", "nested")} after`) + " outside";
		const spans = styledSpans(footer);
		const outer = spans.find(span => span.t.includes("before"))!.s;
		expect(spans.find(span => span.t.includes("after"))!.s).toBe(outer);
		expect(spans.find(span => span.t.includes("nested"))!.s).not.toBe(outer);
		expect(spans.find(span => span.t.includes("outside"))!.s).toBeUndefined();
	});

	it("restores its color after a full reset inside the text", async () => {
		const theme = (await getThemeByName("dark"))!;
		setThemeInstance(theme);
		const styled = theme.fg("accent", "a\x1b[0mb") + "c";
		const spans = styledSpans(styled);
		expect(spans.find(span => span.t.includes("b"))!.s).toBe(styledSpans(theme.fg("accent", "a"))[0]!.s);
		expect(spans.find(span => span.t.includes("c"))!.s).toBeUndefined();
	});
});
