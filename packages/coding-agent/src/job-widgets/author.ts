/**
 * The cheap-model side of job widgets: one toolless request to the `widget`
 * role (aliasing `smol`) with a forced `respond` call carrying the spec
 * schema, fed the job's brief and redacted output samples.
 */
import { type AgentTelemetryConfig, instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, SimpleStreamOptions, Tool, ToolChoice, UserMessage } from "@oh-my-pi/pi-ai";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { formatBytes, prompt, truncate } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleChain, roleCandidatePool } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import systemPrompt from "../prompts/system/job-widget-system.md" with { type: "text" };
import userPrompt from "../prompts/system/job-widget-user.md" with { type: "text" };
import { CREDENTIAL_PATTERNS } from "../secrets/patterns";
import type { JobWidgetSourceSample } from "./runtime";
import { JOB_WIDGET_SPEC_SCHEMA, type JobWidgetSpec } from "./spec";
import type { JobWidgetBrief } from "./types";

/** What the author is asked to write a spec for. */
export interface JobWidgetAuthorRequest {
	jobId: string;
	canAuthor?: () => boolean;
	brief: JobWidgetBrief;
	/** Per source: first and last lines, most active first; raw (the author redacts). */
	sources: readonly JobWidgetSourceSample[];
	/** Re-authoring: the spec in place and why it is being replaced (`no rule matched the last 200 lines`). */
	previous?: { spec: JobWidgetSpec; reason: string };
	/** Retry: the rejected answer and what was wrong with it. */
	rejected?: { answer: string; errors: string[] };
}

/**
 * Writes one candidate spec (unvalidated; the registry validates and retries
 * once). Resolves `undefined` when the model is unavailable or admission is
 * denied. Identity/settings changes invalidate the registry before re-admission.
 */
export type JobWidgetAuthor = (request: JobWidgetAuthorRequest, signal: AbortSignal) => Promise<unknown>;

const RESPOND_TOOL = "respond";
const MAX_BRIEF_CHARS = 1500;
const MAX_SAMPLE_LINE_BYTES = 300;
const MAX_SAMPLE_BYTES = 12 * 1024;
const MAX_PROMPT_BYTES = 32 * 1024;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_PROMPT_SOURCES = 16;
const MAX_SOURCE_METADATA_CHARS = 160;
const MAX_REJECTION_ERRORS = 12;
/** Lines of one shape (same text but for its digits and spacing) the head, and the tail, of a source keep. */
const MAX_SHAPE_REPEATS = 3;
/** Output cap of a spec request: the largest valid spec stays well under it, a runaway answer does not. */
const MAX_SPEC_TOKENS = 3000;

const CREDENTIAL_REGEXES = CREDENTIAL_PATTERNS.map(pattern => ({
	name: pattern.name,
	regex: new RegExp(pattern.source, `g${pattern.flags ?? ""}`),
}));

/**
 * Text bound for the author model with secrets removed: the session's secret
 * obfuscator when it has secrets, then the built-in credential shapes
 * (`[GitHubToken redacted]`), which apply even with secret handling off.
 */
export function redactWidgetSample(text: string, obfuscate?: (text: string) => string): string {
	let out = obfuscate ? obfuscate(text) : text;
	for (const { name, regex } of CREDENTIAL_REGEXES) {
		regex.lastIndex = 0;
		if (regex.test(out)) out = out.replace(regex, `[${name} redacted]`);
	}
	return out;
}

function boundBytes(text: string, limit: number): string {
	if (Buffer.byteLength(text) <= limit) return text;
	let low = 0;
	let high = Math.min(text.length, limit);
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, mid)) <= limit) low = mid;
		else high = mid - 1;
	}
	if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low -= 1;
	return text.slice(0, low);
}

/** Template context of `job-widget-user.md`. */
interface PromptSource {
	id: string;
	label: string;
	size: string;
	lines: number;
	omitted: number;
	head: string[];
	tail: string[];
}

/**
 * Sample lines for the prompt: each line redacted and cut at 300 UTF-8 bytes, the
 * first lines then the last per source, most active source first, ≤ 12 KB in
 * total with every source getting a fair share of what is left. The head and
 * the tail each keep at most three lines of one shape (a progress line
 * repeating with new numbers), so a busy source shows its distinct lines
 * rather than one line many times. Lines that would open or close the
 * prompt's code fence are left out.
 */
