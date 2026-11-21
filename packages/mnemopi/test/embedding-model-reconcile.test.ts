/** Store opens replace incomparable model/pooling vectors only after a complete rebuild succeeds. */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	currentEmbeddingModel,
	resetEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const OLD_MODEL = "BAAI/bge-small-en-v1.5";
const NEW_MODEL = "intfloat/multilingual-e5-large";

// Deterministic fastembed-shaped provider so the background rebuild actually
// writes rows (and stamps them with the active model) under the test runtime.
function fakeEmbed() {
	return async function* embed(texts: readonly string[]) {
		yield texts.map(() => [0.1, 0.2, 0.3, 0.4]);
	};
}

function seedDb(model: string): { db: Database; ids: string[] } {
	const db = new Database(":memory:");
	initBeam(db);
	const ts = new Date().toISOString();
	db.prepare(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
	).run("wm-1", "alpha working memory", ts);
	db.prepare(
		"INSERT INTO episodic_memory (id, content, source, timestamp, session_id, binary_vector) VALUES (?, ?, 'test', ?, 'default', ?)",
	).run("ep-1", "beta episodic memory", ts, new Uint8Array([1, 2, 3, 4]));
	for (const id of ["wm-1", "ep-1"]) {
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			id,
			JSON.stringify([1, 0, 0, 0]),
			model,
		);
	}
	return { db, ids: ["wm-1", "ep-1"] };
}

