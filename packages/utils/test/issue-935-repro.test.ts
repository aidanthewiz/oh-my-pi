import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
	});

	it("resolves a missing path through its deepest existing ancestor only when asked", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-through-missing-"));
		try {
			const real = path.join(temp, "real");
			const link = path.join(temp, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link, "junction");
			const missing = path.join(link, "sub", "new.ts");
			expect(resolveEquivalentPath(missing)).toBe(missing);
			expect(resolveEquivalentPath(missing, { throughMissing: true })).toBe(
				path.join(fs.realpathSync(real), "sub", "new.ts"),
			);
			fs.mkdirSync(path.dirname(missing));
			fs.writeFileSync(missing, "");
			expect(resolveEquivalentPath(missing, { throughMissing: true })).toBe(
				path.join(fs.realpathSync(real), "sub", "new.ts"),
			);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});

	it.each(["EACCES", "ELOOP", "ENOTDIR"])("does not turn %s into a through-missing key", code => {
		const failure = Object.assign(new Error(code), { code });
		const failRealpath = () => {
			throw failure;
		};
		vi.spyOn(fs, "realpathSync").mockImplementation(Object.assign(failRealpath, { native: failRealpath }));
		const inputPath = path.resolve("/sessions/link-project/new.ts");
		expect(() => resolveEquivalentPath(inputPath, { throughMissing: true })).toThrow(failure);
		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
	});
});
