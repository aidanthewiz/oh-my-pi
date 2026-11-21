import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentOptions, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function lastAgentMessage(session: AgentSession): AssistantMessage {
	const message = session.agent.state.messages.at(-1);
	if (message?.role !== "assistant") {
		throw new Error("Expected trailing assistant message");
	}
	return message as AssistantMessage;
}

describe("AgentSession manual retry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-manual-retry-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	afterAll(async () => {
		await authStorage.close();
		tempDir.removeSync();
	});

	async function createWithStopDiagnostic(
		responses: MockResponseSource,
		tools: AgentTool[] = [],
		transformContext?: AgentOptions["transformContext"],
		existing?: { manager: SessionManager; provider: MockModel },
	) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model");
		const manager = existing?.manager ?? SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("session_stop", event => {
					const assistant = event.last_assistant_message;
					if (
						assistant?.role !== "assistant" ||
						(assistant.stopReason !== "error" && assistant.stopReason !== "aborted")
					)
						return;
					pi.sendMessage(
						{
							customType: "retry-diagnostic",
							content: "The attempt failed; manual retry remains available",
							display: true,
							details: { failedAttempt: true },
						},
						{ triggerTurn: false },
					);
				});
			},
			tempDir.path(),
			new EventBus(),
			runtime,
			"manual-retry-stop",
		);
		const provider = existing?.provider ?? createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools, messages: manager.buildSessionContext().messages },
			streamFn: provider.stream,
			convertToLlm,
			transformContext,
		});
		session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry,
			extensionRunner: new ExtensionRunner([extension], runtime, tempDir.path(), manager, modelRegistry),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"plan.defaultOnStartup": false,
			}),
		});
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw new Error(error.error);
			},
		});
		session.subscribe(() => {});
		return { active: session, manager, provider, model };
	}

	it.each(["live", "copied", "reopened"] as const)(
		"retries a failed %s turn after a passive stop diagnostic",
		async state => {
			const { active, manager, provider, model } = await createWithStopDiagnostic([
				{ throw: "stop diagnostic retry failure" },
				context => {
					expect(context.messages.some(message => message.role === "assistant")).toBe(false);
					return { content: ["recovered with diagnostic retained"] };
				},
			]);
			await active.prompt("fail once");
			await active.waitForIdle();
			expect(active.agent.state.messages.at(-1)).toMatchObject({
				role: "custom",
				customType: "retry-diagnostic",
				details: { failedAttempt: true },
			});
			expect(active.hasAbortedToolCallTail).toBe(false);
			if (state === "copied") {
				active.agent.replaceMessages(active.agent.state.messages.map(message => ({ ...message })));
			}
			let currentManager = manager;
			if (state === "reopened") {
				const sessionFile = path.join(tempDir.path(), "reopened-diagnostic.jsonl");
				fs.writeFileSync(
					sessionFile,
					[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n",
				);
				await active.dispose();
				currentManager = await SessionManager.open(sessionFile, tempDir.path());
				session = new AgentSession({
					agent: new Agent({
						getApiKey: () => "test-key",
						initialState: {
							model,
							systemPrompt: ["Test"],
							tools: [],
							messages: currentManager.buildSessionContext().messages,
						},
						streamFn: provider.stream,
						convertToLlm,
					}),
					sessionManager: currentManager,
					modelRegistry,
					settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
				});
				session.subscribe(() => {});
			}
			if (!session) throw new Error("Expected retry session");
			await expect(session.retry()).resolves.toBe(true);
			await session.waitForIdle();
			expect(provider.calls).toHaveLength(2);
			expect(
				session.agent.state.messages.some(
					message => message.role === "assistant" && message.stopReason === "error",
				),
			).toBe(false);
			expect(lastAgentMessage(session).content).toContainEqual({
				type: "text",
				text: "recovered with diagnostic retained",
			});
			expect(currentManager.buildSessionContext({ transcript: true }).messages).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "retry-diagnostic",
					details: { failedAttempt: true },
				}),
			);
			await expect(session.retry()).resolves.toBe(false);
			expect(provider.calls).toHaveLength(2);
		},
	);

	it("retries a reopened context cancellation and then a reopened passive error diagnostic", async () => {
		const entered = Promise.withResolvers<void>();
		const { active, manager, provider } = await createWithStopDiagnostic(
			[
				context => {
					expect(context.messages.some(message => message.role === "assistant")).toBe(false);
					return { throw: "Retry failed after context cancellation" };
				},
				context => {
					expect(context.messages.some(message => message.role === "assistant")).toBe(false);
					return { content: ["Recovered after context cancellation"] };
				},
			],
			[],
			async (messages, signal) => {
				if (!signal) throw new Error("Expected context cancellation signal");
				const cancelled = Promise.withResolvers<void>();
				if (signal.aborted) cancelled.resolve();
				else signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
				entered.resolve();
				await cancelled.promise;
				signal.throwIfAborted();
				return messages;
			},
		);
		const terminalTranscripts: AgentMessage[][] = [];
		active.subscribe(event => {
			if (event.type === "agent_end") {
				terminalTranscripts.push(manager.buildSessionContext({ transcript: true }).messages);
			}
		});
		const running = active.prompt("cancel during context preparation");
		await entered.promise;
		active.agent.abort("Interrupted by user");
		await running;
		await active.waitForIdle();
		const transcript = manager.buildSessionContext({ transcript: true }).messages;
		expect(transcript.filter(message => message.role === "assistant")).toEqual([
			expect.objectContaining({ stopReason: "aborted", errorMessage: "Interrupted by user" }),
		]);
		expect(transcript.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
		expect(terminalTranscripts).toEqual([transcript]);
		expect(provider.calls).toHaveLength(0);
		const sessionFile = path.join(tempDir.path(), "reopened-context-cancellation.jsonl");
		fs.writeFileSync(
			sessionFile,
			[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n",
		);
		await active.dispose();
		const reopened = await SessionManager.open(sessionFile, tempDir.path());
		const failedRetry = await createWithStopDiagnostic([], [], undefined, { manager: reopened, provider });
		const failedRetryTranscripts: AgentMessage[][] = [];
		failedRetry.active.subscribe(event => {
			if (event.type === "agent_end") {
				failedRetryTranscripts.push(reopened.buildSessionContext({ transcript: true }).messages);
			}
		});
		await expect(failedRetry.active.retry()).resolves.toBe(true);
		await failedRetry.active.waitForIdle();
		const failedTranscript = reopened.buildSessionContext({ transcript: true }).messages;
		expect(failedTranscript.filter(message => message.role === "assistant")).toEqual([
			expect.objectContaining({ stopReason: "aborted", errorMessage: "Interrupted by user" }),
			expect.objectContaining({ stopReason: "error", errorMessage: "Retry failed after context cancellation" }),
		]);
		expect(failedTranscript.filter(message => message.role === "custom")).toEqual([
			expect.objectContaining({ customType: "retry-diagnostic", details: { failedAttempt: true } }),
		]);
		expect(failedTranscript.at(-1)).toMatchObject({ role: "custom", customType: "retry-diagnostic" });
		expect(failedRetryTranscripts).toEqual([failedTranscript]);
		expect(provider.calls).toHaveLength(1);
		const diagnosticFile = path.join(tempDir.path(), "reopened-context-retry-diagnostic.jsonl");
		fs.writeFileSync(
			diagnosticFile,
			[reopened.getHeader(), ...reopened.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n",
		);
		await failedRetry.active.dispose();
		const diagnosticManager = await SessionManager.open(diagnosticFile, tempDir.path());
		const recovered = await createWithStopDiagnostic([], [], undefined, { manager: diagnosticManager, provider });
		await expect(recovered.active.retry()).resolves.toBe(true);
		await recovered.active.waitForIdle();
		expect(lastAgentMessage(recovered.active).content).toContainEqual({
			type: "text",
			text: "Recovered after context cancellation",
		});
		expect(provider.calls).toHaveLength(2);
		expect(diagnosticManager.buildSessionContext({ transcript: true }).messages).toContainEqual(
			expect.objectContaining({ customType: "retry-diagnostic" }),
		);
		await expect(recovered.active.retry()).resolves.toBe(false);
		expect(provider.calls).toHaveLength(2);
	});

	it.each(["live", "copied", "reopened"] as const)(
		"does not retry an older %s failure through unrelated custom context and an eval snapshot",
		async state => {
			const { active, manager, provider } = await createWithStopDiagnostic([{ throw: "original failure" }]);
			await active.prompt("fail once");
			await active.waitForIdle();
			await active.sendCustomMessage(
				{ customType: "unrelated-context", content: "A different context update", display: false },
				{ triggerTurn: false },
			);
			manager.appendCustomMessageEntry("eval-state-context", "Retained eval state", false);
			active.agent.replaceMessages(active.buildDisplaySessionContext().messages);
			if (state === "copied") {
				active.agent.replaceMessages(active.agent.state.messages.map(message => ({ ...message })));
			}
			let current = active;
			if (state === "reopened") {
				const sessionFile = path.join(tempDir.path(), "unrelated-retry-context.jsonl");
				fs.writeFileSync(
					sessionFile,
					[manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n",
				);
				await active.dispose();
				const reopened = await SessionManager.open(sessionFile, tempDir.path());
				current = (await createWithStopDiagnostic([], [], undefined, { manager: reopened, provider })).active;
			}
			const before = current.agent.state.messages.slice();
			await expect(current.retry()).resolves.toBe(false);
			expect(current.hasAbortedToolCallTail).toBe(false);
			expect(current.agent.state.messages).toEqual(before);
			expect(provider.calls).toHaveLength(1);
		},
	);

	it("does not borrow a persisted failure across newer active custom context", async () => {
		const { active, provider } = await createWithStopDiagnostic([{ throw: "original failure" }]);
		await active.prompt("fail once");
		await active.waitForIdle();
		active.agent.appendMessage({
			role: "custom",
			customType: "active-context",
			content: "Newer context not in the persisted failure branch",
			display: false,
			timestamp: Date.now(),
		});
		const before = active.agent.state.messages.slice();
		await expect(active.retry()).resolves.toBe(false);
		expect(active.hasAbortedToolCallTail).toBe(false);
		expect(active.agent.state.messages).toEqual(before);
		expect(provider.calls).toHaveLength(1);
	});

	it.each([false, true])(
		"preserves tool replay safety with a passive diagnostic and partial success=%s",
		async partial => {
			const schema = type({ value: type("string") });
			const executed: string[] = [];
			let failingCalls = 0;
			const probe: AgentTool<typeof schema> = {
				name: "probe",
				label: "Probe",
				description: "Retry probe",
				parameters: schema,
				async execute(_id, params) {
					executed.push(params.value);
					const isError = params.value === "fail" && ++failingCalls === 1;
					return { content: [{ type: "text", text: isError ? "failed" : `ok:${params.value}` }], isError };
				},
			};
			const { active, manager, provider } = await createWithStopDiagnostic(
				[
					{
						content: [
							{ type: "toolCall", id: "failed-call", name: "probe", arguments: { value: "fail" } },
							...(partial
								? [
										{
											type: "toolCall" as const,
											id: "successful-call",
											name: "probe",
											arguments: { value: "success" },
										},
									]
								: []),
						],
						stopReason: "toolUse",
					},
					{ throw: "provider failed after tool execution" },
					context => {
						const results = context.messages.filter(message => message.role === "toolResult");
						expect(results.map(result => result.toolCallId).sort()).toEqual(
							partial ? ["failed-call", "successful-call"] : ["failed-call"],
						);
						expect(results.find(result => result.toolCallId === "failed-call")?.isError).toBe(true);
						return { content: ["tool retry recovered"] };
					},
				],
				[probe],
			);
			await active.prompt("run the probe");
			await active.waitForIdle();
			const failedLeaf = manager.getLeafId();
			const completedResults = active.agent.state.messages.filter(message => message.role === "toolResult");
			const diagnostic = active.agent.state.messages.at(-1);
			if (!diagnostic) throw new Error("Expected retry diagnostic");
			expect(diagnostic).toMatchObject({ role: "custom", customType: "retry-diagnostic" });
			expect(active.hasAbortedToolCallTail).toBe(!partial);
			await expect(active.retry()).resolves.toBe(true);
			await active.waitForIdle();
			expect(executed).toEqual(partial ? ["fail", "success"] : ["fail"]);
			expect(active.agent.state.messages.filter(message => message.role === "toolResult")).toEqual(completedResults);
			expect(active.agent.state.messages).toContainEqual(diagnostic);
			const transcript = manager.buildSessionContext({ transcript: true }).messages;
			expect(transcript.filter(message => message.role === "toolResult")).toEqual(completedResults);
			expect(transcript).toContainEqual(diagnostic);
			expect(transcript).toContainEqual(
				expect.objectContaining({
					role: "assistant",
					stopReason: "error",
					errorMessage: "provider failed after tool execution",
				}),
			);
			expect(provider.calls).toHaveLength(3);
			expect(lastAgentMessage(active).content).toContainEqual({ type: "text", text: "tool retry recovered" });
			expect(
				buildSessionContext(manager.getEntries(), failedLeaf, undefined, { transcript: true }).messages,
			).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "retry-diagnostic",
					details: { failedAttempt: true },
				}),
			);
		},
	);

	it("removes the failed assistant turn and continues with a fresh attempt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{ throw: "manual retry test failure" },
				{ content: ["recovered after manual retry"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("fail once");
		await session.waitForIdle();
		expect(lastAgentMessage(session).stopReason).toBe("error");

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "recovered after manual retry" });
	});

	it.each(["retry", "new", "clear", "tree"])("handles a pruned refusal before %s", async action => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");

		const mock = createMockModel({
			responses: [
				{ content: ["previous answer"], stopReason: "stop" },
				{
					stopReason: "error",
					stopDetails: { type: "refusal", category: "cyber", explanation: "Declined." },
					errorMessage: "Refusal (cyber): Declined.",
				},
				{ content: ["retried answer"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"retry.modelFallback": false,
			}),
			modelRegistry,
		});

		await session.prompt("first prompt");
		await session.waitForIdle();
		const previousLeaf = session.sessionManager.getLeafId();
		if (!previousLeaf) throw new Error("Expected the previous answer to be persisted");

		await session.prompt("second prompt");
		await session.waitForIdle();
		expect(session.getLastAssistantMessage()?.stopReason).toBe("error");
		expect(session.agent.state.messages.at(-1)?.role).toBe("user");
		expect(
			session.sessionManager
				.buildSessionContext({ transcript: true })
				.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);

		if (action === "retry") {
			await expect(session.retry()).resolves.toBe(true);
			await session.waitForIdle();

			expect(mock.calls).toHaveLength(3);
			const request = mock.calls[2].context.messages;
			expect(request.filter(message => message.role === "user").map(message => message.content)).toEqual([
				[{ type: "text", text: "first prompt" }],
				[{ type: "text", text: "second prompt" }],
			]);
			expect(request.filter(message => message.role === "assistant").map(message => message.content)).toEqual([
				[{ type: "text", text: "previous answer" }],
			]);
			expect(session.getLastAssistantMessage()?.content).toEqual([{ type: "text", text: "retried answer" }]);
		} else if (action === "new") {
			await session.newSession();
		} else if (action === "clear") {
			await session.resetSessionContext();
		} else {
			await session.navigateTree(previousLeaf, { summarize: false });
		}

		await expect(session.retry()).resolves.toBe(false);
		expect(mock.calls).toHaveLength(action === "retry" ? 3 : 2);
	});

	it("returns false when the trailing assistant turn succeeded", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [{ content: ["already done"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("succeed");
		await session.waitForIdle();

		await expect(session.retry()).resolves.toBe(false);
		expect(mock.calls.length).toBe(1);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "already done" });
	});

	it("retries past synthetic tool results left by a mid-tool-call stream stall", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		// First turn stalls mid-tool-call: the assistant emits a `write` tool call
		// but the stream ends with an error before it runs, so `stopReason: "error"`.
		// The agent loop then appends a synthetic tool_result for the un-run call,
		// which trails the failed assistant turn in agent state.
		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "write", arguments: { path: "plan.md", content: "x" } }],
					stopReason: "error",
					errorMessage: "OpenAI completions stream stalled while waiting for the next event",
				},
				{ content: ["recovered after stalled tool call"], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("write the plan");
		await session.waitForIdle();

		// The failed assistant turn is shadowed by a trailing synthetic tool_result.
		const messages = session.agent.state.messages;
		expect(messages.at(-1)?.role).toBe("toolResult");
		const failedAssistant = messages.findLast(m => m.role === "assistant") as AssistantMessage;
		expect(failedAssistant.stopReason).toBe("error");
		expect(session.hasAbortedToolCallTail).toBe(true);

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "recovered after stalled tool call",
		});
	});

	it("reports an aborted tool-call tail only when the failed turn ended on a tool call", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({ responses: [] });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const user = { role: "user", content: "run the tool", timestamp: Date.now() } as const;
		const toolTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const abortedBoundary: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "aborted",
			errorMessage: "Stopped before model call",
			timestamp: Date.now(),
		};
		const toolResult = (isError: boolean) => ({
			role: "toolResult" as const,
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text" as const, text: isError ? "aborted" : "ok" }],
			isError,
			timestamp: Date.now(),
		});

		// Esc landed during tool execution: errored result right before the boundary.
		agent.replaceMessages([user, toolTurn, toolResult(true), abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(true);

		// The tool completed; the abort only killed the next model call.
		agent.replaceMessages([user, toolTurn, toolResult(false), abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(false);

		// Abort with no tool activity in the turn at all.
		agent.replaceMessages([user, abortedBoundary]);
		expect(session.hasAbortedToolCallTail).toBe(false);
	});

	it("re-executes the aborted tool call instead of re-issuing it via the model", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const toolSchema = type({ value: type("string") });
		const executed: string[] = [];
		const probeTool: AgentTool<typeof toolSchema, { value: string }> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.value);
				return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
			},
		};
		// One response only: the retry must re-run the tool directly, spending the
		// single model call on the continuation after the fresh result.
		const mock = createMockModel({ responses: [{ content: ["done after replay"], stopReason: "stop" }] });
		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		// Esc landed during tool execution: complete tool-calling turn, errored
		// result, aborted boundary.
		const toolTurn: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [probeTool],
				messages: [
					{ role: "user", content: "run the probe", timestamp: Date.now() },
					toolTurn,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "probe",
						content: [{ type: "text", text: "Execution interrupted" }],
						isError: true,
						timestamp: Date.now(),
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "aborted",
						errorMessage: "Interrupted by user",
						timestamp: Date.now(),
					},
				],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
		const replayResult = messages[2];
		if (replayResult.role !== "toolResult") throw new Error("Expected replayed tool result");
		expect(replayResult.isError).not.toBe(true);
		expect(replayResult.content).toContainEqual({ type: "text", text: "ok:again" });
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "done after replay" });
	});

	it("retries an aborted tool-call turn past a background-job result folded in after the interrupt", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const toolSchema = type({ question: type("string") });
		const executed: string[] = [];
		const askTool: AgentTool<typeof toolSchema, { question: string }> = {
			name: "ask",
			label: "Ask",
			description: "Ask tool",
			parameters: toolSchema,
			async execute(_toolCallId, params) {
				executed.push(params.question);
				return { content: [{ type: "text", text: "answered" }], details: params };
			},
		};
		const mock = createMockModel({ responses: [{ content: ["retried with job result"], stopReason: "stop" }] });
		const zeroUsage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		// #17266: the user cancelled `ask`, then a background job finished while
		// idle and its async-result was folded in behind the aborted boundary.
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [askTool],
				messages: [
					{ role: "user", content: "start the job, then ask me", timestamp: Date.now() },
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "call_ask", name: "ask", arguments: { question: "which?" } }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_ask",
						toolName: "ask",
						content: [{ type: "text", text: "Ask tool was cancelled by the user" }],
						isError: true,
						timestamp: Date.now(),
					},
					{
						role: "assistant",
						content: [{ type: "text", text: "" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: zeroUsage,
						stopReason: "aborted",
						errorMessage: "Interrupted by user",
						timestamp: Date.now(),
					},
					{
						role: "custom",
						customType: "async-result",
						content: "Background job bg_1 finished: build ok",
						display: true,
						timestamp: Date.now(),
					},
				],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		expect(session.hasAbortedToolCallTail).toBe(true);
		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();

		// A tool replay would cut the job result out of history; the retry
		// re-attempts the model call with the result still in context instead.
		expect(executed).toEqual([]);
		expect(mock.calls.length).toBe(1);
		const messages = session.agent.state.messages;
		expect(messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
		const delivery = messages[3];
		expect(delivery.role === "custom" ? delivery.customType : undefined).toBe("async-result");
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "retried with job result" });
	});

	it("retries a persisted failed turn after rebuilding provider context", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const mock = createMockModel({
			responses: [
				{
					content: [{ type: "toolCall", name: "write", arguments: { path: "plan.md", content: "x" } }],
					stopReason: "error",
					errorMessage: "stream stalled before the tool ran",
				},
				{ content: ["recovered after session reopen"], stopReason: "stop" },
			],
		});
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		await session.prompt("write before reopen");
		await session.waitForIdle();
		const failedAssistant = session.agent.state.messages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(failedAssistant?.stopReason).toBe("error");

		const reopenedManager = SessionManager.inMemory();
		reopenedManager.restoreState(sessionManager.captureState());
		await session.dispose();
		session = undefined;

		const restoredMessages = reopenedManager.buildSessionContext().messages;
		// The failed tool-call turn AND its paired synthetic tool result are both
		// dropped from provider context — leaving a stranded tool result with no
		// preceding tool_use would be rejected by provider converters.
		expect(restoredMessages.map(message => message.role)).toEqual(["user"]);
		const transcriptMessages = reopenedManager.buildSessionContext({ transcript: true }).messages;
		expect(transcriptMessages.at(-1)?.role).toBe("toolResult");
		const transcriptAssistant = transcriptMessages.findLast(
			(message): message is AssistantMessage => message.role === "assistant",
		);
		expect(transcriptAssistant?.stopReason).toBe("error");

		const reopenedAgent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: restoredMessages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent: reopenedAgent,
			sessionManager: reopenedManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
		});
		session.subscribe(() => {});

		// Provider context dropped the failed turn, so the tail predicate must
		// fall back to the persisted display transcript (mirrors retry()).
		expect(session.hasAbortedToolCallTail).toBe(true);
		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();
		expect(session.agent.state.messages.map(message => message.role)).toEqual(["user", "assistant"]);

		expect(mock.calls.length).toBe(2);
		expect(lastAgentMessage(session).stopReason).toBe("stop");
		expect(lastAgentMessage(session).content).toContainEqual({
			type: "text",
			text: "recovered after session reopen",
		});
	});

	it("lets an idle aside start a turn after the user resumes an interrupted run with retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		const toolSchema = type({});
		const firstRunStarted = Promise.withResolvers<void>();
		let probeRuns = 0;
		const probeTool: AgentTool<typeof toolSchema> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: toolSchema,
			async execute(_toolCallId, _params, signal) {
				probeRuns++;
				if (probeRuns === 1) {
					// Blocks until the user interrupt aborts it, like a pending `ask`.
					const aborted = Promise.withResolvers<never>();
					signal?.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
					firstRunStarted.resolve();
					await aborted.promise;
				}
				return { content: [{ type: "text", text: "probed" }] };
			},
		};
		const mock = createMockModel({
			handler: context => {
				const transcript = JSON.stringify(context.messages);
				if (transcript.includes("LATE_ASIDE")) return { content: ["handled late aside"] };
				if (context.messages.at(-1)?.role === "user") {
					return { content: [{ type: "toolCall", name: "probe", arguments: {} }] };
				}
				if (transcript.includes("probed")) return { content: ["done after retry"] };
				// The interrupted run's follow-up call after the aborted tool; the abort cancels it.
				return { content: ["unreachable"], delayMs: 60_000 };
			},
		});
		const agent = new Agent({
			convertToLlm,
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [probeTool], messages: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			toolRegistry: new Map([[probeTool.name, probeTool]]),
		});
		session.subscribe(() => {});

		// The user presses Esc while the tool runs, then resumes with /retry.
		const run = session.prompt("run the probe");
		await firstRunStarted.promise;
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await run.catch(() => {});
		await session.waitForIdle();
		await expect(session.retry()).resolves.toBe(true);
		await session.waitForIdle();
		expect(probeRuns).toBe(2);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "done after retry" });

		// The resumed run finished; a late aside must wake the agent, not stay folded
		// as if the earlier interrupt were still in effect.
		const dispatched = await session.sendCustomMessage(
			{ customType: "ext-aside", content: "LATE_ASIDE", display: false, attribution: "agent" },
			{ deliverAs: "aside" },
		);
		await session.waitForIdle();

		expect(dispatched).toBe(true);
		expect(mock.calls.filter(call => JSON.stringify(call.context.messages).includes("LATE_ASIDE"))).toHaveLength(1);
		expect(lastAgentMessage(session).content).toContainEqual({ type: "text", text: "handled late aside" });
	});
});