function countEmbeddings(memory: Mnemopi): number {
	return (memory.conn.query("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number }).n;
}

describe("reconcileEmbeddingModel on store open", () => {
	it("wipes stale embeddings + binary vectors and re-embeds when the model changed", async () => {
		const { db, ids } = seedDb(OLD_MODEL);
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// The constructor enqueues the migration: it probes the new provider, embeds the corpus,
			// then swaps the stale vectors and clears the episodic binary vector.
			expect(memory.beam.pendingExtractions.size).toBeGreaterThanOrEqual(1);
			await memory.flushExtractions();
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).toBeNull();

			// Every live memory is re-stamped with the new model.
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all() as {
				memory_id: string;
				model: string;
			}[];
			expect(rows.map(row => row.memory_id).sort()).toEqual([...ids].sort());
			expect(rows.every(row => row.model === NEW_MODEL)).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("preserves updated embeddings and skips deleted memories when a rebuild commits", async () => {
		const { db } = seedDb(OLD_MODEL);
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-deleted", "delete during rebuild", ts);
		db.prepare("INSERT INTO memory_embeddings (memory_id, embedding_json, model) VALUES (?, ?, ?)").run(
			"wm-deleted",
			JSON.stringify([1, 0, 0, 0]),
			OLD_MODEL,
		);

		const oldContent = "alpha working memory";
		const updatedContent = "updated working memory";
		const updatedVector = [0, 1, 0, 0];
		const rebuildStarted = Promise.withResolvers<void>();
		const releaseRebuild = Promise.withResolvers<void>();
		const provider = async function* (texts: readonly string[]) {
			if (texts.includes(oldContent)) {
				rebuildStarted.resolve();
				await releaseRebuild.promise;
			}
			yield texts.map(text => {
				if (text === oldContent) return [1, 0, 0, 0];
				if (text === updatedContent) return updatedVector;
				return [0, 0, 1, 0];
			});
		};
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider } });
		try {
			await rebuildStarted.promise;
			const pendingBeforeUpdate = new Set(memory.beam.pendingExtractions);
			expect(memory.update("wm-1", updatedContent)).toBe(true);
			expect(memory.forget("wm-deleted")).toBe(true);
			const updateEmbedding = [...memory.beam.pendingExtractions].find(task => !pendingBeforeUpdate.has(task));
			expect(updateEmbedding).toBeDefined();
			await updateEmbedding;

			releaseRebuild.resolve();
			await memory.flushExtractions();

			const results = await memory.recall("unrelated lexical query", 5, {
				queryEmbedding: updatedVector,
				vecWeight: 1,
				ftsWeight: 0,
				importanceWeight: 0,
			});
			const updated = results.find(result => result.id === "wm-1");
			expect(updated?.content).toBe(updatedContent);
			expect(updated?.dense_score).toBe(1);
			expect(memory.conn.query("SELECT 1 FROM memory_embeddings WHERE memory_id = 'wm-deleted'").get()).toBeNull();
		} finally {
			releaseRebuild.resolve();
			await memory.flushExtractions();
			memory.close();
			db.close();
		}
	});

	it("keeps stale embeddings when the new provider does not answer", async () => {
		const { db } = seedDb(OLD_MODEL);
		const down = async function* (_texts: readonly string[]): AsyncGenerator<number[][]> {
			yield* [];
			throw new Error("provider down");
		};
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: down } });
		try {
			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT model FROM memory_embeddings").all() as { model: string }[];
			expect(rows).toHaveLength(2);
			expect(rows.every(row => row.model === OLD_MODEL)).toBe(true);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			memory.close();
			db.close();
		}
	});

	it("leaves embeddings untouched when the stored model already matches", () => {
		const { db } = seedDb(NEW_MODEL);
		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// No mismatch -> no wipe, no rebuild enqueued.
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			// The no-op path must preserve the episodic binary vector too (regression
			// guard against an unconditional clear that would silently drop vectors).
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
			expect(Array.from(ep.v as Uint8Array)).toEqual([1, 2, 3, 4]);
		} finally {
			memory.close();
			db.close();
		}
	});

	it("does not wipe when embeddings are disabled via the MNEMOPI_NO_EMBEDDINGS env", () => {
		const { db } = seedDb(OLD_MODEL);
		const previous = process.env.MNEMOPI_NO_EMBEDDINGS;
		process.env.MNEMOPI_NO_EMBEDDINGS = "1";
		let memory: Mnemopi | undefined;
		try {
			// The model differs, but with embeddings disabled the rebuild would
			// produce nothing — so the stale-but-present vectors must survive.
			memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			if (previous === undefined) {
				delete process.env.MNEMOPI_NO_EMBEDDINGS;
			} else {
				process.env.MNEMOPI_NO_EMBEDDINGS = previous;
			}
			memory?.close();
			db.close();
		}
	});

	it("does not wipe when the active embedding model is empty", () => {
		const { db } = seedDb(OLD_MODEL);
		let memory: Mnemopi | undefined;
		try {
			// An explicit empty model resolves to no embedder; wiping would be
			// unrecoverable, so the reconcile must skip.
			memory = new Mnemopi({ db, embeddings: { model: "", provider: fakeEmbed() } });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
		} finally {
			memory?.close();
			db.close();
		}
	});

	it("does not reconcile a read-only open (reconcile: false), even on a model change", () => {
		const { db } = seedDb(OLD_MODEL);
		let memory: Mnemopi | undefined;
		try {
			// A stats/read-only open is short-lived and would exit before its async
			// rebuild completed, so it must not perform the destructive wipe.
			memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() }, reconcile: false });
			expect(countEmbeddings(memory)).toBe(2);
			expect(memory.beam.pendingExtractions.size).toBe(0);
			const ep = memory.conn.query("SELECT binary_vector AS v FROM episodic_memory WHERE id = 'ep-1'").get() as {
				v: Uint8Array | null;
			};
			expect(ep.v).not.toBeNull();
		} finally {
			memory?.close();
			db.close();
		}
	});

	it("recovers an interrupted rebuild: re-enqueues live memories missing an active-model embedding", async () => {
		// Simulate a wipe that completed but whose async rebuild never finished (a process exit
		// or transient embed failure): live memories remain but `memory_embeddings` is empty. A
		// prior bug treated the empty table as "reconciled" and stranded them FTS-only forever.
		const db = new Database(":memory:");
		initBeam(db);
		const ts = new Date().toISOString();
		db.prepare(
			"INSERT INTO working_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("wm-1", "alpha working memory", ts);
		db.prepare(
			"INSERT INTO episodic_memory (id, content, source, timestamp, session_id) VALUES (?, ?, 'test', ?, 'default')",
		).run("ep-1", "beta episodic memory", ts);

		const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, provider: fakeEmbed() } });
		try {
			// No stale rows to wipe, but the missing-embedding recovery enqueues the live rows.
			expect(countEmbeddings(memory)).toBe(0);
			expect(memory.beam.pendingExtractions.size).toBeGreaterThanOrEqual(1);

			await memory.flushExtractions();
			const rows = memory.conn.query("SELECT memory_id, model FROM memory_embeddings ORDER BY memory_id").all() as {
				memory_id: string;
				model: string;
			}[];
			expect(rows.map(row => row.memory_id).sort()).toEqual(["ep-1", "wm-1"]);
			expect(rows.every(row => row.model === NEW_MODEL)).toBe(true);
		} finally {
			memory.close();
			db.close();
		}
	});
});

const MEAN_MODELS = [
	{ model: "intfloat/multilingual-e5-large", dim: 1024 },
	{ model: "sentence-transformers/all-MiniLM-L6-v2", dim: 384 },
];

