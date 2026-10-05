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
	/<\s*(\/?)\s*[｜|]\s*DSML\s*[｜|]\s*(tool_calls|invoke|parameter)\b(?:[ \t]*(?:\r?\n[ \t]*)?(?:name|string)[ \t]*=[ \t]*(?:"[^"<>\r\n]*"?|'[^'<>\r\n]*'?|[^\s<>]+))*(?:\s*>|[ \t]*)/gu;
// Code the model deliberately quoted (fences, inline spans) is not a leak.
const QUOTED_CODE_PATTERN = /(```|~~~)[\s\S]*?(?:\1|$)|(?<!`)(`+)(?!`)[^\n]*?\2(?!`)/g;
// The identifier-only line a degraded model writes in place of
// `<｜DSML｜invoke name="…">` (e.g. `bash\n<｜DSML｜parameter …>`): part of the
// broken call, so it goes with the markup.
const TRAILING_TOOL_NAME_LINE = /(^|\n)[ \t]*[A-Za-z_][\w.-]*[ \t]*\r?\n[ \t]*$/;

/** Only a retained closer proves where a call's unquoted payload ends. */
function stripUnquoted(text: string): string {
	const quoted = [...text.matchAll(QUOTED_CODE_PATTERN)];
	const tags: RegExpExecArray[] = [];
	let quoteIndex = 0;
	for (const tag of text.matchAll(DSML_TAG_PATTERN)) {
		while (quoteIndex < quoted.length && quoted[quoteIndex]!.index + quoted[quoteIndex]![0].length <= tag.index) {
			quoteIndex++;
		}
		const quote = quoted[quoteIndex];
		if (!quote || quote.index > tag.index) tags.push(tag);
	}
	if (tags.length === 0) return text;

	const open = new Map<string, number>();
	const ends = new Map<number, number>();
	for (let index = 0; index < tags.length; index++) {
		const tag = tags[index]!;
		const kind = tag[2]!;
		for (const [name, opener] of open) {
			if (name !== kind && kind !== "tool_calls" && !(kind === "invoke" && name === "parameter")) continue;
			if (tag[1]) ends.set(opener, tag.index + tag[0].length);
			open.delete(name);
		}
		if (!tag[1]) open.set(kind, index);
	}

	const parts: string[] = [];
	let cursor = 0;
	for (let index = 0; index < tags.length; index++) {
		const tag = tags[index]!;
		if (tag.index < cursor) continue;
		let start = tag.index;
		const nameLine =
			!tag[1] && tag[2] === "parameter" ? TRAILING_TOOL_NAME_LINE.exec(text.slice(cursor, start)) : null;
		if (nameLine) start = cursor + nameLine.index + nameLine[1]!.length;
		parts.push(text.slice(cursor, start).trim());
		cursor = ends.get(index) ?? tag.index + tag[0].length;
	}
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
