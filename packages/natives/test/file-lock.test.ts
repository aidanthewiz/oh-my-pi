import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "../native/index.js";

test("FileLock binds release to one native owner", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-lock-"));
	const lockPath = path.join(root, "resource.lock");
	try {
		const first = FileLock.tryAcquire(lockPath);
		expect(first.acquired).toBe(true);

		const blocked = FileLock.tryAcquire(lockPath);
		expect(blocked.acquired).toBe(false);
		blocked.release();

		first.release();
		const successor = FileLock.tryAcquire(lockPath);
		expect(successor.acquired).toBe(true);

		first.release();
		const third = FileLock.tryAcquire(lockPath);
		expect(third.acquired).toBe(false);
		third.release();
		expect(successor.acquired).toBe(true);

		expect(await Bun.file(lockPath).exists()).toBe(process.platform !== "win32");

		successor.release();
		const finalOwner = FileLock.tryAcquire(lockPath);
		expect(finalOwner.acquired).toBe(true);
		finalOwner.release();
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
});

test.skipIf(process.platform === "linux" || process.platform === "win32")(
	"non-creating FileLock refuses missing files and symlinks",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-native-existing-lock-"));
		const lockPath = path.join(root, "resource.lock");
		const target = path.join(root, "target");
		try {
			const missing = FileLock.tryAcquire(lockPath, false);
			expect(missing.acquired).toBe(false);
			missing.release();
			expect(await Bun.file(lockPath).exists()).toBe(false);
			await Bun.write(target, "unrelated bytes");
			await fs.symlink(target, lockPath);
			expect(() => FileLock.tryAcquire(lockPath, false)).toThrow(Error);
			expect(await fs.readlink(lockPath)).toBe(target);
			expect(await Bun.file(target).text()).toBe("unrelated bytes");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
