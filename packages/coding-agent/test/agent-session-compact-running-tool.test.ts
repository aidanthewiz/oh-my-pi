import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { cfgCompactionAutoContinue } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const CALL_ID = "toolu_running_wait";

describe("session transitions while a tool runs", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-transition-running-tool-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		await authStorage?.close();
		authStorage = undefined;
		tempDir.removeSync();
	});

	/** Start a turn whose only tool call settles when the turn is aborted, like `wait` on a long job. */
	async function startRunningTool(toolName = "wait") {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic model");
		const toolStarted = Promise.withResolvers<void>();
		const waitTool: AgentTool = {
			name: toolName,
			label: "Wait",
			description: "Waits until aborted",
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				toolStarted.resolve();
				const aborted = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return { content: [{ type: "text", text: "wait interrupted" }] };
			},
		};
		const mock = createMockModel({
			responses: [{ content: [{ type: "toolCall", id: CALL_ID, name: toolName, arguments: {} }] }],
			handler: { content: ["done"] },
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [waitTool] },
			streamFn: mock.stream,
		});

		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_before_compact", async event => ({
					compaction: {
						summary: "compacted",
						shortSummary: undefined,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: {},
					},
				}));
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"transition-running-tool",
		);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({ "compaction.keepRecentTokens": 1 });
		cfgCompactionAutoContinue.set(settings, false);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[waitTool.name, waitTool]]),
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry),
		});

		const prompt = session.prompt("wait for the job");
		await toolStarted.promise;
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a session file");
		return { active: session, sessionManager, sessionFile, prompt };
	}

	/** Roles of the session file's message entries carrying the running call, in file order, read back from disk. */
	async function persistedCallEntries(sessionFile: string): Promise<string[]> {
		const reopened = await SessionManager.open(sessionFile, tempDir.join("sessions"));
		try {
			return reopened.getEntries().flatMap(entry => {
				if (entry.type !== "message") return [];
				const { message } = entry;
				if (message.role === "toolResult") return message.toolCallId === CALL_ID ? ["toolResult"] : [];
				if (message.role === "assistant") {
					return message.content.some(block => block.type === "toolCall" && block.id === CALL_ID)
						? ["assistant"]
						: [];
				}
				return [];
			});
		} finally {
			await reopened.close();
		}
	}

	it.each(["new", "switch", "revise-input", "replace-bridge"] as const)(
		"rejects a pending ACP grant after %s without executing or caching it",
		async boundary => {
			const effect = tempDir.join("approved-effect.txt");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
			const tool: AgentTool = {
				name: "bash",
				label: "Bash",
				description: "Writes an isolated approval marker",
				parameters: type({ command: "string" }),
				execute: async () => {
					await Bun.write(effect, "executed");
					return { content: [{ type: "text", text: "recorded" }] };
				},
			};
			authStorage = createInMemoryAuthStorage();
			authStorage.keys.setRuntime("anthropic", "test-key");
			const mock = createMockModel({ handler: { content: ["unused"] } });
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [tool] },
					streamFn: mock.stream,
				}),
				sessionManager: SessionManager.create(tempDir.path(), tempDir.join("sessions")),
				settings: Settings.isolated({ "compaction.enabled": false, "tools.approvalMode": "always-ask" }),
				modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
				toolRegistry: new Map([[tool.name, tool]]),
			});
			const entered = Promise.withResolvers<void>();
			const grant = Promise.withResolvers<ClientBridgePermissionOutcome>();
			const allowed: ClientBridgePermissionOutcome = {
				outcome: "selected",
				optionId: "allow_always",
				kind: "allow_always",
			};
			let requests = 0;
			const bridge: ClientBridge = {
				capabilities: { requestPermission: true },
				requestPermission: async () => {
					requests++;
					entered.resolve();
					return requests === 1 ? grant.promise : allowed;
				},
			};
			session.setClientBridge(bridge);
			await session.setActiveToolsByName(["bash"]);
			const args = { command: "printf approved" };
			const pending = session
				.getToolForEvalBridge("bash")!
				.execute("old-grant", args, undefined, undefined as never, undefined as never)
				.then(
					() => undefined,
					error => error,
				);
			try {
				await entered.promise;
				if (boundary === "new") await session.newSession();
				else if (boundary === "switch") {
					const target = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
					target.appendMessage({ role: "user", content: "permission target", timestamp: 1 });
					await target.flush();
					const targetFile = target.getSessionFile()!;
					await target.close();
					await session.switchSession(targetFile);
				} else if (boundary === "revise-input") args.command = "printf revised";
				else
					session.setClientBridge({
						capabilities: { requestPermission: true },
						requestPermission: async () => {
							requests++;
							return allowed;
						},
					});
				grant.resolve(allowed);
				expect(await pending).toBeInstanceOf(ToolError);
				expect(await Bun.file(effect).exists()).toBe(false);
				args.command = "printf approved";
				await session
					.getToolForEvalBridge("bash")!
					.execute("fresh-grant", args, undefined, undefined as never, undefined as never);
				expect(requests).toBe(2);
				expect(await Bun.file(effect).text()).toBe("executed");
			} finally {
				grant.resolve(allowed);
				await pending;
			}
		},
	);

	it("keeps the interrupted tool's result when /compact aborts it", async () => {
		const { active, sessionManager, sessionFile, prompt } = await startRunningTool();

		await active.compact();
		await prompt;
		await sessionManager.flush();

		expect(await persistedCallEntries(sessionFile)).toEqual(["assistant", "toolResult"]);
		expect(sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("does not record a rewind the interrupted turn never applied", async () => {
		const { active, sessionManager, sessionFile, prompt } = await startRunningTool("rewind");

		await active.compact();
		await prompt;
		await sessionManager.flush();

		expect(await persistedCallEntries(sessionFile)).toEqual(["assistant"]);
	});

	it("keeps the interrupted tool's result in the old session on /new", async () => {
		const { active, sessionManager, sessionFile, prompt } = await startRunningTool();

		await active.newSession();
		await prompt;
		await sessionManager.flush();

		expect(sessionManager.getSessionFile()).not.toBe(sessionFile);
		expect(await persistedCallEntries(sessionFile)).toEqual(["assistant", "toolResult"]);
	});

	it("keeps the interrupted tool's result in the old session on a session switch", async () => {
		const target = SessionManager.create(tempDir.path(), tempDir.join("sessions"));
		target.appendMessage({ role: "user", content: "other session", timestamp: Date.now() });
		await target.flush();
		const targetFile = target.getSessionFile();
		if (!targetFile) throw new Error("Expected a target session file");
		await target.close();
		const { active, sessionManager, sessionFile, prompt } = await startRunningTool();

		await active.switchSession(targetFile);
		await prompt;
		await sessionManager.flush();

		expect(sessionManager.getSessionFile()).toBe(targetFile);
		expect(await persistedCallEntries(sessionFile)).toEqual(["assistant", "toolResult"]);
	});
});
