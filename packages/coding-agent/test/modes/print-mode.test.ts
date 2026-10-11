/**
 * Contract: `--mode json` output stays linear in conversation size. Streaming
 * `message_update` events must not re-serialize the in-progress message, and
 * printed messages must not carry provider-opaque replay payloads (encrypted
 * reasoning history), which previously produced multi-GB transcripts.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "../../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../../src/extensibility/extensions/runner";
import type { ExtensionFactory } from "../../src/extensibility/extensions/types";
import { printableEvent, runPrintMode } from "../../src/modes/print-mode";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { EventBus } from "../../src/utils/event-bus";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../../src/session/agent-session";
type StdoutWriteCallback = (error?: Error | null) => void;

const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "openai-responses",
	provider: "openai",
	model: "gpt-test",
	usage: {} as AssistantMessage["usage"],
	stopReason: "stop",
	timestamp: 1,
	providerPayload: { type: "openaiResponsesHistory", provider: "openai", dt: true, items: [{ big: "blob" }] },
};

describe("printableEvent", () => {
	it("emits only the incremental delta for message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel", partial: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hel" },
		});
	});

	it("drops the done-variant message snapshot from message_update", () => {
		const event: AgentSessionEvent = {
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "done", reason: "stop", message: assistant },
		};
		const printed = JSON.parse(JSON.stringify(printableEvent(event)));
		expect(printed).toEqual({ type: "message_update", assistantMessageEvent: { type: "done", reason: "stop" } });
	});

	it("strips providerPayload from message_end but keeps the message content", () => {
		const event: AgentSessionEvent = { type: "message_end", message: assistant };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			message: Record<string, unknown>;
		};
		expect(printed.message.providerPayload).toBeUndefined();
		expect(printed.message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(printed.message.model).toBe("gpt-test");
	});

	it("strips providerPayload from every message in agent_end", () => {
		const event: AgentSessionEvent = { type: "agent_end", messages: [assistant, assistant] };
		const printed = JSON.parse(JSON.stringify(printableEvent(event))) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(printed.messages).toHaveLength(2);
		for (const message of printed.messages) expect(message.providerPayload).toBeUndefined();
	});

	it("passes unrelated events through untouched", () => {
		const event: AgentSessionEvent = { type: "notice", level: "info", message: "hi" };
		expect(printableEvent(event)).toBe(event);
	});
});

describe("print-mode extension completion", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		session = undefined;
		authStorage = undefined;
	});

	async function createSession(factory: ExtensionFactory, responses: MockResponseSource = []) {
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			factory,
			process.cwd(),
			new EventBus(),
			runtime,
			"print-command",
		);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const extensionRunner = new ExtensionRunner([extension], runtime, process.cwd(), sessionManager, modelRegistry);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected test model");
		const provider = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: provider.stream,
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "plan.defaultOnStartup": false }),
			modelRegistry,
			extensionRunner,
		});
		return { session, modelRegistry, provider };
	}

	it("delivers nested agent work and the final custom outcome before JSON shutdown and pipe drain", async () => {
		const firstStarted = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<void>();
		const releaseSecond = Promise.withResolvers<void>();
		const outcomeSendStarted = Promise.withResolvers<void>();
		const releaseOutcome = Promise.withResolvers<void>();
		const outcomeAppended = Promise.withResolvers<void>();
		const finalWrite = Promise.withResolvers<void>();
		let turns = 0;
		const { session: active, provider } = await createSession(
			pi => {
				pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") });
				pi.on("session_stop", async (_event, ctx) => {
					if (++turns === 1) return { continue: true, additionalContext: "Continue" };
					outcomeSendStarted.resolve();
					await releaseOutcome.promise;
					pi.sendMessage(
						{
							customType: "managed_result",
							content: "Validated",
							display: true,
							details: { validated: true, turns },
						},
						{ triggerTurn: false },
					);
					ctx.shutdown();
				});
			},
			[
				async () => {
					firstStarted.resolve();
					await releaseFirst.promise;
					return { content: ["First analysis"] };
				},
				async () => {
					secondStarted.resolve();
					await releaseSecond.promise;
					return { content: ["Final analysis"] };
				},
			],
		);
		const records: Array<Record<string, unknown>> = [];
		let releaseOutcomeWrite: (() => void) | undefined;
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
				callback?: StdoutWriteCallback,
			) => {
				const record = JSON.parse(String(chunk)) as Record<string, unknown>;
				const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
				const message = record.message as { customType?: string } | undefined;
				if (record.type === "message_end" && message?.customType === "managed_result") {
					releaseOutcomeWrite = () => {
						releaseOutcomeWrite = undefined;
						records.push(record);
						done?.();
					};
					finalWrite.resolve();
				} else {
					records.push(record);
					done?.();
				}
				return true;
			},
		);
		active.subscribe(event => {
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "managed_result"
			) {
				outcomeAppended.resolve();
			}
		});
		let returned = false;
		const run = runPrintMode(active, { mode: "json", initialMessage: "/managed", messages: ["Must not run"] }).then(
			code => {
				returned = true;
				return code;
			},
		);
		try {
			await withTimeout(firstStarted.promise, 2_000, "Extension analysis never started");
			expect(active.isDisposed).toBe(false);
			expect(returned).toBe(false);
			releaseFirst.resolve();
			await withTimeout(secondStarted.promise, 2_000, "Nested analysis never started");
			expect(active.isDisposed).toBe(false);
			releaseSecond.resolve();
			await withTimeout(outcomeSendStarted.promise, 2_000, "Final outcome send never started");
			expect(active.isDisposed).toBe(false);
			releaseOutcome.resolve();
			await withTimeout(outcomeAppended.promise, 2_000, "Final outcome was not appended");
			await withTimeout(finalWrite.promise, 2_000, "Final outcome was not printed");
			expect(active.isDisposed).toBe(false);
			expect(returned).toBe(false);
			releaseOutcomeWrite?.();
			expect(await run).toBe(0);
			expect(records).toContainEqual(
				expect.objectContaining({
					type: "message_end",
					message: expect.objectContaining({
						customType: "managed_result",
						details: { validated: true, turns: 2 },
					}),
				}),
			);
			expect(active.isDisposed).toBe(true);
			expect(provider.calls).toHaveLength(2);
		} finally {
			releaseFirst.resolve();
			releaseSecond.resolve();
			releaseOutcome.resolve();
			releaseOutcomeWrite?.();
			await run;
		}
	});

	it("delivers queued follow-ups after a non-triggering stop-hook message without adding a model turn", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		let stops = 0;
		const delivered: string[] = [];
		const { session: active, provider } = await createSession(
			pi => {
				pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") });
				pi.on("session_stop", async () => {
					if (++stops === 1) {
						hookStarted.resolve();
						await releaseHook.promise;
					}
					pi.sendMessage(
						{ customType: "managed_result", content: "Completed", display: true, details: { stops } },
						{ triggerTurn: false },
					);
				});
			},
			[
				{ content: ["Initial analysis"] },
				context => {
					const last = context.messages.at(-1);
					expect(last?.role).toBe("user");
					expect(last?.content).toEqual([{ type: "text", text: "First follow-up" }]);
					delivered.push("first");
					return { content: ["First follow-up delivered"] };
				},
				context => {
					const last = context.messages.at(-1);
					expect(last?.role).toBe("user");
					expect(last?.content).toEqual([{ type: "text", text: "Second follow-up" }]);
					delivered.push("second");
					return { content: ["Second follow-up delivered"] };
				},
			],
		);
		active.agent.setFollowUpMode("one-at-a-time");
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
				callback?: StdoutWriteCallback,
			) => {
				output.push(String(chunk));
				(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
				return true;
			},
		);
		const run = runPrintMode(active, { mode: "json", initialMessage: "/managed" });
		try {
			await withTimeout(hookStarted.promise, 2_000, "Stop hook never started");
			await active.sendUserMessage("First follow-up", { deliverAs: "followUp" });
			await active.sendUserMessage("Second follow-up", { deliverAs: "followUp" });
			releaseHook.resolve();
			expect(await run).toBe(0);
			expect(delivered).toEqual(["first", "second"]);
			expect(provider.calls).toHaveLength(3);
			const records = output.map(line => JSON.parse(line));
			expect(records).toContainEqual(
				expect.objectContaining({
					type: "message_end",
					message: expect.objectContaining({
						role: "assistant",
						content: [{ type: "text", text: "Second follow-up delivered" }],
					}),
				}),
			);
		} finally {
			releaseHook.resolve();
			await run;
		}
	});

	it("prints the delayed extension response instead of exiting with no text", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session: active } = await createSession(
			pi => pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") }),
			[
				async () => {
					started.resolve();
					await release.promise;
					return { content: ["Analysis complete"] };
				},
			],
		);
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
				callback?: StdoutWriteCallback,
			) => {
				output.push(String(chunk));
				(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
				return true;
			},
		);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const run = runPrintMode(active, { mode: "text", initialMessage: "/managed" });
		try {
			await withTimeout(started.promise, 2_000, "Extension analysis never started");
			expect(active.isDisposed).toBe(false);
			release.resolve();
			expect(await run).toBe(0);
			expect(output.join("")).toBe("Analysis complete\n");
		} finally {
			release.resolve();
			await run;
		}
	});

	it("keeps explicit non-triggering messages as steering while the provider is genuinely streaming", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session: active, provider } = await createSession(
			pi => pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") }),
			[
				async () => {
					started.resolve();
					await release.promise;
					return { content: ["Initial analysis"] };
				},
				context => ({
					content: [
						context.messages.some(
							message =>
								message.role === "developer" &&
								(typeof message.content === "string"
									? message.content.includes("Refine the analysis")
									: message.content.some(
											part => part.type === "text" && part.text.includes("Refine the analysis"),
										)),
						)
							? "Steered analysis"
							: "Missing steering",
					],
				}),
			],
		);
		const output: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
				callback?: StdoutWriteCallback,
			) => {
				output.push(String(chunk));
				(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
				return true;
			},
		);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const run = runPrintMode(active, { mode: "text", initialMessage: "/managed" });
		try {
			await withTimeout(started.promise, 2_000, "Extension analysis never started");
			await active.sendCustomMessage(
				{ customType: "steer-note", content: "Refine the analysis", display: false },
				{ triggerTurn: false },
			);
			release.resolve();
			expect(await run).toBe(0);
			expect(output.join("")).toBe("Steered analysis\n");
			expect(provider.calls).toHaveLength(2);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("terminates a local-only shutdown command without waiting for agent events or running the next prompt", async () => {
		const { session: active } = await createSession(pi => {
			pi.registerCommand("local", { handler: async (_args, ctx) => ctx.shutdown() });
		});
		const code = await withTimeout(
			runPrintMode(active, { mode: "text", initialMessage: "/local", messages: ["Must not run"] }),
			2_000,
			"Local-only command did not settle",
		);
		expect(code).toBe(0);
		expect(active.getLastAssistantMessage()).toBeUndefined();
		expect(active.isDisposed).toBe(true);
	});

	it("settles cancelled extension analysis with a failed status instead of abandoning the active turn", async () => {
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { session: active } = await createSession(
			pi => pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") }),
			[
				async (_context, options) => {
					options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
					started.resolve();
					await release.promise;
					return { stopReason: options?.signal?.aborted ? "aborted" : "stop", content: ["Cancelled"] };
				},
			],
		);
		vi.spyOn(process.stdout, "write").mockImplementation(
			(
				_chunk: string | Uint8Array,
				encodingOrCallback?: BufferEncoding | StdoutWriteCallback,
				callback?: StdoutWriteCallback,
			) => {
				(typeof encodingOrCallback === "function" ? encodingOrCallback : callback)?.();
				return true;
			},
		);
		const run = runPrintMode(active, { mode: "json", initialMessage: "/managed" });
		try {
			await withTimeout(started.promise, 2_000, "Extension analysis never started");
			await active.abort();
			expect(await run).toBe(1);
			expect(active.isDisposed).toBe(true);
		} finally {
			release.resolve();
			await run;
		}
	});

	it("returns failure with a diagnostic when an extension send is rejected before provider dispatch", async () => {
		const { session: active, modelRegistry } = await createSession(pi =>
			pi.registerCommand("managed", { handler: async () => pi.sendUserMessage("Analyze") }),
		);
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue(undefined);
		const errors: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
			errors.push(String(chunk));
			return true;
		});
		const code = await runPrintMode(active, { mode: "json", initialMessage: "/managed" });
		expect(code).toBe(1);
		expect(errors.join("")).toContain("Extension sendUserMessage failed: No API key found for anthropic.");
		expect(active.isDisposed).toBe(true);
	});
});
