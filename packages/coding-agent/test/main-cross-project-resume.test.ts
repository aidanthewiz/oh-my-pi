/**
 * Regression: `--resume <id>` must open a cross-project session in its recorded
 * cwd instead of prompting to fork it into the launch directory.
 *
 * Also covers the moved/renamed-worktree path: when the matched session's
 * recorded directory no longer exists, `--resume <id>` offers to *move*
 * (re-root) the session rather than opening against a missing directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Args, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as pluginHelpers from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { createSessionManager, runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as sessionListingModule from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resumeCommand } from "@oh-my-pi/pi-coding-agent/utils/resume-command";
import {
	__resetDirsFromEnvForTests,
	getProjectDir,
	normalizePathForComparison,
	setAgentDir,
	setProjectDir,
} from "@oh-my-pi/pi-utils";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPiProfile = process.env.PI_PROFILE;
const originalOmpProfile = process.env.OMP_PROFILE;
let agentDirRoot: string | undefined;

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

beforeEach(async () => {
	agentDirRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-agent-dir-"));
	setAgentDir(path.join(agentDirRoot, "agent"));
});

afterEach(async () => {
	// `runRootCommand` registers the CLI's extension roots (`--no-extensions` → explicit-only) process-wide.
	clearOmpExtensionCliRoots();
	restoreEnv("PI_CODING_AGENT_DIR", originalAgentDir);
	restoreEnv("PI_PROFILE", originalPiProfile);
	restoreEnv("OMP_PROFILE", originalOmpProfile);
	__resetDirsFromEnvForTests();
	if (agentDirRoot) {
		await fsp.rm(agentDirRoot, { recursive: true, force: true });
	}
});

function buildArgs(resume: string, sessionDir?: string): Args {
	return {
		resume,
		sessionDir,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		invalidFlagValues: [],
	};
}

function buildGlobalMatch(cwd: string): { session: SessionInfo; scope: "global" } {
	return {
		scope: "global",
		session: {
			path: path.join(cwd, "019e84ed-b4cc-7000-9c87-5afe6df992c1.jsonl"),
			id: "019e84ed-b4cc-7000-9c87-5afe6df992c1",
			cwd,
			title: "in-other-project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			size: 0,
			firstMessage: "",
			allMessagesText: "",
		},
	};
}

const stubSettings = { get: () => undefined } as unknown as Settings;

describe("createSessionManager — cross-project --resume", () => {
	let existingProject: string;

	beforeEach(async () => {
		existingProject = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-"));
		const match = buildGlobalMatch(existingProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: existingProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(existingProject, { recursive: true, force: true });
	});

	it("opens the existing journal in its recorded cwd without a relocation prompt", async () => {
		const match = buildGlobalMatch(existingProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const movePrompt = vi.fn(async () => "declined" as const);

		const result = await createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings, movePrompt);

		if (!result) throw new Error("Expected resumed session manager");
		try {
			expect(result.getSessionFile()).toBe(match.session.path);
			expect(result.getCwd()).toBe(existingProject);
		} finally {
			await result.close();
		}
		expect(movePrompt).not.toHaveBeenCalled();
	});
});

describe("SessionManager.open — recorded cwd adoption", () => {
	it("keeps the launch cwd when the recorded cwd cannot be probed", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-denied-"));
		const launchProject = path.join(root, "launch");
		const deniedProject = path.join(root, "denied");
		await fsp.mkdir(launchProject);
		const match = buildGlobalMatch(deniedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: deniedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realStat = fs.promises.stat.bind(fs.promises) as (
			path: fs.PathLike,
			options?: fs.StatOptions,
		) => Promise<fs.Stats>;
		const stat = vi.spyOn(fs.promises, "stat").mockImplementation((async (
			target: fs.PathLike,
			options?: fs.StatOptions,
		) => {
			if (normalizePathForComparison(String(target)) === normalizePathForComparison(deniedProject)) {
				throw Object.assign(new Error("operation not permitted"), { code: "EACCES" });
			}
			return realStat(target, options);
		}) as typeof fs.promises.stat);
		try {
			const manager = await SessionManager.open(match.session.path, undefined, undefined, {
				initialCwd: launchProject,
			});
			try {
				expect(manager.getCwd()).toBe(launchProject);
			} finally {
				await manager.close();
			}
		} finally {
			stat.mockRestore();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	it("keeps the launch cwd when the recorded cwd denies search permission", async () => {
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-noexec-"));
		const launchProject = path.join(root, "launch");
		const deniedProject = path.join(root, "denied");
		await fsp.mkdir(launchProject);
		await fsp.mkdir(deniedProject);
		const match = buildGlobalMatch(deniedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: deniedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		const realAccess = fs.promises.access.bind(fs.promises);
		const access = vi.spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (normalizePathForComparison(String(target)) === normalizePathForComparison(deniedProject)) {
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});

		try {
			const manager = await SessionManager.open(match.session.path, undefined, undefined, {
				initialCwd: launchProject,
			});
			try {
				expect(manager.getCwd()).toBe(launchProject);
			} finally {
				await manager.close();
			}
		} finally {
			access.mockRestore();
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("runRootCommand — cross-project --resume", () => {
	let root: string;
	let launchProject: string;
	let resumedProject: string;
	let originalProject: string;

	beforeEach(async () => {
		originalProject = getProjectDir();
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-xproj-root-"));
		launchProject = path.join(root, "launch");
		resumedProject = path.join(root, "resumed");
		await Promise.all([fsp.mkdir(launchProject), fsp.mkdir(resumedProject)]);
		const match = buildGlobalMatch(resumedProject);
		await Bun.write(
			match.session.path,
			`${JSON.stringify({
				type: "session",
				id: match.session.id,
				cwd: resumedProject,
				timestamp: new Date(0).toISOString(),
			})}\n`,
		);
		setProjectDir(launchProject);
	});

	afterEach(async () => {
		setProjectDir(originalProject);
		vi.restoreAllMocks();
		await fsp.rm(root, { recursive: true, force: true });
	});

	it("uses the destination cwd after access returns during resume", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const reloadForCwd = vi.spyOn(settings, "reloadForCwd");
		const preloadedCwds: (string | undefined)[] = [];
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockImplementation(async (_home, cwd) => {
			preloadedCwds.push(cwd);
		});
		const realAccess = fs.promises.access.bind(fs.promises);
		let deniedProbes = 2;
		const access = vi.spyOn(fs.promises, "access").mockImplementation(async (target, mode) => {
			if (deniedProbes > 0 && path.basename(String(target)) === "resumed") {
				deniedProbes -= 1;
				throw Object.assign(new Error("permission denied"), { code: "EACCES" });
			}
			return realAccess(target, mode);
		});
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const rawArgs = ["--cwd", launchProject, "--resume", "019e84ed", "--print"];
		const parsed = parseArgs(rawArgs);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let resumedManager: SessionManager | undefined;

		let preloadedDestinationAtCreation = false;
		let sessionOptionsCwd: string | undefined;

		try {
			await runRootCommand(parsed, rawArgs, {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					sessionOptionsCwd = options.cwd;
					// Awaited during the switch, so by session creation the destination
					// preload has already been requested for the resumed project.
					preloadedDestinationAtCreation = preloadedCwds.includes(resumedProject);
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			access.mockRestore();
			await authStorage.close();
			await resumedManager?.close();
		}
		expect(deniedProbes).toBe(0);

		expect(getProjectDir()).toBe(resumedProject);
		// process.cwd() reports the physical path (/private/var/... on macOS) while
		// the fixture path keeps the /var symlink form — compare canonicalized.
		expect(normalizePathForComparison(process.cwd())).toBe(normalizePathForComparison(resumedProject));
		expect(reloadForCwd).toHaveBeenCalledWith(resumedProject);
		expect(resumedManager?.getCwd()).toBe(resumedProject);
		expect(parsed.cwd).toBe(resumedProject);
		expect(sessionOptionsCwd).toBe(resumedProject);
		expect(preloadedDestinationAtCreation).toBe(true);
	}, 15_000);

	it("re-scopes Settings back to the launch project when destination rescope fails", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const reloadForCwd = vi.spyOn(settings, "reloadForCwd").mockImplementation(async cwd => {
			if (normalizePathForComparison(cwd) === normalizePathForComparison(resumedProject)) {
				throw new Error("destination config unreadable");
			}
		});
		vi.spyOn(pluginHelpers, "preloadPluginRoots").mockResolvedValue(undefined);
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let resumedManager: SessionManager | undefined;

		try {
			await runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			reloadForCwd.mockRestore();
			await authStorage.close();
			await resumedManager?.close();
		}

		// The destination read rejected, so the fallback must re-scope Settings
		// back to the launch project; otherwise path-derived values and saves
		// would still target the failed resume target.
		expect(getProjectDir()).toBe(launchProject);
		expect(resumedManager?.getCwd()).toBe(launchProject);
		expect(settings.getCwd()).toBe(launchProject);
	});

	it("rolls back the session manager when the resumed cwd is denied", async () => {
		const match = buildGlobalMatch(resumedProject);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(match);
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		const originalChdir = process.chdir.bind(process);
		const chdir = vi.spyOn(process, "chdir").mockImplementation(dir => {
			if (normalizePathForComparison(dir) === normalizePathForComparison(resumedProject)) {
				throw new Error("operation not permitted");
			}
			originalChdir(dir);
		});
		const parsed = parseArgs(["--resume", "019e84ed", "--print"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		let resumedManager: SessionManager | undefined;

		try {
			await runRootCommand(parsed, ["--resume", "019e84ed", "--print"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					if (!options) throw new Error("Expected session options");
					resumedManager = options.sessionManager;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			chdir.mockRestore();
			await authStorage.close();
			await resumedManager?.close();
		}

		expect(getProjectDir()).toBe(launchProject);
		expect(resumedManager?.getCwd()).toBe(launchProject);
	});
});

describe("createSessionManager — cross-project --resume relocation (moved worktree)", () => {
	let missingRoot: string;
	let missingProject: string;

	beforeEach(async () => {
		missingRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-moved-xproj-"));
		missingProject = path.join(missingRoot, "worktree-gone");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(missingRoot, { recursive: true, force: true });
	});

	it("offers move (not fork) and returns undefined when the user declines", async () => {
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));
		expect(fs.existsSync(missingProject)).toBe(false);

		const result = await createSessionManager(
			buildArgs("019e84ed"),
			"/current/project",
			stubSettings,
			async () => "declined" as const,
		);

		expect(result).toBeUndefined();
	});

	it("throws the move-specific error when unavailable in non-interactive mode", async () => {
		const originalIsTTY = process.stdin.isTTY;
		Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
		try {
			vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue(buildGlobalMatch(missingProject));

			await expect(createSessionManager(buildArgs("019e84ed"), "/current/project", stubSettings)).rejects.toThrow(
				`Session "019e84ed" belongs to a directory that no longer exists (${missingProject}); run interactively to move it into the current project.`,
			);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
		}
	});

	it("moves a local explicit-session-dir match whose recorded cwd is gone", async () => {
		const currentProject = path.join(missingRoot, "current-project");
		const explicitSessionDir = path.join(missingRoot, "sessions");
		await fsp.mkdir(currentProject, { recursive: true });

		const moved = SessionManager.create(missingProject, explicitSessionDir);
		moved.appendMessage({ role: "user", content: "before local move", timestamp: 1 });
		await moved.flush();
		const oldFile = moved.getSessionFile();
		if (!oldFile) throw new Error("Expected persisted session file");
		const resumePrefix = moved.getSessionId().slice(0, 8);
		const sessionInfo: SessionInfo = {
			path: oldFile,
			id: moved.getSessionId(),
			cwd: missingProject,
			title: "moved-local",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			size: 0,
			firstMessage: "before local move",
			allMessagesText: "before local move",
		};
		await moved.close();
		expect(fs.existsSync(missingProject)).toBe(false);
		vi.spyOn(sessionListingModule, "resolveResumableSession").mockResolvedValue({
			scope: "local",
			session: sessionInfo,
		});

		const movePrompt = vi.fn(async () => "accepted" as const);
		const result = await createSessionManager(
			buildArgs(resumePrefix, explicitSessionDir),
			currentProject,
			stubSettings,
			movePrompt,
		);

		if (!result) throw new Error("Expected moved session manager");
		try {
			expect(result.getSessionFile()).toBe(oldFile);
			expect(result.getCwd()).toBe(path.resolve(currentProject));
			const entries = await loadEntriesFromFile(oldFile);
			const header = entries.find(
				(entry): entry is SessionHeader =>
					typeof entry === "object" &&
					entry !== null &&
					"type" in entry &&
					(entry as { type: unknown }).type === "session",
			);
			expect(header?.cwd).toBe(path.resolve(currentProject));
		} finally {
			await result.close();
		}
		expect(movePrompt).toHaveBeenCalledTimes(1);
	});
});

describe("generated resume hints — explicit custom session directory", () => {
	for (const scenario of ["custom directory", "different future directory", "unavailable recorded project"]) {
		it.skipIf(process.platform === "win32")(`opens the retained journal with ${scenario}`, async () => {
			if (!agentDirRoot) throw new Error("Expected isolated agent directory");
			const project = path.join(agentDirRoot, "project");
			const launch = path.join(agentDirRoot, "another-launch-directory");
			const sessionDir = path.join(agentDirRoot, "custom ' $HOME $(touch injected) sessions");
			await fsp.mkdir(project);
			await fsp.mkdir(launch);
			setProjectDir(launch);
			const original = SessionManager.create(project, sessionDir);
			original.appendMessage({ role: "user", content: "retained checkpoint", timestamp: 1 });
			await original.ensureOnDisk();
			await original.flush();
			const sessionId = original.getSessionId();
			const sessionFile = original.getSessionFile();
			await original.close();
			if (!sessionFile) throw new Error("Expected persisted journal");
			if (scenario === "unavailable recorded project") await fsp.rmdir(project);
			const opened = await SessionManager.open(
				sessionFile,
				scenario === "different future directory" ? path.join(agentDirRoot, "future-sessions") : undefined,
				undefined,
				{ initialCwd: launch },
			);
			let hint: string;
			try {
				if (scenario !== "custom directory") expect(opened.getSessionDir()).not.toBe(sessionDir);
				const currentFile = opened.getSessionFile();
				if (!currentFile) throw new Error("Expected original journal");
				hint = resumeCommand(currentFile);
			} finally {
				await opened.close();
			}
			const shell = Bun.spawn(["/bin/sh", "-c", `set -- ${hint}; printf '%s\\000' "$@"`], {
				cwd: launch,
				env: { PATH: "/usr/bin:/bin" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = await new Response(shell.stdout).text();
			expect(await shell.exited).toBe(0);
			const args = parseArgs(output.split("\0").slice(1, -1));
			const resumed = await createSessionManager(
				args,
				launch,
				Settings.isolated({ "marketplace.autoUpdate": "off" }),
			);
			if (!resumed) throw new Error("Expected the original session manager");
			try {
				expect(resumed.getSessionId()).toBe(sessionId);
				expect(resumed.getSessionFile()).toBe(sessionFile);
				expect(resumed.getSessionDir()).toBe(sessionDir);
				expect(await fsp.realpath(resumed.getCwd())).toBe(
					await fsp.realpath(scenario === "unavailable recorded project" ? launch : project),
				);
				expect(
					resumed
						.getEntries()
						.some(
							entry =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								entry.message.content === "retained checkpoint",
						),
				).toBe(true);
				expect(fs.existsSync(path.join(launch, "injected"))).toBe(false);
			} finally {
				await resumed.close();
			}
		});
	}
});
