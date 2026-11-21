import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { TaskParams } from "@oh-my-pi/pi-tui/tools/task";
import type { IsolationHandle, WorktreeBaseline } from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as worktreeModule from "@oh-my-pi/pi-coding-agent/task/worktree";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createSessionDefaults } from "../helpers/session-defaults";

const TEST_TASK: TaskParams = { agent: "task", name: "CheckLsp", task: "Inspect LSP tools." };
const isolationFixtures: string[] = [];

function createYieldingSession(): AgentSession {
	const transport = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", name: "yield", arguments: { data: { ok: true } } }] },
			{ content: ["done"] },
		],
	});
	const yieldTool = new YieldTool({
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	});
	const agent = new Agent({
		initialState: { model: transport.model, systemPrompt: ["test"], tools: [yieldTool] },
		streamFn: transport.stream,
	});
	let disposed = false;

	return {
		...createSessionDefaults(),
		get isDisposed() {
			return disposed;
		},
		dispose: async () => {
			agent.abort();
			await agent.waitForIdle();
			disposed = true;
		},
		state: agent.state,
		agent,
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["yield"],
		getEnabledToolNames: () => ["yield"],
		subscribe: (listener: (event: AgentSessionEvent) => void) => agent.subscribe(listener),
		prompt: async (text: string, _options?: PromptOptions) => {
			await agent.prompt(text);
			return true;
		},
		getLastAssistantMessage: () => agent.state.messages.findLast(message => message.role === "assistant"),
	} as unknown as AgentSession;
}

function createSession(
	options: {
		cwd?: string;
		isolationEnabled?: boolean;
		parentEnableLsp?: boolean;
		planMode?: PlanModeState;
		sessionFile?: string | null;
		taskEnableLsp?: boolean;
	} = {},
): ToolSession {
	const modelRegistry = {
		authStorage: undefined,
		refresh: async () => {},
		getAvailable: () => [],
		getApiKey: async () => null,
	} as unknown as ModelRegistry;

	return {
		cwd: options.cwd ?? "/tmp",
		hasUI: false,
		enableLsp: options.parentEnableLsp,
		settings: Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": options.isolationEnabled ?? false,
			"isolation.backend": "rcopy",
			...(options.taskEnableLsp !== undefined ? { "task.enableLsp": options.taskEnableLsp } : {}),
		}),
		getSessionFile: () => options.sessionFile ?? null,
		getSessionSpawns: () => "*",
		modelRegistry,
		getPlanModeState: () => options.planMode,
	} as unknown as ToolSession;
}

function mockAgents(agent: AgentDefinition): void {
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
		agents: [agent],
		projectAgentsDir: null,
	});
}

function mockCreateAgentSession(): { getOptions: () => CreateAgentSessionOptions | undefined } {
	let capturedOptions: CreateAgentSessionOptions | undefined;
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async (options = {}) => {
		capturedOptions = options;
		const session = createYieldingSession();
		return {
			session,
			captureOwnerCurrent: () => () => !session.isDisposed,
			captureOwnerLifetimeCurrent: () => () => !session.isDisposed,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
			eventBus: new EventBus(),
		} satisfies CreateAgentSessionResult;
	});
	return { getOptions: () => capturedOptions };
}

