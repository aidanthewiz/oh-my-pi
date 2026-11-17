/**
 * Ask Tool - the model asks the user to fill in one HTML `<form>`.
 *
 * Hosts with a form surface render the form whole. Rich choice hosts retain
 * answer attachments; other hosts walk the named fields through prompts.
 * A timed-out form is incomplete and never grants approval.
 */

import { type as arkType } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { rasterizeSvg } from "@oh-my-pi/pi-natives";
import { loadFormImage, MAX_FORM_IMAGE_BYTES, type FormMedia } from "@oh-my-pi/pi-tui/html-form/media";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { formatKeyHint } from "@oh-my-pi/pi-tui/app-keybindings";
import { editorKey, editorKeys } from "@oh-my-pi/pi-tui/chrome/keybinding-hints";
import {
	choiceValue,
	fieldContexts,
	fieldQuestions,
	fieldError,
	formAnswers,
	type HtmlFormData,
	type OptionNote,
	OTHER_LABEL,
	textValue,
} from "@oh-my-pi/pi-tui/html-form/data";
import {
	type ChoiceField,
	type HtmlForm,
	parseHtmlForm,
	spansText,
	type TextField,
} from "@oh-my-pi/pi-tui/html-form/parse";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import type { AskToolDetails } from "@oh-my-pi/pi-tui/tools/ask";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isRecord, logger, parseImageMetadata, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionUISelectItem } from "../extensibility/extensions";
import { askTimeoutMs, cfgAskNotify } from "../modes/settings";
import askDescription from "../prompts/tools/ask.md" with { type: "text" };
import { callRegisteredTool } from "../eval/js/session-tool";
import askHeadlessForkMessage from "../prompts/tools/ask-headless-fork.md" with { type: "text" };
import askResultTemplate from "../prompts/tools/ask-result.md" with { type: "text" };
import { shiftImageMarkers } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { renderAttachmentSourceNotice } from "../session/attachment-source-notice";
import { cfgSpeechEnabled } from "../tts/settings";
import { vocalizer } from "../tts/vocalizer";
import { shouldDescribeImagesForTextModel } from "../utils/image-vision-fallback";
import type { ToolSession } from ".";
import { ToolAbortError } from "./tool-errors";

/** Returned to a headless fork's model instead of aborting its run. */
const HEADLESS_FORK_ASK_ERROR = prompt.render(askHeadlessForkMessage);

const NO_NAMED_CONTROLS_ERROR =
	"Error: the form has no named controls. Put at least one <input>, <select> or <textarea> with a `name` attribute inside the <form>.";

// Window after the timeout deadline within which an `undefined` answer is
// attributed to a UI-enforced timeout (for surfaces that close the dialog at
// the deadline but never invoke `onTimeout`). Cancels beyond it are user Esc.
const TIMEOUT_DETECTION_TOLERANCE_MS = 1_000;
/** Largest edge rasterized from approved SVG bytes before the form sees a PNG. */
const MAX_FORM_SVG_EDGE_PX = 2048;

const askSchema = arkType({
	html: arkType("string").describe("one HTML <form>"),
});

export type AskParams = typeof askSchema.infer;

/** The `html` of a persisted or streamed `ask` call, for `/tree` re-answer and status lines. */
export function recoverAskHtml(toolCallArguments: unknown): string | undefined {
	if (!isRecord(toolCallArguments)) return undefined;
	const html = toolCallArguments.html;
	return typeof html === "string" ? html : undefined;
}

// =============================================================================
// Field-by-field fallback
// =============================================================================

/** The dialog primitives the fallback walks a form with. */
type FallbackUI = Pick<ExtensionUIContext, "select" | "input" | "editor" | "timeoutStartsOnPresentation">;

/** One prompt's outcome: the answer, or undefined with `timedOut` telling a deadline from a cancel. */
interface PromptOutcome<T> {
	value: T | undefined;
	timedOut: boolean;
}

/** A choice field's answer: its checked option indices and, when the user chose "Other", that text. */
interface ChoiceAnswer {
	checked: Set<number>;
	other?: string;
}

/** One field's prompt text: its question and the form text around it ({@link fieldContexts}). */
interface FieldText {
	question: string;
	context: string;
}

