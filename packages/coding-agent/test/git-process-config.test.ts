import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import type { Subprocess } from "bun";

type SpawnOptions = Bun.SpawnOptions.SpawnOptions<
	Bun.SpawnOptions.Writable,
	Bun.SpawnOptions.Readable,
	Bun.SpawnOptions.Readable
>;

type SpawnCall = {
	cmd: string[];
	options: SpawnOptions;
};

function createTextStream(text: string): ReadableStream<Uint8Array> {
	const body = new Response(text).body;
	if (!body) {
		throw new Error("Failed to create response stream.");
	}
	return body;
}

function createFakeProcess(stdout = "", stderr = "", exitCode = 0): Subprocess {
	return {
		pid: 12345,
		stdout: createTextStream(stdout),
		stderr: createTextStream(stderr),
		exited: Promise.resolve(exitCode),
	} as Subprocess;
}

function createSpawnMock(calls: SpawnCall[]) {
	function mockSpawn(options: SpawnOptions & { cmd: string[] }): Subprocess;
	function mockSpawn(cmd: string[], options?: SpawnOptions): Subprocess;
	function mockSpawn(first: string[] | (SpawnOptions & { cmd: string[] }), second?: SpawnOptions): Subprocess {
		if (Array.isArray(first)) {
			calls.push({ cmd: first, options: second ?? ({} as SpawnOptions) });
		} else {
			const { cmd, ...options } = first;
			calls.push({ cmd, options });
		}
		return createFakeProcess();
	}

	return mockSpawn;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("git subprocess config", () => {
	it("disables fsmonitor and untracked cache for read-only commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		expect(await git.status.summary("/work/pi")).toEqual({ staged: 0, unstaged: 0, untracked: 0 });
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"--no-optional-locks",
			"status",
			"--porcelain",
		]);
	});

	it("disables fsmonitor and untracked cache for mutating commands", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		await git.stage.files("/work/pi", ["tracked.txt"]);

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"add",
			"--",
			"tracked.txt",
		]);
	});

	it("scopes pushes to the named refspec, never following tags", async () => {
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		await git.push("/work/pi", { remote: "fork", refspec: "HEAD:refs/heads/feature" });

		// `--no-follow-tags` must override a user's `push.followTags = true`:
		// implicit tag pushes are rejected on remotes the user cannot tag
		// (e.g. PR-head forks) and fail the call after the branch updated.
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.cmd).toEqual([
			"git",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"core.untrackedCache=false",
			"push",
			"--no-verify",
			"--no-follow-tags",
			"fork",
			"HEAD:refs/heads/feature",
		]);
	});

	it("does not expose parent credentials to repository Git hooks", async () => {
		const originalSecret = process.env.MANAGED_PROFILE_SECRET;
		const originalSocket = process.env.SSH_AUTH_SOCK;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		process.env.MANAGED_PROFILE_SECRET = "parent-secret";
		process.env.SSH_AUTH_SOCK = "/tmp/coreforge-test-hook-agent.sock";
		try {
			await git.commit("/work/pi", "fix: filter Git child environment");
		} finally {
			if (originalSecret === undefined) delete process.env.MANAGED_PROFILE_SECRET;
			else process.env.MANAGED_PROFILE_SECRET = originalSecret;
			if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
			else process.env.SSH_AUTH_SOCK = originalSocket;
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env).not.toHaveProperty("MANAGED_PROFILE_SECRET");
		expect(spawnCalls[0]?.options.env).not.toHaveProperty("SSH_AUTH_SOCK");
	});

	it("preserves Git authentication only for network operations", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-git-network-auth-"));
		const originalSocket = process.env.SSH_AUTH_SOCK;
		const originalSshCommand = process.env.GIT_SSH_COMMAND;
		const originalGitAskpass = process.env.GIT_ASKPASS;
		const originalSshAskpass = process.env.SSH_ASKPASS;
		const originalToken = process.env.GH_TOKEN;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		process.env.SSH_AUTH_SOCK = "/tmp/coreforge-test-agent.sock";
		process.env.GIT_SSH_COMMAND = "ssh -o IdentitiesOnly=yes";
		process.env.GIT_ASKPASS = "/tmp/coreforge-test-git-askpass";
		process.env.SSH_ASKPASS = "/tmp/coreforge-test-ssh-askpass";
		process.env.GH_TOKEN = "not-for-git-hooks";
		try {
			await git.push(root, { remote: "origin", refspec: "HEAD" });
			await git.fetch(root, "origin", "main", "refs/remotes/origin/main");
			await git.clone("git@example.com:org/repo.git", path.join(root, "clone"));
		} finally {
			if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
			else process.env.SSH_AUTH_SOCK = originalSocket;
			if (originalSshCommand === undefined) delete process.env.GIT_SSH_COMMAND;
			else process.env.GIT_SSH_COMMAND = originalSshCommand;
			if (originalGitAskpass === undefined) delete process.env.GIT_ASKPASS;
			else process.env.GIT_ASKPASS = originalGitAskpass;
			if (originalSshAskpass === undefined) delete process.env.SSH_ASKPASS;
			else process.env.SSH_ASKPASS = originalSshAskpass;
			if (originalToken === undefined) delete process.env.GH_TOKEN;
			else process.env.GH_TOKEN = originalToken;
			await fs.promises.rm(root, { recursive: true, force: true });
		}

		expect(spawnCalls).toHaveLength(3);
		for (const call of spawnCalls) {
			expect(call.options.env?.SSH_AUTH_SOCK).toBe("/tmp/coreforge-test-agent.sock");
			expect(call.options.env?.GIT_SSH_COMMAND).toBe("ssh -o IdentitiesOnly=yes");
			expect(call.options.env?.GIT_ASKPASS).toBe("/tmp/coreforge-test-git-askpass");
			expect(call.options.env?.SSH_ASKPASS).toBe("/tmp/coreforge-test-ssh-askpass");
			expect(call.options.env).not.toHaveProperty("GH_TOKEN");
		}
	});

	it("rejects Git authentication paths injected by repository dotenv files", async () => {
		const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-git-auth-env-"));
		const originalSocket = process.env.SSH_AUTH_SOCK;
		const injectedSocket = path.join(root, "repo-agent.sock");
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));
		await fs.promises.writeFile(path.join(root, ".env"), `SSH_AUTH_SOCK=${injectedSocket}\n`);
		process.env.SSH_AUTH_SOCK = injectedSocket;
		try {
			await git.push(root, { remote: "origin", refspec: "HEAD" });
		} finally {
			if (originalSocket === undefined) delete process.env.SSH_AUTH_SOCK;
			else process.env.SSH_AUTH_SOCK = originalSocket;
			await fs.promises.rm(root, { recursive: true, force: true });
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env?.SSH_AUTH_SOCK).not.toBe(injectedSocket);
	});
	it("preserves the caller's GPG_TTY for signing-capable commands", async () => {
		const originalGpgTty = process.env.GPG_TTY;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		process.env.GPG_TTY = "/dev/pts/42";
		try {
			await git.commit("/work/pi", "fix: preserve signing tty");
		} finally {
			if (originalGpgTty === undefined) {
				delete process.env.GPG_TTY;
			} else {
				process.env.GPG_TTY = originalGpgTty;
			}
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env?.GPG_TTY).toBe("/dev/pts/42");
	});

	it("does not invent a bogus GPG_TTY when the caller has none", async () => {
		const originalGpgTty = process.env.GPG_TTY;
		const spawnCalls: SpawnCall[] = [];
		vi.spyOn(Bun, "spawn").mockImplementation(createSpawnMock(spawnCalls));

		delete process.env.GPG_TTY;
		try {
			await git.commit("/work/pi", "fix: allow gui pinentry");
		} finally {
			if (originalGpgTty !== undefined) {
				process.env.GPG_TTY = originalGpgTty;
			}
		}

		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.options.env).not.toHaveProperty("GPG_TTY");
	});
});
