import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { clearMemoryData, getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import {
	closeMemoryDb,
	enqueueGlobalWatermark,
	openMemoryDb,
	upsertThreads,
} from "@oh-my-pi/pi-coding-agent/memories/storage";
import { getAgentDbPath, TempDir } from "@oh-my-pi/pi-utils";

const CWD_A = "/projects/alpha";
const CWD_B = "/projects/beta";
const STAGE1_KIND = "memory_stage1";
const GLOBAL_KIND = "memory_consolidate_global";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("memory clear project scope", () => {
	let tempDir: TempDir;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@test-memory-clear-scope-");
		agentDir = tempDir.join("agent");
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterEach(async () => {
		await tempDir.remove().catch(() => {});
	});

	test("clearing one project keeps the other project's memory state", async () => {
		const db = openMemoryDb(getAgentDbPath(agentDir));
		upsertThreads(db, [
			{ id: "thread-a", updatedAt: 100, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" },
			{ id: "thread-b", updatedAt: 101, rolloutPath: "/b.jsonl", cwd: CWD_B, sourceKind: "cli" },
		]);
		db.run("INSERT INTO stage1_outputs VALUES ('thread-a', 100, 'alpha raw', 'alpha summary', null, 100)");
		db.run("INSERT INTO stage1_outputs VALUES ('thread-b', 101, 'beta raw', 'beta summary', null, 101)");
		const insertStage1Job = db.prepare(
			"INSERT INTO jobs (kind, job_key, status, retry_remaining, input_watermark, last_success_watermark) VALUES (?, ?, 'pending', 3, 0, 0)",
		);
		insertStage1Job.run(STAGE1_KIND, "thread-a");
		insertStage1Job.run(STAGE1_KIND, "thread-b");
		enqueueGlobalWatermark(db, 100, CWD_A, { forceDirtyWhenNotAdvanced: true });
		enqueueGlobalWatermark(db, 101, CWD_B, { forceDirtyWhenNotAdvanced: true });
		closeMemoryDb(db);

		const rootA = getMemoryRoot(agentDir, CWD_A);
		const rootB = getMemoryRoot(agentDir, CWD_B);
		await fs.mkdir(rootA, { recursive: true });
		await fs.mkdir(rootB, { recursive: true });
		await Bun.write(path.join(rootA, "MEMORY.md"), "# alpha memory\n");
		await Bun.write(path.join(rootB, "MEMORY.md"), "# beta memory\n");

		await clearMemoryData(agentDir, CWD_A);

		expect(await fileExists(path.join(rootA, "MEMORY.md"))).toBe(false);
		expect(await Bun.file(path.join(rootB, "MEMORY.md")).text()).toBe("# beta memory\n");

		const check = openMemoryDb(getAgentDbPath(agentDir));
		const threads = check.query("SELECT id FROM threads ORDER BY id").all() as { id: string }[];
		const outputs = check.query("SELECT thread_id FROM stage1_outputs ORDER BY thread_id").all() as {
			thread_id: string;
		}[];
		const jobs = check.query("SELECT kind, job_key FROM jobs ORDER BY kind, job_key").all() as {
			kind: string;
			job_key: string;
		}[];
		closeMemoryDb(check);

		expect(threads).toEqual([{ id: "thread-b" }]);
		expect(outputs).toEqual([{ thread_id: "thread-b" }]);
		expect(jobs).toEqual([
			{ kind: GLOBAL_KIND, job_key: `global:${CWD_B}` },
			{ kind: STAGE1_KIND, job_key: "thread-b" },
		]);
	});

	test("an aborted clear keeps the project's persisted state and generated files", async () => {
		const db = openMemoryDb(getAgentDbPath(agentDir));
		upsertThreads(db, [{ id: "thread-a", updatedAt: 100, rolloutPath: "/a.jsonl", cwd: CWD_A, sourceKind: "cli" }]);
		db.run("INSERT INTO stage1_outputs VALUES ('thread-a', 100, 'alpha raw', 'alpha summary', null, 100)");
		enqueueGlobalWatermark(db, 100, CWD_A, { forceDirtyWhenNotAdvanced: true });
		closeMemoryDb(db);

		const memoryFile = path.join(getMemoryRoot(agentDir, CWD_A), "MEMORY.md");
		await fs.mkdir(path.dirname(memoryFile), { recursive: true });
		await Bun.write(memoryFile, "# alpha memory\n");
		const controller = new AbortController();
		const reason = new Error("clear cancelled");
		controller.abort(reason);

		await expect(clearMemoryData(agentDir, CWD_A, controller.signal)).rejects.toBe(reason);

		expect(await Bun.file(memoryFile).text()).toBe("# alpha memory\n");
		const check = openMemoryDb(getAgentDbPath(agentDir));
		try {
			expect(check.query("SELECT id FROM threads").all()).toEqual([{ id: "thread-a" }]);
			expect(check.query("SELECT raw_memory FROM stage1_outputs").all()).toEqual([{ raw_memory: "alpha raw" }]);
			expect(check.query("SELECT job_key FROM jobs WHERE kind = ?").all(GLOBAL_KIND)).toEqual([
				{ job_key: `global:${CWD_A}` },
			]);
		} finally {
			closeMemoryDb(check);
		}
	});
});