async function withLocalEmbeddings(fn: () => Promise<void>): Promise<void> {
	const keys = [
		"NODE_ENV",
		"BUN_ENV",
		"MNEMOPI_EMBEDDING_API_URL",
		"OPENROUTER_BASE_URL",
		"MNEMOPI_EMBEDDINGS_VIA_API",
		"MNEMOPI_NO_EMBEDDINGS",
	] as const;
	const previous = keys.map(key => process.env[key]);
	try {
		for (const key of keys) delete process.env[key];
		resetEmbeddingProviderForTests();
		await fn();
	} finally {
		resetEmbeddingProviderForTests();
		for (let i = 0; i < keys.length; i++) {
			const value = previous[i];
			if (value === undefined) delete process.env[keys[i]];
			else process.env[keys[i]] = value;
		}
	}
}

describe("local fastembed pooling identity reconciliation", () => {
	it.each(MEAN_MODELS)("rebuilds legacy $model vectors without changing source memories", async ({ model, dim }) => {
		await withLocalEmbeddings(async () => {
			const { db } = seedDb(model);
			const legacy = JSON.stringify(Array.from({ length: dim }, (_, i) => Number(i === 0)));
			db.run("UPDATE memory_embeddings SET embedding_json = ?", [legacy]);
			db.run("UPDATE working_memory SET embed_text = 'alpha retrieval context' WHERE id = 'wm-1'");
			db.run("CREATE TABLE vec_episodes (rowid INTEGER PRIMARY KEY, embedding BLOB)");
			db.run("INSERT INTO vec_episodes (embedding) VALUES (?)", [new Uint8Array([1, 2, 3, 4])]);
			const working = db.query("SELECT * FROM working_memory").all();
			const episodic = db.query("SELECT content, source, timestamp, session_id FROM episodic_memory").all();
			let initCalls = 0;
			setLocalModelInitializerForTests(async () => {
				initCalls++;
				return {
					embed: async function* (texts) {
						yield texts.map(text =>
							Array.from({ length: dim }, (_, i) =>
								Number(i === (text === "alpha retrieval context" || text === "beta episodic memory" ? 1 : 0)),
							),
						);
					},
				};
			});
			const memory = new Mnemopi({ db, embeddings: { model, disabled: false, apiUrl: "" } });
			try {
				expect(countEmbeddings(memory)).toBe(2);
				await memory.flushExtractions();
				expect(db.query("SELECT binary_vector FROM episodic_memory").get()).toEqual({ binary_vector: null });
				expect(db.query("SELECT * FROM vec_episodes").all()).toEqual([]);
				expect(db.query("SELECT * FROM working_memory").all()).toEqual(working);
				expect(db.query("SELECT content, source, timestamp, session_id FROM episodic_memory").all()).toEqual(
					episodic,
				);
				expect(db.query("SELECT id FROM fts_working WHERE fts_working MATCH 'alpha'").all()).toEqual([
					{ id: "wm-1" },
				]);
				expect(db.query("SELECT rowid FROM fts_episodes WHERE fts_episodes MATCH 'beta'").all()).toEqual([
					{ rowid: 1 },
				]);
				expect(withMnemopiRuntimeOptions(memory.runtimeOptions, currentEmbeddingModel)).toBe(model);
				const rows = db
					.query("SELECT memory_id, embedding_json, model FROM memory_embeddings ORDER BY memory_id")
					.all();
				expect(rows).toEqual(
					["ep-1", "wm-1"].map(memoryId => ({
						memory_id: memoryId,
						embedding_json: JSON.stringify(Array.from({ length: dim }, (_, i) => Number(i === 1))),
						model: `${model}@fastembed3-mean`,
					})),
				);
				const reopened = new Mnemopi({ db, embeddings: { model, disabled: false, apiUrl: "" } });
				try {
					expect(reopened.beam.pendingExtractions.size).toBe(0);
					expect(
						db.query("SELECT memory_id, embedding_json, model FROM memory_embeddings ORDER BY memory_id").all(),
					).toEqual(rows);
					expect(initCalls).toBe(1);
				} finally {
					reopened.close();
				}
			} finally {
				memory.close();
				db.close();
			}
		});
	});

	it("preserves BGE, API, and custom provider vectors and identities", async () => {
		await withLocalEmbeddings(async () => {
			let initCalls = 0;
			let providerCalls = 0;
			setLocalModelInitializerForTests(async () => {
				initCalls++;
				throw new Error("a current store must not load a model");
			});
			const provider = {
				embed: async function* (texts: readonly string[]) {
					providerCalls++;
					yield texts.map(() => [1, 0, 0, 0]);
				},
			};
			const cases = [
				{ model: OLD_MODEL, disabled: false, apiUrl: "" },
				{ model: NEW_MODEL, disabled: false, apiUrl: "http://offline.invalid/v1" },
				{ model: MEAN_MODELS[1].model, disabled: false, apiUrl: "http://offline.invalid/v1" },
				{ model: NEW_MODEL, disabled: false, apiUrl: "", provider },
				{ model: MEAN_MODELS[1].model, disabled: false, apiUrl: "", provider },
				{ model: "custom-semantic-model", disabled: false, apiUrl: "", provider },
			];
			for (const embeddings of cases) {
				const { db } = seedDb(embeddings.model);
				const before = db.query("SELECT * FROM memory_embeddings ORDER BY memory_id").all();
				const memory = new Mnemopi({ db, embeddings });
				try {
					expect(memory.beam.pendingExtractions.size).toBe(0);
					expect(db.query("SELECT * FROM memory_embeddings ORDER BY memory_id").all()).toEqual(before);
					expect(db.query("SELECT binary_vector FROM episodic_memory").get()).toEqual({
						binary_vector: new Uint8Array([1, 2, 3, 4]),
					});
				} finally {
					memory.close();
					db.close();
				}
			}
			expect(initCalls).toBe(0);
			expect(providerCalls).toBe(0);
		});
	});

	it("preserves legacy pooling vectors on disabled, read-only, and empty-model opens", async () => {
		await withLocalEmbeddings(async () => {
			let initCalls = 0;
			setLocalModelInitializerForTests(async () => {
				initCalls++;
				throw new Error("guarded opens must not load a model");
			});
			const cases = [
				{ embeddings: { model: NEW_MODEL, disabled: true, apiUrl: "" } },
				{ embeddings: { model: NEW_MODEL, disabled: false, apiUrl: "" }, reconcile: false },
				{ embeddings: { model: "", disabled: false, apiUrl: "" } },
			];
			for (const options of cases) {
				const { db } = seedDb(NEW_MODEL);
				const before = db.query("SELECT * FROM memory_embeddings ORDER BY memory_id").all();
				const memory = new Mnemopi({ db, ...options });
				try {
					expect(memory.beam.pendingExtractions.size).toBe(0);
					expect(db.query("SELECT * FROM memory_embeddings ORDER BY memory_id").all()).toEqual(before);
					expect(db.query("SELECT binary_vector FROM episodic_memory").get()).toEqual({
						binary_vector: new Uint8Array([1, 2, 3, 4]),
					});
				} finally {
					memory.close();
					db.close();
				}
			}
			expect(initCalls).toBe(0);
		});
	});

	it("resumes only missing live rows after an interrupted bounded rebuild", async () => {
		await withLocalEmbeddings(async () => {
			const { db } = seedDb(`${NEW_MODEL}@fastembed3-mean`);
			db.run("DELETE FROM memory_embeddings WHERE memory_id = 'ep-1'");
			db.run("UPDATE episodic_memory SET binary_vector = NULL");
			db.run("UPDATE working_memory SET embed_text = 'alpha retrieval context' WHERE id = 'wm-1'");
			const insert = db.prepare(
				"INSERT INTO working_memory (id, content, source, timestamp, session_id, superseded_by) VALUES (?, ?, 'test', ?, 'default', ?)",
			);
			for (let i = 0; i < 129; i++)
				insert.run(`missing-${i}`, `missing content ${i}`, "2026-10-04T00:00:00.000Z", null);
			insert.run("retired", "retired content", "2026-10-04T00:00:00.000Z", "wm-1");
			const retained = db.query("SELECT * FROM memory_embeddings WHERE memory_id = 'wm-1'").get();
			const batches: string[][] = [];
			setLocalModelInitializerForTests(async () => ({
				embed: async function* (texts) {
					batches.push([...texts]);
					yield texts.map(() => [0, 1, 0, 0]);
				},
			}));
			const memory = new Mnemopi({ db, embeddings: { model: NEW_MODEL, disabled: false, apiUrl: "" } });
			try {
				expect(memory.beam.pendingExtractions.size).toBe(2);
				expect(db.query("SELECT * FROM memory_embeddings WHERE memory_id = 'wm-1'").get()).toEqual(retained);
				await memory.flushExtractions();
				expect(batches.map(batch => batch.length)).toEqual([128, 2]);
				expect(batches.flat().sort()).toEqual(
					["beta episodic memory", ...Array.from({ length: 129 }, (_, i) => `missing content ${i}`)].sort(),
				);
				expect(db.query("SELECT * FROM memory_embeddings WHERE memory_id = 'retired'").get()).toBeNull();
				expect(db.query("SELECT * FROM memory_embeddings WHERE memory_id = 'wm-1'").get()).toEqual(retained);
				expect(db.query("SELECT DISTINCT model FROM memory_embeddings").all()).toEqual([
					{ model: `${NEW_MODEL}@fastembed3-mean` },
				]);
				expect(countEmbeddings(memory)).toBe(131);
			} finally {
				memory.close();
				db.close();
			}
		});
	});
});
