/**
 * F2 live-steal repro (holds for HOLD finding 2 on 48642f8432).
 *
 * A live acquirer descheduled between lock create and holder record leaves
 * exactly this filesystem state: a contentless lock file older than the
 * orphan budget. Fixed code additionally holds a process-owned OS gate from
 * before create until after release, which the kernel reclaims even on
 * SIGKILL, and refuses the steal path while another holder owns it.
 *
 * This test takes the descheduled acquirer's place: it holds the OS gate,
 * plants the aged contentless lock, and publishes as a second writer. Broken
 * code cannot see the gate, so it steals the "orphan" and publishes around
 * the live holder. Fixed code fails closed at the gate before touching the
 * lockfile, and the holder's own publish lands cleanly once released.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock as NativeFileLock } from "@oh-my-pi/pi-natives";
import {
	FileSessionStorage,
	SessionLockError,
	SessionWriteConflictError,
	sessionContentFingerprint,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

/** Mirrors the OS-gate sidecar derived in `#withPublishLock`. */
function osGatePath(lockPath: string): string {
	return `${lockPath}.os`;
}

describe("publish lock OS gate", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-publish-gate-"));
	});

	afterEach(async () => {
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	it("refuses to steal while a live holder owns the gate", () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");
		storage.writeTextSync(sessionPath, "original\n");
		const lockPath = path.join(tempDir, ".session.jsonl.lock");
		// The descheduled holder owns the gate and left a contentless file
		// older than any live acquisition could be.
		const gate = NativeFileLock.tryAcquire(osGatePath(lockPath));
		expect(gate.acquired).toBe(true);
		try {
			fs.writeFileSync(lockPath, "");
			const aged = new Date(Date.now() - 60_000);
			fs.utimesSync(lockPath, aged, aged);
			let threw: unknown;
			try {
				storage.writeTextSync(sessionPath, "B-content\n");
			} catch (err) {
				threw = err;
			}
			if (!(threw instanceof SessionLockError)) {
				const body = fs.readFileSync(sessionPath, "utf8");
				throw new Error(
					`second writer published around a live gate holder (threw=${threw}, body=${JSON.stringify(body)})`,
				);
			}
			expect(fs.readFileSync(sessionPath, "utf8")).toBe("original\n");
		} finally {
			gate.release();
		}
		// The holder resumes after its deschedule and publishes cleanly.
		storage.writeTextSync(sessionPath, "A-content\n");
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("A-content\n");
	});
	it("serializes in-place title updates with the same publish gate", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "title.jsonl");
		const before = serializeTitleSlot({ title: "Original", source: "user", updatedAt: "t1" }) + "entry\n";
		storage.writeTextSync(sessionPath, before);
		const lockPath = path.join(tempDir, ".title.jsonl.lock");
		const gate = NativeFileLock.tryAcquire(osGatePath(lockPath));
		expect(gate.acquired).toBe(true);
		try {
			await expect(
				storage.updateSessionTitle(sessionPath, { title: "Updated", source: "user", updatedAt: "t2" }),
			).rejects.toBeInstanceOf(SessionLockError);
			expect(fs.readFileSync(sessionPath, "utf8")).toBe(before);
		} finally {
			gate.release();
		}
		const fingerprint = await storage.updateSessionTitle(sessionPath, {
			title: "Updated",
			source: "user",
			updatedAt: "t2",
		});
		if (!fingerprint) throw new Error("file title update must return a confirmed fingerprint");
		expect(fingerprint.copy().digest("hex")).toBe(sessionContentFingerprint(fs.readFileSync(sessionPath, "utf8")));
	});

	it("refuses an in-place title update after an equal-size turn replacement", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "title-cas.jsonl");
		const before = serializeTitleSlot({ title: "Original", source: "user", updatedAt: "t1" }) + "entry\n";
		storage.writeTextSync(sessionPath, before);
		const replaced = before.replace("entry\n", "other\n");
		fs.writeFileSync(sessionPath, replaced);
		await expect(
			storage.updateSessionTitle(
				sessionPath,
				{ title: "Updated", source: "user", updatedAt: "t2" },
				{ expectedSize: Buffer.byteLength(before), expectedFingerprint: sessionContentFingerprint(before) },
			),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe(replaced);
	});

	it("holds an append while another writer owns the gate", async () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "session.jsonl");
		storage.writeTextSync(sessionPath, "original\n");
		const writer = storage.openWriter(sessionPath);
		const appendSync = writer.appendSync?.bind(writer);
		if (!appendSync) throw new Error("File writer must expose appendSync");
		// Appends no longer claim the lockfile, so the gate is the only thing
		// keeping them out of another process's check-then-rename. A holder
		// mid-publish must make the append fail closed rather than land in the
		// file its rename is about to replace.
		const gate = NativeFileLock.tryAcquire(osGatePath(path.join(tempDir, ".session.jsonl.lock")));
		expect(gate.acquired).toBe(true);
		try {
			expect(() => appendSync("lost\n")).toThrow(SessionLockError);
		} finally {
			gate.release();
		}
		// The failed append poisons the writer; close surfaces it.
		await expect(writer.close()).rejects.toBeInstanceOf(SessionLockError);
		expect(fs.readFileSync(sessionPath, "utf8")).toBe("original\n");
	});

	it("fails closed when the native OS lock cannot be acquired", () => {
		const storage = new FileSessionStorage();
		const sessionPath = path.join(tempDir, "unsupported.jsonl");
		const spy = vi.spyOn(NativeFileLock, "tryAcquire").mockImplementation(() => {
			throw new Error("OS locks unavailable");
		});
		try {
			expect(() => storage.claimSessionFile(sessionPath)).toThrow(SessionLockError);
			expect(() => storage.writeTextSync(sessionPath, "not published\n")).toThrow(SessionLockError);
			expect(fs.existsSync(sessionPath)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});
});
