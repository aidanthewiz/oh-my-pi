// Regression: amazon-bedrock ignored the onPayload replacement return value
// (fire-and-forget), so the hook could never change the body actually sent
// upstream. The replacement contract matches anthropic / openai-responses /
// google: await the hook and use its non-undefined return as the request body.
import { describe, expect, it, vi } from "bun:test";
import { type BedrockOptions, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { BedrockCompat } from "@oh-my-pi/pi-catalog/types";

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

const toolContext: Context = {
	...context,
	tools: [{ name: "test_tool", description: "test", parameters: { type: "object" } }],
};

function prefixBound(
	overrides: { id?: string; provider?: string; compat?: BedrockCompat } = {},
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: overrides.id ?? "us.anthropic.claude-fable-5-1-v1:0",
		name: "Claude",
		api: "bedrock-converse-stream",
		provider: overrides.provider ?? "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
		compat: overrides.compat,
	});
}

// Capture the serialized body the provider sends. The response is an empty
// event stream: the fetch (and thus the body capture) happens before any
// response parsing, and the stream's outcome is irrelevant to the assertion.
async function captureSentBody(
	onPayload: (payload: unknown) => unknown | Promise<unknown>,
	target: Model<"bedrock-converse-stream"> = model(),
	options: Partial<BedrockOptions> = {},
	targetContext: Context = context,
): Promise<Record<string, any>> {
	let captured: Record<string, any> | undefined;
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body;
		const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
		captured = JSON.parse(text);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
		);
	}) as unknown as typeof fetch;

	const stream = streamBedrock(target, targetContext, {
		...options,
		bearerToken: "test-token",
		region: "us-east-1",
		fetch: fetchMock,
		onPayload,
	});
	const result = await stream.result();
	if (!captured) throw new Error(result.errorMessage ?? "Bedrock did not send a request");
	return captured;
}

describe("bedrock onPayload replacement", () => {
	it("sends an async onPayload replacement body", async () => {
		const body = await captureSentBody(async payload => ({
			...(payload as Record<string, unknown>),
			messages: [{ role: "user", content: [{ text: "replacement" }] }],
		}));

		expect(body.messages).toEqual([{ role: "user", content: [{ text: "replacement" }] }]);
		expect(JSON.stringify(body.messages)).not.toContain("hi");
	}, 10_000);

	it("keeps the original body when onPayload returns undefined", async () => {
		const body = await captureSentBody(async () => undefined);

		expect(body.messages[0].content[0].text).toBe("hi");
	}, 10_000);

	it("sends Fable 5.1 thinking-binding controls through additional fields", async () => {
		const body = await captureSentBody(async () => undefined, prefixBound(), { reasoning: Effort.High });

		expect(body.additionalModelRequestFields.thinking.block_binding).toEqual({
			prefix_mismatch_behavior: "drop_block",
		});
		expect(body.additionalModelRequestFields.anthropic_beta).toContain("thinking-binding-controls-2026-08-01");
		expect(body.additionalModelResponseFieldPaths).toEqual(["/input_transformations"]);
	}, 10_000);

	it("sends thinking-binding controls for Opus 5.5 on a custom Bedrock-wire provider", async () => {
		const target = prefixBound({
			id: "global.anthropic.claude-opus-5-5",
			provider: "bedrock-gateway",
			compat: { supportsThinkingBindingControls: true },
		});
		const body = await captureSentBody(async () => undefined, target, {
			reasoning: Effort.High,
			anthropicPrefixMismatchBehavior: "error",
		});

		expect(body.additionalModelRequestFields.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "error" });
		expect(body.additionalModelRequestFields.anthropic_beta).toContain("thinking-binding-controls-2026-08-01");
	}, 10_000);

	it("does not enable binding payloads on a non-prefix-bound model", async () => {
		const body = await captureSentBody(async () => undefined, model(), {
			anthropicPrefixMismatchBehavior: "error",
		});

		expect(body.additionalModelRequestFields).toBeUndefined();
		expect(body.additionalModelResponseFieldPaths).toBeUndefined();
	}, 10_000);

	it("omits thinking-binding controls but keeps adaptive thinking when the endpoint opts out", async () => {
		const target = prefixBound({ compat: { supportsThinkingBindingControls: false } });
		const body = await captureSentBody(async () => undefined, target, {
			reasoning: Effort.High,
			anthropicPrefixMismatchBehavior: "error",
		});

		expect(body.additionalModelRequestFields).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			output_config: { effort: "high" },
		});
		expect(body.additionalModelResponseFieldPaths).toBeUndefined();
	}, 10_000);

	it("downgrades a forced tool choice on prefix-bound models even when the controls are opted out", async () => {
		for (const toolChoice of ["any", { type: "tool", name: "test_tool" }] as const) {
			const target = prefixBound({ compat: { supportsThinkingBindingControls: false } });
			const body = await captureSentBody(async () => undefined, target, { toolChoice }, toolContext);

			expect(body.toolConfig.toolChoice).toEqual({ auto: {} });
			expect(body.additionalModelRequestFields).toBeUndefined();
			expect(body.additionalModelResponseFieldPaths).toBeUndefined();
		}
	}, 10_000);

	it("keeps a forced tool choice on models without prefix binding", async () => {
		const body = await captureSentBody(async () => undefined, model(), { toolChoice: "any" }, toolContext);

		expect(body.toolConfig.toolChoice).toEqual({ any: {} });
	}, 10_000);

	it("keeps mismatch recovery bounded and honors error precedence after opting out", async () => {
		const target = prefixBound({ compat: { supportsThinkingBindingControls: false } });
		const replayContext: Context = {
			messages: [
				...context.messages,
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "Prior reasoning", thinkingSignature: "signed-thinking" },
						{ type: "text", text: "Prior answer" },
					],
					api: target.api,
					provider: target.provider,
					model: target.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: 1,
				},
				{ role: "user", content: "Continue", timestamp: 2 },
			],
		};
		const mismatch = "Invalid `signature` in `thinking` block: bound to a different conversation";
		for (const scenario of [
			{ error: mismatch, behavior: undefined, attempts: 2 },
			{ error: mismatch, behavior: "error" as const, attempts: 1 },
			{ error: "ValidationException: invalid request setting", behavior: undefined, attempts: 1 },
		]) {
			const requests: Record<string, any>[] = [];
			const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const body = init?.body;
				requests.push(JSON.parse(body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body)));
				return new Response(scenario.error, { status: 400 });
			}) as unknown as typeof fetch;
			const result = await streamBedrock(target, replayContext, {
				bearerToken: "test-token",
				region: "us-east-1",
				fetch: fetchMock,
				reasoning: Effort.High,
				anthropicPrefixMismatchBehavior: scenario.behavior,
			}).result();

			expect(requests).toHaveLength(scenario.attempts);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain(scenario.error);
			expect(requests[0]!.messages[1].content).toContainEqual({
				reasoningContent: { reasoningText: { text: "Prior reasoning", signature: "signed-thinking" } },
			});
			if (scenario.attempts === 2) {
				expect(requests[1]!.messages[1].content).toEqual([{ text: "Prior answer" }]);
			}
			for (const request of requests) {
				expect(request.additionalModelRequestFields).toEqual({
					thinking: { type: "adaptive", display: "summarized" },
					output_config: { effort: "high" },
				});
				expect(request.additionalModelResponseFieldPaths).toBeUndefined();
			}
		}
	}, 10_000);
});
