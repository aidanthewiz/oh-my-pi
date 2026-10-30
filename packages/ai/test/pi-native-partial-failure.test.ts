import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentEvent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamPiNative } from "../src/providers/pi-native-client";
import { encodeStream } from "../src/providers/pi-native-server";
import { streamSimple } from "../src/stream";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, ToolCall } from "../src/types";
import { AssistantMessageEventStream } from "../src/utils/event-stream";

const model = buildModel({
	id: "synthetic-partial-failure",
	name: "Synthetic partial failure",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "http://gateway.invalid",
	transport: "pi-native",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 4096,
});
const context: Context = { messages: [{ role: "user", content: "synthetic request", timestamp: 1 }] };
const receivedText = "Already received answer.";
const iteratorFailure = "synthetic gateway iterator failure";
const canonicalFailure = "synthetic canonical content discard";
const receivedUsage: AssistantMessage["usage"] = {
	input: 19,
	output: 7,
	cacheRead: 3,
	cacheWrite: 2,
	totalTokens: 31,
	cost: { input: 0.019, output: 0.007, cacheRead: 0.003, cacheWrite: 0.002, total: 0.031 },
};
const completedCall: ToolCall = {
	type: "toolCall",
	id: "synthetic-completed-call",
	name: "synthetic_effect",
	arguments: { value: "complete" },
};
const incompleteCall: ToolCall = {
	type: "toolCall",
	id: "synthetic-incomplete-call",
	name: "synthetic_effect",
	arguments: { value: "unfinished" },
};
type Scenario = "text" | "completed-call" | "incomplete-call" | "before-output" | "canonical-empty";

function assistant(content: AssistantMessage["content"] = [], withUsage = false): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content,
		usage: withUsage
			? structuredClone(receivedUsage)
			: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
		stopReason: "stop",
		timestamp: 2,
	};
}

function gateway(scenario: Scenario) {
	let requests = 0;
	const control = new AbortController();
	const bodies: ReadableStream<Uint8Array>[] = [];
	const fetch: FetchImpl = async () => {
		requests++;
		const source = new AssistantMessageEventStream();
		source.push({ type: "start", partial: assistant() });
		if (scenario !== "before-output") {
			source.push({ type: "text_start", contentIndex: 0, partial: assistant([{ type: "text", text: "" }]) });
			const text = [{ type: "text" as const, text: receivedText }];
			source.push({ type: "text_delta", contentIndex: 0, delta: receivedText, partial: assistant(text, true) });
			source.push({ type: "text_end", contentIndex: 0, content: receivedText, partial: assistant(text, true) });
			if (scenario === "completed-call" || scenario === "incomplete-call") {
				const call = structuredClone(scenario === "completed-call" ? completedCall : incompleteCall);
				source.push({
					type: "toolcall_start",
					contentIndex: 1,
					partial: assistant([...text, { ...call, arguments: {} }], true),
				});
				source.push({
					type: "toolcall_delta",
					contentIndex: 1,
					delta: scenario === "completed-call" ? '{"value":"complete"}' : '{"value":"unfinished',
					partial: assistant([...text, call], true),
				});
				if (scenario === "completed-call") {
					source.push({
						type: "toolcall_end",
						contentIndex: 1,
						toolCall: call,
						partial: assistant([...text, call], true),
					});
				}
			}
		}
		if (scenario === "canonical-empty") {
			const error = assistant();
			error.stopReason = "error";
			error.errorMessage = canonicalFailure;
			source.push({ type: "error", reason: "error", error });
		} else {
			// fail() rejects iteration after the queued progress, exercising encodeStream's catch.
			source.fail(new Error(iteratorFailure));
		}
		const body = encodeStream(source, model.id, undefined, { signal: control.signal });
		bodies.push(body);
		return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
	};
	return {
		fetch,
		get requests() {
			return requests;
		},
		async close() {
			control.abort();
			await Promise.all(bodies.map(body => body.cancel().catch(() => {})));
		},
	};
}

function expectError(message: AssistantMessage, scenario: Scenario) {
	expect(message.stopReason).toBe("error");
	expect(message.errorMessage).toBe(scenario === "canonical-empty" ? canonicalFailure : iteratorFailure);
	expect(message).toMatchObject({ role: "assistant", api: model.api, provider: model.provider, model: model.id });
}

function expectRetained(message: AssistantMessage, scenario: Scenario, persisted: boolean) {
	expectError(message, scenario);
	if (scenario === "before-output" || scenario === "canonical-empty") {
		expect(message.content).toEqual([]);
		expect(message.usage).toEqual(assistant().usage);
		return;
	}
	expect(message.content.filter(block => block.type === "text")).toEqual([{ type: "text", text: receivedText }]);
	expect(message.usage).toEqual(receivedUsage);
	if (scenario === "completed-call") {
		expect(message.content.filter(block => block.type === "toolCall")).toEqual([completedCall]);
	} else if (persisted || scenario === "text") {
		expect(message.content.filter(block => block.type === "toolCall")).toEqual([]);
	}
}

