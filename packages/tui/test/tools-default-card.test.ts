import { describe, expect, it } from "bun:test";
import { getThemeByName } from "../src/theme";
import type { DefaultToolRenderInput } from "../src/tools/default-renderer";
import { describeDefaultToolExecution, formatDefaultToolExecution } from "../src/tools/default-renderer";
import type { RenderResultOptions } from "../src/tools/renderer";

/** A generic (MCP/custom/extension) tool call that fell through to the fallback card. */
function mcpResult(output: string, expanded: boolean): DefaultToolRenderInput {
	return {
		label: "srv/mcp_tool",
		args: { query: "tokyo" },
		result: { output, isError: false },
		options: { expanded, isPartial: false } satisfies RenderResultOptions,
	};
}

describe("generic fallback card", () => {
	it("expands past 12 lines — Ctrl+O reveals the whole output", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		// 40 numbered rows: well past both the 12-row expanded cap and the 4-row collapsed window.
		const rows = Array.from({ length: 40 }, (_, i) => `row-${i}`);

		const collapsed = Bun.stripANSI(formatDefaultToolExecution(mcpResult(rows.join("\n"), false), 80, theme));
		expect(collapsed).toContain("row-0");
		expect(collapsed).toContain("row-3");
		expect(collapsed).not.toContain("row-10");

		const expanded = Bun.stripANSI(formatDefaultToolExecution(mcpResult(rows.join("\n"), true), 80, theme));
		// One exact ordered assertion: every row on its own line, no missing, extra, or reordered rows.
		expect(
			expanded
				.split("\n")
				.map(row => row.trim())
				.filter(row => /^row-\d+$/.test(row)),
		).toEqual(rows);
		expect(expanded).toContain("row-39");
		expect(expanded).not.toMatch(/more lines/);
	});

	it("keeps a >64 KiB result whole in the native view — no pre-slice before the terminal clamp", () => {
		// 100 KiB of newline-joined text: past the old 64 KiB construction-time cut.
		const rows = Array.from({ length: 4096 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
		const output = `${rows.join("\n")}\n`;
		expect(output.length).toBeGreaterThan(64 * 1024);

		const view = describeDefaultToolExecution(mcpResult(output, false));
		const body = view.body ?? [];
		const child = body[0];
		const props = child && "k" in child ? child.p : undefined;
		const text = props && "text" in props ? props.text : undefined;
		expect(typeof text).toBe("string");
		// Every byte survives construction; the terminal's disclosure clamp is the only bound.
		expect(text).toBe(output.trimEnd());
		expect(text?.length).toBeGreaterThan(64 * 1024);
		expect(text?.endsWith(`line-4095-${"x".repeat(20)}`)).toBe(true);
	});

	it("preserves large JSON values, exact integer identifiers and data keys in native disclosure", () => {
		const longValue = "x".repeat(3000);
		for (const [output, marker] of [
			[JSON.stringify({ blob: longValue }), longValue],
			[JSON.stringify(Array.from({ length: 300 }, (_, i) => `entry-${i}`)), "entry-299"],
			['{"id": 9223372036854775807}', "9223372036854775807"],
			['{"i": "kept"}', "kept"],
		]) {
			const view = describeDefaultToolExecution(mcpResult(output!, true));
			expect(JSON.stringify(view.body)).toContain(marker!);
		}

		const large = JSON.stringify({ blob: "x".repeat(100 * 1024) });
		const largeChild = (describeDefaultToolExecution(mcpResult(large, true)).body ?? [])[0];
		const props = largeChild && "k" in largeChild ? largeChild.p : undefined;
		expect(props && "text" in props ? props.text : undefined).toBe(large);
	});

	it("expands JSON the tree would cut as every raw row", async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("theme unavailable");
		const values = Array.from({ length: 300 }, (_, i) => `value-${i}`);
		const expanded = Bun.stripANSI(
			formatDefaultToolExecution(mcpResult(JSON.stringify(values, null, 2), true), 80, theme),
		);
		expect(expanded).toContain('"value-299"');
	});
});
