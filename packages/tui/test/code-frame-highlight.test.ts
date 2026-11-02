import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as themeModule from "../src/theme/theme";
import { getThemeByName, type Theme } from "../src/theme/theme";
import { classifyGroupedLines, createCodeFrameStyler } from "../src/tools/grouped-file-output";

afterEach(() => {
	vi.restoreAllMocks();
});

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
});

describe("search code frames", () => {
	it("highlights only a bounded chunk of a huge match for the rows actually requested", () => {
		const lines = ["## big.ts", ...Array.from({ length: 2000 }, (_, i) => ` ${i + 1}│const v${i} = ${i};`)];
		const style = createCodeFrameStyler(lines, classifyGroupedLines(lines, undefined), "toolOutput", theme);
		const highlight = spyOn(themeModule, "highlightCode");
		style(1);
		style(2000);
		const highlightedRows = highlight.mock.calls.reduce((rows, [code]) => rows + code.split("\n").length, 0);
		expect(highlightedRows).toBeLessThanOrEqual(128);
	});
});