const scenarios: Scenario[] = ["text", "completed-call", "incomplete-call", "before-output", "canonical-empty"];

for (const [route, stream] of [
	["native", streamPiNative],
	["simple", streamSimple],
] as const) {
	describe(`pi-native partial failure via ${route}`, () => {
		for (const scenario of scenarios) {
			it(`GWP-${route}-${scenario}: retains received output without replay`, async () => {
				const transport = gateway(scenario);
				try {
					const response = stream(model, context, {
						fetch: transport.fetch,
						apiKey: "synthetic-gateway-bearer",
						streamFirstEventTimeoutMs: 10000,
						streamIdleTimeoutMs: 10000,
					});
					const events: AssistantMessageEvent[] = [];
					for await (const event of response) events.push(event);
					const result = await response.result();
					expect(transport.requests).toBe(1);
					expect(
						events.filter(event => event.type === "done" || event.type === "error").map(event => event.type),
					).toEqual(["error"]);
					const terminal = events.at(-1);
					if (terminal?.type !== "error") throw new Error("Expected terminal gateway error");
					expect(terminal.error).toEqual(result);
					if (scenario !== "before-output") {
						const progress = events.find(event => event.type === "text_delta");
						expect(progress).toMatchObject({ delta: receivedText, partial: { usage: receivedUsage } });
					}
					if (scenario === "completed-call" || scenario === "incomplete-call") {
						expect(events.find(event => event.type === "toolcall_delta")).toMatchObject({
							partial: {
								content: [
									{ type: "text", text: receivedText },
									scenario === "completed-call" ? completedCall : incompleteCall,
								],
							},
						});
						expect(events.filter(event => event.type === "toolcall_end").map(event => event.toolCall)).toEqual(
							scenario === "completed-call" ? [completedCall] : [],
						);
					}
					expectRetained(result, scenario, false);
				} finally {
					await transport.close();
				}
			});
		}
	});
}

describe("pi-native partial failure in Agent history", () => {
	for (const scenario of scenarios) {
		it(`GWP-agent-${scenario}: commits received output and completed calls without tool effects`, async () => {
			const transport = gateway(scenario);
			const parameters = type({ value: "string" });
			const effects: string[] = [];
			const tool: AgentTool<typeof parameters, { synthetic: boolean }> = {
				name: "synthetic_effect",
				label: "Synthetic effect sentinel",
				description: "Records synthetic execution only",
				parameters,
				async execute(_id, args) {
					effects.push(args.value);
					return { content: [{ type: "text", text: "synthetic execution" }], details: { synthetic: true } };
				},
			};
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Synthetic regression"], messages: [], tools: [tool] },
				streamFn: (requestedModel, requestContext, options) =>
					streamSimple(requestedModel, requestContext, {
						...options,
						fetch: transport.fetch,
						apiKey: "synthetic-gateway-bearer",
						streamFirstEventTimeoutMs: 10000,
						streamIdleTimeoutMs: 10000,
					}),
			});
			const events: AgentEvent[] = [];
			const unsubscribe = agent.subscribe(event => events.push(event));
			try {
				await agent.prompt("synthetic request");
				expect(transport.requests).toBe(1);
				expect(effects).toEqual([]);
				const toolResults = agent.state.messages.filter(message => message.role === "toolResult");
				expect(
					toolResults.map(message => ({
						id: message.toolCallId,
						name: message.toolName,
						error: message.isError,
					})),
				).toEqual(
					scenario === "completed-call" ? [{ id: completedCall.id, name: completedCall.name, error: true }] : [],
				);
				const stored = agent.state.messages[1];
				if (stored?.role !== "assistant") throw new Error("Expected stored assistant");
				const ended = events.flatMap(event =>
					event.type === "message_end" && event.message.role === "assistant" ? [event.message] : [],
				);
				expect(ended).toEqual([stored]);
				if (scenario !== "before-output") {
					const progress = events.find(
						event => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
					);
					expect(progress).toMatchObject({
						message: { content: [{ type: "text", text: receivedText }], usage: receivedUsage },
					});
				}
				if (scenario === "completed-call" || scenario === "incomplete-call") {
					const progress = events.flatMap(event =>
						event.type === "message_update" ? [event.assistantMessageEvent] : [],
					);
					expect(progress.find(event => event.type === "toolcall_delta")).toMatchObject({
						partial: {
							content: [
								{ type: "text", text: receivedText },
								scenario === "completed-call" ? completedCall : incompleteCall,
							],
						},
					});
					expect(progress.filter(event => event.type === "toolcall_end").map(event => event.toolCall)).toEqual(
						scenario === "completed-call" ? [completedCall] : [],
					);
				}
				expectRetained(stored, scenario, true);
			} finally {
				unsubscribe();
				agent.abort();
				await transport.close();
			}
		});
	}
});