/** Title of a field's prompt: the form context, then `line` (the question, maybe annotated). */
function promptTitle(text: FieldText, line: string): string {
	return text.context ? `${text.context}\n\n${line}` : line;
}

/** Row a radio or checkbox group's free-text "Other" answer takes in the fallback select. */
const OTHER_ROW = `${OTHER_LABEL} (type your own)`;

/**
 * Show one deadline-bound prompt. Surfaces that run the countdown report it via
 * `onTimeout`/`onTimeoutStart`/`onTimeoutReset`; for the rest a local timer
 * aborts the prompt at the deadline.
 */
async function promptWithTimeout<T>(
	ui: FallbackUI,
	timeout: number | undefined,
	signal: AbortSignal,
	show: (dialogOptions: ExtensionUIDialogOptions) => Promise<T | undefined>,
): Promise<PromptOutcome<T>> {
	let timedOut = false;
	const timeoutController = timeout === undefined ? undefined : new AbortController();
	const dialogSignal = timeoutController ? AbortSignal.any([signal, timeoutController.signal]) : signal;
	let timeoutId: NodeJS.Timeout | undefined;
	let timeoutStartedMs = Date.now();
	const armFallbackTimeout = (durationMs: number) => {
		clearTimeout(timeoutId);
		timeoutStartedMs = Date.now();
		timeoutId = setTimeout(() => {
			timedOut = true;
			timeoutController?.abort();
		}, durationMs);
	};
	const dialogOptions: ExtensionUIDialogOptions = {
		timeout,
		signal: dialogSignal,
		onTimeout: () => {
			timedOut = true;
		},
		onTimeoutStart: timeout === undefined ? undefined : () => armFallbackTimeout(timeout),
		onTimeoutReset: timeout === undefined ? undefined : () => armFallbackTimeout(timeout),
	};
	try {
		const value = await untilAborted(dialogSignal, () => {
			const shown = show(dialogOptions);
			if (timeout !== undefined && !ui.timeoutStartsOnPresentation) armFallbackTimeout(timeout);
			return shown;
		});
		if (!timedOut && value === undefined && timeout !== undefined) {
			// Fallback for surfaces that enforce `timeout` without invoking
			// `onTimeout`: their auto-cancel resolves right at the deadline. A
			// cancel arriving well past it is a deliberate user Esc.
			const elapsed = Date.now() - timeoutStartedMs;
			timedOut = elapsed >= timeout && elapsed <= timeout + TIMEOUT_DETECTION_TOLERANCE_MS;
		}
		return { value, timedOut };
	} catch (error) {
		if (timedOut && error instanceof Error && error.name === "AbortError")
			return { value: undefined, timedOut: true };
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Checked option indices for a choice field. Radios and single selects take
 * one pick, opening on the preselected option; checkbox groups, lone
 * checkboxes and multi-selects toggle rows until a Done row. Radio and
 * checkbox groups end with an "Other" row that asks for free text; a blank
 * or cancelled answer returns to the options.
 */
async function askChoice(
	ui: FallbackUI,
	field: ChoiceField,
	text: FieldText,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<ChoiceAnswer>> {
	const { question } = text;
	// The options the user can pick, by index, with one-line labels.
	const options = field.options.flatMap((option, index) =>
		option.disabled ? [] : [{ index, label: spansText(option.label).replace(/\s+/g, " ").trim() || option.value }],
	);
	const labels = disambiguateDisplayLabels(
		options.map(option => option.label),
		[],
	);
	const preselected = new Set(field.options.flatMap((option, index) => (option.checked ? [index] : [])));
	const helpText = `${editorKeys("tui.select.up", "tui.select.down")} navigate  ${formatKeyHint("enter")} select  ${editorKey("tui.select.cancel")} cancel`;
	const otherRow = field.other ? disambiguateDisplayLabels([OTHER_ROW], labels)[0] : undefined;
	const choiceRows = otherRow === undefined ? labels : [...labels, otherRow];

	if (!field.multi) {
		let initialIndex = Math.max(
			0,
			options.findIndex(option => preselected.has(option.index)),
		);
		while (true) {
			const outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.select(promptTitle(text, question), choiceRows, {
					...dialogOptions,
					initialIndex,
					outline: true,
					helpText,
					selectionMarker: "radio",
				}),
			);
			if (outcome.timedOut) return { value: undefined, timedOut: true };
			if (otherRow !== undefined && outcome.value === otherRow) {
				const typed = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
					ui.input(promptTitle(text, question), undefined, dialogOptions),
				);
				if (typed.timedOut) return { value: undefined, timedOut: true };
				initialIndex = labels.length;
				if (!typed.value?.trim()) continue;
				return { value: { checked: new Set(), other: typed.value }, timedOut: false };
			}
			const picked = outcome.value === undefined ? -1 : labels.indexOf(outcome.value);
			const option = options[picked];
			return { value: option ? { checked: new Set([option.index]) } : undefined, timedOut: outcome.timedOut };
		}
	}

	const doneLabel = disambiguateDisplayLabels([`${theme.status.success} Done selecting`], choiceRows)[0]!;
	const checked = new Set(preselected);
	let other: string | undefined;
	let touched = false;
	let cursor = Math.max(
		0,
		options.findIndex(option => checked.has(option.index)),
	);
	while (true) {
		const answered = checked.size + (other === undefined ? 0 : 1);
		const canFinish = !field.required || answered > 0;
		const rows: ExtensionUISelectItem[] = canFinish ? [...choiceRows, doneLabel] : [...choiceRows];
		const checkedIndices = options.flatMap((option, row) => (checked.has(option.index) ? [row] : []));
		if (other !== undefined) checkedIndices.push(labels.length);
		const prefix = answered > 0 ? `(${answered} selected) ` : "";
		const outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
			ui.select(promptTitle(text, `${prefix}${question}`), rows, {
				...dialogOptions,
				initialIndex: cursor,
				outline: true,
				helpText,
				selectionMarker: "checkbox",
				checkedIndices,
				markableCount: choiceRows.length,
			}),
		);
		if (outcome.timedOut) return { value: touched ? { checked, other } : undefined, timedOut: true };
		if (outcome.value === undefined) return { value: undefined, timedOut: false };
		if (outcome.value === doneLabel) return { value: { checked, other }, timedOut: false };
		if (otherRow !== undefined && outcome.value === otherRow) {
			cursor = labels.length;
			if (other !== undefined) {
				other = undefined;
				touched = true;
				continue;
			}
			const typed = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.input(promptTitle(text, question), undefined, dialogOptions),
			);
			if (typed.timedOut) return { value: touched ? { checked } : undefined, timedOut: true };
			// A blank or cancelled answer leaves Other unchecked.
			if (typed.value?.trim()) {
				other = typed.value;
				touched = true;
			}
			continue;
		}
		const row = labels.indexOf(outcome.value);
		const option = options[row];
		if (!option) continue;
		cursor = row;
		touched = true;
		if (checked.has(option.index)) checked.delete(option.index);
		else checked.add(option.index);
	}
}

