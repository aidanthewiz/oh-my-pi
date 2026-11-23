/**
 * Removal of DeepSeek tool-call markup left in visible assistant text.
 *
 * DeepSeek models on OpenAI-compatible hosts sometimes emit their tool calls as
 * text in `content`: the V4 `<｜DSML｜…>` envelope or the V3 chat-template
 * tokens (`<｜tool▁calls▁begin｜>` …). A well-formed call is healed into a
 * structured call by `StreamMarkupHealing`, but a degraded model can drop
 * required tags (or the host runs no healer at all). That markup must not stay
 * in history: replaying it teaches the model to keep writing tool calls as text
 * (issue #10556). Callers strip it before the message is committed and tell the
 * model its call failed.
 */

import {
	DEEPSEEK_TOOL_CALL_BEGIN,
	DEEPSEEK_TOOL_CALLS_BEGIN,
	DEEPSEEK_TOOL_CALL_END,
	DEEPSEEK_TOOL_CALL_TOKENS,
	DEEPSEEK_TOOL_CALLS_END,
	findDeepSeekTemplateToken,
} from "../dialect/deepseek";
import type { AssistantMessage, Model } from "../types";
import { dropReasoningDetailsEnvelopes, isReasoningField, parseReasoningDetailsSignature } from "./reasoning-source";

