import { describe, expect, it } from "bun:test";
import {
	SqlSessionStorage,
	type SqlSessionStorageClient,
	type SqlSessionStorageResult,
} from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	SessionWriteConflictError,
	sessionContentFingerprint,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

interface FakeRow {
	content: string;
	mtimeMs: number;
	title: string | null;
	title_source: string | null;
	title_updated_at: string | null;
	title_card: string | null;
}

function mysqlResult(affectedRows: number, rows: unknown[] = []): SqlSessionStorageResult {
	return Object.assign(rows, { affectedRows });
}

/** In-memory row store speaking just enough MySQL wire behavior for the test. */
function mysqlFake(): { client: SqlSessionStorageClient; rows: Map<string, FakeRow>; failNextUpdate(): void } {
	let skipNextUpdate = false;
	const rows = new Map<string, FakeRow>();
	const client: SqlSessionStorageClient = {
		options: { adapter: "mysql" },
		async unsafe(sql: string, values: unknown[] = []): Promise<SqlSessionStorageResult> {
			if (sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE")) return mysqlResult(0);
			if (sql.startsWith("SELECT path")) {
				return mysqlResult(
					0,
					[...rows].map(([path, row]) => ({
						path,
						mtime_ms: row.mtimeMs,
						byte_len: Buffer.byteLength(row.content, "utf8"),
						title: row.title,
						title_source: row.title_source,
						title_updated_at: row.title_updated_at,
						title_card: row.title_card,
					})),
				);
			}
			if (sql.startsWith("SELECT content")) {
				const row = rows.get(values[0] as string);
				return mysqlResult(
					0,
					row
						? [
								{
									content: row.content,
									title: row.title,
									title_source: row.title_source,
									title_updated_at: row.title_updated_at,
									title_card: row.title_card,
								},
							]
						: [],
				);
			}
			if (sql.startsWith("INSERT INTO")) {
				const [path, content, mtimeMs] = values as [string, string, number];
				if (sql.includes("DO NOTHING")) {
					if (rows.has(path)) return mysqlResult(0);
					rows.set(path, {
						content,
						mtimeMs,
						title: values[3] as string | null,
						title_source: values[4] as string | null,
						title_updated_at: values[5] as string | null,
						title_card: values[6] as string | null,
					});
					return mysqlResult(1, [{ path }]);
				}
				if (sql.includes("CONCAT(content, ?)")) {
					const existing = rows.get(path);
					rows.set(path, {
						content: (existing?.content ?? "") + (values[3] as string),
						mtimeMs: values[4] as number,
						title: existing?.title ?? null,
						title_source: existing?.title_source ?? null,
						title_updated_at: existing?.title_updated_at ?? null,
						title_card: existing?.title_card ?? null,
					});
					return mysqlResult(existing ? 2 : 1);
				}
				rows.set(path, {
					content: values[7] as string,
					mtimeMs: values[8] as number,
					title: values[9] as string | null,
					title_source: values[10] as string | null,
					title_updated_at: values[11] as string | null,
					title_card: values[12] as string | null,
				});
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE") && sql.includes("SET title = ?")) {
				const [title, title_source, title_updated_at, title_card, mtimeMs, path] = values as [
					string | null,
					string | null,
					string | null,
					string | null,
					number,
					string,
				];
				const row = rows.get(path);
				if (!row) return mysqlResult(0);
				rows.set(path, { ...row, title, title_source, title_updated_at, title_card, mtimeMs });
				return mysqlResult(1);
			}
			if (sql.startsWith("UPDATE")) {
				const [content, mtimeMs, title, title_source, title_updated_at, title_card, path, expectedSize] =
					values as [string, number, string | null, string | null, string | null, string | null, string, number];
				if (skipNextUpdate) {
					skipNextUpdate = false;
					return mysqlResult(0);
				}
				const row = rows.get(path);
				if (!row || Buffer.byteLength(row.content, "utf8") !== expectedSize) {
					return mysqlResult(0);
				}
				if (
					row.content === content &&
					row.title === title &&
					row.title_source === title_source &&
					row.title_updated_at === title_updated_at &&
					row.title_card === title_card
				) {
					// Matched but unchanged: a real MySQL UPDATE reports
					// affectedRows 0 here (unless CLIENT_FOUND_ROWS is set).
					return mysqlResult(0);
				}
				rows.set(path, { content, mtimeMs, title, title_source, title_updated_at, title_card });
				return mysqlResult(1);
			}
			throw new Error(`mysqlFake: unhandled statement: ${sql.slice(0, 60)}`);
		},
		async transaction(callback) {
			return callback(client);
		},
	};
	return {
		client,
		rows,
		failNextUpdate: () => {
			skipNextUpdate = true;
		},
	};
}

const BODY = "title-slot-line\nheader-line\nentry-one\n";

describe("SqlSessionStorage (MySQL no-op replace)", () => {
	it("does not latch a false conflict when affectedRows is 0 for a byte-identical body", async () => {
		// The sync publish path (`writeTextSync`, used by manager rewrites) has
		// no content readback: a backend `SessionWriteConflictError` lands in
		// the drain error latch. Identical bodies must not produce one.
		const { client, rows } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		expect(storage.adapter).toBe("mysql");

		await storage.writeText("/s/n.jsonl", BODY);
		const size = Buffer.byteLength(BODY, "utf8");

		storage.writeTextSync("/s/n.jsonl", BODY, { expectedSize: size });
		await storage.drain();
		expect(rows.get("/s/n.jsonl")?.content).toBe(BODY);
	});

	it("still throws a genuine conflict when another writer changed the body", async () => {
		const { client } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });

		await storage.writeText("/s/c.jsonl", BODY);
		const staleSize = Buffer.byteLength(BODY, "utf8");
		await storage.writeText("/s/c.jsonl", `${BODY}peer-line\n`);

		await expect(storage.writeTextAtomic("/s/c.jsonl", BODY, { expectedSize: staleSize })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
	});

	it("checks the old content under the transaction lock before replacing equal-length peer data", async () => {
		const { client, rows } = mysqlFake();
		const first = await SqlSessionStorage.create({ client });
		await first.writeText("/s/fenced.jsonl", "owner-one\n");
		const second = await SqlSessionStorage.create({ client });
		await second.writeTextAtomic("/s/fenced.jsonl", "owner-two\n", { expectedSize: 10 });
		const newer = rows.get("/s/fenced.jsonl");
		await expect(
			first.writeTextAtomic("/s/fenced.jsonl", "stale-end\n", {
				expectedSize: 10,
				expectedFingerprint: sessionContentFingerprint("owner-one\n"),
			}),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(rows.get("/s/fenced.jsonl")).toEqual(newer);
	});
	it("rejects zero affected rows when a title change was not published even if the transcript bytes match", async () => {
		const { client, rows, failNextUpdate } = mysqlFake();
		const storage = await SqlSessionStorage.create({ client });
		const sessionPath = "/s/title-fenced.jsonl";
		const targetTitle = { title: "New", source: "user" as const, updatedAt: "t2" };
		const oldTitle = { title: "Old", source: "auto" as const, updatedAt: "t1" };
		const raw = `${serializeTitleSlot(targetTitle)}{"type":"session"}\n`;
		await storage.writeText(sessionPath, raw);
		await storage.updateSessionTitle(sessionPath, oldTitle);
		failNextUpdate();
		await expect(
			storage.writeTextAtomic(sessionPath, raw, {
				expectedSize: Buffer.byteLength(raw, "utf8"),
				expectedFingerprint: sessionContentFingerprint(raw),
				expectedTitleMeta: JSON.stringify(oldTitle),
			}),
		).rejects.toBeInstanceOf(SessionWriteConflictError);
		expect(rows.get(sessionPath)?.title).toBe("Old");
	});

	it("still throws when the row is missing", async () => {
		const { client } = mysqlFake();

		const storage = await SqlSessionStorage.create({ client });

		await expect(storage.writeTextAtomic("/s/gone.jsonl", BODY, { expectedSize: 42 })).rejects.toBeInstanceOf(
			SessionWriteConflictError,
		);
	});
});
