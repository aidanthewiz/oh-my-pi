import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { sendsImageInputOnWire } from "@oh-my-pi/pi-ai/providers/vision-guard";
import { type Api, type AssistantMessage, completeSimple, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	getAllowedAvailableModels,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import imageQuestionSystemPromptTemplate from "../prompts/tools/image-question-system.md" with { type: "text" };
import { completionRecord } from "../session/model-usage-journal";
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import type { ToolSession } from "../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { LoadedImageInput } from "./image-loading";

import { cfgImagesBlockImages } from "../modes/settings";
import { cfgImagesQuestionTimeoutMs } from "../tools/settings";

/** Vision-capable model selected for an explicit image question. */
export interface ResolvedImageQuestionModel {
	model: Model<Api>;
	selectedPattern: string | undefined;
}

/** Text and accounting returned by one explicit image question. */
export interface ImageQuestionResult {
	text: string;
	model: string;
	usage: Usage;
}

/** Resolve the vision model used by `read <image>?q=<question>`. */
export function resolveImageQuestionModel(session: ToolSession): ResolvedImageQuestionModel {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new ToolError("Model registry is unavailable for image questions.");
	}

	const availableModels = getAllowedAvailableModels(modelRegistry, session.settings);
	if (availableModels.length === 0) {
		throw new ToolError("No models available for image questions.");
	}

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, availableModels, matchPreferences);
	};

	const activeModelPattern = session.getActiveModelString?.() ?? session.getModelString?.();
	let model: Model<Api> | undefined;
	let selectedPattern: string | undefined;
	for (const pattern of ["@vision", "@default", activeModelPattern]) {
		const resolved = resolvePattern(pattern);
		if (resolved && sendsImageInputOnWire(resolved)) {
			model = resolved;
			selectedPattern = pattern;
			break;
		}
	}

	const activeProvider = resolvePattern(activeModelPattern)?.provider;
	model ??= availableModels.find(
		candidate => candidate.provider === activeProvider && sendsImageInputOnWire(candidate),
	);
	model ??= availableModels.find(candidate => sendsImageInputOnWire(candidate));
	if (!model) {
		const textOnly = resolvePattern("@vision") ?? resolvePattern("@default") ?? resolvePattern(activeModelPattern);
		if (!textOnly) throw new ToolError("Unable to resolve a model for image questions.");
		throw new ToolError(
			`Resolved model ${textOnly.provider}/${textOnly.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
		);
	}

	return { model, selectedPattern };
}

/** Ask the resolved vision model a question about an already-loaded image. */
export async function askImageQuestion(
	session: ToolSession,
	resolved: ResolvedImageQuestionModel,
	image: LoadedImageInput,
	question: string,
	signal: AbortSignal | undefined,
	completeImpl: typeof completeSimple = completeSimple,
): Promise<ImageQuestionResult> {
	if (cfgImagesBlockImages.get(session.settings)) {
		throw new ToolError(
			"Image submission is disabled by settings (images.blockImages=true). Disable it to ask about images.",
		);
	}

	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new ToolError("Model registry is unavailable for image questions.");
	}
	const availableModels = getAllowedAvailableModels(modelRegistry, session.settings);
	if (availableModels.length === 0) {
		throw new ToolError("No models available for image questions.");
	}

	const { model, selectedPattern } = resolved;
	const sessionId = session.getSessionId?.() ?? undefined;
	const credentialSessionId = session.getCredentialSourceSessionId?.() ?? sessionId;
	const isCurrent = session.captureOwnerCurrent?.() ?? (() => session.isDisposed?.() !== true);
	const costGate = session.costGate;
	const manager = session.sessionManager;
	const usageOwner =
		manager?.getSessionId && manager.getLeafId
			? { sessionId: manager.getSessionId(), parentId: manager.getLeafId() }
			: undefined;
	const telemetry = resolveTelemetry(session.getTelemetry?.(), sessionId);
	const timeoutMs = cfgImagesQuestionTimeoutMs.get(session.settings);
	const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
	const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
	const effectiveSignal = timeoutSignal ? (signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal) : signal;
	const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
	const formatTimeoutMessage = (): string => {
		const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
		return `Image question timed out after ${seconds}s. Increase images.questionTimeoutMs (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`;
	};
	const assertCurrent = (): void => {
		effectiveSignal?.throwIfAborted();
		if (!isCurrent()) throw new ToolError("Image question owner is no longer current.");
	};
	assertCurrent();
	costGate?.admit();

	const configuredThinking = concreteThinkingLevel(
		extractExplicitThinkingSelector(selectedPattern, session.settings, {
			isLiteralModelId: (provider, id) => {
				if (provider !== undefined) {
					return availableModels.some(candidate => candidate.provider === provider && candidate.id === id);
				}
				const lowerId = id.toLowerCase();
				return availableModels.some(candidate => candidate.id.toLowerCase() === lowerId);
			},
		}),
	);
	const reasoning = toReasoningEffort(resolveThinkingLevelForModel(model, configuredThinking));

	const streamOptions = session.prepareSimpleStreamOptions?.(
		{ signal: effectiveSignal, reasoning },
		model.provider,
	) ?? {
		signal: effectiveSignal,
		reasoning,
	};
	const resolveCredential = modelRegistry.resolver(model, credentialSessionId);
	let response: AssistantMessage;
	try {
		const apiKey = await modelRegistry.getApiKey(model, credentialSessionId, { signal: effectiveSignal });
		assertCurrent();
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}
		response = await instrumentedCompleteSimple(
			model,
			{
				systemPrompt: [prompt.render(imageQuestionSystemPromptTemplate)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: image.data, mimeType: image.mimeType },
							{ type: "text", text: question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				...streamOptions,
				apiKey: async context => {
					assertCurrent();
					const credential = await resolveCredential(context);
					assertCurrent();
					return credential;
				},
				onPayload: async (payload, requestModel, requestSignal) => {
					assertCurrent();
					requestSignal?.throwIfAborted();
					const replacement = await streamOptions.onPayload?.(payload, requestModel, requestSignal);
					assertCurrent();
					requestSignal?.throwIfAborted();
					costGate?.admit();
					return replacement ?? payload;
				},
				onResponse: async (response, requestModel, requestSignal) => {
					if (!effectiveSignal?.aborted && isCurrent()) {
						await streamOptions.onResponse?.(response, requestModel, requestSignal);
					}
				},
				onSseEvent: (event, requestModel) => {
					if (!effectiveSignal?.aborted && isCurrent()) streamOptions.onSseEvent?.(event, requestModel);
				},
			},
			{ telemetry, oneshotKind: "image_question", completeImpl },
		);
		costGate?.record(response.usage.cost.total);
		if (usageOwner) {
			manager?.appendModelUsage?.(
				{
					purpose: "image-question",
					api: response.api,
					provider: response.provider,
					model: response.model,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: response.errorMessage,
					completion: completionRecord(question, response),
				},
				usageOwner,
			);
		}
		assertCurrent();
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
		}
		throw error;
	}

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "Image question request failed.");
	}
	if (response.stopReason === "aborted") {
		if (timedOut()) throw new ToolError(formatTimeoutMessage());
		throw new ToolError("Image question request aborted.");
	}

	const text = extractTextContent(response);
	if (!text) {
		throw new ToolError("Vision model returned no text output.");
	}

	return {
		text,
		model: `${model.provider}/${model.id}`,
		usage: response.usage,
	};
}
