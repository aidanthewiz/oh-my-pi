import { afterEach, describe, expect, it, vi } from "bun:test";
import type { PathLike } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { canonicalProjectDir } from "../../src/daemon/paths";

describe("daemon project canonicalization EISDIR fallback", () => {
	const originalRealpath = fs.realpath.bind(fs);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the resolved path when realpath throws EISDIR", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-eisdir-fallback-"));
		const resolvedProjectDir = path.resolve(projectDir);

		vi.spyOn(fs, "realpath").mockImplementation((async (p: PathLike) => {
			if (path.resolve(String(p)) === resolvedProjectDir) {
				const err = new Error("EISDIR: illegal operation on a directory") as NodeJS.ErrnoException;
				err.code = "EISDIR";
				err.errno = -21;
				err.syscall = "lstat";
				err.path = `R:${path.sep}`;
				throw err;
			}
			return originalRealpath(p);
		}) as typeof fs.realpath);

		try {
			expect(await canonicalProjectDir(projectDir)).toBe(resolvedProjectDir);
		} finally {
			await fs.rm(projectDir, { recursive: true, force: true });
		}
	});
});
