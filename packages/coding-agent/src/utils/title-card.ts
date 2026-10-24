import type { TitleIcons } from "./title-settings";
import { normalizeGeneratedTitle } from "../tiny/text";
import { canonicalNerdFontName, nerdFontGlyph } from "./nerd-font-glyphs";

/** Validated alternatives; display preferences do not change these candidates. */
export interface TitleCard {
	code: string;
	emoji?: string;
	nf?: string;
}

export interface GeneratedSessionTitle {
	title: string;
	card?: TitleCard;
}

/** The first `<title …/>` or `<title …>text</title>` tag in a reply. */
const TITLE_TAG = /<title(\s[^>]*?)?\s*(?:\/>|>([\s\S]*?)<\/title>)/i;
const TITLE_ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** One RGI emoji: ZWJ sequences, modifiers, flags and variation selectors included. */
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;
const CODE = /^[A-Z0-9]{1,6}$/;
/** The card form, `<icon> <CODE>: <title>`. */
const CARD_LINE = /^(\S+) ([A-Z0-9]{1,6}): (\S.*)$/u;
/** Tern reads at most 8 characters as the icon. */
const MAX_ICON_CODEPOINTS = 8;

/** Whether `icon` reads as a card icon to Tern: 1-8 characters, none of them ASCII. */
function isCardIcon(icon: string): boolean {
	let codepoints = 0;
	for (const char of icon) {
		if (char.charCodeAt(0) < 0x80 || ++codepoints > MAX_ICON_CODEPOINTS) return false;
	}
	return codepoints > 0;
}

/**
 * One emoji as the card's icon, else `undefined`. An emoji the model left
 * unqualified (`🗄` for `🗄️`) gets its variation selector back; keycaps (`#️⃣`)
 * are refused because Tern reads an icon as non-ASCII characters only.
 */
function cardEmoji(value: string | undefined): string | undefined {
	const emoji = value?.trim();
	if (!emoji) return undefined;
	const qualified = RGI_EMOJI.test(emoji) ? emoji : RGI_EMOJI.test(`${emoji}\uFE0F`) ? `${emoji}\uFE0F` : undefined;
	return qualified && isCardIcon(qualified) ? qualified : undefined;
}

/**
 * The card for `code` and its icons, or `undefined` when a piece the card form
 * needs is missing: a code (a lowercase one is repaired) and at least one icon.
 * An `nf` name resolves to the catalog glyph it means; one matching nothing in
 * the bundled catalog is dropped, leaving the emoji.
 */
function buildCard(code: string | undefined, emoji: string | undefined, nf: string | undefined): TitleCard | undefined {
	const cardCode = code?.trim().toUpperCase();
	if (!cardCode || !CODE.test(cardCode)) return undefined;
	const cardEmojiValue = cardEmoji(emoji);
	const cardNf = nf ? canonicalNerdFontName(nf) : undefined;
	if (!cardEmojiValue && !cardNf) return undefined;
	const card: TitleCard = { code: cardCode };
	if (cardEmojiValue) card.emoji = cardEmojiValue;
	if (cardNf) card.nf = cardNf;
	return card;
}

export function validateTitleCard(value: unknown): TitleCard | undefined {
	if (!value || typeof value !== "object") return undefined;
	const card = value as Record<string, unknown>;
	return buildCard(
		typeof card.code === "string" ? card.code : undefined,
		typeof card.emoji === "string" ? card.emoji : undefined,
		typeof card.nf === "string" ? card.nf : undefined,
	);
}

/** Private-use glyphs belong only to the active Nerd grid, never OS titles. */
export function renderSessionTitle(
	title: string,
	card: TitleCard | undefined,
	icons: TitleIcons,
	nerdActive: boolean,
	portable = false,
): string {
	if (portable && !card) {
		const legacy = splitCardTitle(title);
		if (legacy && /\p{Co}/u.test(legacy.icon)) return legacy.title;
	}
	if (!card || icons === "boring") return title;
	const icon =
		(!portable && nerdActive && icons === "nf+emoji" && card.nf ? nerdFontGlyph(card.nf) : undefined) ??
		(portable ? cardEmoji(card.emoji) : card.emoji);
	return icon ? `${icon} ${card.code}: ${title}` : title;
}

/** Parse validated title candidates without selecting a display icon. */
export function parseCardTitleReply(reply: string, sourceText?: string): GeneratedSessionTitle | null {
	const tag = TITLE_TAG.exec(reply);
	if (!tag || tag[2] === undefined) return null;
	const attrs: Record<string, string> = {};
	for (const match of (tag[1] ?? "").matchAll(TITLE_ATTR)) {
		attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
	}
	let text = tag[2].replace(/\s+/g, " ").trim();
	let card = buildCard(attrs.code, attrs.emoji, attrs.nf);
	const line = splitCardTitle(text);
	if (line) {
		if (!card && attrs.code === undefined) card = buildCard(line.code, line.icon, attrs.nf);
		if (card) text = line.title;
	}
	const title = normalizeGeneratedTitle(text, sourceText);
	return title ? { title, ...(card ? { card } : {}) } : null;
}

/** Parse card candidates; text after the code is ignored. */
export function parseCardReply(reply: string): TitleCard | undefined {
	const tokens = reply.trim().split(/\s+/);
	const nf = tokens[0]?.startsWith("nf-") ? tokens.shift() : undefined;
	const emoji = cardEmoji(tokens[0]) ? tokens.shift() : undefined;
	return buildCard(tokens[0]?.replace(/:$/, ""), emoji, nf);
}

/**
 * The pieces of a session title in the card form `<icon> <CODE>: <title>`, or
 * `undefined` for a plain title (`Fix: the parser` has no icon, so it stays whole).
 */
export function splitCardTitle(title: string): { icon: string; code: string; title: string } | undefined {
	const line = CARD_LINE.exec(title);
	if (!line || !isCardIcon(line[1]!)) return undefined;
	return { icon: line[1]!, code: line[2]!, title: line[3]! };
}
