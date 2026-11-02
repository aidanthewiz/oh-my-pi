import { describe, expect, it } from "bun:test";
import { RedisClient, SQL } from "bun";
import { RedisSessionStorage } from "@oh-my-pi/pi-coding-agent/session/redis-session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import {
	SessionWriteConflictError,
	sessionContentFingerprint,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { admitTitleCard, serializeTitleSlot } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const sessionPath = "/sessions/cas/session.jsonl";
const title = { title: "Original", source: "auto" as const, updatedAt: "t1" };
const suffix =
	'{"type":"session","id":"cas-session","timestamp":"t1","cwd":"/cwd"}\n' +
	'{"type":"message","id":"turn","parentId":null,"timestamp":"t1","message":{"role":"user","content":"alpha","timestamp":1}}\n';
const original = serializeTitleSlot(title) + suffix;

type Storage = SqlSessionStorage | RedisSessionStorage;

async function openBackend(kind: "sqlite" | "redis"): Promise<{
	open(): Promise<Storage>;
	close(): Promise<void>;
}> {
	if (kind === "sqlite") {
		const client = new SQL("sqlite::memory:");
		return { open: () => SqlSessionStorage.create({ client }), close: () => client.end() };
	}
	if (!redisUrl) throw new Error("PI_TEST_REDIS_URL must name a disposable Redis instance");
	const url = new URL(redisUrl);
	if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
		throw new Error("Session CAS tests require a loopback Redis instance");
	}
	const client = new RedisClient(redisUrl);
	const prefix = `omp:test:session-cas:${crypto.randomUUID()}:`;
	await client.ping();
	return {
		open: () => RedisSessionStorage.create({ client, prefix }),
		async close() {
			try {
				await client.del(`${prefix}file:${sessionPath}`, `${prefix}meta`, `${prefix}title`);
			} finally {
				client.close();
			}
		},
	};
}

for (const backend of ["sqlite", "redis"] as const) {
	describe.skipIf(backend === "redis" && !redisUrl)(`indexed CAS on actual ${backend}`, () => {
		for (const publish of ["sync", "async"] as const) {
			it.each(["turn", "title", "card"] as const)(
				`${publish} publication preserves a peer's %s update`,
				async change => {
					const db = await openBackend(backend);
					try {
						const first = await db.open();
						await first.writeText(sessionPath, original);
						const snapshot = await first.readTextSnapshot(sessionPath);
						const peer = await db.open();
						if (change === "turn") {
							const replacement = original.replace('"alpha"', '"bravo"');
							expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
							await peer.writeText(sessionPath, replacement);
						} else {
							await peer.updateSessionTitle(
								sessionPath,
								change === "title"
									? { title: "Peer", source: "user", updatedAt: "t2" }
									: { ...title, card: admitTitleCard(title, { code: "PEER", emoji: "🚀" }) },
							);
						}
						const accepted = await peer.readCommittedState(sessionPath);
						if (change !== "turn") expect(accepted.rawContent).toBe(snapshot.rawContent);
						const options = {
							expectedSize: Buffer.byteLength(snapshot.rawContent),
							expectedFingerprint: sessionContentFingerprint(snapshot.rawContent),
							expectedTitleMeta: snapshot.titleMeta,
						};
						const stale = original.replace('"alpha"', '"delta"');
						if (publish === "sync") {
							first.writeTextSync(sessionPath, stale, options);
							await expect(first.confirmWrites(sessionPath)).rejects.toBeInstanceOf(SessionWriteConflictError);
							await first.drain().catch(() => {});
						} else {
							await expect(first.writeTextAtomic(sessionPath, stale, options)).rejects.toBeInstanceOf(
								SessionWriteConflictError,
							);
						}
						const reopened = await db.open();
						expect(await reopened.readCommittedState(sessionPath)).toEqual(accepted);
					} finally {
						await db.close();
					}
				},
			);
		}

		it("does not confirm raw replacement from a matching title-overlay projection", async () => {
			const db = await openBackend(backend);
			try {
				const storage = await db.open();
				await storage.writeText(sessionPath, original);
				const updated = { title: "Peer", source: "user" as const, updatedAt: "t2" };
				await storage.updateSessionTitle(sessionPath, updated);
				const snapshot = await storage.readTextSnapshot(sessionPath);
				const desired = serializeTitleSlot(updated) + suffix;
				expect(snapshot.content).toBe(desired);
				expect(snapshot.rawContent).toBe(original);
				await expect(
					storage.writeTextAtomic(sessionPath, desired, {
						expectedSize: Buffer.byteLength(original),
						expectedFingerprint: "0".repeat(40),
						expectedTitleMeta: snapshot.titleMeta,
					}),
				).rejects.toBeInstanceOf(SessionWriteConflictError);
				expect((await storage.readCommittedState(sessionPath)).rawContent).toBe(original);
			} finally {
				await db.close();
			}
		});
	});
}
