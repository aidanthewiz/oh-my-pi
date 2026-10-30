import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GrepOutputMode, grep, hasMatch, search } from "../native/index.js";

describe("grep engine boundaries", () => {
	for (const [content, pattern] of [
		["other\nneedle", "^needle"],
		["needle\nother", "needle$"],
		["other\nneedle", "^needle(?=$)"],
		["needle\nother", "needle(?=$)"],
	] as const) {
		it(`[GS-F1] uses whole-buffer anchors for ${pattern} unless multiline is enabled`, () => {
			for (const value of [content, new TextEncoder().encode(content)]) {
				for (const expression of [pattern, new TextEncoder().encode(pattern)]) {
					expect(hasMatch(value, expression)).toBe(false);
					expect(hasMatch(value, expression, false, false)).toBe(false);
					expect(hasMatch(value, expression, false, true)).toBe(true);
				}
			}
		});
	}

	it("[GS-F1-controls] retains case folding, stray groups, and scanner line anchors", () => {
		expect(hasMatch("NEEDLE", "^needle$", true, false)).toBe(true);
		expect(hasMatch("call fetchProvider( now", "fetchProvider(")).toBe(true);
		for (const pattern of ["^needle", "^needle(?=$)"]) {
			const scanned = search("other\nneedle\n", { pattern, multiline: false });
			expect(scanned.error).toBeUndefined();
			expect(scanned.matches.map(match => [match.lineNumber, match.line])).toEqual([[2, "needle"]]);
		}
	});

	for (const pattern of [String.raw`foo(?!\s)`, String.raw`foo(?:\nbar)?\z`]) {
		it(`[GS-F4] evaluates each isolated line for ${pattern} in search and file grep`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-grep-fallback-"));
			try {
				const file = path.join(root, "fixture.txt");
				for (const content of ["foo\nqux\n", "foo\nqux"]) {
					await fs.writeFile(file, content);
					for (const mode of [GrepOutputMode.Content, GrepOutputMode.Count]) {
						for (const value of [content, new TextEncoder().encode(content)]) {
							const scanned = search(value, { pattern, multiline: false, mode });
							expect(scanned.error).toBeUndefined();
							expect(scanned.matchCount).toBe(1);
							if (mode === GrepOutputMode.Content) {
								expect(scanned.matches.map(match => [match.lineNumber, match.line])).toEqual([[1, "foo"]]);
							}
						}
						const onDisk = await grep({ pattern, path: file, multiline: false, mode });
						expect(onDisk.totalMatches).toBe(1);
						expect(onDisk.filesWithMatches).toBe(1);
						expect(onDisk.filesSearched).toBe(1);
						if (mode === GrepOutputMode.Content) {
							expect(onDisk.matches.map(match => [match.lineNumber, match.line])).toEqual([[1, "foo"]]);
						}
					}
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}

	it("[GS-F4-controls] keeps earlier line-local matches when a later whole-buffer match exists", () => {
		const scanned = search("foo\nqux\nfooZ\n", { pattern: String.raw`foo(?!\s)` });
		expect(scanned.error).toBeUndefined();
		expect(scanned.matches.map(match => [match.lineNumber, match.line])).toEqual([
			[1, "foo"],
			[3, "fooZ"],
		]);
		const multiline = search("foo\nqux\n", { pattern: String.raw`foo(?:\nbar)?\z`, multiline: true });
		expect(multiline.error).toBeUndefined();
		expect(multiline.matchCount).toBe(0);
	});

	it("[GS-F2-context] delivers complete context across read and callback batch boundaries", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-grep-stream-context-"));
		const controller = new AbortController();
		try {
			const file = path.join(root, "dense.txt");
			const count = 4096 + 5;
			await fs.writeFile(
				file,
				Array.from({ length: count }, (_, i) => `before ${i}\nneedle ${i}\nafter ${i}\n`).join(""),
			);
			let delivered = 0;
			const result = await grep({
				pattern: "needle",
				path: file,
				contextBefore: 1,
				contextAfter: 1,
				signal: controller.signal,
				onMatches(batch) {
					expect(batch.length).toBeGreaterThan(0);
					expect(batch.length).toBeLessThanOrEqual(1024);
					for (const match of batch) {
						expect(match.lineNumber).toBe(delivered * 3 + 2);
						expect(match.line).toBe(`needle ${delivered}`);
						expect(match.contextBefore).toEqual([{ lineNumber: delivered * 3 + 1, line: `before ${delivered}` }]);
						expect(match.contextAfter).toEqual([{ lineNumber: delivered * 3 + 3, line: `after ${delivered}` }]);
						delivered++;
					}
				},
			});
			expect(delivered).toBe(count);
			expect(result.totalMatches).toBe(count);
			expect(result.filesSearched).toBe(1);
			expect(result.filesWithMatches).toBe(1);
			expect(result.matches).toEqual([]);
		} finally {
			controller.abort();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
