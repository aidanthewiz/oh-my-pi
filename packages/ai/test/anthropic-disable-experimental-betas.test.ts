import { describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { withEnv } from "./helpers";

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const GATEWAY_ENV = { CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: "https://llm-gateway.example.com" };
const OFFICIAL_ENV = { CLAUDE_CODE_USE_FOUNDRY: undefined, ANTHROPIC_BASE_URL: undefined };

/**
 * Defaults to the model from the gateway report:
 * `thinking.adaptive.block_binding: Extra inputs are not permitted`.
 */
function anthropicModel(id = "claude-sonnet-5-5"): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

interface CapturedRequest {
	url: string;
	body: {
		thinking?: { type: string; block_binding?: unknown };
		context_management?: unknown;
		fallback_credit_token?: string;
		fallbacks?: unknown;
		messages?: unknown;
		output_config?: { effort?: string; task_budget?: unknown };
		tools?: Array<Record<string, unknown>>;
	};
	beta: string;
	authorization: string | null;
}

async function captureRequest(
	model: Model<"anthropic-messages">,
	extra: AnthropicOptions = {},
	messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }],
	tools?: Context["tools"],
): Promise<CapturedRequest> {
	let captured: CapturedRequest | undefined;
	await streamAnthropic(
		model,
		{ messages, tools },
		{
			apiKey: "sk-ant-api-test",
			thinkingEnabled: true,
			reasoning: Effort.High,
			...extra,
			fetch: async (url, init) => {
				const body = init?.body;
				if (typeof body !== "string" && !(body instanceof Uint8Array)) {
					throw new Error("Expected a string or UTF-8 byte request body");
				}
				captured ??= {
					url: String(url),
					body: JSON.parse(
						typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body),
					),
					beta: new Headers(init?.headers).get("anthropic-beta") ?? "",
					authorization: new Headers(init?.headers).get("authorization"),
				};
				return Response.json({ error: { type: "invalid_request_error", message: "captured" } }, { status: 400 });
			},
		},
	).result();
	if (!captured) throw new Error("expected a captured request");
	return captured;
}

