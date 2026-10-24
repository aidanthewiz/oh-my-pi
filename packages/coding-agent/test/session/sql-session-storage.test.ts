/**
 * Functional tests for {@link SqlSessionStorage}. Driven by a real
 * `Bun.SQL` SQLite instance (in-memory) so the storage exercises actual
 * SQL execution, not a hand-rolled mock. PostgreSQL/MySQL need actual-engine
 * qualification; captured query strings do not establish database behavior.
 */

import { describe, expect, it } from "bun:test";
import {
	admitTitleCard,
	overlayTitleSlotContent,
	serializeTitleSlot,
	titleUpdateFromContent,
} from "@oh-my-pi/pi-coding-agent/session/session-title-slot";
import {
	SessionWriteConflictError,
	sessionContentFingerprint,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage, type SqlSessionStorageClient } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import { SQL } from "bun";

async function createSqlite(): Promise<{ client: InstanceType<typeof SQL>; storage: SqlSessionStorage }> {
	const client = new SQL("sqlite::memory:");
	const storage = await SqlSessionStorage.create({ client });
	return { client, storage };
}

describe("SqlSessionStorage (SQLite backend)", () => {
	it("migrates existing title rows, reconstructs cards, and clears an identical title's card", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			await client.unsafe(
				`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT)`,
			);
			const sessionPath = "/sessions/p/card.jsonl";
			const old = { title: "Portable", source: "auto" as const, updatedAt: "t1" };
			const raw = `${serializeTitleSlot(old)}{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n`;
			await client.unsafe(
				`INSERT INTO omp_session_files (path, content, mtime_ms, title, title_source, title_updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
				[sessionPath, raw, 1, old.title, old.source, old.updatedAt],
			);
			const storage = await SqlSessionStorage.create({ client });
			const update = { title: "Portable", source: "auto" as const, updatedAt: "t2" };
			const card = admitTitleCard(update, { code: "DB", emoji: "🧪", nf: "nf-md-flask" });
			await storage.updateSessionTitle(sessionPath, { ...update, card });
			const rebuilt = await SqlSessionStorage.create({ client });
			const [prefix] = await rebuilt.readTextSlices(sessionPath, 256, 0);
			expect(JSON.parse(prefix).card).toMatchObject({ code: "DB", emoji: "🧪", nf: "nf-md-flask" });
			expect(titleUpdateFromContent(await rebuilt.readText(sessionPath))?.card?.code).toBe("DB");
			const clear = { title: "Portable", source: "user" as const, updatedAt: "t3" };
			await rebuilt.updateSessionTitle(sessionPath, clear);
			const cold = await SqlSessionStorage.create({ client });
			expect(titleUpdateFromContent(await cold.readText(sessionPath))).toEqual(clear);
			const rows = await client.unsafe(
				`SELECT title, title_source, title_updated_at, title_card FROM omp_session_files WHERE path = ?`,
				[sessionPath],
			);
			expect(rows).toEqual([{ title: "Portable", title_source: "user", title_updated_at: "t3", title_card: null }]);
		} finally {
			await client.end();
		}
	});

	it("rejects a stale rewrite after a card-only peer update without changing raw bytes", async () => {
		const { client, storage } = await createSqlite();
		try {
			const sessionPath = "/sessions/p/card-fence.jsonl";
			const update = { title: "Portable", source: "auto" as const, updatedAt: "t1" };
			const first = { ...update, card: admitTitleCard(update, { code: "OLD", emoji: "🧪" }) };
			const raw = `${serializeTitleSlot(first)}{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n`;
			await storage.writeText(sessionPath, raw);
			const snapshot = await storage.readTextSnapshot(sessionPath);
			const peer = await SqlSessionStorage.create({ client });
			await peer.updateSessionTitle(sessionPath, {
				...update,
				card: admitTitleCard(update, { code: "NEW", emoji: "🚀" }),
			});
			await expect(
				storage.writeTextAtomic(sessionPath, raw, {
					expectedSize: Buffer.byteLength(snapshot.rawContent, "utf8"),
					expectedFingerprint: sessionContentFingerprint(snapshot.rawContent),
					expectedTitleMeta: snapshot.titleMeta,
				}),
			).rejects.toBeInstanceOf(SessionWriteConflictError);
			expect((await peer.readTextSnapshot(sessionPath)).rawContent).toBe(snapshot.rawContent);
			expect(titleUpdateFromContent(await peer.readText(sessionPath))?.card?.code).toBe("NEW");
		} finally {
			await client.end();
		}
	});

	it("rolls back a rejected title/card publish and permits a later title transaction", async () => {
		const { client, storage } = await createSqlite();
		try {
			const sessionPath = "/sessions/p/rejected-card.jsonl";
			const old = { title: "Old", source: "auto" as const, updatedAt: "t1" };
			const first = { ...old, card: admitTitleCard(old, { code: "OLD", emoji: "🧪" }) };
			await storage.writeText(
				sessionPath,
				`${serializeTitleSlot(first)}{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n`,
			);
			await client.unsafe(
				`CREATE TRIGGER reject_title_card BEFORE UPDATE OF title_card ON omp_session_files ` +
					`BEGIN SELECT RAISE(ABORT, 'card rejected'); END`,
			);
			const next = { title: "New", source: "user" as const, updatedAt: "t2" };
			await expect(
				storage.updateSessionTitle(sessionPath, {
					...next,
					card: admitTitleCard(next, { code: "NEW", emoji: "🚀" }),
				}),
			).rejects.toThrow("card rejected");
			const [prefix] = await storage.readTextSlices(sessionPath, 256, 0);
			expect(JSON.parse(prefix)).toMatchObject({
				title: "Old",
				source: "auto",
				updatedAt: "t1",
				card: { code: "OLD" },
			});
			expect(titleUpdateFromContent(await storage.readText(sessionPath))).toEqual(first);
			await client.unsafe(`DROP TRIGGER reject_title_card`);
			await storage.updateSessionTitle(sessionPath, next);
			expect(titleUpdateFromContent(await storage.readText(sessionPath))).toEqual(next);
		} finally {
			await client.end();
		}
	});

	it("does not attach a stored card to a different winning title tuple", async () => {
		const { client, storage } = await createSqlite();
		try {
			const sessionPath = "/sessions/p/stale-card.jsonl";
			const old = { title: "Generated", source: "auto" as const, updatedAt: "t1" };
			const update = { ...old, card: admitTitleCard(old, { code: "GEN", emoji: "🧪" }) };
			await storage.writeText(
				sessionPath,
				`${serializeTitleSlot(update)}{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n`,
			);
			await client.unsafe(
				`UPDATE omp_session_files SET title = ?, title_source = ?, title_updated_at = ? WHERE path = ?`,
				["Manual", "user", "t2", sessionPath],
			);
			const cold = await SqlSessionStorage.create({ client });
			expect(titleUpdateFromContent(await cold.readText(sessionPath))).toEqual({
				title: "Manual",
				source: "user",
				updatedAt: "t2",
			});
			const [prefix] = await cold.readTextSlices(sessionPath, 256, 0);
			expect(JSON.parse(prefix).title).toBe("Manual");
			expect(JSON.parse(prefix).card).toBeUndefined();
		} finally {
			await client.end();
		}
	});

	it("preserves a card across append and move, then clears it on truncation", async () => {
		const { client, storage } = await createSqlite();
		try {
			const source = "/sessions/p/moving-card.jsonl";
			const destination = "/sessions/p/moved-card.jsonl";
			const update = { title: "Portable", source: "auto" as const, updatedAt: "t1" };
			await storage.writeText(
				source,
				`${serializeTitleSlot({ ...update, card: admitTitleCard(update, { code: "DB", emoji: "🧪" }) })}` +
					'{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n',
			);
			await storage.writeText(destination, "old destination\n");
			const writer = storage.openWriter(source);
			await writer.append('{"type":"custom","data":"appended"}\n');
			await writer.close();
			await storage.rename(source, destination);
			const cold = await SqlSessionStorage.create({ client });
			const content = await cold.readText(destination);
			expect(titleUpdateFromContent(content)?.card?.code).toBe("DB");
			expect(content).toEndWith('{"type":"custom","data":"appended"}\n');
			expect(cold.existsSync(source)).toBe(false);
			const replacement = cold.openWriter(destination, { flags: "w" });
			await replacement.append("replacement\n");
			await replacement.close();
			const cleared = await SqlSessionStorage.create({ client });
			expect(await cleared.readText(destination)).toBe("replacement\n");
			expect((await cleared.readTextSnapshot(destination)).titleMeta).toBeNull();
		} finally {
			await client.end();
		}
	});

	it("keeps complete overflow titles through direct updates, sync writes, and fenced rewrites", async () => {
		const { client, storage } = await createSqlite();
		try {
			const sessionPath = "/sessions/p/overflow.jsonl";
			const short = { title: "Short", source: "auto" as const, updatedAt: "t1" };
			const raw = `${serializeTitleSlot(short)}{"type":"session","id":"s","timestamp":"t1","cwd":"/repo"}\n{"type":"custom","data":"tail"}\n`;
			await storage.writeText(sessionPath, raw);
			const long = { title: "界".repeat(150), source: "user" as const, updatedAt: "t2" };
			await storage.updateSessionTitle(sessionPath, long);
			const snapshot = await storage.readTextSnapshot(sessionPath);
			expect(JSON.parse(snapshot.titleMeta!)).toEqual(long);
			expect(titleUpdateFromContent(snapshot.content)).toEqual(long);
			expect(Buffer.byteLength(snapshot.rawContent.split("\n")[0] + "\n", "utf8")).toBe(256);
			expect(snapshot.rawContent).toEndWith('{"type":"custom","data":"tail"}\n');
			storage.writeTextSync("/sessions/p/overflow-copy.jsonl", snapshot.content);
			await storage.drain();
			const newer = { ...long, title: "🙂".repeat(130), updatedAt: "t3" };
			await storage.writeTextAtomic(sessionPath, overlayTitleSlotContent(snapshot.content, newer), {
				expectedSize: Buffer.byteLength(snapshot.rawContent, "utf8"),
				expectedFingerprint: sessionContentFingerprint(snapshot.rawContent),
				expectedTitleMeta: snapshot.titleMeta,
			});
			const cold = await SqlSessionStorage.create({ client });
			expect(titleUpdateFromContent(await cold.readText(sessionPath))).toEqual(newer);
			expect(JSON.parse((await cold.readTextSnapshot("/sessions/p/overflow-copy.jsonl")).titleMeta!)).toEqual(long);
		} finally {
			await client.end();
		}
	});

	it("indexes writeText metadata and reads content asynchronously", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "line1\nline2\n");

		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(true);
		expect(await storage.readText("/sessions/p/a.jsonl")).toBe("line1\nline2\n");

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/a.jsonl",
		])) as Array<{ path: string; content: string }>;
		expect(rows).toEqual([{ path: "/sessions/p/a.jsonl", content: "line1\nline2\n" }]);

		const stat = storage.statSync("/sessions/p/a.jsonl");
		expect(stat.size).toBe(12);
		expect(typeof stat.mtimeMs).toBe("number");
		await client.end();
	});

	it("reconstructs existing rows with UTF-8 byte sizes", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			await client.unsafe(
				`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, title_card TEXT)`,
			);
			await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
				"/sessions/p/existing.jsonl",
				"界🙂\n",
				1,
			]);
			const storage = await SqlSessionStorage.create({ client, createTable: false });
			expect(storage.statSync("/sessions/p/existing.jsonl").size).toBe(8);
			expect(await storage.readText("/sessions/p/existing.jsonl")).toBe("界🙂\n");
		} finally {
			await client.end();
		}
	});

	it("listFilesSync returns only direct children matching the glob", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/dir/a.jsonl", "x");
		await storage.writeText("/dir/b.jsonl", "y");
		await storage.writeText("/dir/sub/c.jsonl", "z"); // nested — not a direct child
		await storage.writeText("/dir/note.bak", "skip");

		expect(storage.listFilesSync("/dir", "*.jsonl").sort()).toEqual(["/dir/a.jsonl", "/dir/b.jsonl"]);
		expect(storage.listFilesSync("/dir", "*.bak")).toEqual(["/dir/note.bak"]);
		await client.end();
	});

	it("writer.append appends to SQL after drain", async () => {
		const { client, storage } = await createSqlite();
		const writer = storage.openWriter("/sessions/p/session.jsonl");
		await writer.append('{"type":"session"}\n');
		await writer.append('{"type":"message"}\n');

		// Reads await queued appends and fetch content from SQL.
		expect(await storage.readText("/sessions/p/session.jsonl")).toBe('{"type":"session"}\n{"type":"message"}\n');

		await storage.drain();
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/session.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe('{"type":"session"}\n{"type":"message"}\n');

		await writer.close();
		await client.end();
	});

	it("flags='w' truncates both mirror and SQL row", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/keep.jsonl", "old content\n");

		const writer = storage.openWriter("/sessions/p/keep.jsonl", { flags: "w" });
		await writer.append("fresh\n");
		await writer.close();

		expect(await storage.readText("/sessions/p/keep.jsonl")).toBe("fresh\n");
		const rows = (await client.unsafe(`SELECT content FROM omp_session_files WHERE path = ?`, [
			"/sessions/p/keep.jsonl",
		])) as Array<{ content: string }>;
		expect(rows[0].content).toBe("fresh\n");
		await client.end();
	});

	it("statSync mtimes are strictly monotonic across rapid writes", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/s/a", "1");
		await storage.writeText("/s/b", "2");
		await storage.writeText("/s/c", "3");
		const a = storage.statSync("/s/a").mtimeMs;
		const b = storage.statSync("/s/b").mtimeMs;
		const c = storage.statSync("/s/c").mtimeMs;
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
		await client.end();
	});

	it("drain() surfaces writer errors so background failures are observable", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const writer = storage.openWriter("/sessions/p/fail.jsonl");

		// Force a SQL error: drop the table so the next append throws.
		await client.unsafe("DROP TABLE omp_session_files");
		void writer.append("doomed\n").catch(() => {});

		await expect(storage.drain()).rejects.toThrow();
		expect(writer.getError()).toBeDefined();
		await client.end();
	});

	it("deleteSessionWithArtifacts removes JSONL plus any sidecar keys", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/s1.jsonl", "session\n");
		await storage.writeText("/sessions/p/s1/draft.txt", "draft body");
		await storage.writeText("/sessions/p/s1/sub/notes", "more");
		await storage.writeText("/sessions/p/other.jsonl", "untouched\n");

		await storage.deleteSessionWithArtifacts("/sessions/p/s1.jsonl");

		expect(storage.existsSync("/sessions/p/s1.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/s1/sub/notes")).toBe(false);
		expect(storage.existsSync("/sessions/p/other.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files ORDER BY path`)) as Array<{
			path: string;
		}>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/other.jsonl"]);
		await client.end();
	});

	it("rename moves content and mtime atomically inside the mirror and the DB", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/orig.jsonl", "payload\n");
		const originalMtime = storage.statSync("/sessions/p/orig.jsonl").mtimeMs;

		await storage.rename("/sessions/p/orig.jsonl", "/sessions/p/renamed.jsonl");
		expect(storage.existsSync("/sessions/p/orig.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/renamed.jsonl")).toBe("payload\n");
		expect(storage.statSync("/sessions/p/renamed.jsonl").mtimeMs).toBe(originalMtime);

		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/renamed.jsonl", content: "payload\n" }]);
		await client.end();
	});

	it("rename overwrites an existing destination (parity with fs.rename)", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/a.jsonl", "from-a\n");
		await storage.writeText("/sessions/p/b.jsonl", "from-b\n");

		await storage.rename("/sessions/p/a.jsonl", "/sessions/p/b.jsonl");
		expect(storage.existsSync("/sessions/p/a.jsonl")).toBe(false);
		expect(await storage.readText("/sessions/p/b.jsonl")).toBe("from-a\n");
		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/b.jsonl", content: "from-a\n" }]);
		await client.end();
	});

	it("rename to the same path preserves the row", async () => {
		const { client, storage } = await createSqlite();
		const sessionPath = "/sessions/p/same.jsonl";
		await storage.writeText(sessionPath, "keep-me\n");

		await storage.rename(sessionPath, sessionPath);

		expect(storage.existsSync(sessionPath)).toBe(true);
		expect(await storage.readText(sessionPath)).toBe("keep-me\n");

		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [sessionPath]);
		await expect(storage.rename(sessionPath, sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("rename rolls back destination deletion when moving the source fails", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(
			`CREATE TRIGGER reject_session_move BEFORE UPDATE OF path ON omp_session_files ` +
				`WHEN OLD.path = '${source}' BEGIN SELECT RAISE(ABORT, 'move rejected'); END`,
		);

		await expect(storage.rename(source, destination)).rejects.toThrow("move rejected");

		expect(await storage.readText(source)).toBe("source\n");
		expect(await storage.readText(destination)).toBe("destination\n");
		await client.end();
	});

	it("rename rejects an externally deleted source without deleting the destination", async () => {
		const { client, storage } = await createSqlite();
		const source = "/sessions/p/source.jsonl";
		const destination = "/sessions/p/destination.jsonl";
		await storage.writeText(source, "source\n");
		await storage.writeText(destination, "destination\n");
		await client.unsafe(`DELETE FROM omp_session_files WHERE path = ?`, [source]);

		await expect(storage.rename(source, destination)).rejects.toMatchObject({ code: "ENOENT" });

		expect(await storage.readText(destination)).toBe("destination\n");
		const rows = (await client.unsafe(`SELECT path, content FROM omp_session_files`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: destination, content: "destination\n" }]);
		await client.end();
	});

	it("rename rejects a missing source, including a same-path rename", async () => {
		const { client, storage } = await createSqlite();

		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/new.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(storage.rename("/sessions/p/missing.jsonl", "/sessions/p/missing.jsonl")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await client.end();
	});

	it("refresh() reloads the mirror from SQL after out-of-band writes", async () => {
		const { client, storage } = await createSqlite();
		// Simulate a peer process inserting directly.
		await client.unsafe(`INSERT INTO omp_session_files (path, content, mtime_ms) VALUES (?, ?, ?)`, [
			"/peer/x.jsonl",
			"from peer\n",
			Date.now() + 5_000,
		]);
		expect(storage.existsSync("/peer/x.jsonl")).toBe(false);

		await storage.refresh();
		expect(storage.existsSync("/peer/x.jsonl")).toBe(true);
		expect(await storage.readText("/peer/x.jsonl")).toBe("from peer\n");
		await client.end();
	});

	it("readTextSlices returns byte windows from the head and tail", async () => {
		const { client, storage } = await createSqlite();
		await storage.writeText("/sessions/p/big.jsonl", "abcdefghij");

		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 4, 0))[0]).toBe("abcd");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 100, 0))[0]).toBe("abcdefghij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 0))[0]).toBe("");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 3))[1]).toBe("hij");
		expect((await storage.readTextSlices("/sessions/p/big.jsonl", 0, 100))[1]).toBe("abcdefghij");
		expect(await storage.readTextSlices("/sessions/p/big.jsonl", 4, 3)).toEqual(["abcd", "hij"]);
		await client.end();
	});

	it("persists title updates as indexed fields across storage reloads", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/sessions/p/titled.jsonl";
		const header = `${JSON.stringify({ type: "session", id: "s", timestamp: "t1", cwd: "/repo" })}\n`;
		await storage.writeText(
			sessionPath,
			`${serializeTitleSlot({ title: "Old", source: "auto", updatedAt: "t1" })}${header}`,
		);

		await storage.updateSessionTitle(sessionPath, { title: "New", source: "user", updatedAt: "t2" });

		expect(JSON.parse((await storage.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await storage.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});

		const reloaded = await SqlSessionStorage.create({ client });
		expect(JSON.parse((await reloaded.readText(sessionPath)).split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		expect(JSON.parse((await reloaded.readTextSlices(sessionPath, 256, 0))[0].split("\n")[0])).toMatchObject({
			type: "title",
			title: "New",
			source: "user",
			updatedAt: "t2",
		});
		await client.end();
	});

	it("reads multibyte head and tail windows by bytes", async () => {
		const { client, storage } = await createSqlite();
		try {
			await storage.writeText("/sessions/p/unicode.jsonl", "界🙂middle🚀終");
			expect(await storage.readTextSlices("/sessions/p/unicode.jsonl", 7, 7)).toEqual(["界🙂", "🚀終"]);
			expect(await storage.readTextSlices("/sessions/p/unicode.jsonl", 0, 3)).toEqual(["", "終"]);
		} finally {
			await client.end();
		}
	});

	it("custom table name is honored", async () => {
		const client = new SQL("sqlite::memory:");
		const storage = await SqlSessionStorage.create({ client, table: "agent_sessions" });
		await storage.writeText("/sessions/p/x.jsonl", "hello\n");
		const rows = (await client.unsafe(`SELECT path, content FROM agent_sessions`)) as Array<{
			path: string;
			content: string;
		}>;
		expect(rows).toEqual([{ path: "/sessions/p/x.jsonl", content: "hello\n" }]);
		await client.end();
	});

	it("rejects table names that aren't safe identifiers", async () => {
		const client = new SQL("sqlite::memory:");
		await expect(SqlSessionStorage.create({ client, table: "drop table users; --" })).rejects.toThrow(
			/table name must match/,
		);
		await client.end();
	});

	it("LIKE special chars in artifact paths don't blow up the prefix sweep", async () => {
		const { client, storage } = await createSqlite();
		// Path containing `%`, `_`, and the escape char `#`.
		await storage.writeText("/sessions/p/odd%_#name.jsonl", "session\n");
		await storage.writeText("/sessions/p/odd%_#name/draft.txt", "sidecar");
		await storage.writeText("/sessions/p/sibling.jsonl", "untouched");

		await storage.deleteSessionWithArtifacts("/sessions/p/odd%_#name.jsonl");
		expect(storage.existsSync("/sessions/p/odd%_#name.jsonl")).toBe(false);
		expect(storage.existsSync("/sessions/p/odd%_#name/draft.txt")).toBe(false);
		expect(storage.existsSync("/sessions/p/sibling.jsonl")).toBe(true);

		const remaining = (await client.unsafe(`SELECT path FROM omp_session_files`)) as Array<{ path: string }>;
		expect(remaining.map(r => r.path)).toEqual(["/sessions/p/sibling.jsonl"]);
		await client.end();
	});

	it("unlink on a missing key throws ENOENT", async () => {
		const { client, storage } = await createSqlite();
		await expect(storage.unlink("/sessions/p/ghost.jsonl")).rejects.toMatchObject({ code: "ENOENT" });
		await client.end();
	});

	it("createTable: false skips the DDL (consumer manages migrations)", async () => {
		const client = new SQL("sqlite::memory:");
		// Pre-create the table with the expected schema.
		await client.unsafe(
			`CREATE TABLE omp_session_files (path TEXT PRIMARY KEY, content TEXT NOT NULL, mtime_ms INTEGER NOT NULL, title TEXT, title_source TEXT, title_updated_at TEXT, title_card TEXT)`,
		);
		const storage = await SqlSessionStorage.create({ client, createTable: false });
		await storage.writeText("/s/x.jsonl", "ok");
		expect(await storage.readText("/s/x.jsonl")).toBe("ok");
		await client.end();
	});
});

describe("SqlSessionStorage adapter admission", () => {
	it("rejects clients reporting an unknown adapter without an override", async () => {
		const client: SqlSessionStorageClient = {
			options: { adapter: "weirdb" },
			async unsafe() {
				return [];
			},
			async transaction(callback) {
				return callback(client);
			},
		};
		await expect(SqlSessionStorage.create({ client })).rejects.toThrow(/unable to infer adapter/);
	});

	it("executes against an explicitly selected SQLite adapter", async () => {
		const client = new SQL("sqlite::memory:");
		try {
			const wrapped: SqlSessionStorageClient = {
				options: { adapter: "" },
				unsafe: (query, values) => client.unsafe(query, values),
				transaction: callback => client.transaction(async transaction => callback(transaction)),
			};
			const storage = await SqlSessionStorage.create({ client: wrapped, adapter: "sqlite" });
			await storage.writeText("/sessions/override.jsonl", "selected adapter\n");
			expect(await storage.readText("/sessions/override.jsonl")).toBe("selected adapter\n");
		} finally {
			await client.end();
		}
	});
});
