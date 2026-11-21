import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { mergeIsolatedChanges } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { FileChangeReport } from "@oh-my-pi/pi-coding-agent/tools";
import * as repoLock from "@oh-my-pi/pi-coding-agent/utils/repo-lock";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

function patchResult(index: number, patchPath: string): SingleResult {
	return {
		index,
		id: `t${index}`,
		agent: "task",
		agentSource: "bundled",
		task: "edit one line",
		exitCode: 0,
		output: "",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 1,
		requests: 1,
		patchPath,
	};
}

describe("mergeIsolatedChanges patch mode", () => {
	// #18483: concurrent merge-backs touching one file each rewrote it from the
	// same preimage, so the last writer dropped the others' hunks while every
	// caller still reported "Applied patches: yes".
	it("lands every same-file patch when parallel tasks merge back concurrently", async () => {
		const workers = 16;
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-merge-"));
		tempDirs.push(repo);
		const file = path.join(repo, "shared.txt");
		const lines = Array.from({ length: workers * 10 }, (_, i) => `line ${i}`);
		await Bun.write(file, `${lines.join("\n")}\n`);
		await $`git init -q -b main && git config core.autocrlf false && git add shared.txt && git -c user.email=t@t -c user.name=t commit -qm base`
			.cwd(repo)
			.quiet();

		const results: SingleResult[] = [];
		for (let i = 0; i < workers; i++) {
			const edited = lines.with(i * 10 + 5, `edited by worker ${i}`);
			await Bun.write(file, `${edited.join("\n")}\n`);
			const patchPath = path.join(repo, `.git/p${i}.patch`);
			await Bun.write(patchPath, await $`git diff`.cwd(repo).quiet().text());
			results.push(patchResult(i, patchPath));
		}
		await $`git checkout -q shared.txt`.cwd(repo).quiet();

		const outcomes = await Promise.all(
			results.map(result => mergeIsolatedChanges({ result, repoRoot: repo, mergeMode: "patch" })),
		);

		const landed = (await Bun.file(file).text()).split("\n").filter(line => line.startsWith("edited by worker"));
		expect(landed).toHaveLength(workers);
		expect(outcomes.every(o => o.changesApplied && o.hadAnyChanges)).toBe(true);
	});

	it.serial("journals only each agent's own changes during concurrent same-file merges", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-journal-"));
		tempDirs.push(repo);
		const file = path.join(repo, "shared.txt");
		const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
		const initial = `${lines.join("\n")}\n`;
		await Bun.write(file, initial);
		await $`git init -q -b main && git config core.autocrlf false && git add shared.txt && git -c user.email=t@t -c user.name=t commit -qm base`
			.cwd(repo)
			.quiet();
		const results: SingleResult[] = [];
		for (let i = 0; i < 2; i++) {
			await Bun.write(file, `${lines.with(i * 20 + 5, `edited by worker ${i}`).join("\n")}\n`);
			const patchPath = path.join(repo, `.git/p${i}.patch`);
			await Bun.write(patchPath, await $`git diff`.cwd(repo).quiet().text());
			results.push(patchResult(i, patchPath));
		}
		await $`git checkout -q shared.txt`.cwd(repo).quiet();

		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const queued = Promise.withResolvers<void>();
		const lock = repoLock.withRepoLock;
		const holder = lock(repo, async () => {
			entered.resolve();
			await release.promise;
		});
		let requests = 0;
		function observeLock<T>(cwd: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
			const pending = lock(cwd, fn, signal);
			if (cwd === repo && ++requests === 2) queued.resolve();
			return pending;
		}
		const spy = spyOn(repoLock, "withRepoLock").mockImplementation(observeLock);
		const reports: FileChangeReport[] = [];
		const pending: ReturnType<typeof mergeIsolatedChanges>[] = [];
		try {
			await Promise.race([
				entered.promise,
				holder.then(() => {
					throw new Error("repository lock holder ended before admission");
				}),
			]);
			pending.push(
				...results.map(result =>
					mergeIsolatedChanges({
						result,
						repoRoot: repo,
						mergeMode: "patch",
						parentAgentId: "parent",
						recordFileChange: change => reports.push(change),
					}),
				),
			);
			await Promise.race([
				queued.promise,
				...pending.map(async operation => {
					await operation;
					throw new Error("a merge ended before both joined the repository queue");
				}),
			]);
		} finally {
			release.resolve();
			await Promise.allSettled([holder, ...pending]);
			spy.mockRestore();
		}
		const outcomes = await Promise.all(pending);
		expect(outcomes.every(outcome => outcome.changesApplied && outcome.hadAnyChanges)).toBe(true);
		expect(reports).toHaveLength(2);
		expect(reports[0].before).toBe(initial);
		expect(reports[1].before).toBe(reports[0].after);
		for (const report of reports) {
			const worker = results.findIndex(result => result.id === report.agent?.agent);
			expect(worker).toBeGreaterThanOrEqual(0);
			const expected = report.before!.split("\n").with(worker * 20 + 5, `edited by worker ${worker}`);
			expect(report.after).toBe(expected.join("\n"));
		}
		expect(reports[1].after).toBe(await fs.readFile(file, "utf8"));
	});

	it.skipIf(process.platform === "win32")("records task edits for quoted diff paths", async () => {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-quoted-path-"));
		tempDirs.push(repo);
		const filename = 'has"quote.txt';
		const file = path.join(repo, filename);
		await Bun.write(file, "before\n");
		await $`git init -q -b main && git config core.autocrlf false && git add -- ${filename} && git -c user.email=t@t -c user.name=t commit -qm base`
			.cwd(repo)
			.quiet();
		await Bun.write(file, "after\n");
		const patchPath = path.join(repo, ".git/quoted.patch");
		await Bun.write(patchPath, await $`git diff --no-ext-diff --no-textconv`.cwd(repo).quiet().text());
		await $`git checkout -q -- ${filename}`.cwd(repo).quiet();

		const changes: Array<{ path: string; before: string | null; after: string | null }> = [];
		const outcome = await mergeIsolatedChanges({
			result: patchResult(1, patchPath),
			repoRoot: repo,
			mergeMode: "patch",
			recordFileChange: change => changes.push(change),
		});

		expect(outcome.changesApplied).toBe(true);
		expect(outcome.hadAnyChanges).toBe(true);
		expect(changes.map(change => ({ path: change.path, before: change.before, after: change.after }))).toEqual([
			{ path: file, before: "before\n", after: "after\n" },
		]);
	});
});
