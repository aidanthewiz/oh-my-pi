import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initializeWithSettings, loadCapability, resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/discovery";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { loadProjectContextFiles } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { __resetDirsFromEnvForTests, getProjectAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

/** Linked-worktree shape `vcs.git` resolves without invoking git. */
function linkWorktree(project: string, worktreeRoot: string): Promise<void> {
	const commonDir = path.join(project, ".git");
	const gitDir = path.join(commonDir, "worktrees", path.basename(worktreeRoot));
	return fs.mkdir(gitDir, { recursive: true }).then(async () => {
		await fs.mkdir(worktreeRoot, { recursive: true });
		await fs.writeFile(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/feature\n");
		await fs.writeFile(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`);
		await fs.writeFile(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`);
	});
}

describe("contextFiles.extra", () => {
	let tempDir = "";
	let tempHome = "";
	const isolatedEnvKeys = [
		"HOME",
		"USERPROFILE",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"CLAUDE_CONFIG_DIR",
		"OMP_MANAGED_CONFIG_FILE",
	] as const;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		originalEnv = Object.fromEntries(isolatedEnvKeys.map(key => [key, process.env[key]]));
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extra-ctx-home-"));
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		restoreEnv("CLAUDE_CONFIG_DIR", undefined);
		restoreEnv("OMP_MANAGED_CONFIG_FILE", undefined);
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		tempDir = await fs.mkdtemp(path.join(tempHome, "omp-extra-ctx-"));
		await fs.mkdir(path.join(tempDir, ".git"));
	});

	afterEach(async () => {
		resetSettingsForTest();
		resetCapabilityForTests();
		AgentStorage.close();
		vi.restoreAllMocks();
		for (const key of isolatedEnvKeys) restoreEnv(key, originalEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHome);
	});

	async function bind(extra: string[], cwd = tempDir): Promise<void> {
		const settings = await Settings.init({
			inMemory: true,
			cwd,
			overrides: { "contextFiles.extra": extra },
		});
		initializeWithSettings(settings);
	}

	test("loads a configured sibling beside AGENTS.md instead of replacing it", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		await bind(["AGENTS.local.md"]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		const names = result.items.map(file => path.basename(file.path));

		expect(names).toContain("AGENTS.md");
		expect(names).toContain("AGENTS.local.md");
		expect(result.items.find(file => file.path.endsWith("AGENTS.local.md"))?.content).toBe("# personal\n");
	});

	test("does not discover an unlisted local sibling", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		await bind([]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items.map(file => path.basename(file.path))).toEqual(["AGENTS.md"]);
	});

	test("drops only the extra file when its extension id is disabled", async () => {
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# shared\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.local.md"), "# personal\n");
		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				"contextFiles.extra": ["AGENTS.local.md"],
				disabledExtensions: ["context-file:project:AGENTS.local.md"],
			},
		});
		initializeWithSettings(settings);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			disabledExtensions: ["context-file:project:AGENTS.local.md"],
		});

		expect(result.items.map(file => path.basename(file.path))).toEqual(["AGENTS.md"]);
	});

	test("rejects a path entry when settings load", async () => {
		await expect(
			Settings.init({
				inMemory: true,
				cwd: tempDir,
				overrides: { "contextFiles.extra": ["../AGENTS.local.md"] },
			}),
		).rejects.toThrow(/file names, not paths/);
	});

	test("rejects a built-in context filename", async () => {
		await expect(
			Settings.init({
				inMemory: true,
				cwd: tempDir,
				overrides: { "contextFiles.extra": ["AGENTS.md"] },
			}),
		).rejects.toThrow(/built-in context file/);
	});

	test("keeps a walked workspace copy and the primary checkout copy when they share a depth", async () => {
		const primary = path.join(tempHome, "code", "proj");
		const worktree = path.join(tempHome, "code", "proj-wt");
		const workspace = path.join(tempHome, "code", "AGENTS.local.md");
		await linkWorktree(primary, worktree);
		await fs.writeFile(workspace, "# workspace\n");
		await fs.writeFile(path.join(primary, "AGENTS.local.md"), "# primary personal\n");
		await bind(["AGENTS.local.md"], worktree);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: worktree });
		const byPath = new Map(result.items.map(file => [file.path, file.content]));

		expect(byPath.get(workspace)).toBe("# workspace\n");
		expect(byPath.get(path.join(primary, "AGENTS.local.md"))).toBe("# primary personal\n");
	});

	test("loads the primary checkout copy from a linked worktree without importing the primary AGENTS.md", async () => {
		const primary = path.join(tempDir, "primary");
		const worktree = path.join(tempDir, ".wt", "feature");
		await linkWorktree(primary, worktree);
		await fs.writeFile(path.join(primary, "AGENTS.md"), "# primary shared\n");
		await fs.writeFile(path.join(primary, "AGENTS.local.md"), "# primary personal\n");
		await fs.writeFile(path.join(worktree, "AGENTS.md"), "# worktree shared\n");
		await fs.writeFile(path.join(worktree, "AGENTS.local.md"), "# worktree personal\n");
		const userFile = path.join(tempHome, ".omp", "agent", "AGENTS.md");
		await Bun.write(userFile, "# user baseline\n");
		await bind(["AGENTS.local.md"], worktree);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: worktree });
		const byPath = new Map(result.items.map(file => [file.path, file.content]));

		expect(byPath.get(path.join(worktree, "AGENTS.md"))).toBe("# worktree shared\n");
		expect(byPath.get(path.join(primary, "AGENTS.local.md"))).toBe("# primary personal\n");
		expect(byPath.has(path.join(primary, "AGENTS.md"))).toBe(false);
		const ordered = await loadProjectContextFiles({ cwd: worktree });
		const order = ordered.map(file => file.path);
		expect(order.indexOf(userFile)).toBeLessThan(order.indexOf(path.join(primary, "AGENTS.local.md")));
		expect(order.indexOf(path.join(primary, "AGENTS.local.md"))).toBeLessThan(
			order.indexOf(path.join(worktree, "AGENTS.md")),
		);
		expect(ordered.find(file => file.path === path.join(worktree, "AGENTS.local.md"))?.content).toBe(
			"# worktree personal\n",
		);
	});

	test("loads a user-agent-dir extra file without shadowing user AGENTS.md", async () => {
		const agentDir = path.join(tempHome, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "AGENTS.md"), "# user shared\n");
		await fs.writeFile(path.join(agentDir, "AGENTS.local.md"), "# user personal\n");
		await fs.writeFile(path.join(tempDir, "AGENTS.md"), "# project\n");
		await bind(["AGENTS.local.md"]);

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });
		const userLocal = result.items.find(file => file.path === path.join(agentDir, "AGENTS.local.md"));
		const userShared = result.items.find(file => file.path === path.join(agentDir, "AGENTS.md"));

		expect(userLocal?.level).toBe("user");
		expect(userLocal?.content).toBe("# user personal\n");
		expect(userShared?.content).toBe("# user shared\n");
	});

	test("a project-configured list does not read the user agent directory", async () => {
		const agentDir = path.join(tempHome, ".omp", "agent");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "secrets.md"), "# user secret\n");
		await fs.writeFile(path.join(tempDir, "secrets.md"), "# project file\n");
		await Bun.write(
			path.join(getProjectAgentDir(tempDir), "config.yml"),
			"contextFiles:\n  extra:\n    - secrets.md\n",
		);
		initializeWithSettings(await Settings.init({ cwd: tempDir, agentDir }));

		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items.map(file => file.path)).toEqual([path.join(tempDir, "secrets.md")]);
	});

	test("a managed list retains user and project files through a child overlay", async () => {
		const agentDir = path.join(tempHome, ".omp", "agent");
		const managedPath = path.join(agentDir, "config.managed.yml");
		const previousManagedPath = process.env.OMP_MANAGED_CONFIG_FILE;
		const previousBunManagedPath = Bun.env.OMP_MANAGED_CONFIG_FILE;
		await Bun.write(managedPath, "contextFiles:\n  extra:\n    - managed.md\n");
		await Bun.write(
			path.join(getProjectAgentDir(tempDir), "config.yml"),
			"contextFiles:\n  extra:\n    - secrets.md\n",
		);
		await Bun.write(path.join(agentDir, "managed.md"), "# managed user baseline\n");
		await Bun.write(path.join(tempDir, "managed.md"), "# managed project addition\n");
		await Bun.write(path.join(agentDir, "secrets.md"), "# excluded user secret\n");
		process.env.OMP_MANAGED_CONFIG_FILE = managedPath;
		Bun.env.OMP_MANAGED_CONFIG_FILE = managedPath;
		try {
			const parent = await Settings.init({ cwd: tempDir, agentDir });
			initializeWithSettings(parent.overlay());
			const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir, agentDir });
			const byPath = new Map(result.items.map(file => [file.path, file.content]));
			expect(byPath.get(path.join(agentDir, "managed.md"))).toBe("# managed user baseline\n");
			expect(byPath.get(path.join(tempDir, "managed.md"))).toBe("# managed project addition\n");
			expect(byPath.has(path.join(agentDir, "secrets.md"))).toBe(false);
			expect(byPath.has(path.join(tempDir, "secrets.md"))).toBe(false);
		} finally {
			if (previousManagedPath === undefined) delete process.env.OMP_MANAGED_CONFIG_FILE;
			else process.env.OMP_MANAGED_CONFIG_FILE = previousManagedPath;
			if (previousBunManagedPath === undefined) delete Bun.env.OMP_MANAGED_CONFIG_FILE;
			else Bun.env.OMP_MANAGED_CONFIG_FILE = previousBunManagedPath;
		}
	});
});
