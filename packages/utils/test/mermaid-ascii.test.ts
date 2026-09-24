import path from "node:path";
import { describe, expect, it } from "bun:test";
import { renderMermaidAscii, renderMermaidAsciiSafe } from "../src/mermaid-ascii";

describe("renderMermaidAscii", () => {
	it("defers native addon loading until rendering begins", async () => {
		// A fresh dynamic import isolates the module-evaluation boundary under test.
		const proc = Bun.spawn(
			[
				process.execPath,
				"--no-install",
				"--eval",
				`await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/mermaid-ascii.ts"))})`,
			],
			{
				cwd: path.resolve(import.meta.dir, "../../.."),
				env: { ...process.env, PI_DEBUG_STARTUP: "1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
		expect(exitCode).toBe(0);
		expect(stderr).not.toContain("native:loadNative:start");
	});

	it("renders through the native binding with the requested options", () => {
		const rendered = renderMermaidAscii("graph LR\n  A --> B", { useAscii: true, colorMode: "none" });
		expect(rendered).toBe(
			["+---+     +---+", "|   |     |   |", "| A |---->| B |", "|   |     |   |", "+---+     +---+"].join("\n"),
		);
	});

	it("maps renderer errors to null in the safe variant", () => {
		expect(() => renderMermaidAscii("", { colorMode: "none" })).toThrow("Empty mermaid diagram");
		expect(renderMermaidAsciiSafe("", { colorMode: "none" })).toBeNull();
	});
});