/**
 * Text for a text field, re-asking with the validation error until it is
 * valid. Textareas and prefilled inputs open the editor on their current
 * value (a re-ask keeps the rejected text); empty inputs prompt with their
 * placeholder.
 */
async function askText(
	ui: FallbackUI,
	field: TextField,
	text: FieldText,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<PromptOutcome<string>> {
	const useEditor = field.multiline || field.value !== "";
	let error: string | undefined;
	let current = field.value;
	while (true) {
		const title = promptTitle(text, error ? `${text.question} (${error})` : text.question);
		let outcome: PromptOutcome<string>;
		if (useEditor) {
			// The editor has no countdown: typing a long answer must not race a deadline.
			const prefill = current;
			const value = await untilAborted(signal, () =>
				ui.editor(title, prefill, { signal }, field.multiline ? undefined : { promptStyle: true }),
			);
			outcome = { value, timedOut: false };
		} else {
			outcome = await promptWithTimeout(ui, timeout, signal, dialogOptions =>
				ui.input(title, field.placeholder || undefined, dialogOptions),
			);
		}
		if (outcome.value === undefined) return outcome;
		error = fieldError(field, outcome.value);
		if (!error) return outcome;
		current = outcome.value;
	}
}

/**
 * Walk the form's named fields in order. A timeout retains explicit answers
 * and leaves untouched fields absent.
 */
async function askFieldByField(
	ui: FallbackUI,
	form: HtmlForm,
	timeout: number | undefined,
	signal: AbortSignal,
): Promise<{ data: HtmlFormData; timedOut: boolean } | undefined> {
	const data: HtmlFormData = Object.fromEntries(form.hidden);
	const questions = fieldQuestions(form);
	const contexts = fieldContexts(form);
	for (const field of form.fields) {
		if (!field.name) continue;
		const text = { question: questions.get(field) ?? field.name, context: contexts.get(field) ?? "" };
		if (field.kind === "choice") {
			const outcome = await askChoice(ui, field, text, timeout, signal);
			if (outcome.value !== undefined) {
				const value = choiceValue(field, outcome.value.checked, outcome.value.other);
				if (value === undefined) delete data[field.name];
				else data[field.name] = value;
			}
			if (outcome.timedOut) return { data, timedOut: true };
			if (outcome.value === undefined) return undefined;
			continue;
		}
		const outcome = await askText(ui, field, text, timeout, signal);
		if (outcome.timedOut) return { data, timedOut: true };
		if (outcome.value === undefined) return undefined;
		data[field.name] = textValue(field, outcome.value);
	}
	return { data, timedOut: false };
}

// =============================================================================
// Tool Class
// =============================================================================

/** Asks the user to fill in one HTML form and returns the submitted form data. */
export class AskTool implements AgentTool<typeof askSchema, AskToolDetails> {
	readonly name = "ask";
	readonly approval = "read" as const;
	readonly label = "Ask";
	readonly summary = "Ask the user to fill in a form";
	readonly parameters = askSchema;
	readonly strict = true;

	// Run alone in its tool batch. The interactive dialog is a single shared UI
	// surface (`ExtensionUiController` has no queue and overwrites the active
	// dialog on each call), so two concurrent `ask` calls would clobber each
	// other: the second steals focus and orphans the first, whose promise then
	// hangs until the user aborts the whole turn.
	readonly concurrency = "exclusive";
	readonly loadMode = "discoverable";

	constructor(private readonly session: ToolSession) {}

	readonly description = prompt.render(askDescription);

	static createIf(session: ToolSession): AskTool | null {
		return (session.canPromptUser ?? session.hasUI) || session.advertiseHeadlessAsk ? new AskTool(session) : null;
	}

	/** Send terminal notification when ask tool is waiting for input */
	#sendAskNotification(): void {
		if (!this.session.hasUI) return;
		const method = cfgAskNotify.get(this.session.settings);
		if (method === "off") return;
		TERMINAL.sendNotification({
			title: "Coreforge",
			body: "Waiting for input",
			type: "ask",
			urgency: "normal",
			actions: "focus",
		});
	}

	/**
	 * Blocks for answer images: each image with its source-path notice and, for a text-only model,
	 * the vision description a pasted prompt image gets (best effort).
	 */
	async #answerImageBlocks(
		images: ImageContent[],
		signal: AbortSignal | undefined,
		isCurrent: () => boolean,
		describeImages: boolean,
	): Promise<Array<TextContent | ImageContent>> {
		signal?.throwIfAborted();
		if (!isCurrent()) throw new ToolAbortError("Ask image answer owner changed");
		if (images.length === 0) return [];
		let descriptions: TextContent[] | undefined;
		const model = this.session.getActiveModel?.();
		const describe = this.session.describeAttachedImages;
		if (describeImages && shouldDescribeImagesForTextModel(model, this.session.settings)) {
			if (!describe) throw new ToolAbortError("Owned image description is unavailable for this session");
			try {
				descriptions = await describe(images, signal, isCurrent);
			} catch (error) {
				logger.warn("ask answer image description failed; image left undescribed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		signal?.throwIfAborted();
		if (!isCurrent()) throw new ToolAbortError("Ask image answer owner changed");
		const blocks: Array<TextContent | ImageContent> = [];
		for (const [index, image] of images.entries()) {
			const notice = renderAttachmentSourceNotice(image, index + 1);
			if (notice) blocks.push({ type: "text", text: notice.content });
			// Keep the source tag: `attachment://N` resolves this result's images to their files.
			blocks.push(image);
			const description = descriptions?.[index];
			if (description) blocks.push(description);
		}
		return blocks;
	}

	async execute(
		_toolCallId: string,
		params: AskParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AskToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AskToolDetails>> {
		const goalRuntime = this.session.getGoalRuntime?.();
		const ownerCurrent = this.session.captureOwnerCurrent?.();
		const goalId = this.session.getGoalModeState?.()?.goal.id;
		const sessionId = this.session.getSessionId?.();
		const model = this.session.getActiveModel?.();
		const isCurrent = () =>
			ownerCurrent?.() !== false &&
			this.session.isDisposed?.() !== true &&
			sessionId === this.session.getSessionId?.() &&
			model === this.session.getActiveModel?.();
		if (signal?.aborted) throw new ToolAbortError("Ask input was cancelled");
		if (!isCurrent()) throw new ToolAbortError("Ask answer owner changed");
		// Headless fallback
		if (!context?.hasUI || !context.ui) {
			// A headless fork (`/tan`) keeps `ask` advertised only to share the parent's
			// prompt-cache prefix. Aborting would end its run with no final answer, and the
			// parent would receive an empty result; let the model put the question there.
			if (this.session.advertiseHeadlessAsk) throw new ToolError(HEADLESS_FORK_ASK_ERROR);
			context?.abort();
			throw new ToolAbortError("Ask tool requires interactive mode");
		}

		const html = params.html;
		const form = parseHtmlForm(html);
		const questions = fieldQuestions(form);
		const named = form.fields.filter(field => field.name);
		if (named.length === 0) {
			return { content: [{ type: "text", text: NO_NAMED_CONTROLS_ERROR }], details: { answers: [] } };
		}

		const extensionUi = context.ui;

		// Determine timeout based on settings and plan mode
		const planModeEnabled = this.session.getPlanModeState?.()?.enabled ?? false;
		const timeout = planModeEnabled ? undefined : askTimeoutMs(this.session.settings);
		// A message the user queues closes the dialog without cancelling the turn: they moved on, and the
		// message reaches the agent at the batch boundary. Peer IRC, asides and finished background jobs are
		// not the user's answer, so the dialog stays open for it.
		const steeringSignal = context.toolCall?.steeringSignal;
		const userSteering = new AbortController();
		const onSteer = () => {
			if (steeringSignal?.reason === "user") userSteering.abort();
		};
		if (steeringSignal?.aborted) onSteer();
		else steeringSignal?.addEventListener("abort", onSteer, { once: true });
		const dialogSignal = signal ? AbortSignal.any([signal, userSteering.signal]) : userSteering.signal;
		const abortError = (): ToolAbortError =>
			new ToolAbortError(userSteering.signal.aborted ? "Ask interrupted by message" : "Ask input was cancelled");
		const checkAnswerCurrent = () => {
			if (dialogSignal.aborted) throw abortError();
			if (!isCurrent()) throw new ToolAbortError("Ask answer owner changed");
		};
		const pauseGoal = () =>
			goalRuntime?.pauseGoal({
				isCurrent: () =>
					goalId !== undefined && isCurrent() && this.session.getGoalModeState?.()?.goal.id === goalId,
			});
		const cancelAsk = async (): Promise<never> => {
			checkAnswerCurrent();
			await pauseGoal();
			checkAnswerCurrent();
			context.abort();
			throw new ToolAbortError("Ask tool was cancelled by the user");
		};

		// Send notification if waiting and not suppressed
		this.#sendAskNotification();

		// Speak the questions aloud before surfacing them. Ask vocalizes in every
		// mode — it's the assistant addressing the user — gated only by speech.enabled
		// (the vocalizer re-checks the setting and no-ops when disabled).
		if (cfgSpeechEnabled.get(this.session.settings)) {
			vocalizer.speak(named.map(field => questions.get(field) ?? field.name).join("\n"));
		}

		let answered: { data: HtmlFormData; notes?: OptionNote[]; timedOut?: boolean } | undefined;
		const answerImages: ImageContent[] = [];
		try {
			const choices = named.filter((field): field is ChoiceField => field.kind === "choice");
			const richCompatible = form.sections.every(section =>
				section.blocks.every(block => block.kind === "text" || block.kind === "field"),
			);
			if (extensionUi.askDialog && choices.length === named.length && richCompatible) {
				const richContext = form.sections
					.flatMap(section => [
						spansText(section.title),
						...section.blocks.flatMap(block => (block.kind === "text" ? [spansText(block.spans)] : [])),
					])
					.filter(Boolean)
					.join("\n\n");
				const richQuestions = choices.map((field, index) => {
					const options = field.options.filter(option => !option.disabled);
					const labels = disambiguateDisplayLabels(
						options.map(option => spansText(option.label)),
						[],
					);
					const recommended = options.findIndex(option => option.checked);
					return {
						id: field.name,
						question: [
							...new Set([
								...(index === 0 && richContext ? [richContext] : []),
								questions.get(field) ?? field.name,
							]),
						].join("\n\n"),
						options: labels.map(label => ({ label })),
						multi: field.multi,
						...(recommended >= 0 ? { recommended } : {}),
					};
				});
				const rich = await untilAborted(dialogSignal, () =>
					extensionUi.askDialog!(richQuestions, { timeout, signal: dialogSignal, acceptImages: true }),
				);
				checkAnswerCurrent();
				if (!rich) return await cancelAsk();
				if (rich.kind === "chat") {
					await pauseGoal();
					checkAnswerCurrent();
					return {
						content: [
							{ type: "text", text: "User chose to discuss the question instead of submitting the form." },
						],
						details: { answers: [] },
					};
				}
				if (rich.results.length !== choices.length)
					throw new ToolError("Ask dialog returned an invalid result count");
				const data: HtmlFormData = Object.fromEntries(form.hidden);
				const notes: OptionNote[] = [];
				let timedOut = false;
				for (const [index, field] of choices.entries()) {
					const result = rich.results[index];
					const question = richQuestions[index]!;
					if (!result || result.id !== field.name)
						throw new ToolError("Ask dialog returned an invalid field order");
					if (!field.multi && result.selectedOptions.length > 1)
						throw new ToolError("Ask dialog returned multiple answers for a single-choice field");
					const options = field.options.flatMap((option, optionIndex) =>
						option.disabled ? [] : [{ option, optionIndex }],
					);
					const checked = new Set<number>();
					for (const selected of result.selectedOptions) {
						const selectedIndex = question.options.findIndex(option => option.label === selected);
						const option = options[selectedIndex];
						if (!option) throw new ToolError("Ask dialog returned an unknown choice");
						checked.add(option.optionIndex);
					}
					const customOffset = answerImages.length;
					if (result.customInputImages) answerImages.push(...result.customInputImages);
					const noteOffset = answerImages.length;
					if (result.noteImages) answerImages.push(...result.noteImages);
					const customInput =
						result.customInput === undefined
							? undefined
							: shiftImageMarkers(result.customInput, customOffset, result.customInputImages?.length ?? 0);
					if (customInput !== undefined && !field.other)
						throw new ToolError("Ask dialog returned a custom answer for a field without Other");
					if (!result.timedOut && !field.multi && checked.size === 0 && customInput === undefined)
						return await cancelAsk();
					if (!result.timedOut || checked.size > 0 || customInput !== undefined) {
						const value = choiceValue(field, checked, customInput);
						if (value !== undefined) data[field.name] = value;
					}
					if (result.note !== undefined) {
						const noteIndex = question.options.findIndex(option => option.label === result.noteOption);
						const selected =
							result.noteOption === undefined
								? options.find(({ optionIndex }) => checked.has(optionIndex))
								: options[noteIndex];
						notes.push({
							name: field.name,
							question: questions.get(field) ?? field.name,
							option: selected ? spansText(selected.option.label) : OTHER_LABEL,
							value: selected?.option.value ?? customInput ?? "",
							text: shiftImageMarkers(result.note, noteOffset, result.noteImages?.length ?? 0),
						});
					}
					timedOut ||= result.timedOut === true;
				}
				answered = { data, notes, timedOut };
			} else if (extensionUi.formDialog) {
				const media = new Map<string, FormMedia | Error>();
				for (const section of form.sections) {
					for (const block of section.blocks) {
						if (block.kind !== "image" || /^data:/i.test(block.src) || media.has(block.src)) continue;
						try {
							dialogSignal.throwIfAborted();
							if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
							const result = await callRegisteredTool(
								"read",
								{ path: /\.svgz?$/i.test(block.src) ? `${block.src}:img` : block.src },
								{ session: this.session, signal: dialogSignal },
							);
							dialogSignal.throwIfAborted();
							if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
							if (
								!isRecord(result) ||
								!("images" in result) ||
								("hasError" in result && result.hasError === true) ||
								!Array.isArray(result.images)
							)
								throw new ToolError("Form media did not resolve to an approved image");
							const image: unknown = result.images[0];
							if (!isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string")
								throw new ToolError("Form media did not resolve to an approved image");
							if (image.data.length > Math.ceil(MAX_FORM_IMAGE_BYTES / 3) * 4)
								throw new ToolError("Form image exceeds the image byte limit");
							let bytes: Uint8Array = Uint8Array.fromBase64(image.data);
							if (bytes.byteLength > MAX_FORM_IMAGE_BYTES)
								throw new ToolError("Form image exceeds the image byte limit");
							if (image.mimeType.toLowerCase() === "image/svg+xml") {
								bytes = await rasterizeSvg(bytes, MAX_FORM_SVG_EDGE_PX, MAX_FORM_SVG_EDGE_PX);
								dialogSignal.throwIfAborted();
								if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
								if (bytes.byteLength > MAX_FORM_IMAGE_BYTES)
									throw new ToolError("Form image exceeds the image byte limit");
							}
							const metadata = parseImageMetadata(bytes);
							if (!metadata) throw new ToolError("Form media did not resolve to an approved raster image");
							media.set(block.src, { bytes, mime: metadata.mimeType });
						} catch (error) {
							dialogSignal.throwIfAborted();
							if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
							media.set(block.src, error instanceof Error ? error : new ToolError(String(error)));
						}
					}
				}
				const formDialog = extensionUi.formDialog.bind(extensionUi);
				answered = await untilAborted(dialogSignal, () =>
					formDialog(html, {
						timeout,
						signal: dialogSignal,
						loadMedia: async (source: string, mediaSignal: AbortSignal): Promise<FormMedia> => {
							const activeSignal = AbortSignal.any([dialogSignal, mediaSignal]);
							activeSignal.throwIfAborted();
							if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
							if (/^data:/i.test(source)) {
								const loaded = await loadFormImage(source, { cwd: this.session.cwd, signal: activeSignal });
								activeSignal.throwIfAborted();
								if (!isCurrent()) throw new ToolAbortError("Ask media owner changed");
								return loaded;
							}
							const admitted = media.get(source);
							if (!admitted) throw new ToolError("Form image source was not admitted");
							if (admitted instanceof Error) throw admitted;
							return { bytes: admitted.bytes.slice(), mime: admitted.mime };
						},
					}),
				);
			} else {
				answered = await askFieldByField(extensionUi, form, timeout, dialogSignal);
			}
			checkAnswerCurrent();
			if (!answered) return await cancelAsk();
			if (answered.timedOut) {
				await pauseGoal();
				checkAnswerCurrent();
			}

			const notes = answered.notes?.length ? answered.notes : undefined;
			const details: AskToolDetails = {
				answers: formAnswers(form, answered.data),
				...(notes ? { notes } : {}),
				...(answered.timedOut ? { timedOut: true } : {}),
			};
			const text = prompt.render(askResultTemplate, {
				timedOut: answered.timedOut,
				json: JSON.stringify(answered.data, null, 2),
				notes: notes?.map(note => ({ ...note, text: note.text.replace(/\s+/g, " ").trim() })),
			});
			const imageBlocks = await this.#answerImageBlocks(answerImages, dialogSignal, isCurrent, !answered.timedOut);
			checkAnswerCurrent();
			return { content: [{ type: "text", text }, ...imageBlocks], details };
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw abortError();
			throw error;
		} finally {
			steeringSignal?.removeEventListener("abort", onSteer);
		}
	}
}