async function mockIsolation(): Promise<{ repoRoot: string; isolationDir: string }> {
	const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-lsp-isolation-"));
	isolationFixtures.push(fixtureRoot);
	const repoRoot = path.join(fixtureRoot, "repo");
	const isolationDir = path.join(fixtureRoot, "isolated-subagent");
	for (const directory of [repoRoot, isolationDir]) {
		const proc = Bun.spawn(["git", "init", "--quiet", directory], {
			cwd: fixtureRoot,
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `git init failed: ${exitCode}`);
	}
	const baseline: WorktreeBaseline = {
		root: {
			repoRoot,
			headCommit: "HEAD",
			staged: "",
			unstaged: "",
			untracked: [],
			untrackedPatch: "",
		},
		nested: [],
	};
	const isolationHandle: IsolationHandle = {
		mergedDir: isolationDir,
		backend: worktreeModule.parseIsolationBackend("rcopy")!,
		fellBack: false,
		fallbackReason: null,
	};

	vi.spyOn(worktreeModule, "captureBaseline").mockResolvedValue(baseline);
	vi.spyOn(worktreeModule, "ensureIsolation").mockResolvedValue(isolationHandle);
	vi.spyOn(worktreeModule, "captureDeltaPatch").mockResolvedValue({ rootPatch: "", nestedPatches: [] });
	vi.spyOn(worktreeModule, "cleanupIsolation").mockImplementation(async () => {
		await removeWithRetries(isolationDir);
	});
	return { repoRoot, isolationDir };
}

describe("subagent LSP availability", () => {
	afterEach(async () => {
		vi.restoreAllMocks();
		await Promise.all(isolationFixtures.splice(0).map(directory => removeWithRetries(directory)));
	});

	it("disables LSP for subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession());
		const result = await tool.execute("tool-call", TEST_TASK);
		expect(result.details?.results[0]?.error).toBeUndefined();
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("enables subagent LSP when task.enableLsp is set", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ taskEnableLsp: true }));
		const result = await tool.execute("tool-call", TEST_TASK);
		expect(result.details?.results[0]?.error).toBeUndefined();
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

		expect(getOptions()?.enableLsp).toBe(true);
		expect(getOptions()?.toolNames).toContain("lsp");
	});

	it("keeps subagent LSP disabled when the parent session disables LSP", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ parentEnableLsp: false, taskEnableLsp: true }));
		const result = await tool.execute("tool-call", TEST_TASK);
		expect(result.details?.results[0]?.error).toBeUndefined();
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("disables LSP for isolated subagents by default", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use LSP when useful.",
			source: "bundled",
			tools: ["lsp"],
		});
		const { repoRoot, isolationDir } = await mockIsolation();
		const { getOptions } = mockCreateAgentSession();

		const tool = await TaskTool.create(createSession({ cwd: repoRoot, isolationEnabled: true }));
		const result = await tool.execute("tool-call", { ...TEST_TASK, isolated: true });
		expect(result.details?.results[0]?.error).toBeUndefined();
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

		expect(getOptions()?.cwd).toBe(isolationDir);
		expect(getOptions()?.enableLsp).toBe(false);
	});

	it("opens isolated persisted subagent sessions with the worktree cwd", async () => {
		mockAgents({
			name: "task",
			description: "Task agent",
			systemPrompt: "Use normal tools.",
			source: "bundled",
			tools: ["write"],
		});
		const { repoRoot, isolationDir } = await mockIsolation();
		const { getOptions } = mockCreateAgentSession();
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolated-session-cwd-"));
		try {
			const parentSessionFile = path.join(tempDir, "parent.jsonl");
			const tool = await TaskTool.create(
				createSession({ cwd: repoRoot, isolationEnabled: true, sessionFile: parentSessionFile }),
			);
			const result = await tool.execute("tool-call", { ...TEST_TASK, isolated: true });
			expect(result.details?.results[0]?.error).toBeUndefined();
			expect(result.details?.results[0]?.exitCode).toBe(0);
			expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

			const sessionManager = getOptions()?.sessionManager as { getCwd?: () => string } | undefined;
			expect(getOptions()?.cwd).toBe(isolationDir);
			expect(sessionManager?.getCwd?.()).toBe(isolationDir);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("clamps plan-mode mixed-capability tools despite ordinary settings", async () => {
		mockAgents({
			name: "task",
			description: "Reviewer-like task agent",
			systemPrompt: "Review with read-only specialty tools.",
			source: "bundled",
			tools: ["bash", "ast_grep", "memory_edit", "retain", "todo"],
		});
		const { getOptions } = mockCreateAgentSession();
		const planMode = { enabled: true, planFilePath: "local://PLAN.md" };

		const tool = await TaskTool.create(createSession({ planMode, taskEnableLsp: true }));
		const result = await tool.execute("tool-call", TEST_TASK);
		expect(result.details?.results[0]?.error).toBeUndefined();
		expect(result.details?.results[0]?.exitCode).toBe(0);
		expect(JSON.parse(result.details!.results[0].output)).toEqual({ ok: true });

		const options = getOptions();
		expect(options?.enableLsp).toBe(false);
		expect(options?.enableIrc).toBe(false);
		expect(options?.restrictToolNames).toBe(true);
		expect(options?.toolNames).toEqual(["read", "grep", "glob", "web_search", "ast_grep"]);
		expect(options?.toolNames).not.toContain("lsp");
		expect(options?.toolNames).not.toContain("bash");
		expect(options?.toolNames).not.toContain("memory_edit");
		expect(options?.toolNames).not.toContain("retain");
		expect(options?.toolNames).not.toContain("todo");
	});
});
