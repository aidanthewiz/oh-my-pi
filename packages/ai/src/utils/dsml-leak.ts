/**
 * Removal of DeepSeek DSML tool-call markup left in visible assistant text.
 *
 * DeepSeek models on OpenAI-compatible hosts sometimes emit their tool calls as
 * raw `<｜DSML｜…>` markup in `content`. A well-formed envelope is healed into a
 * structured call by `StreamMarkupHealing`, but a degraded model can drop the
 * opening `<｜DSML｜tool_calls>` / `<｜DSML｜invoke name="…">` tags (or the host
 * runs no healer at all). That markup must not stay in history: replaying it
 * teaches the model to keep writing tool calls as text (issue #10556). Callers
 * strip it before the message is committed and tell the model its call failed.
 */

import type { AssistantMessage, Model } from "../types";

// Structural DSML tags in either pipe spelling (fullwidth `｜` U+FF5C or ASCII),
// tolerating stray whitespace inside the delimiter run.
const DSML_TAG_PATTERN =
	/<\s*(\/?)\s*[｜|]\s*DSML\s*[｜|]\s*(tool_calls|invoke|parameter)\b[^<>\r\n]*(?:\r?\n(?![ \t]*\r?\n)[^<>\r\n]*)*>?/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|(?<!`)(`+)(?!`)[^\n]*?\2(?!`)/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;
const BLANK_LINE_PATTERN = /\r?\n[ \t]*\r?\n/;

/** Keep prose between independent broken calls, using retained closers as span boundaries. */
function stripUnquoted(text: string): string {
	const tags = [...text.matchAll(DSML_TAG_PATTERN)];
	if (tags.length === 0) return text;
	const quoted = [...text.matchAll(QUOTED_CODE_PATTERN)];
	let quoteIndex = 0;
	let removed = false;
	const parts: string[] = [];
	let cursor = 0;
	for (let index = 0; index < tags.length; index++) {
		const first = tags[index]!;
		if (first.index < cursor) continue;
		while (quoteIndex < quoted.length && quoted[quoteIndex]!.index + quoted[quoteIndex]![0].length <= first.index) {
			quoteIndex++;
		}
		const quote = quoted[quoteIndex];
		if (quote && quote.index <= first.index) continue;
		removed = true;
		let start = first.index;
		const nameLine =
			!first[1] && first[2] === "parameter" ? TRAILING_TOOL_NAME_LINE.exec(text.slice(cursor, start)) : null;
		if (nameLine) start = cursor + nameLine.index + nameLine[1]!.length;
		let last = first;
		const open = new Set<string>();
		for (;;) {
			if (last[1]) {
				if (last[2] === "tool_calls") open.clear();
				else {
					open.delete(last[2]!);
					if (last[2] === "invoke") open.delete("parameter");
				}
			} else open.add(last[2]!);
			const next = tags[index + 1];
			if (!next) break;
			const gap = text.slice(last.index + last[0].length, next.index);
			if (open.size === 0 && gap.trim().length > 0) break;
			if (last[1] && last[2] === "tool_calls" && !next[1]) break;
			last = next;
			index++;
		}
		let end = last.index + last[0].length;
		if (!last[1] || open.size > 0) {
			const blankLine = text.slice(end).search(BLANK_LINE_PATTERN);
			end = blankLine === -1 ? text.length : end + blankLine;
		}
		parts.push(text.slice(cursor, start).trim());
		cursor = end;
	}
	if (!removed) return text;
	parts.push(text.slice(cursor).trim());
	return parts.filter(part => part.length > 0).join("\n\n");
}

/**
 * Whether DSML leak recovery applies to `model`: a DeepSeek-class model, or one
 * explicitly configured with the `dsml` stream healer (e.g. a `models.yml` entry
 * whose id the classifier cannot place). Other models never write DSML tool
 * calls, so DSML text from them is prose and is left alone.
 */
export function isDsmlLeakRecoveryTarget(model: Model): boolean {
	if (model.identity?.class === "deepseek") return true;
	const compat = model.compat;
	return (
		compat !== undefined && "streamMarkupHealingPattern" in compat && compat.streamMarkupHealingPattern === "dsml"
	);
}

/**
 * Strip leaked DSML tool-call markup from `text`, leaving quoted code intact.
 * Returns `undefined` when `text` carries no such markup.
 */
export function stripDsmlToolMarkup(text: string): string | undefined {
	if (!text.includes("DSML")) return undefined;
	const stripped = stripUnquoted(text);
	return stripped !== text ? stripped : undefined;
}

/**
 * Remove leaked DSML tool-call markup from `message`'s text blocks in place,
 * dropping blocks left empty. Returns true when anything was removed.
 */
export function removeDsmlToolMarkupLeak(message: AssistantMessage): boolean {
	let removed = false;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		const stripped = block.type === "text" ? stripDsmlToolMarkup(block.text) : undefined;
		if (block.type !== "text" || stripped === undefined) {
			content.push(block);
			continue;
		}
		removed = true;
		if (stripped.trim().length > 0) content.push({ ...block, text: stripped });
	}
	if (removed) message.content = content;
	return removed;
}