export function buildPromptSources(
	sources: readonly JobWidgetSourceSample[],
	redact: (text: string) => string,
): PromptSource[] {
	let budget = MAX_SAMPLE_BYTES;
	const selected = sources.slice(0, MAX_PROMPT_SOURCES);
	return selected.map((source, index) => {
		const share = Math.floor(budget / (selected.length - index));
		const take = (lines: readonly string[], limit: number): string[] => {
			const out: string[] = [];
			const shapes = new Map<string, number>();
			let used = 0;
			for (const line of lines) {
				const trimmed = line.trimStart();
				if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) continue;
				const shape = trimmed.replace(/\d+/g, "0").replace(/\s+/g, " ");
				const repeats = shapes.get(shape) ?? 0;
				if (repeats >= MAX_SHAPE_REPEATS) continue;
				shapes.set(shape, repeats + 1);
				const sample = boundBytes(redact(line), MAX_SAMPLE_LINE_BYTES);
				const bytes = Buffer.byteLength(sample) + 1;
				if (used + bytes > limit) break;
				used += bytes;
				out.push(sample);
			}
			budget -= used;
			return out;
		};
		// The newest lines show what the job prints now (and what drifted); they get two thirds of the
		// share first, newest backwards, and the first lines get what is left.
		const tail = take(
			source.tail.slice().reverse(),
			source.head.length > 0 ? Math.floor((share * 2) / 3) : share,
		).reverse();
		const tailBytes = tail.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
		const head = take(source.head, share - tailBytes);
		return {
			id: truncate(redact(source.id), MAX_SOURCE_METADATA_CHARS),
			label: truncate(redact(source.label), MAX_SOURCE_METADATA_CHARS),
			size: formatBytes(source.size),
			lines: source.lines,
			omitted: Math.max(0, source.lines - head.length - tail.length),
			head,
			tail,
		};
	});
}

/** The `job-widget-user.md` prompt for a request. */
export function renderJobWidgetPrompt(request: JobWidgetAuthorRequest, redact: (text: string) => string): string {
	const { brief } = request;
	const excerpt = (text: string | undefined): string | undefined =>
		text?.trim() ? truncate(redact(text.trim()), MAX_BRIEF_CHARS) : undefined;
	const rendered = prompt.render(userPrompt, {
		command: excerpt(brief.command),
		task: excerpt(brief.task),
		intent: excerpt(brief.intent),
		watch: excerpt(brief.watch),
		stage: excerpt(brief.stage),
		sources: buildPromptSources(request.sources, redact),
		previous: request.previous && {
			reason: excerpt(request.previous.reason),
			spec: boundBytes(redact(JSON.stringify(request.previous.spec)), 6000),
		},
		rejected: request.rejected && {
			answer: boundBytes(redact(request.rejected.answer), 4000),
			errors: request.rejected.errors.slice(0, MAX_REJECTION_ERRORS).map(error => excerpt(error)),
		},
	});
	return boundBytes(redact(rendered), MAX_PROMPT_BYTES);
}

export interface JobWidgetAuthorAdmission {
	sessionId: string | undefined;
	apiKey: SimpleStreamOptions["apiKey"];
	signal?: AbortSignal;
	isCurrent(): boolean;
	admit(): void;
	onUsage(message: AssistantMessage, prompt: string): void;
}

export interface ModelJobWidgetAuthorOptions {
	settings: Settings;
	modelRegistry: ModelRegistry;
	/** Managed consent and provider/model/credit admission, before credential resolution. */
	admit?: (
		model: Model<Api>,
		signal: AbortSignal,
		request: JobWidgetAuthorRequest,
	) => Promise<JobWidgetAuthorAdmission | undefined>;
	isEnabled?: () => boolean;
	telemetry?: () => AgentTelemetryConfig | undefined;
	/** The session's secret obfuscation, when secret handling is on. */
	obfuscate?: () => ((text: string) => string) | undefined;
}

/** One admitted `widget`-role operation owned by a running job. */
export interface WidgetRequest {
	systemPrompt: string;
	/** The user turn: the job's own text, which never repeats across requests. */
	prompt: string;
	tools?: Tool[];
	maxTokens: number;
	toolChoice?: ToolChoice;
	oneshotKind: string;
	owner: JobWidgetAuthorRequest;
}

