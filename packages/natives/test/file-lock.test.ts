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

test.skipIf(process.platform === "win32")("non-creating FileLock refuses missing files and symlinks", async () => {
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
});

test.skipIf(process.platform !== "linux")(
	"explicit legacy keys retain cross-process ownership without opening CWD entries",
	async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-legacy-"));
		const key = `omp-legacy-${path.basename(root)} α`;
		const firstPath = path.join(root, "first.lock");
		const secondPath = path.join(root, "second.lock");
		const contexts = ["missing", "regular", "fifo"].map(name => path.join(root, name));
		const children: Bun.Subprocess<"pipe", "pipe", "pipe">[] = [];
		let owner: FileLock | undefined;
		const code = `
			import { FileLock } from ${JSON.stringify(new URL("../native/index.js", import.meta.url).href)};
			const lock = FileLock.tryAcquire(process.argv[1], false, process.argv[2]);
			process.stdout.write(JSON.stringify({ acquired: lock.acquired }) + "\\n");
			if (lock.acquired) await Bun.stdin.text();
			lock.release();
		`;
		const start = (cwd: string) => {
			const child = Bun.spawn([process.execPath, "-e", code, secondPath, key], {
				cwd,
				env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin:/bin" },
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
			children.push(child);
			return child;
		};
		const acquired = async (child: (typeof children)[number]) => {
			const reader = child.stdout.getReader();
			const timeout = setTimeout(() => child.kill(), 10_000);
			try {
				let text = "";
				while (!text.includes("\n")) {
					const { value, done } = await reader.read();
					if (done)
						throw new Error(`Lock child exited before readiness: ${await new Response(child.stderr).text()}`);
					text += new TextDecoder().decode(value);
				}
				return JSON.parse(text.trim()).acquired as boolean;
			} finally {
				clearTimeout(timeout);
				reader.releaseLock();
			}
		};
		try {
			await Promise.all(contexts.map(cwd => fs.mkdir(cwd)));
			await Promise.all([fs.writeFile(firstPath, ""), fs.writeFile(secondPath, "")]);
			await fs.writeFile(path.join(contexts[1]!, key), "must remain untouched");
			const fifo = path.join(contexts[2]!, key);
			const madeFifo = Bun.spawnSync(["mkfifo", fifo], { env: { PATH: "/usr/bin:/bin" } });
			expect(madeFifo.exitCode).toBe(0);

			owner = FileLock.tryAcquire(firstPath, false, key);
			expect(owner.acquired).toBe(true);
			for (const cwd of contexts) {
				const blocked = start(cwd);
				expect(await acquired(blocked)).toBe(false);
				expect(await blocked.exited).toBe(0);
			}
			expect(await fs.readdir(contexts[0]!)).toEqual([]);
			expect(await fs.readFile(path.join(contexts[1]!, key), "utf8")).toBe("must remain untouched");
			expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
			owner.release();

			for (const [index, cwd] of contexts.entries()) {
				const successor = start(cwd);
				expect(await acquired(successor)).toBe(true);
				const blocked = FileLock.tryAcquire(firstPath, false, key);
				expect(blocked.acquired).toBe(false);
				blocked.release();
				if (index === 1) successor.kill("SIGKILL");
				else successor.stdin.end();
				const exit = await successor.exited;
				if (index === 1) expect(successor.signalCode).toBe("SIGKILL");
				else expect(exit).toBe(0);
				owner = FileLock.tryAcquire(firstPath, false, key);
				expect(owner.acquired).toBe(true);
				owner.release();
			}
			expect(await fs.readdir(contexts[0]!)).toEqual([]);
			expect(await fs.readFile(path.join(contexts[1]!, key), "utf8")).toBe("must remain untouched");
			expect((await fs.lstat(fifo)).isFIFO()).toBe(true);
		} finally {
			owner?.release();
			for (const child of children) {
				if (child.exitCode === null) child.kill();
			}
			await Promise.all(children.map(child => child.exited));
			await fs.rm(root, { recursive: true, force: true });
		}
	},
);
