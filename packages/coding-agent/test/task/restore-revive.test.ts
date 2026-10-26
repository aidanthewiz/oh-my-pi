/**
 * `omp --restore` end to end for a subagent: a transcript a crash cut off mid tool
 * call is revived from disk, its cut-off call runs again, the agent answers, and the
 * parent receives the answer as the subagent's job.
 */
import { afterEach, beforeEach, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { type RestoreOutcome, restoreSession } from "@oh-my-pi/pi-coding-agent/task/restore";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { type } from "@oh-my-pi/omptype";

const AGENT_ID = "Restored";
const MOCK_API_SOURCE = "test/restore-revive";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

let savedEnv: Record<string, string | undefined> = {};
let root: string;

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-restore-revive-"));
	const home = path.join(root, "home");
	await fs.mkdir(home, { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	AsyncJobManager.setInstance(undefined);
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	await removeWithRetries(root);
});

it("revives a subagent a crash cut off mid tool call, runs the call again, and delivers its answer to the parent", async () => {
	const cwd = path.join(root, "home", "work");
	await fs.mkdir(cwd, { recursive: true });
	const notes = path.join(cwd, "notes.txt");
	await Bun.write(notes, "the answer is 42\n");

	// The main session and its subagent's transcript, as the process left them when it died
	// inside the subagent's `read` call: no tool result, no exit record.
	const main = SessionManager.create(cwd, path.join(root, "sessions"));
	main.appendMessage({ role: "user", content: "fan out", timestamp: Date.now() });
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	await main.close();
	const child = await SessionManager.open(
		path.join(mainFile.slice(0, -6), `${AGENT_ID}.jsonl`),
		undefined,
		undefined,
		{
			initialCwd: cwd,
			parentSession: mainFile,
			suppressBreadcrumb: true,
		},
	);
	child.appendSessionInit({
		systemPrompt: ["test"],
		task: "report what notes.txt says",
		tools: ["read"],
		agent: "task",
		resolvedModel: "mock/mock-model",
	});
	child.appendMessage({ role: "user", content: "report what notes.txt says", timestamp: Date.now() });
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: notes } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	});
	await child.close();

	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	const readResults: string[] = [];
	const mock = createMockModel({
		handler: context => {
			const last = context.messages.at(-1);
			if (last?.role !== "toolResult" || last.toolName !== "read") return { content: ["label"] };
			readResults.push(JSON.stringify(last.content));
			return { content: ["restored: 42"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"async.enabled": true,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		"task.agentIdleTtlMs": 0,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"lsp.enabled": false,
		modelRoles: { default: "mock/mock-model" },
	});
	const { session } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		sessionManager: await SessionManager.open(mainFile),
		agentId: MAIN_AGENT_ID,
		toolNames: ["read"],
		autoApprove: true,
		disableExtensionDiscovery: true,
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		cacheWarming: false,
		skipPythonPreflight: true,
	});
	const manager = session.asyncJobManager;
	if (!manager) throw new Error("Expected the root session's async job manager");
	await initializeExtensions(session, {
		reportSendError: (_action, error) => {
			throw error;
		},
		reportRuntimeError: error => {
			throw error.error;
		},
	});
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({ session, authStorage, modelRegistry, settings, enableLsp: false }),
		() => 0,
	);

	try {
		const outcome = await restoreSession(session);
		expect(outcome.subagents).toEqual([AGENT_ID]);

		await manager.getJob(AGENT_ID)?.promise;
		await session.settleAsyncWork();
		await session.waitForIdle();
		const delivered = session.messages.filter(
			message => message.role === "custom" && message.customType === "async-result",
		);
		expect(delivered.some(message => JSON.stringify(message).includes("restored: 42"))).toBe(true);
		expect(readResults).toHaveLength(1);
		expect(readResults[0]).toContain("the answer is 42");
	} finally {
		try {
			await session.dispose();
		} finally {
			await authStorage.close();
		}
	}
}, 20_000);