/** Every fallback candidate requires a fresh lease from the owning session. */
export async function completeWidgetRequest(
	options: ModelJobWidgetAuthorOptions,
	request: WidgetRequest,
	signal: AbortSignal,
): Promise<AssistantMessage | undefined> {
	signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
	const canAuthor = (): boolean =>
		!signal.aborted && options.isEnabled?.() !== false && request.owner.canAuthor?.() === true;
	if (!options.admit || !canAuthor()) return undefined;
	const { settings, modelRegistry } = options;
	let failure: AssistantMessage | undefined;
	const content = { type: "text" as const, text: request.prompt };
	const message: UserMessage = {
		role: "user",
		content: [content],
		timestamp: Date.now(),
	};
	// The system prompt and tools are the reusable prefix (cached by the provider). The job's text
	// never repeats, so a cache breakpoint on it would only bill a cache write.
	markPerCallContextMessage(message);
	const context = { systemPrompt: [request.systemPrompt], messages: [message], tools: request.tools };
	const bytes = Buffer.byteLength(JSON.stringify(context));
	if (bytes > MAX_PAYLOAD_BYTES) {
		const text = content.text;
		const budget = MAX_PAYLOAD_BYTES - bytes + Buffer.byteLength(JSON.stringify(text));
		if (budget < 2) throw new Error("Widget author context exceeds the outbound limit");
		let low = 0;
		let high = text.length;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (Buffer.byteLength(JSON.stringify(text.slice(0, mid))) <= budget) low = mid;
			else high = mid - 1;
		}
		if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
		content.text = text.slice(0, low);
	}
	for (const { model } of resolveRoleChain("widget", settings, roleCandidatePool("widget", settings, modelRegistry))) {
		if (!canAuthor()) return undefined;
		const lease = await options.admit(model, signal, request.owner);
		if (!lease) continue;
		const requestSignal = lease.signal ? AbortSignal.any([signal, lease.signal]) : signal;
		const current = (): boolean => !requestSignal.aborted && canAuthor() && lease.isCurrent();
		if (!current()) return undefined;
		const streamOptions: SimpleStreamOptions & { onAttempt(message: AssistantMessage): void } = {
			apiKey: lease.apiKey,
			sessionId: lease.sessionId,
			signal: requestSignal,
			onPayload: (_payload, _model, activeSignal) => {
				(activeSignal ?? requestSignal).throwIfAborted();
				if (!current()) throw new Error("Widget request owner changed before dispatch");
				lease.admit();
			},
			onAttempt: message => lease.onUsage(message, content.text),
			disableReasoning: true,
			maxTokens: request.maxTokens,
			toolChoice: request.toolChoice,
		};
		const response = await instrumentedCompleteSimple(model, context, streamOptions, {
			telemetry: resolveTelemetry(options.telemetry?.(), lease.sessionId),
			oneshotKind: request.oneshotKind,
		});
		if (!current()) return undefined;
		if (response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? `${request.oneshotKind} request aborted`);
		}
		if (response.stopReason !== "error") return response;
		failure = response;
	}
	if (failure) throw new Error(failure.errorMessage ?? `${request.oneshotKind} request failed`);
	return undefined;
}

/** A {@link JobWidgetAuthor} backed by the `widget` model role. */
export function createModelJobWidgetAuthor(options: ModelJobWidgetAuthorOptions): JobWidgetAuthor {
	return async (request, signal) => {
		const obfuscate = options.obfuscate?.();
		const redact = (text: string): string => redactWidgetSample(text, obfuscate);
		const response = await completeWidgetRequest(
			options,
			{
				systemPrompt,
				prompt: renderJobWidgetPrompt(request, redact),
				tools: [
					{
						name: RESPOND_TOOL,
						description: "Install the widget spec for this job.",
						parameters: JOB_WIDGET_SPEC_SCHEMA,
						strict: false,
					},
				],
				maxTokens: MAX_SPEC_TOKENS,
				toolChoice: { type: "tool", name: RESPOND_TOOL },
				oneshotKind: "job_widget",
				owner: request,
			},
			signal,
		);
		if (!response) return undefined;
		const call = extractToolCall(response, RESPOND_TOOL);
		if (call) return call.arguments;
		const text = extractTextContent(response);
		if (!text) throw new Error("widget spec request returned nothing");
		return parseJsonPayload(text);
	};
}
