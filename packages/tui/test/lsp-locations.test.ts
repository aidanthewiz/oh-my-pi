import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

const DEFINITIONS = [
	"Found 3 definition(s):",
	"  src/a.ts:42:17",
	"    41: ",
	"    42: export function validate(token: string) {",
	"    43:   return token;",
	"  src/b.ts:7:3",
	"    6: // overload",
	"    7: function validate(): void;",
	"  src/c.d.ts:1:1",
	"    1: declare function validate(): void;",
].join("\n");

function renderRows(text: string, expanded: boolean, width = 100): string[] {
	return lspToolRenderer
		.renderResult({ content: [{ type: "text", text }] }, { expanded, isPartial: false }, theme, {
			action: "definition",
		})
		.render(width)
		.map(row => Bun.stripANSI(row));
}

describe("LSP definition locations", () => {
	it("bounds collapsed locations while keeping their source context", () => {
		const rows = renderRows(DEFINITIONS, false).join("\n");
		expect(rows).toContain("src/a.ts:42:17");
		expect(rows).toContain("export function validate(token: string) {");
		expect(rows).toContain("return token;");
		expect(rows).toContain("src/b.ts:7:3");
		expect(rows).not.toContain("src/c.d.ts");
	});

	it("shows every location when expanded", () => {
		const rows = renderRows(DEFINITIONS, true).join("\n");
		expect(rows).toContain("src/c.d.ts:1:1");
	});

	it("clips collapsed source to the available width without losing expanded content", () => {
		const source = `export const banner = "${"x".repeat(200)}TAIL";`;
		const text = ["Found 1 definition(s):", "  src/a.ts:2:14", `    2: ${source}`].join("\n");
		const rows = renderRows(text, false, 60);
		expect(rows.every(row => row.length <= 60)).toBe(true);
		expect(rows.join("\n")).not.toContain("TAIL");
		expect(renderRows(text, true, 400).join("\n")).toContain(source);
	});

	it("keeps a location whose path starts with whitespace instead of folding its source into the previous one", () => {
		const text = [
			"Found 2 definition(s):",
			"  src/a.ts:1:1",
			"    1: export const a = 1;",
			"   spaced.ts:3:5",
			"    3: export const spaced = 2;",
		].join("\n");
		const rows = renderRows(text, true).join("\n");
		expect(rows).toContain(" spaced.ts:3:5");
		expect(rows).toContain("export const spaced = 2;");
	});
});