describe("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", () => {
	it("withholds block_binding and context_management (and their betas) on an ANTHROPIC_BASE_URL gateway", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
			const enabled = await captureRequest(anthropicModel());
			expect(enabled.url.startsWith("https://llm-gateway.example.com")).toBe(true);
			expect(enabled.body.thinking?.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
			expect(enabled.body.context_management).toBeDefined();
			expect(enabled.beta).toContain(BINDING_BETA);
			expect(enabled.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});

		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const disabled = await captureRequest(anthropicModel());
			expect(disabled.body.thinking?.type).toBe("adaptive");
			expect(disabled.body.thinking?.block_binding).toBeUndefined();
			expect(disabled.body.context_management).toBeUndefined();
			expect(disabled.beta).not.toContain(BINDING_BETA);
			expect(disabled.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("withholds beta tool fields and task budgets but keeps effort, per Claude Code's gateway contract", async () => {
		const tools: Context["tools"] = [
			// `edit` is strict-eligible; `find` is deferred.
			{ name: "edit", description: "Edit a file.", parameters: { type: "object", properties: {} } },
			{
				name: "find",
				description: "Find files.",
				parameters: { type: "object", properties: {} },
				deferLoading: true,
			},
		];
		const options: AnthropicOptions = { taskBudget: { type: "tokens", total: 50_000 } };
		const messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }];

		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
			const enabled = await captureRequest(anthropicModel(), options, messages, tools);
			expect(enabled.body.output_config?.task_budget).toBeDefined();
			expect(enabled.beta).toContain("task-budgets-2026-03-13");
			expect(enabled.body.tools?.some(tool => "defer_loading" in tool)).toBe(true);
		});

		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
			},
			async () => {
				const disabled = await captureRequest(anthropicModel(), options, messages, tools);
				expect(disabled.body.output_config).toEqual({ effort: "high" });
				expect(disabled.beta).toContain("effort-2025-11-24");
				expect(disabled.beta).not.toContain("task-budgets-2026-03-13");
				expect(disabled.beta).not.toContain("structured-outputs-2025-12-15");
				expect(disabled.beta).not.toContain("mid-conversation-tool-changes-2026-07-01");
				// Only the standard tool fields stay, as in Claude Code.
				const standard: Record<string, true> = {
					name: true,
					description: true,
					input_schema: true,
					cache_control: true,
				};
				for (const tool of disabled.body.tools ?? []) {
					expect(Object.keys(tool).filter(key => standard[key] !== true)).toEqual([]);
				}
			},
		);
	});

	it("strips the withheld betas from caller-supplied options.betas", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				betas: [
					BINDING_BETA,
					CONTEXT_MANAGEMENT_BETA,
					"custom-beta-2026-01-01",
					"interleaved-thinking-2025-05-14",
					"context-1m-2025-08-07",
				],
			});
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
			expect(request.beta).toContain("custom-beta-2026-01-01");
			expect(request.beta).toContain("interleaved-thinking-2025-05-14");
			expect(request.beta).toContain("context-1m-2025-08-07");
		});
	});

	it("strips the withheld betas from caller headers an injected client's per-request betas merge into", async () => {
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			let beta = "";
			await streamAnthropic(
				anthropicModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					thinkingEnabled: true,
					reasoning: Effort.High,
					headers: { "anthropic-beta": `${BINDING_BETA},${CONTEXT_MANAGEMENT_BETA},custom-beta-2026-01-01` },
					client: {
						messages: {
							create: (_value, requestOptions) => {
								beta = new Headers(requestOptions?.headers).get("anthropic-beta") ?? "";
								throw new Error("captured");
							},
						},
					},
				},
			).result();
			// The effort beta proves the per-request merge ran over the caller header.
			expect(beta).toContain("effort-2025-11-24");
			expect(beta).toContain("custom-beta-2026-01-01");
			expect(beta).not.toContain(BINDING_BETA);
			expect(beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("forfeits a fallback-credit redemption frozen with withheld fields and builds a fresh request", async () => {
		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				fallbackCreditRedemption: {
					token: "fct_frozen",
					prefillClaim: false,
					params: {
						model: "claude-fable-5-1",
						messages: [{ role: "user", content: "hi" }],
						stream: true,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
					},
					betas: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA],
					expiresAt: Date.now() + 60_000,
				},
			});
			expect(request.body.fallback_credit_token).toBeUndefined();
			expect(request.body.thinking?.block_binding).toBeUndefined();
			expect(request.body.context_management).toBeUndefined();
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain(CONTEXT_MANAGEMENT_BETA);
			// The fresh body's own betas ride, not the saved list describing the old body.
			expect(request.beta).toContain("effort-2025-11-24");
		});
	});

	it.each(["before", "during"] as const)(
		"retains fresh beta headers when a fallback credit expires %s preparation",
		async timing => {
			await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: undefined }, async () => {
				const model = anthropicModel();
				const options: AnthropicOptions = {
					effort: Effort.High,
					taskBudget: { type: "tokens", total: 50_000 },
				};
				const baseline = await captureRequest(model, options);
				let expiryReads = 0;
				const request = await captureRequest(model, {
					...options,
					fallbackCreditRedemption: {
						token: "fct_expired",
						prefillClaim: false,
						params: {
							model: model.id,
							messages: [{ role: "user", content: "saved" }],
							max_tokens: 1024,
							stream: true,
						},
						betas: ["fallback-credit-2026-06-01"],
						betaHeader: "fallback-credit-2026-06-01",
						get expiresAt() {
							return timing === "during" && expiryReads++ === 0 ? Date.now() + 60_000 : Date.now() - 1;
						},
					},
				});
				expect(baseline.body.context_management).toBeDefined();
				expect(baseline.body.output_config?.task_budget).toEqual(options.taskBudget);
				expect(baseline.body.output_config?.effort).toBe("high");
				expect(request.body.fallback_credit_token).toBeUndefined();
				expect(request.body.messages).toEqual(baseline.body.messages);
				expect(request.body.output_config).toEqual(baseline.body.output_config);
				expect(request.body.context_management).toEqual(baseline.body.context_management);
				expect(request.body.thinking).toEqual(baseline.body.thinking);
				expect(new Set(request.beta.split(",").map(beta => beta.trim()))).toEqual(
					new Set(baseline.beta.split(",").map(beta => beta.trim())),
				);
			});
		},
	);

	it("withholds the switch's controls inside server-side fallback entries", async () => {
		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const fallbacks: NonNullable<AnthropicOptions["fallbacks"]> = [
				{
					model: "claude-opus-5",
					thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
					output_config: { effort: "high", task_budget: { type: "tokens", total: 50_000 } },
				},
			];
			const before = structuredClone(fallbacks);
			const request = await captureRequest(anthropicModel(), { fallbacks });
			expect(request.body.fallbacks).toEqual([
				{ model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } },
			]);
			expect(request.beta).not.toContain("task-budgets-2026-03-13");
			expect(fallbacks).toEqual(before);
		});
	});

	it("withholds fields an onPayload hook puts back", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(anthropicModel(), {
				onPayload: payload => {
					const body = payload as Record<string, unknown>;
					return {
						...body,
						thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
						context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
						compaction: { type: "compact_20260904" },
						output_config: { effort: "high", task_budget: { type: "tokens", total: 50_000 }, format: {} },
						tools: [
							{
								name: "edit",
								input_schema: { type: "object" },
								strict: true,
								defer_loading: true,
								eager_input_streaming: true,
							},
						],
						anthropic_beta: [BINDING_BETA, CONTEXT_MANAGEMENT_BETA, "custom-beta-2026-01-01"],
						fallbacks: [
							{
								model: "claude-opus-5",
								thinking: { type: "adaptive", block_binding: {} },
								output_config: { effort: "high", task_budget: {}, format: {} },
							},
						],
						messages: [
							{ role: "user", content: [{ type: "compaction", content: "Earlier summary.", signature: "sig" }] },
							{ role: "user", content: "hi", output_config: { effort: "low", task_budget: {}, format: {} } },
						],
					};
				},
			});
			expect(request.body.thinking).toEqual({ type: "adaptive" });
			expect(request.body.context_management).toBeUndefined();
			expect(request.body).not.toHaveProperty("compaction");
			expect(request.body.output_config).toEqual({ effort: "high" });
			expect(request.body.tools).toEqual([{ name: "edit", input_schema: { type: "object" } }]);
			expect(request.body.fallbacks).toEqual([
				{ model: "claude-opus-5", thinking: { type: "adaptive" }, output_config: { effort: "high" } },
			]);
			expect(request.body).toHaveProperty("anthropic_beta", ["custom-beta-2026-01-01"]);
			expect(request.body.messages).toEqual([
				{ role: "user", content: [{ type: "text", text: "Earlier summary." }] },
				{ role: "user", content: "hi", output_config: { effort: "low" } },
			]);
			expect(request.beta).not.toContain(BINDING_BETA);
			expect(request.beta).not.toContain("compact-2026-09-04");
		});
	});

	it("leaves non-Anthropic providers' context_management intact (#3288)", async () => {
		const zai = buildModel({
			id: "glm-4.6",
			name: "GLM 4.6",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 128_000,
		});
		await withEnv({ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const request = await captureRequest(zai);
			expect(request.body.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
			expect(request.beta).toContain(CONTEXT_MANAGEMENT_BETA);
		});
	});

	it("replays a legacy encrypted compaction summary as text, without its context_management edit", async () => {
		const fable = anthropicModel("claude-fable-5");
		const summary = "## Goal\nAudit the handlers.";
		const messages: Context["messages"] = [
			{
				role: "user",
				content: `<summary>${summary}</summary>`,
				providerPayload: {
					type: "anthropicCompaction",
					provider: "anthropic",
					content: summary,
					exactTail: true,
					encryptedContent: "enc_opaque_legacy",
				},
				timestamp: 1,
			},
			{ role: "user", content: "next", timestamp: 2 },
		];
		await withEnv(
			{
				CLAUDE_CODE_USE_FOUNDRY: undefined,
				ANTHROPIC_BASE_URL: undefined,
				CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
			},
			async () => {
				const request = await captureRequest(fable, {}, messages);
				expect(request.body.context_management).toBeUndefined();
				expect(request.beta).not.toContain("compact-2026-01-12");
				expect(JSON.stringify(request.body.messages)).not.toContain("enc_opaque_legacy");
				expect(JSON.stringify(request.body.messages)).toContain("<summary>");
			},
		);
	});

	it("honors explicit compat overrides without granting the switch to arbitrary providers", async () => {
		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			for (const [provider, admitted] of [
				["anthropic", false],
				["private-gateway", true],
				["private-gateway", false],
			] as const) {
				const model = buildModel({
					...anthropicModel(),
					provider,
					baseUrl: "https://private-gateway.example.com",
					compat: { honorsClaudeCodeBetaKillSwitch: admitted },
				});
				const request = await captureRequest(model);
				expect(request.body.context_management !== undefined).toBe(!admitted);
				expect(request.beta.includes(CONTEXT_MANAGEMENT_BETA)).toBe(!admitted);
			}
		});
	});

	it("strips mixed-case caller beta headers on OAuth override routes without changing authentication", async () => {
		await withEnv({ ...GATEWAY_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			const model = anthropicModel();
			model.compat.allowAnthropicHeaderOverrides = true;
			model.headers = { "AnThRoPiC-BeTa": `${BINDING_BETA},custom-beta-2026-01-01` };
			const apiKey = `sk-ant-${"oat01"}-synthetic`;
			const request = await captureRequest(model, {
				apiKey,
				headers: { "ANTHROPIC-BETA": `${CONTEXT_MANAGEMENT_BETA},custom-beta-2026-01-01` },
			});
			expect(request.beta).toBe("custom-beta-2026-01-01");
			expect(request.body.thinking?.type).toBe("adaptive");
			expect(request.authorization).toBe(`Bearer ${apiKey}`);
		});
	});

	it("does not retry a frozen beta request after server tools have already run", async () => {
		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			let requests = 0;
			const result = await streamAnthropic(
				anthropicModel(),
				{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
				{
					apiKey: "sk-ant-api-test",
					fallbackCreditRedemption: {
						token: "fct_synthetic",
						params: {
							model: "claude-fable-5",
							messages: [{ role: "user", content: "hi" }],
							stream: true,
							output_config: { task_budget: { type: "tokens", total: 10 } },
						},
						refusedContent: [
							{
								type: "anthropicServerTool",
								block: { type: "server_tool_use", id: "srv_1", name: "web_search", input: {} },
							},
						],
						expiresAt: Date.now() + 60_000,
					},
					fetch: async () => {
						requests++;
						throw new Error("must not issue a request");
					},
				},
			).result();
			expect(requests).toBe(0);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("ran server tools");
		});
	});

	it("strips caller headers on explicitly opted-in Copilot routes without opting in ordinary Copilot models", async () => {
		await withEnv({ ...OFFICIAL_ENV, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" }, async () => {
			for (const admitted of [false, true]) {
				const model = buildModel({
					...anthropicModel(),
					provider: "github-copilot",
					baseUrl: "https://copilot-gateway.example.com",
					compat: { honorsClaudeCodeBetaKillSwitch: admitted },
				});
				const apiKey = "synthetic-copilot-key";
				const request = await captureRequest(model, {
					apiKey,
					headers: { "AnThRoPiC-BeTa": `${BINDING_BETA},${CONTEXT_MANAGEMENT_BETA},custom-beta-2026-01-01` },
				});
				expect(request.beta.includes(BINDING_BETA)).toBe(!admitted);
				expect(request.beta.includes(CONTEXT_MANAGEMENT_BETA)).toBe(!admitted);
				expect(request.beta).toContain("custom-beta-2026-01-01");
				expect(request.authorization).toBe(`Bearer ${apiKey}`);
			}
		});
	});
});
