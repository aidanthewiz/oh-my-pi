import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock } from "@oh-my-pi/pi-natives";
import { withArtifactPublicationLock } from "../src/session/artifact-publication";
import { ArtifactManager, writeArtifact } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("ArtifactManager write integrity", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `omp-artifact-integrity-${crypto.randomUUID()}`);
		dirs.push(dir);
		return dir;
	}

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) removeSyncWithRetries(dir);
	});

	it.skipIf(process.platform !== "linux")(
		"publishes from fresh and hostile working directories without opening the legacy name",
		async () => {
			const root = freshDir();
			const key = `coreforge-artifact-publication-v1-${os.userInfo().uid}`;
			const code = `
				import { writeArtifact } from ${JSON.stringify(new URL("../src/session/artifacts.ts", import.meta.url).href)};
				await writeArtifact(process.argv[1], "complete child publication");
			`;
			for (const kind of ["missing", "regular", "fifo"]) {
				const cwd = path.join(root, kind);
				await fsPromises.mkdir(cwd, { recursive: true });
				const legacyPath = path.join(cwd, key);
				if (kind === "regular") await fsPromises.writeFile(legacyPath, "unrelated working-directory file");
				if (kind === "fifo") {
					const madeFifo = Bun.spawnSync(["mkfifo", legacyPath], { env: { PATH: "/usr/bin:/bin" } });
					expect(madeFifo.exitCode).toBe(0);
				}
				const destination = path.join(cwd, "published.md");
				const child = Bun.spawn([process.execPath, "-e", code, destination], {
					cwd,
					env: { HOME: cwd, TMPDIR: cwd, PATH: "/usr/bin:/bin" },
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				});
				const deadline = setTimeout(() => child.kill(), 10_000);
				try {
					const [exit, stdout, stderr] = await Promise.all([
						child.exited,
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
					]);
					expect({ exit, stdout, stderr }).toEqual({ exit: 0, stdout: "", stderr: "" });
					expect(await fsPromises.readFile(destination, "utf8")).toBe("complete child publication");
					if (kind === "missing") expect(fs.existsSync(legacyPath)).toBe(false);
					if (kind === "regular")
						expect(await fsPromises.readFile(legacyPath, "utf8")).toBe("unrelated working-directory file");
					if (kind === "fifo") expect((await fsPromises.lstat(legacyPath)).isFIFO()).toBe(true);
				} finally {
					clearTimeout(deadline);
					if (child.exitCode === null) child.kill();
					await child.exited;
				}
			}
		},
	);

	it("keeps large spills scoped to the restored live owner with bounded reads", async () => {
		const manager = SessionManager.inMemory();
		dirs.push(manager.getArtifactManager().dir);
		const content = `${"x".repeat(8 * 1024 * 1024)}\ncomplete spill tail`;
		const id = await manager.saveArtifact(content);
		if (id === undefined) throw new Error("Expected spill id");
		expect(await manager.getArtifactContent(id, 8 * 1024 * 1024)).toBeNull();
		expect(await manager.getArtifactContent(id, Buffer.byteLength(content))).toBe(content);
		expect(await manager.getArtifactContent(`0${id}`, Buffer.byteLength(content))).toBeNull();
		const snapshot = manager.captureState();

		await manager.newSession();
		dirs.push(manager.getArtifactManager().dir);
		expect(await manager.getArtifactContent(id, Buffer.byteLength(content))).toBeNull();
		expect(await manager.saveArtifact("replacement owner")).toBe(id);
		expect(await manager.getArtifactContent(id, 17)).toBe("replacement owner");
		manager.restoreState(snapshot);
		expect(await manager.getArtifactContent(id, Buffer.byteLength(content))).toBe(content);

		manager.seal();
		expect(await manager.getArtifactContent(id, content.length)).toBeNull();
		manager.releaseRetainedEntries();
	});

	it("keeps persistent spill reads bounded", async () => {
		const dir = freshDir();
		const manager = SessionManager.create(dir, dir);
		try {
			const id = await manager.saveArtifact("disk-owned report");
			if (!id) throw new Error("Expected disk artifact id");
			expect(await manager.getArtifactContent(id, 16)).toBeNull();
			expect(await manager.getArtifactContent(id, 17)).toBe("disk-owned report");
		} finally {
			await manager.close();
			manager.releaseRetainedEntries();
		}
	});

	it("waits for a live publication before replacing its complete artifact", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const contended = Promise.withResolvers<void>();
		const acquire = FileLock.tryAcquire.bind(FileLock);
		vi.spyOn(FileLock, "tryAcquire").mockImplementation((...args) => {
			const lock = acquire(...args);
			if (!lock.acquired) contended.resolve();
			return lock;
		});
		const holder = withArtifactPublicationLock(async () => {
			await writeArtifact(destination, "first accepted report");
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const replacement = writeArtifact(destination, "second accepted report");
		try {
			await contended.promise;
			expect(await Bun.file(destination).text()).toBe("first accepted report");
		} finally {
			release.resolve();
			await holder;
			await replacement;
		}
		expect(await Bun.file(destination).text()).toBe("second accepted report");
	});

	it("cancels a waiting publisher without changing the accepted artifact", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "accepted report");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const contended = Promise.withResolvers<void>();
		const acquire = FileLock.tryAcquire.bind(FileLock);
		vi.spyOn(FileLock, "tryAcquire").mockImplementation((...args) => {
			const lock = acquire(...args);
			if (!lock.acquired) contended.resolve();
			return lock;
		});
		const holder = withArtifactPublicationLock(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const controller = new AbortController();
		const waiting = withArtifactPublicationLock(
			() => writeArtifact(destination, "cancelled report"),
			controller.signal,
		).then(
			() => undefined,
			error => error,
		);
		try {
			await contended.promise;
			controller.abort();
			expect(await waiting).toMatchObject({ name: "AbortError" });
			expect(await Bun.file(destination).text()).toBe("accepted report");
		} finally {
			controller.abort();
			release.resolve();
			await holder;
			await waiting;
		}
	});

	it("makes a detached continuation reacquire after its publication scope ends", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "accepted report");
		const wake = Promise.withResolvers<void>();
		let detached!: Promise<number>;
		await withArtifactPublicationLock(() => {
			detached = wake.promise.then(() => writeArtifact(destination, "detached report"));
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const contended = Promise.withResolvers<void>();
		const acquire = FileLock.tryAcquire.bind(FileLock);
		vi.spyOn(FileLock, "tryAcquire").mockImplementation((...args) => {
			const lock = acquire(...args);
			if (!lock.acquired) contended.resolve();
			return lock;
		});
		const holder = withArtifactPublicationLock(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		wake.resolve();
		try {
			await contended.promise;
			expect(await Bun.file(destination).text()).toBe("accepted report");
		} finally {
			release.resolve();
			await holder;
			await detached;
		}
		expect(await Bun.file(destination).text()).toBe("detached report");
	});

	it("rejects a short write instead of publishing an unreadable artifact id", async () => {
		const manager = new ArtifactManager(freshDir(), null);
		vi.spyOn(Bun, "write").mockResolvedValue(1);

		await expect(manager.save("complete report")).rejects.toThrow("Artifact write incomplete: wrote 1 of 15 bytes");
	});

	it("preserves the write failure when staging cleanup also fails", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 3));
			return 3;
		});
		vi.spyOn(fsPromises, "rm").mockRejectedValue(Object.assign(new Error("cleanup denied"), { code: "EPERM" }));

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");
		expect(await Bun.file(destination).text()).toBe("original valid report");
	});

	it("leaves no discoverable file when the staged write falls short", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		// Faithfully model a short write: partial bytes land on the staging file,
		// and Bun.write reports fewer bytes than requested.
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 3));
			return 3;
		});

		await expect(writeArtifact(destination, "full report body")).rejects.toThrow("Artifact write incomplete");

		// Neither the destination nor a leftover staging file survives, so
		// agent:// scans and local:// spill reads cannot resolve a truncated artifact.
		expect(await fs.promises.readdir(dir)).toEqual([]);
	});

	it("preserves the prior artifact when a follow-up write fails", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original valid report");

		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, 2));
			return 2;
		});

		await expect(writeArtifact(destination, "replacement report")).rejects.toThrow("Artifact write incomplete");

		expect(await Bun.file(destination).text()).toBe("original valid report");
		expect(await fs.promises.readdir(dir)).toEqual(["Worker.md"]);
	});

	it("replaces an existing artifact when Windows rejects rename-over-target", async () => {
		const dir = freshDir();
		await fs.promises.mkdir(dir, { recursive: true });
		const destination = path.join(dir, "Worker.md");
		await writeArtifact(destination, "original report");

		const rename = fs.promises.rename.bind(fs.promises);
		let injected = false;
		vi.spyOn(fs.promises, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(source).includes(".tmp-") && String(target) === destination) {
				injected = true;
				throw Object.assign(new Error("injected Windows replacement failure"), { code: "EEXIST" });
			}
			await rename(source, target);
		});

		await writeArtifact(destination, "replacement report");

		expect(injected).toBe(true);
		expect(await Bun.file(destination).text()).toBe("replacement report");
		expect(await fs.promises.readdir(dir)).toEqual(["Worker.md"]);
	});
});
