/**
 * Regression for #15878: a transcript placed in a session directory as a
 * symlink — a launcher's, a supervisor's clean-up tool's — is a transcript
 * like any other. `Bun.Glob` walks no symlink unless it is asked to, so
 * `omp --session-dir <dir> --resume <id>` found nothing where a hardlink, or
 * a copy, resumed the very same bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	findSessionFiles,
	listAllSessions,
	listRecentSessions,
	listSessions,
	resolveResumableSession,
} from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { FileSessionStorage, SessionWriteConflictError } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const SESSION_ID = "0198aaaa-0000-7000-8000-000000000001";
const SESSION_NAME = `2026-10-15T00-00-00-000Z_${SESSION_ID}.jsonl`;

// This account's filesystem may not be able to make a symlink at all: Windows
// needs SeCreateSymbolicLink, which an unprivileged account doesn't have.
const symlinksAvailable = ((): boolean => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-probe-"));
	try {
		fs.symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
})();

describe("a transcript that is a symlink", () => {
	let sessionsDir = "";
	let real = "";
	let outside = "";

	beforeEach(async () => {
		sessionsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-"));
		real = path.join(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-src-")),
			"transcript.jsonl",
		);
		// a session file as the CLI writes one: its header, then a turn
		await fs.promises.writeFile(
			real,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: SESSION_ID,
					timestamp: "2026-10-15T00:00:00.000Z",
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "u0",
					parentId: null,
					timestamp: "2026-10-15T00:00:00.000Z",
					message: { role: "user", content: "ping", timestamp: 0 },
				}),
			].join("\n") + "\n",
		);
	});

	afterEach(async () => {
		// `real` is empty when `beforeEach` threw before assigning it; removing
		// `path.dirname("")` (`.`) recursively would sweep the test runner's cwd.
		if (sessionsDir) await fs.promises.rm(sessionsDir, { recursive: true, force: true });
		if (real) await fs.promises.rm(path.dirname(real), { recursive: true, force: true });
		if (outside) await fs.promises.rm(outside, { recursive: true, force: true });
		outside = "";
	});

	it.skipIf(!symlinksAvailable)("is listed, and resumed from --session-dir", async () => {
		await fs.promises.symlink(real, path.join(sessionsDir, SESSION_NAME));

		const storage = new FileSessionStorage();
		expect((await listSessions(sessionsDir, storage)).map(session => session.id)).toEqual([SESSION_ID]);
		expect((await resolveResumableSession(SESSION_ID, "/tmp", sessionsDir))?.session.id).toBe(SESSION_ID);
	});

	it.skipIf(!symlinksAvailable)("is found under a project bucket, by id prefix", async () => {
		const bucket = path.join(sessionsDir, "-Users-me-proj");
		await fs.promises.mkdir(bucket, { recursive: true });
		await fs.promises.symlink(real, path.join(bucket, SESSION_NAME));

		expect(await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir)).toEqual([path.join(bucket, SESSION_NAME)]);
	});

	it.skipIf(!symlinksAvailable)("is listed once when a project bucket is a symlink to another", async () => {
		// The layout people build after renaming a project (#5385): one bucket
		// points at the other, so following symlinks reaches the transcript by
		// both names. It is one session, not two, and not an ambiguous match.
		const realBucket = path.join(sessionsDir, "-Users-me-real-proj");
		const aliasBucket = path.join(sessionsDir, "-Users-me-alias-proj");
		await fs.promises.mkdir(realBucket, { recursive: true });
		await fs.promises.symlink(real, path.join(realBucket, SESSION_NAME));
		await fs.promises.symlink(path.basename(realBucket), aliasBucket);

		const storage = new FileSessionStorage();
		expect((await listAllSessions(storage, sessionsDir)).map(session => session.id)).toEqual([SESSION_ID]);
		expect(await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir)).toEqual([
			path.join(realBucket, SESSION_NAME),
		]);
		expect((await listRecentSessions({ limit: 10, sessionsRoot: sessionsDir })).map(s => s.id)).toEqual([SESSION_ID]);
	});

	it.skipIf(!symlinksAvailable)("does not follow a bucket symlink out of the sessions root", async () => {
		// A bucket that is a symlink is not traversed, so a scan stays inside
		// the sessions root instead of listing whatever the alias points at.
		outside = path.join(path.dirname(sessionsDir), `${path.basename(sessionsDir)}-outside`);
		await fs.promises.mkdir(outside, { recursive: true });
		await fs.promises.copyFile(real, path.join(outside, SESSION_NAME));
		await fs.promises.symlink(outside, path.join(sessionsDir, "alias"));

		const storage = new FileSessionStorage();
		expect(await listAllSessions(storage, sessionsDir)).toEqual([]);
		expect(await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir)).toEqual([]);
		expect(await listRecentSessions({ limit: 10, sessionsRoot: sessionsDir })).toEqual([]);
	});

	it.skipIf(!symlinksAvailable)(
		"deduplicates leaf aliases but preserves distinct copies of the same session",
		async () => {
			const first = path.join(sessionsDir, "first");
			const second = path.join(sessionsDir, "second");
			await fs.promises.mkdir(first);
			await fs.promises.mkdir(second);
			await fs.promises.symlink(real, path.join(first, SESSION_NAME));
			await fs.promises.symlink(real, path.join(second, SESSION_NAME));
			const copy = path.join(first, `copy_${SESSION_ID}.jsonl`);
			await fs.promises.copyFile(real, copy);
			const expected = [fs.realpathSync(real), fs.realpathSync(copy)].sort();
			const found = await findSessionFiles(SESSION_ID.slice(0, 8), sessionsDir);
			expect(found.map(file => fs.realpathSync(file)).sort()).toEqual(expected);
			const listed = await listAllSessions(new FileSessionStorage(), sessionsDir);
			expect(listed.map(session => fs.realpathSync(session.path)).sort()).toEqual(expected);
		},
	);
});

describe("resuming through a symlinked transcript", () => {
	let sessionsDir = "";
	let staged = "";
	let real = "";
	let link = "";

	beforeEach(async () => {
		if (!symlinksAvailable) return;
		sessionsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-"));
		staged = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-session-symlink-src-"));
		real = path.join(staged, "transcript.jsonl");
		link = path.join(sessionsDir, SESSION_NAME);
		await fs.promises.writeFile(
			real,
			[
				JSON.stringify({
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: SESSION_ID,
					timestamp: "2026-10-15T00:00:00.000Z",
					cwd: "/tmp",
				}),
				JSON.stringify({
					type: "message",
					id: "u0",
					parentId: null,
					timestamp: "2026-10-15T00:00:00.000Z",
					message: { role: "user", content: "ping", timestamp: 0 },
				}),
			].join("\n") + "\n",
		);
		await fs.promises.symlink(real, link);
	});

	afterEach(async () => {
		if (sessionsDir) await fs.promises.rm(sessionsDir, { recursive: true, force: true });
		if (staged) await fs.promises.rm(staged, { recursive: true, force: true });
	});

	// A full rewrite renames a staged file over the path. Left alone, that
	// replaces the link: the staged transcript keeps every turn before it and a
	// new regular file beside it takes the rest (#15878).
	it.skipIf(!symlinksAvailable)("rewrites the referent and keeps the link", async () => {
		const storage = new FileSessionStorage();
		const before = await fs.promises.readFile(link, "utf8");
		storage.writeTextSync(link, `${before}${JSON.stringify({ type: "message", id: "a1" })}\n`);

		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		expect(await fs.promises.readFile(real, "utf8")).toContain(`"id":"a1"`);
	});

	it.skipIf(!symlinksAvailable)("appends through the link to the referent", async () => {
		const storage = new FileSessionStorage();
		const writer = storage.openWriter(link);
		const appendSync = writer.appendSync?.bind(writer);
		if (!appendSync) throw new Error("File writer must expose appendSync");
		appendSync(`${JSON.stringify({ type: "message", id: "a2" })}\n`);
		await writer.flush();

		expect(await fs.promises.readFile(real, "utf8")).toContain(`"id":"a2"`);
		expect((await fs.promises.lstat(link)).isSymbolicLink()).toBe(true);
		await writer.close();
	});

	it.skipIf(!symlinksAvailable)("keeps async CAS and rejected publication on the referent", async () => {
		const storage = new FileSessionStorage();
		const before = await storage.readText(real);
		const expectedSize = Buffer.byteLength(before);
		await storage.writeLinesAtomic(link, [before, "accepted\n"], { expectedSize });
		await expect(storage.writeTextAtomic(link, "stale\n", { expectedSize })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
		await storage.writeTextAtomic(link, "rejected\n", { commitGuard: () => false });
		expect(await storage.readText(real)).toBe(`${before}accepted\n`);
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it.skipIf(!symlinksAvailable)("keeps its referent through the EPERM replacement fallback", async () => {
		const target = fs.realpathSync(real);
		let failedRename = false;
		class EpermStorage extends FileSessionStorage {
			override renameSync(source: string, destination: string): void {
				if (!failedRename && destination === target) {
					failedRename = true;
					throw Object.assign(new Error("Synthetic rename denial"), { code: "EPERM" });
				}
				super.renameSync(source, destination);
			}
		}
		await new EpermStorage().writeTextAtomic(link, "replacement\n");
		expect(failedRename).toBe(true);
		expect(await fs.promises.readFile(real, "utf8")).toBe("replacement\n");
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
	});

	it.skipIf(!symlinksAvailable)("creates a dangling transcript referent without replacing its aliases", async () => {
		fs.unlinkSync(real);
		const secondLink = path.join(sessionsDir, "second.jsonl");
		fs.symlinkSync(path.basename(link), secondLink);
		const storage = new FileSessionStorage();
		storage.writeTextSync(secondLink, "created\n", { expectedSize: null });
		const writer = storage.openWriter(link);
		try {
			await writer.append("appended\n");
			await storage.writeTextAtomic(secondLink, "rewritten\n", { expectedSize: 17 });
			await writer.append("after-rewrite\n");
			expect(await storage.readText(real)).toBe("rewritten\nafter-rewrite\n");
			expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			expect(fs.lstatSync(secondLink).isSymbolicLink()).toBe(true);
		} finally {
			await writer.close();
		}
	});

	it.skipIf(!symlinksAvailable)("shares a missing descendant with a symlinked directory alias", async () => {
		const directoryAlias = path.join(sessionsDir, "directory");
		fs.symlinkSync(staged, directoryAlias, process.platform === "win32" ? "junction" : "dir");
		const missing = path.join(staged, "new", "transcript.jsonl");
		const alias = path.join(directoryAlias, "new", "transcript.jsonl");
		const storage = new FileSessionStorage();
		const writer = storage.openWriter(alias);
		try {
			await writer.append("first\n");
			storage.writeTextSync(missing, "replacement\n", { expectedSize: 6 });
			await writer.append("last\n");
			expect(await fs.promises.readFile(missing, "utf8")).toBe("replacement\nlast\n");
			expect(fs.lstatSync(directoryAlias).isSymbolicLink()).toBe(true);
		} finally {
			await writer.close();
		}
	});

	it.skipIf(!symlinksAvailable)("rejects a dangling symlink cycle without replacing the link", () => {
		const loop = path.join(sessionsDir, "loop.jsonl");
		fs.symlinkSync("missing/../loop.jsonl", loop);
		expect(() => new FileSessionStorage().writeTextSync(loop, "replacement\n")).toThrow(/ELOOP|symlink cycle/);
		expect(fs.lstatSync(loop).isSymbolicLink()).toBe(true);
	});

	it.skipIf(!symlinksAvailable)(
		"preserves a successful concurrent alias append across referent publication",
		async () => {
			const modulePath = Bun.fileURLToPath(new URL("../src/session/session-storage.ts", import.meta.url));
			const control = path.join(staged, "control");
			fs.mkdirSync(control);
			const marker = (name: string) => path.join(control, name);
			// Separate processes exercise native OS locks; fake timers cannot advance their barriers.
			const waitFor = async (name: string, timeout = 10_000) => {
				const deadline = Date.now() + timeout;
				while (!fs.existsSync(marker(name))) {
					if (Date.now() > deadline) throw new Error(`Timed out waiting for ${name}`);
					await Bun.sleep(5);
				}
			};
			const childSource = `
			import * as fs from "node:fs";
			import * as path from "node:path";
			import { mock } from "bun:test";
			import * as native from "@oh-my-pi/pi-natives";
			const [modulePath, role, file, control] = process.argv.slice(1);
			const marker = name => path.join(control, name);
			if (role === "append") {
				const bindings = { ...native };
				const OriginalFileLock = bindings.FileLock;
				class ObservedFileLock extends OriginalFileLock {
					static tryAcquire(gatePath) {
						const lock = OriginalFileLock.tryAcquire(gatePath);
						if (!lock.acquired) fs.writeFileSync(marker("outcome"), "blocked");
						return lock;
					}
				}
				mock.module("@oh-my-pi/pi-natives", () => ({ ...bindings, FileLock: ObservedFileLock }));
			}
			const { FileSessionStorage } = await import(modulePath);
			const waitFor = name => {
				const deadline = Date.now() + 15000;
				while (!fs.existsSync(marker(name))) {
					if (Date.now() > deadline) throw new Error("Child barrier timed out: " + name);
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
				}
			};
			if (role === "append") {
				const writer = new FileSessionStorage().openWriter(file);
				fs.writeFileSync(marker("ready"), "");
				waitFor("go");
				fs.writeFileSync(marker("attempt"), "");
				await writer.append("successful-append\\n");
				await writer.close();
				fs.writeFileSync(marker("success"), "");
				fs.writeFileSync(marker("outcome"), "success");
			} else {
				class PausedPublisher extends FileSessionStorage {
					renameSync(source, target) {
						fs.writeFileSync(marker("boundary"), "");
						waitFor("release");
						super.renameSync(source, target);
					}
				}
				new PausedPublisher().writeTextSync(file, "replacement\\n", {expectedSize: fs.statSync(file).size});
			}
		`;
			const appender = Bun.spawn([process.execPath, "--eval", childSource, modulePath, "append", link, control], {
				stdout: "pipe",
				stderr: "pipe",
			});
			let publisher: Subprocess<"ignore", "pipe", "pipe"> | undefined;
			try {
				await waitFor("ready");
				publisher = Bun.spawn([process.execPath, "--eval", childSource, modulePath, "publish", real, control], {
					stdout: "pipe",
					stderr: "pipe",
				});
				await waitFor("boundary");
				fs.writeFileSync(marker("go"), "");
				await waitFor("attempt");
				await waitFor("outcome");
				fs.writeFileSync(marker("release"), "");
				expect(await publisher.exited).toBe(0);
				expect(await appender.exited).toBe(0);
				expect(fs.existsSync(marker("success"))).toBe(true);
				expect(await fs.promises.readFile(real, "utf8")).toBe("replacement\nsuccessful-append\n");
				expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
			} finally {
				fs.writeFileSync(marker("go"), "");
				fs.writeFileSync(marker("release"), "");
				if (appender.exitCode === null) appender.kill();
				if (publisher?.exitCode === null) publisher.kill();
				await Promise.all([appender.exited, publisher?.exited]);
			}
		},
		25_000,
	);
});
