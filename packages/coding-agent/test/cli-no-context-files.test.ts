import { afterAll, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { reset as resetCapabilities } from "@oh-my-pi/pi-coding-agent/capability";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PRIMARY_MARKER = "primary-context-marker-7f3a";
const EXTRA_ROOT_MARKER = "extra-root-context-marker-2c9d";
const IMPORTED_MARKER = "imported-context-marker-5e1b";
const USER_AGENTS_MARKER = "user-agents-marker-9b41";
const EXTRA_CLAUDE_MARKER = "extra-claude-marker-6a07";
const PINNED_AGENTS_MARKER = "pinned-agents-marker-f90a";
const PINNED_CLAUDE_MARKER = "pinned-claude-marker-168b";
const NESTED_DIR = "nested-context-dir-4d8e";
// A nested AGENTS.md is not inlined; the prompt lists its path for the agent to read.
const NESTED_LISTING = `${NESTED_DIR}/AGENTS.md`;
const MARKERS = [
	PRIMARY_MARKER,
	EXTRA_ROOT_MARKER,
	IMPORTED_MARKER,
	USER_AGENTS_MARKER,
	EXTRA_CLAUDE_MARKER,
	NESTED_LISTING,
];
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

describe("--no-context-files", () => {
	let tempDir: TempDir;
	let contextProbe = 0;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let homedirSpy: Mock<typeof os.homedir>;
	const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

	beforeAll(async () => {
		tempDir = await TempDir.create("@cli-no-context-files-");
		// User-level discovery reads the process-global agent dir and home: point both at the
		// fixture so neither run picks up the developer's own config.
		setAgentDir(tempDir.join("home/.omp/agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir.join("home"));
		await Promise.all([
			Bun.write(tempDir.join("project/AGENTS.md"), `${PRIMARY_MARKER}\n`),
			Bun.write(tempDir.join(`project/${NESTED_DIR}/AGENTS.md`), "nested\n"),
			Bun.write(tempDir.join("extra/AGENTS.md"), `${EXTRA_ROOT_MARKER}\n@imported.md\n`),
			Bun.write(tempDir.join("extra/imported.md"), `${IMPORTED_MARKER}\n`),
			Bun.write(tempDir.join("home/.omp/agent/AGENTS.md"), `${USER_AGENTS_MARKER}\n`),
			Bun.write(tempDir.join("extra-claude/CLAUDE.md"), `${EXTRA_CLAUDE_MARKER}\n`),
		]);
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		closeModelCache();
		homedirSpy.mockRestore();
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		__resetDirsFromEnvForTests();
		await tempDir.remove();
	});

	async function createSession(flags: string[], overrides: Partial<sdkModule.CreateAgentSessionOptions> = {}) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			includeWorkspaceTree: true,
		});
		const args = parseArgs([
			"--cwd",
			tempDir.join("project"),
			"--add-dir",
			tempDir.join("extra"),
			"--add-dir",
			tempDir.join("extra-claude"),
			...flags,
		]);
		const options = await buildSessionOptions(args, [], SessionManager.inMemory(args.cwd), modelRegistry, settings);
		const { session } = await sdkModule.createAgentSession({
			...options,
			agentDir: getAgentDir(),
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			enableLsp: false,
			skipPythonPreflight: true,
			...overrides,
		});
		return session;
	}

	/** Spawns one `task` subagent through the session's own task tool and returns the child's system prompt. */
	async function subagentPrompt(session: AgentSession, contextFilePolicy?: "inherit" | "none"): Promise<string> {
		const createChild = sdkModule.createAgentSession;
		const probeId = ++contextProbe;
		let childPrompt: string | undefined;
		// The child's prompt is settled once it is created; stop before its first model call.
		const createSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async childOptions => {
			const created = await createChild(childOptions);
			childPrompt = created.session.systemPrompt.join("\n");
			await created.session.dispose();
			throw new Error("child prompt captured");
		});
		try {
			await session.getToolByName("task")?.execute(`no-context-files-child-${probeId}`, {
				agent: "task",
				name: `ContextProbe${probeId}`,
				task: "Report.",
				solutionSpace: "one fix: probe only",
				contextFilePolicy,
			});
		} finally {
			createSpy.mockRestore();
		}
		if (childPrompt === undefined) throw new Error("task tool did not create a subagent session");
		return childPrompt;
	}

	it("keeps every context file, including additional roots' and their imports, out of the session and its subagents", async () => {
		const ambient = await createSession([]);
		try {
			const prompt = ambient.systemPrompt.join("\n");
			for (const marker of MARKERS) expect(prompt).toContain(marker);
			expect(prompt.indexOf(USER_AGENTS_MARKER)).toBeLessThan(prompt.indexOf(PRIMARY_MARKER));
			const childPrompt = await subagentPrompt(ambient);
			for (const marker of MARKERS) expect(childPrompt).toContain(marker);
			await ambient.refreshBaseSystemPrompt();
			for (const marker of MARKERS) expect(ambient.systemPrompt.join("\n")).toContain(marker);
			const isolatedPrompt = await subagentPrompt(ambient, "none");
			for (const marker of MARKERS) expect(isolatedPrompt).not.toContain(marker);
		} finally {
			await ambient.dispose();
		}

		const session = await createSession(["--no-context-files"]);
		try {
			for (const marker of MARKERS) expect(session.systemPrompt.join("\n")).not.toContain(marker);
			await session.refreshBaseSystemPrompt();
			for (const marker of MARKERS) expect(session.systemPrompt.join("\n")).not.toContain(marker);
			const childPrompt = await subagentPrompt(session);
			for (const marker of MARKERS) expect(childPrompt).not.toContain(marker);
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("keeps supplied context ordered through SDK rebuilds and task inheritance, but not explicit none", async () => {
		const session = await createSession([], {
			contextFiles: [
				{ path: tempDir.join("provided/AGENTS.md"), content: PINNED_AGENTS_MARKER },
				{ path: tempDir.join("provided/CLAUDE.md"), content: PINNED_CLAUDE_MARKER },
			],
		});
		try {
			for (const prompt of [session.systemPrompt.join("\n"), await subagentPrompt(session)]) {
				expect(prompt).toContain(PINNED_AGENTS_MARKER);
				expect(prompt).toContain(PINNED_CLAUDE_MARKER);
				expect(prompt.indexOf(PINNED_AGENTS_MARKER)).toBeLessThan(prompt.indexOf(PINNED_CLAUDE_MARKER));
				for (const marker of [EXTRA_ROOT_MARKER, IMPORTED_MARKER, EXTRA_CLAUDE_MARKER]) {
					expect(prompt).toContain(marker);
				}
			}
			await session.refreshBaseSystemPrompt();
			const rebuilt = session.systemPrompt.join("\n");
			expect(rebuilt).toContain(PINNED_AGENTS_MARKER);
			expect(rebuilt.indexOf(PINNED_AGENTS_MARKER)).toBeLessThan(rebuilt.indexOf(PINNED_CLAUDE_MARKER));
			const isolated = await subagentPrompt(session, "none");
			for (const marker of [...MARKERS, PINNED_AGENTS_MARKER, PINNED_CLAUDE_MARKER]) {
				expect(isolated).not.toContain(marker);
			}
		} finally {
			await session.dispose();
		}
	}, 60_000);

	it("rediscovers changed primary and additional-root context on prompt rebuild", async () => {
		const session = await createSession([]);
		const refreshedPrimary = "refreshed-primary-marker-470b";
		const refreshedExtra = "refreshed-extra-marker-d46f";
		try {
			await Bun.write(tempDir.join("project/AGENTS.md"), `${refreshedPrimary}\n`);
			await Bun.write(tempDir.join("extra/AGENTS.md"), `${refreshedExtra}\n@imported.md\n`);
			resetCapabilities();
			await session.refreshBaseSystemPrompt();
			const prompt = session.systemPrompt.join("\n");
			expect(prompt).toContain(refreshedPrimary);
			expect(prompt).toContain(refreshedExtra);
			expect(prompt).toContain(IMPORTED_MARKER);
			expect(prompt).not.toContain(PRIMARY_MARKER);
			expect(prompt).not.toContain(EXTRA_ROOT_MARKER);
			const child = await subagentPrompt(session);
			expect(child).toContain(refreshedPrimary);
			expect(child).toContain(refreshedExtra);
		} finally {
			await session.dispose();
			await Bun.write(tempDir.join("project/AGENTS.md"), `${PRIMARY_MARKER}\n`);
			await Bun.write(tempDir.join("extra/AGENTS.md"), `${EXTRA_ROOT_MARKER}\n@imported.md\n`);
			resetCapabilities();
		}
	}, 60_000);
});
