import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "../../coding-agent/src/config/settings";
import type { ToolSession } from "../../coding-agent/src/tools";
import { ReadTool } from "../../coding-agent/src/tools/read";
import type { NativeChild } from "../src/native/node";
import { getThemeByName, initTheme, type Theme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer, type ReadToolDetails } from "../src/tools/read";

type Presentation = "ansi" | "native";
type ReadResult = AgentToolResult<ReadToolDetails>;

function nativeText(children: readonly NativeChild[] | undefined): string {
	return (children ?? [])
		.flatMap(child => {
			if (!("k" in child)) return [];
			const props = child.p as { text?: string; spans?: readonly { t: string }[] } | undefined;
			return [props?.text ?? props?.spans?.map(span => span.t).join("") ?? "", nativeText(child.c)];
		})
		.filter(Boolean)
		.join("\n");
}

function textBody(result: ReadResult): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("raw read presentation", () => {
	let directory: string;
	let theme: Theme;
	let tool: ReadTool;

	beforeAll(async () => {
		await initTheme();
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		theme = dark;
	});

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), "read-raw-presentation-"));
		const session: ToolSession = {
			cwd: directory,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		tool = new ReadTool(session);
	});

	afterEach(() => {
		removeSyncWithRetries(directory);
	});

	function present(result: ReadResult, readPath: string, presentation: Presentation): string {
		const options = { expanded: true, isPartial: false };
		if (presentation === "native") {
			return Bun.stripANSI(nativeText(readToolRenderer.describeResult(result, options, { path: readPath }).body));
		}
		return Bun.stripANSI(
			readToolRenderer.renderResult(result, options, theme, { path: readPath }).render(240).join("\n"),
		);
	}

	test.each([
		["ansi", true],
		["native", true],
		["ansi", false],
		["native", false],
	] as const)("preserves URL body and statistics in %s presentation (raw=%s)", async (presentation, raw) => {
		const body = "FIRST\n---\n\nLAST";
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(body, { headers: { "Content-Type": "text/plain" } }),
		});
		try {
			const source = `http://127.0.0.1:${server.port}/body.txt`;
			const readPath = raw ? `${source}:raw` : source;
			const result = await tool.execute("read-url-presentation", { path: readPath });
			if (raw) expect(textBody(result)).toBe(body);
			else {
				expect(textBody(result)).toContain(`URL: ${source}\n`);
				expect(textBody(result)).toEndWith(`\n---\n\n${body}`);
			}

			const displayed = present(result, readPath, presentation);
			expect(displayed).toMatch(/FIRST[\s\S]*---[\s\S]*LAST/);
			expect(displayed.match(/\bFIRST\b/g)).toHaveLength(1);
			expect(displayed.match(/\bLAST\b/g)).toHaveLength(1);
			expect(displayed).not.toContain(`URL: ${source}`);
			expect(displayed).toContain("3 lines");
			if (presentation === "ansi") expect(displayed).toMatch(/Chars:\s*15\b/);
			else expect(displayed).toContain("15 chars");
		} finally {
			await server.stop(true);
		}
	});

	test.each(["ansi", "native"] as const)(
		"preserves an out-of-bounds raw file diagnostic without inventing source content in %s presentation",
		async presentation => {
			const file = path.join(directory, "notes.txt");
			fs.writeFileSync(file, "alpha\nbeta");
			const successfulPath = `${file}:raw`;
			const successful = await tool.execute("read-file-control", { path: successfulPath });
			expect(textBody(successful)).toBe("alpha\nbeta");
			const successfulDisplay = present(successful, successfulPath, presentation);
			expect(successfulDisplay).toContain("alpha");
			expect(successfulDisplay).toContain("beta");

			const readPath = `${file}:99:raw`;
			const result = await tool.execute("read-file-beyond-end", { path: readPath });
			const diagnostic = "Line 99 is beyond end of file (2 lines total).";
			expect(textBody(result)).toBe("");
			expect(result.details?.notes?.join("\n")).toContain(diagnostic);
			const displayed = present(result, readPath, presentation);
			expect(displayed).toContain(diagnostic);
			expect(displayed).not.toContain("alpha");
			expect(displayed).not.toContain("beta");
			expect(textBody(result)).toBe("");
		},
	);
});
