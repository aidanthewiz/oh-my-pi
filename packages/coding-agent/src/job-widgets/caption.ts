/**
 * Job captions: one plain-English line saying what a background command does
 * and when it ends, for people reading the jobs sheet. The `widget` role's
 * model writes it once per job, from the command and the intent it was
 * started with; it never sees the job's output.
 */
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, SimpleStreamOptions, UserMessage } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { shortenEmbeddedPaths } from "@oh-my-pi/pi-tui/render/render-utils";
import { prompt, sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import systemPrompt from "../prompts/system/job-caption-system.md" with { type: "text" };
import userPrompt from "../prompts/system/job-caption-user.md" with { type: "text" };
import { type ModelJobWidgetAuthorOptions, redactWidgetSample, resolveWidgetModel } from "./author";
import type { JobWidgetBrief } from "./types";

/**
 * Writes the caption of a command's job from its brief (command, intent,
 * timeout); resolves the raw reply, which the registry normalizes with
 * {@link normalizeJobCaption}, or `undefined` when no model can write one.
 */
export type JobCaptionWriter = (
	brief: JobWidgetBrief & { command: string; jobId?: string; canAuthor?: () => boolean },
	signal: AbortSignal,
) => Promise<string | undefined>;

/** Longest command a reader takes in at a glance; anything with shell control flow is never one. */
const GLANCEABLE_COMMAND_CHARS = 60;
/** Command text sent to the model; past this the head says enough. */
const MAX_COMMAND_CHARS = 4000;
const MAX_INTENT_CHARS = 300;
/** A one-line reply needs a few dozen tokens; the cap only stops a runaway answer. */
const MAX_CAPTION_TOKENS = 120;
const MAX_CAPTION_CHARS = 200;

/**
 * Whether a command needs explaining: one longer than a glance or using
 * shell control flow (`;`, pipes, `&`, substitutions, several lines).
 * Redirections like `2>&1` and quoted text are not control flow; a
 * double-quoted span that substitutes still is.
 */
export function needsJobCaption(command: string): boolean {
	const trimmed = command.trim();
	if (trimmed.length > GLANCEABLE_COMMAND_CHARS) return true;
	const unquoted = trimmed.replace(/'[^']*'|"(?:[^"\\$`]|\\.)*"|\d*>&\d*|&>/g, "");
	return /[\n;|&`]|\$\(/.test(unquoted);
}

/** The caption in a model reply: its first non-empty line as plain text with home paths shortened, unquoted, without list markers or a final period. */
export function normalizeJobCaption(reply: string): string | undefined {
	const line = reply
		.split("\n")
		.map(text => text.trim())
		.find(text => text.length > 0);
	if (!line) return undefined;
	const caption = sanitizeText(line)
		.replace(/^(?:[-*•]\s+|caption:\s*)/i, "")
		.replace(/^["'`“”]+|["'`“”]+$/g, "")
		.replace(/\s+/g, " ")
		.replace(/\.$/, "")
		.trim();
	return caption ? truncate(shortenEmbeddedPaths(caption), MAX_CAPTION_CHARS) : undefined;
}

/** A {@link JobCaptionWriter} backed by the `widget` model role. */
export function createModelJobCaptionWriter(options: ModelJobWidgetAuthorOptions): JobCaptionWriter {
	return async (brief, signal) => {
		signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
		if (!options.admit || signal.aborted || options.isEnabled?.() === false || brief.canAuthor?.() !== true)
			return undefined;
		const { command, intent, timeoutSec } = brief;
		const model = resolveWidgetModel(options.settings, options.modelRegistry);
		if (!model) return undefined;
		const lease = await options.admit(model, signal, {
			jobId: brief.jobId ?? "",
			canAuthor: brief.canAuthor,
			brief,
			sources: [],
		});
		if (!lease) return undefined;
		const requestSignal = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
		const current = (): boolean =>
			!requestSignal.aborted && options.isEnabled?.() !== false && brief.canAuthor?.() === true && lease.isCurrent();
		if (!current()) return undefined;
		const obfuscate = options.obfuscate?.();
		const telemetry = options.telemetry?.();
		const redact = (text: string): string => redactWidgetSample(text, obfuscate);
		const message: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: prompt.render(userPrompt, {
						intent: intent ? truncate(redact(intent), MAX_INTENT_CHARS) : undefined,
						command: truncate(redact(command.trim()), MAX_COMMAND_CHARS),
						timeoutSec,
					}),
				},
			],
			timestamp: Date.now(),
		};
		// The system prompt is the reusable prefix; the command never repeats.
		markPerCallContextMessage(message);
		const streamOptions: SimpleStreamOptions & { onAttempt(message: AssistantMessage): void } = {
			apiKey: lease.apiKey,
			signal: requestSignal,
			onPayload: (_payload, _model, signal) => {
				(signal ?? requestSignal).throwIfAborted();
				lease.admit();
			},
			onAttempt: lease.onUsage,
			disableReasoning: true,
			maxTokens: MAX_CAPTION_TOKENS,
		};
		const response = await instrumentedCompleteSimple(
			model,
			{ systemPrompt: [systemPrompt], messages: [message] },
			streamOptions,
			{ telemetry: resolveTelemetry(telemetry, lease.sessionId), oneshotKind: "job_caption" },
		);
		if (!current()) return undefined;
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `job caption request ${response.stopReason}`);
		}
		return extractTextContent(response);
	};
}