it("does not replay interrupted child effects when /new cancels its registered job during cold revival", async () => {
	const cwd = path.join(root, "home", "cancel-work");
	await fs.mkdir(cwd, { recursive: true });
	const probeFile = path.join(cwd, "probe.jsonl");
	const token = "owned-cold-cancel";
	const childId = "ColdCancelled";
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const main = SessionManager.create(cwd, path.join(root, "cancel-sessions"));
	main.appendMessage({ role: "user", content: "fan out", timestamp: 1 });
	main.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Main turn complete" }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "stop",
		timestamp: 2,
	});
	expect(hasRestorableTurn(main.getBranch())).toBe(false);
	await main.ensureOnDisk();
	const mainFile = main.getSessionFile();
	if (!mainFile) throw new Error("Expected a persisted session file");
	await main.close();
	const child = await SessionManager.open(path.join(mainFile.slice(0, -6), `${childId}.jsonl`), undefined, undefined, {
		initialCwd: cwd,
		parentSession: mainFile,
		suppressBreadcrumb: true,
	});
	child.appendSessionInit({
		systemPrompt: ["RESTORE_CANCEL_CHILD"],
		task: "append the owned probe",
		tools: ["restore_probe"],
		agent: "task",
		resolvedModel: "mock/mock-model",
		spawns: "",
	});
	child.appendMessage({ role: "user", content: "append the owned probe", timestamp: 3 });
	child.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: "call_probe", name: "restore_probe", arguments: { token } }],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: "toolUse",
		timestamp: 4,
	});
	expect(hasRestorableTurn(child.getBranch())).toBe(true);
	await child.close();

	const probeParameters = type({ token: "string" });
	const extension: ExtensionFactory = pi => {
		pi.registerTool({
			name: "restore_probe",
			label: "Owned append probe",
			description: "Append an owned receipt",
			approval: "write",
			parameters: probeParameters,
			async execute(toolCallId, params) {
				expect(toolCallId).toBe("call_probe");
				expect(probeParameters.assert(params).token).toBe(token);
				await fs.appendFile(probeFile, JSON.stringify({ token, toolCallId }) + "\n");
				return { content: [{ type: "text", text: "Owned probe appended" }], details: { token } };
			},
		});
	};
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("mock", "test-key");
	const modelRegistry = new ModelRegistry(authStorage);
	let childProviderCalls = 0;
	const mock = createMockModel({
		handler: context => {
			if (context.systemPrompt?.includes("RESTORE_CANCEL_CHILD")) childProviderCalls++;
			return { content: ["Child answer after cancelled restore"] };
		},
	});
	const catalogAvailable = modelRegistry.getAvailable.bind(modelRegistry);
	vi.spyOn(modelRegistry, "getAvailable").mockImplementation(kind => [mock, ...catalogAvailable(kind)]);
	const settings = Settings.isolated({
		"async.enabled": true,
		"task.isolation.enabled": false,
		"task.enableLsp": false,
		"task.agentIdleTtlMs": 0,
		"task.maxRuntimeMs": 10_000,
		"task.completionProbe": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"lsp.enabled": false,
		modelRoles: { default: "mock/mock-model", tiny: "mock/mock-model" },
	});
	const { session } = await createAgentSession({
		cwd,
		authStorage,
		modelRegistry,
		model: mock,
		settings,
		sessionManager: await SessionManager.open(mainFile),
		agentId: MAIN_AGENT_ID,
		extensions: [extension],
		toolNames: ["restore_probe"],
		autoApprove: true,
		disableExtensionDiscovery: true,
		preloadedExtensionPaths: [],
		preloadedCustomToolPaths: [],
		contextFiles: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		cacheWarming: false,
		skipPythonPreflight: true,
	});
	const manager = session.asyncJobManager;
	if (!manager) throw new Error("Expected the root session's async job manager");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const lifecycle = AgentLifecycleManager.global();
	const realFactory = createPersistedSubagentReviverFactory({
		session,
		authStorage,
		modelRegistry,
		settings,
		enableLsp: false,
	});
	let attempt: Promise<RestoreOutcome> | undefined;
	try {
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
		});
		lifecycle.setPersistedSubagentReviverFactory(
			async ref => {
				const revive = await realFactory(ref);
				if (!revive) return undefined;
				return async expectedRef => {
					entered.resolve();
					await release.promise;
					return revive(expectedRef);
				};
			},
			() => 0,
		);
		const oldSessionId = session.sessionId;
		attempt = restoreSession(session);
		await entered.promise;
		const originalJob = manager.getJob(childId);
		if (!originalJob) throw new Error("Expected restore to register the child before revival");
		expect(originalJob.type).toBe("task");
		expect(originalJob.ownerId).toBe(MAIN_AGENT_ID);
		expect(originalJob.agentId).toBe(childId);
		expect(originalJob.status).toBe("running");
		expect(originalJob.abortController.signal.aborted).toBe(false);
		expect(AgentRegistry.global().get(childId)?.status).toBe("parked");
		expect(
			await fs.stat(probeFile).then(
				() => true,
				error => {
					if (error.code === "ENOENT") return false;
					throw error;
				},
			),
		).toBe(false);
		expect(await session.newSession()).toBe(true);
		expect(session.sessionId).not.toBe(oldSessionId);
		expect(manager.getJob(childId)).toBe(originalJob);
		expect(originalJob.status).toBe("cancelled");
		expect(originalJob.abortController.signal.aborted).toBe(true);
		const callsAtRelease = childProviderCalls;
		release.resolve();
		expect(await attempt).toEqual({ turn: false, subagents: [childId] });
		await originalJob.promise;
		const revived = AgentRegistry.global().get(childId)?.session;
		await revived?.waitForIdle();
		await session.settleAsyncWork();
		await session.waitForIdle();
		const probeAppends = await fs.readFile(probeFile, "utf8").then(
			bytes =>
				bytes
					.trim()
					.split("\n")
					.map(line => JSON.parse(line)),
			error => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		const publications = session.messages.filter(
			message => message.role === "custom" && message.customType === "async-result",
		);
		expect({
			probeAppends,
			childProviderCallsAfterRelease: childProviderCalls - callsAtRelease,
			publications,
		}).toEqual({ probeAppends: [], childProviderCallsAfterRelease: 0, publications: [] });
		expect(originalJob.status).toBe("cancelled");
		expect(manager.getAllJobs().filter(job => job.status === "running")).toEqual([]);
		await lifecycle.dispose();
		expect(lifecycle.has(childId)).toBe(false);
		expect(revived?.isDisposed ?? true).toBe(true);
		expect(await manager.dispose({ timeoutMs: 1_000 })).toBe(true);
		expect(manager.getAllJobs()).toEqual([]);
	} finally {
		release.resolve();
		try {
			try {
				await attempt;
			} finally {
				await manager.getJob(childId)?.promise;
			}
		} finally {
			try {
				await lifecycle.dispose();
			} finally {
				try {
					await session.dispose();
				} finally {
					await authStorage.close();
				}
			}
		}
	}
}, 20_000);
