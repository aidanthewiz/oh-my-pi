/**
 * Integration: `SessionManager` driven by `SqlSessionStorage` (SQLite
 * backend) instead of the file-backed store. Verifies the SQL substrate is
 * genuinely pluggable — append → flush → reload via `open()` works against
 * a real `Bun.SQL` connection, and `SessionManager.list()` enumerates rows
 * out of the table.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Usage } from "@oh-my-pi/pi-ai";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	SessionWriteConflictError,
	sessionContentFingerprint,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import { SQL } from "bun";

// Storage keys are platform paths; `/sessions/...` is only drive-relative on Windows,
// so a resolved `open()` would address a different key than `create()` wrote.
const virtualDir = (dir: string): string => path.resolve(dir);

function fakeUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

describe("SessionManager + SqlSessionStorage (SQLite)", () => {
	it("reopens portable metadata, clears it on a plain rename, and preserves overflow titles", async () => {
		const client = new SQL("sqlite::memory:");
		const dir = virtualDir("/sessions/portable-card");
		let storage = await SqlSessionStorage.create({ client });
		let manager = SessionManager.create("/cwd", dir, storage);
		try {
			await manager.ensureOnDisk();
			await manager.setSessionName("Portable", "auto", undefined, {
				code: "DB",
				emoji: "🧪",
				nf: "nf-md-flask",
			});
			const file = manager.getSessionFile()!;
			await manager.close();
			storage = await SqlSessionStorage.create({ client });
			manager = await SessionManager.open(file, dir, storage);
			expect(manager.getSessionName()).toBe("Portable");
			expect(manager.getSessionTitleCard()).toEqual({ code: "DB", emoji: "🧪", nf: "nf-md-flask" });
			await manager.setSessionName("Portable", "user");
			await manager.close();
			storage = await SqlSessionStorage.create({ client });
			manager = await SessionManager.open(file, dir, storage);
			expect(manager.getSessionName()).toBe("Portable");
			expect(manager.getSessionTitleCard()).toBeUndefined();
			await manager.setSessionName("界".repeat(150), "user", undefined, { code: "LONG", emoji: "🧪" });
			await manager.close();
			storage = await SqlSessionStorage.create({ client });
			manager = await SessionManager.open(file, dir, storage);
			expect(manager.getSessionName()).toBe("界".repeat(150));
			expect(manager.getSessionTitleCard()).toBeUndefined();
			const snapshot = await storage.readTextSnapshot(file);
			expect(JSON.parse(snapshot.titleMeta!).title).toBe("界".repeat(150));
			expect(Buffer.byteLength(snapshot.rawContent.split("\n")[0] + "\n", "utf8")).toBe(256);
		} finally {
			await manager.close();
			await client.end();
		}
	});

	it("persists appended assistant messages into SQL and reloads via open()", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/proj");

		const manager = SessionManager.create("/cwd", sessionDir, storage);
		manager.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "hi" }],
			usage: fakeUsage(10, 5),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const sessionFilePath = sessionFile as string;
		expect(sessionFilePath.startsWith(sessionDir)).toBe(true);

		// `appendMessage` queues the cold-path rewrite onto SessionManager's
		// internal persist chain via a fire-and-forget call. `flush()` awaits
		// that chain; `drain()` mops up the storage-level pending tail.
		await manager.flush();
		await storage.drain();
		await manager.close();

		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			sessionFilePath,
		])) as Array<{ content: string }>;
		expect(rows).toHaveLength(1);
		const lines = rows[0].content.trim().split("\n");
		expect(lines.length).toBeGreaterThanOrEqual(3);
		// The fixed-width title slot is always the first physical line; the session header follows.
		const slot = JSON.parse(lines[0]);
		expect(slot.type).toBe("title");
		const header = JSON.parse(lines[1]);
		expect(header.type).toBe("session");
		const msg = JSON.parse(lines[lines.length - 1]);
		expect(msg.type).toBe("message");
		expect(msg.message.role).toBe("assistant");
		expect(msg.message.content[0].text).toBe("hi");

		const reopened = await SessionManager.open(sessionFilePath, sessionDir, storage);
		const leaf = reopened.getLeafEntry();
		expect(leaf).toBeDefined();
		expect(leaf?.type).toBe("message");
		await reopened.close();
		await client.end();
	});

	it("SessionManager.list returns SQL-backed sessions for the cwd", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/list-proj");

		const a = SessionManager.create("/cwd", sessionDir, storage);
		a.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "alpha" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await a.flush();
		await storage.drain();
		await a.close();

		const b = SessionManager.create("/cwd", sessionDir, storage);
		b.appendMessage({
			role: "assistant",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			content: [{ type: "text", text: "beta" }],
			usage: fakeUsage(1, 1),
			api: "anthropic-messages",
			stopReason: "stop",
			timestamp: Date.now(),
		});
		await b.flush();
		await storage.drain();
		await b.close();

		const aFile = a.getSessionFile();
		const bFile = b.getSessionFile();
		expect(aFile).toBeDefined();
		expect(bFile).toBeDefined();

		const sessions = await SessionManager.list("/cwd", sessionDir, storage);
		const sessionFiles = sessions.map(s => s.path).sort();
		expect(sessionFiles).toContain(aFile as string);
		expect(sessionFiles).toContain(bFile as string);
		await client.end();
	});

	it("rejects a stale rewrite after another SQL storage appends", async () => {
		const client = new SQL("sqlite::memory:");
		const firstStorage = await SqlSessionStorage.create({ client });
		const sessionDir = virtualDir("/sessions/shared");
		const first = SessionManager.create("/cwd", sessionDir, firstStorage);
		await first.ensureOnDisk();
		const sessionFile = first.getSessionFile();
		if (!sessionFile) throw new Error("Expected session file");

		const secondStorage = await SqlSessionStorage.create({ client });
		const second = await SessionManager.open(sessionFile, sessionDir, secondStorage);
		second.appendMessage({ role: "user", content: "durable SQL peer turn", timestamp: Date.now() });
		await second.close();

		await expect(first.rewriteEntries()).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(await secondStorage.readText(sessionFile)).toContain("durable SQL peer turn");
		await client.end();
	});
	it("rejects a stale title-only replacement even when SQL content bytes do not change", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			const first = await SqlSessionStorage.create({ client });
			const sessionPath = "/sessions/title-fence.jsonl";
			const oldTitle = { title: "Old", source: "auto" as const, updatedAt: "t1" };
			const raw = `${serializeTitleSlot(oldTitle)}{"type":"session","id":"s","timestamp":"t1","cwd":"/cwd"}\n`;
			await first.writeText(sessionPath, raw);
			const newer = await SqlSessionStorage.create({ client });
			const newTitle = { title: "New", source: "user" as const, updatedAt: "t2" };
			await newer.updateSessionTitle(sessionPath, newTitle);

			await expect(
				first.writeTextAtomic(sessionPath, raw, {
					expectedSize: Buffer.byteLength(raw, "utf8"),
					expectedFingerprint: sessionContentFingerprint(raw),
					expectedTitleMeta: JSON.stringify(oldTitle),
				}),
			).rejects.toBeInstanceOf(SessionWriteConflictError);
			expect((await newer.readCommittedState(sessionPath)).titleMeta).toBe(JSON.stringify(newTitle));
		} finally {
			await client.end();
		}
	});
});