// Structural DSML tags in either pipe spelling (fullwidth `｜` U+FF5C or ASCII),
// including doubled delimiters and the observed malformed ` calls` wrapper.
const DSML_TAG_PATTERN =
	/<\s*(\/?)\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(tool_calls|invoke|parameter|calls)\b(?:[ \t]*(?:\r?\n[ \t]*)?(?:name|string)[ \t]*=[ \t]*(?:"[^"<>\r\n]*"?|'[^'<>\r\n]*'?|[^\s<>]+))*(?:\s*>|[ \t]*)/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|(?<!`)(`+)(?!`)[^\n]*?\2(?!`)/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;

interface MarkupTag {
	readonly index: number;
	readonly end: number;
	readonly kind: string;
	readonly closing: boolean;
	readonly complete: boolean;
}

function hasCompleteHeader(header: string): boolean {
	if (!header.endsWith(">")) return false;
	let quote = 0;
	for (let index = 0; index < header.length; index++) {
		const char = header.charCodeAt(index);
		if (char === quote) quote = 0;
		else if (!quote && (char === 34 || char === 39)) quote = char;
	}
	return quote === 0;
}

/** Only a complete leaf's matching closer identifies its unquoted payload. */
function stripUnquoted(text: string): string {
	const quoted = [...text.matchAll(QUOTED_CODE_PATTERN)];
	const allTags: MarkupTag[] = [];
	for (const tag of text.matchAll(DSML_TAG_PATTERN)) {
		allTags.push({
			index: tag.index,
			end: tag.index + tag[0].length,
			kind: tag[2] === "calls" ? "tool_calls" : tag[2]!,
			closing: !!tag[1],
			complete: hasCompleteHeader(tag[0]),
		});
	}
	for (
		let tag = findDeepSeekTemplateToken(text, DEEPSEEK_TOOL_CALL_TOKENS);
		tag;
		tag = findDeepSeekTemplateToken(text, DEEPSEEK_TOOL_CALL_TOKENS, tag.index + tag.raw.length)
	) {
		allTags.push({
			index: tag.index,
			end: tag.index + tag.raw.length,
			kind:
				tag.token === DEEPSEEK_TOOL_CALL_BEGIN || tag.token === DEEPSEEK_TOOL_CALL_END
					? "template_call"
					: tag.token === DEEPSEEK_TOOL_CALLS_BEGIN || tag.token === DEEPSEEK_TOOL_CALLS_END
						? "template_calls"
						: "template_separator",
			closing: tag.token === DEEPSEEK_TOOL_CALL_END || tag.token === DEEPSEEK_TOOL_CALLS_END,
			complete: true,
		});
	}
	const tags: MarkupTag[] = [];
	let quoteIndex = 0;
	for (const tag of allTags.sort((a, b) => a.index - b.index)) {
		while (quoteIndex < quoted.length && quoted[quoteIndex]!.index + quoted[quoteIndex]![0].length <= tag.index) {
			quoteIndex++;
		}
		const quote = quoted[quoteIndex];
		if (!quote || quote.index > tag.index) tags.push(tag);
	}
	if (tags.length === 0) return text;

	const open = new Map<string, number>();
	const ends = new Map<number, number>();
	let parameterizedInvoke: number | undefined;
	for (let index = 0; index < tags.length; index++) {
		const tag = tags[index]!;
		const kind = tag.kind;
		if (kind.startsWith("template_")) {
			const opener = open.get("template_call");
			if (tag.closing && opener !== undefined) {
				ends.set(opener, tag.end);
				open.delete("template_call");
			}
			if (!tag.closing && kind === "template_call") open.set(kind, index);
			if (!tag.closing && kind === "template_calls") open.delete("template_call");
			continue;
		}
		if (kind === "parameter") parameterizedInvoke = open.get("invoke");
		for (const [name, opener] of open) {
			if (name !== kind && kind !== "tool_calls" && !(kind === "invoke" && name === "parameter")) continue;
			if (
				tag.closing &&
				name === kind &&
				kind !== "tool_calls" &&
				opener !== parameterizedInvoke &&
				tags[opener]!.complete &&
				tag.complete
			) {
				ends.set(opener, tag.end);
			}
			open.delete(name);
		}
		if (!tag.closing) open.set(kind, index);
	}

	const parts: string[] = [];
	let cursor = 0;
	for (let index = 0; index < tags.length; index++) {
		const tag = tags[index]!;
		if (tag.index < cursor) continue;
		let start = tag.index;
		const nameLine =
			!tag.closing && tag.kind === "parameter" ? TRAILING_TOOL_NAME_LINE.exec(text.slice(cursor, start)) : null;
		if (nameLine) start = cursor + nameLine.index + nameLine[1]!.length;
		parts.push(text.slice(cursor, start).trim());
		cursor = ends.get(index) ?? tag.end;
	}
	parts.push(text.slice(cursor).trim());
	return parts.filter(part => part.length > 0).join("\n\n");
}

/**
 * Whether DSML leak recovery applies to `model`: a DeepSeek-class model, or one
 * explicitly configured with the `dsml` stream healer (e.g. a `models.yml` entry
 * whose id the classifier cannot place). Other models never write DeepSeek tool
 * calls, so such markup from them is prose and is left alone.
 */
export function isDsmlLeakRecoveryTarget(model: Model): boolean {
	if (model.identity?.class === "deepseek") return true;
	const compat = model.compat;
	return (
		compat !== undefined && "streamMarkupHealingPattern" in compat && compat.streamMarkupHealingPattern === "dsml"
	);
}

/**
 * Strip leaked DeepSeek tool-call markup (DSML or chat-template tokens) from
 * `text`, leaving quoted code intact. Returns `undefined` when `text` carries
 * no such markup.
 */
export function stripDsmlToolMarkup(text: string): string | undefined {
	if (!text.includes("DSML") && !text.includes("｜")) return undefined;
	const stripped = stripUnquoted(text);
	return stripped !== text ? stripped : undefined;
}

/**
 * Remove leaked DSML tool-call markup from an assistant message before commit,
 * including reasoning blocks and turns with valid structured calls. Rewritten
 * thinking with an opaque signature is discarded; OpenAI-compatible reasoning
 * field names and `reasoning_details` envelopes are replay state, not
 * signatures, and survive cleanup. Envelope entries carry the turn's original
 * reasoning text, so rewriting any thinking block reduces every envelope of the
 * turn to its field marker.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let content: AssistantMessage["content"] | undefined;
	let thinkingChanged = false;
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index]!;
		if (block.type !== "text" && block.type !== "thinking") {
			content?.push(block);
			continue;
		}
		const stripped = stripDsmlToolMarkup(block.type === "text" ? block.text : block.thinking);
		if (stripped === undefined) {
			content?.push(block);
			continue;
		}
		content ??= message.content.slice(0, index);
		if (block.type === "text") {
			if (stripped.trim().length > 0) content.push({ ...block, text: stripped });
		} else {
			thinkingChanged = true;
			const signature = block.thinkingSignature;
			const completionsTurn = message.api === "openai-completions" || message.api === "openrouter";
			const replayState =
				completionsTurn && (isReasoningField(signature) || parseReasoningDetailsSignature(signature) !== undefined);
			if ((!signature || replayState) && stripped.trim().length > 0) {
				content.push({ ...block, thinking: stripped });
			}
		}
	}
	if (!content) return false;
	message.content = thinkingChanged ? dropReasoningDetailsEnvelopes(content) : content;
	return true;
}
