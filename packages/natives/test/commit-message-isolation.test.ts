/**
 * Concurrent `commitCreate` calls must not share `.git/COMMIT_EDITMSG`.
 *
 * The `commit-msg` hook runs after the message is written and before it is
 * read back. Replacing `COMMIT_EDITMSG` in that window is another call's
 * write. Each call has to commit its own subject and body, including the
 * hook's edit of the file it was given, and remove that file on every exit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	const process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
		process.exited,
	]);
	if (exitCode !== 0) throw new Error(stderr);
	return stdout.trimEnd();
}

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-commit-msg-"));
	roots.push(root);
	await git(root, "init", "-b", "main");
	await git(root, "config", "user.name", "Native Test");
	await git(root, "config", "user.email", "native@example.test");
	await git(root, "config", "core.autocrlf", "false");
	// A global `core.hooksPath` would hide the fixture hook from gix.
	await git(root, "config", "core.hooksPath", ".git/hooks");
	await git(root, "config", "commit.gpgsign", "false");
	await Bun.write(path.join(root, "tracked.txt"), "one\n");
	await git(root, "add", "tracked.txt");
	await git(root, "commit", "-m", "initial");
	return root;
}

async function installHook(root: string, script: string, name = "commit-msg"): Promise<void> {
	const hooks = path.join(root, ".git", "hooks");
	await fs.mkdir(hooks, { recursive: true });
	const hook = path.join(hooks, name);
	await Bun.write(hook, script);
	await fs.chmod(hook, 0o755);
}

describe("commitCreate message isolation", () => {
	test("keeps its subject and body when another call replaces COMMIT_EDITMSG", async () => {
		const root = await repository();
		await installHook(
			root,
			[
				"#!/bin/sh",
				"git_dir=$(git rev-parse --absolute-git-dir)",
				'printf \'%s\' "$1" > "$git_dir/seen-msg-path"',
				"printf '\\nHook-Trailer: kept\\n' >> \"$1\"",
				"printf '%s\\n\\n%s\\n' 'stolen subject' 'stolen body' > \"$git_dir/COMMIT_EDITMSG\"",
				"",
			].join("\n"),
		);
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("mine subject\n\nmine body\n", { allowEmpty: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		const committed = await git(root, "log", "-1", "--format=%B");
		expect(committed).toContain("mine subject");
		expect(committed).toContain("mine body");
		expect(committed).toContain("Hook-Trailer: kept");
		expect(committed).not.toContain("stolen subject");
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		expect(await Bun.file(shared).text()).toBe("stolen subject\n\nstolen body\n");
	});

	test("leaves no message file behind when noVerify skips the hook", async () => {
		const root = await repository();
		const gitDir = path.join(root, ".git");
		const before = new Set(await fs.readdir(gitDir));
		const repo = vcsGitDiscover(root)!;

		const sha = await repo.commitCreate("private message\n", { allowEmpty: true, noVerify: true });

		expect(sha).toBe(await git(root, "rev-parse", "HEAD"));
		expect(await git(root, "log", "-1", "--format=%B")).toBe("private message");
		const added = (await fs.readdir(gitDir)).filter(name => !before.has(name));
		expect(added).toEqual([]);
	});

	test("keeps message data and writes one canonical terminal LF", async () => {
		const root = await repository();
		const repo = vcsGitDiscover(root)!;
		for (const noVerify of [false, true]) {
			const sha = await repo.commitCreate("subject ünïcode\n\nbody  \n\tindented line\n\n", {
				allowEmpty: true,
				noVerify,
			});
			const child = Bun.spawn(["git", "cat-file", "commit", sha], { cwd: root, stdout: "pipe", stderr: "pipe" });
			const [raw, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(exitCode, stderr).toBe(0);
			expect(raw.slice(raw.indexOf("\n\n") + 2)).toBe("subject ünïcode\n\nbody  \n\tindented line\n");
		}
	});

	test("removes the message file when commit-msg rejects the commit", async () => {
		const root = await repository();
		await installHook(
			root,
			[
				"#!/bin/sh",
				"git_dir=$(git rev-parse --absolute-git-dir)",
				'printf \'%s\' "$1" > "$git_dir/seen-msg-path"',
				"exit 1",
				"",
			].join("\n"),
		);
		const shared = path.join(root, ".git", "COMMIT_EDITMSG");
		await Bun.write(shared, "preexisting\n");
		const head = await git(root, "rev-parse", "HEAD");
		const repo = vcsGitDiscover(root)!;

		await expect(repo.commitCreate("will not land\n", { allowEmpty: true })).rejects.toThrow();

		expect(await git(root, "rev-parse", "HEAD")).toBe(head);
		const seen = (await Bun.file(path.join(root, ".git", "seen-msg-path")).text()).trim();
		expect(path.basename(seen)).not.toBe("COMMIT_EDITMSG");
		expect(await Bun.file(seen).exists()).toBe(false);
		// Hooks that ignore `$1` and read COMMIT_EDITMSG see this call's message.
		expect(await Bun.file(shared).text()).toBe("will not land\n");
	});

	test.each([false, true])("finishes a resolved merge (unchanged tree=%s)", async unchangedTree => {
		const root = await repository();
		await git(root, "switch", "-c", "side");
		await Bun.write(path.join(root, "branch.txt"), "side\n");
		await git(root, "add", ".");
		await git(root, "commit", "-m", "side");
		const side = await git(root, "rev-parse", "HEAD");
		await git(root, "switch", "main");
		await Bun.write(path.join(root, unchangedTree ? "branch.txt" : "main.txt"), unchangedTree ? "side\n" : "main\n");
		await git(root, "add", ".");
		await git(root, "commit", "-m", "main");
		const main = await git(root, "rev-parse", "HEAD");
		await git(root, "merge", "--no-ff", "--no-commit", "side");
		const repo = vcsGitDiscover(root)!;

		const id = await repo.commitCreate("resolved merge\n", {});

		expect(await git(root, "rev-parse", "HEAD")).toBe(id);
		expect(await git(root, "show", "-s", "--format=%P", id)).toBe(`${main} ${side}`);
		expect(await Bun.file(path.join(root, ".git", "MERGE_HEAD")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, ".git", "MERGE_MSG")).exists()).toBe(false);
		expect(await git(root, "status", "--porcelain")).toBe("");
	});

	test.each([false, true])("restores merge autostash and retains conflict recovery (conflict=%s)", async conflict => {
		const root = await repository();
		await git(root, "switch", "-c", "side");
		await Bun.write(path.join(root, "branch.txt"), "side\n");
		if (conflict) await Bun.write(path.join(root, "tracked.txt"), "side edit\n");
		await git(root, "add", ".");
		await git(root, "commit", "-m", "side");
		const side = await git(root, "rev-parse", "HEAD");
		await git(root, "switch", "main");
		const main = await git(root, "rev-parse", "HEAD");
		await Bun.write(path.join(root, "tracked.txt"), "local edit\n");
		await git(root, "merge", "--no-ff", "--no-commit", "--autostash", "side");
		const stash = await git(root, "rev-parse", "MERGE_AUTOSTASH");
		const repo = vcsGitDiscover(root)!;

		const outcome = await repo.commitCreate("autostashed merge\n", {}).then(
			id => ({ id, error: null }),
			error => ({ id: null, error: String(error) }),
		);

		const id = await git(root, "rev-parse", "HEAD");
		expect(await git(root, "show", "-s", "--format=%P", id)).toBe(`${main} ${side}`);
		if (conflict) {
			expect(outcome.error).toContain(id);
			expect(outcome.error).toContain(stash);
			expect(await git(root, "stash", "list", "--format=%H")).toBe(stash);
			expect(await git(root, "show", `${stash}:tracked.txt`)).toBe("local edit");
			expect(await git(root, "diff", "--name-only", "--diff-filter=U")).toBe("tracked.txt");
			const worktree = await Bun.file(path.join(root, "tracked.txt")).text();
			expect(worktree).toContain("local edit\n");
			expect(worktree).toContain("side edit\n");
		} else {
			expect(outcome.id).toBe(id);
			expect(await Bun.file(path.join(root, "tracked.txt")).text()).toBe("local edit\n");
			expect(await git(root, "stash", "list", "--format=%H")).toBe("");
			expect(await git(root, "diff", "--cached", "--name-only")).toBe("");
		}
		expect(await Bun.file(path.join(root, ".git", "MERGE_HEAD")).exists()).toBe(false);
		expect(await Bun.file(path.join(root, ".git", "MERGE_AUTOSTASH")).exists()).toBe(false);
	});

	test.each([false, true])("honors prepare-commit-msg edits and refusal (noVerify=%s)", async noVerify => {
		const root = await repository();
		await installHook(
			root,
			[
				"#!/bin/sh",
				"printf '%s\\n' \"$2\" > .git/prepare-source",
				"printf '\\nPrepared: yes\\n' >> \"$1\"",
				"",
			].join("\n"),
			"prepare-commit-msg",
		);
		await installHook(
			root,
			[
				"#!/bin/sh",
				'grep -q "^Prepared: yes$" "$1" || { echo "prepare hook did not run" >&2; exit 1; }',
				"printf '\\nValidated: yes\\n' >> \"$1\"",
				"",
			].join("\n"),
		);
		const repo = vcsGitDiscover(root)!;

		const id = await repo.commitCreate("prepared message\n", { allowEmpty: true, noVerify });

		const committed = await git(root, "log", "-1", "--format=%B");
		expect(committed).toContain("Prepared: yes");
		expect(committed.includes("Validated: yes")).toBe(!noVerify);
		expect(await Bun.file(path.join(root, ".git", "prepare-source")).text()).toBe("message\n");
		await installHook(root, "#!/bin/sh\nexit 17\n", "prepare-commit-msg");
		await expect(repo.commitCreate("must not land\n", { allowEmpty: true, noVerify })).rejects.toThrow();
		expect(await git(root, "rev-parse", "HEAD")).toBe(id);
	});
});
