import { createHash } from "node:crypto";
import { type TitleCard, validateTitleCard } from "../utils/title-card";
import {
	SESSION_TITLE_SLOT_BYTES,
	SESSION_TITLE_SLOT_ENTRY_TYPE,
	type SessionHeader,
	type SessionTitleCard,
	type SessionTitleSlotEntry,
	type SessionTitleSource,
} from "./session-entries";

/** Semantic title update persisted by session storage backends. */
export interface SessionTitleUpdate {
	title?: string;
	source?: SessionTitleSource;
	updatedAt: string;
	card?: SessionTitleCard;
	/** Physical overflow reference, not a replacement title. */
	ref?: string;
}

function titleKey(update: SessionTitleUpdate): string {
	return createHash("sha256")
		.update(JSON.stringify([update.title ?? "", update.source ?? null, update.updatedAt]))
		.digest("hex")
		.slice(0, 16);
}

export function boundTitleCard(update: SessionTitleUpdate, value: unknown): SessionTitleCard | undefined {
	const card = validateTitleCard(value);
	if (!card || !value || typeof value !== "object" || !("key" in value) || value.key !== titleKey(update)) {
		return undefined;
	}
	return { ...card, key: titleKey(update) };
}

function titleSlotLine(update: SessionTitleUpdate, pad = ""): string {
	const slot: SessionTitleSlotEntry = {
		type: SESSION_TITLE_SLOT_ENTRY_TYPE,
		v: 1,
		title: update.title ?? "",
		...(update.source ? { source: update.source } : {}),
		updatedAt: update.updatedAt,
		...(update.card ? { card: update.card } : {}),
		...(update.ref ? { ref: update.ref } : {}),
		pad,
	};
	return `${JSON.stringify(slot)}\n`;
}

export function titleFitsSlot(update: SessionTitleUpdate): boolean {
	return (
		Buffer.byteLength(titleSlotLine({ ...update, card: undefined, ref: undefined }), "utf8") <=
		SESSION_TITLE_SLOT_BYTES
	);
}

/** Omit optional metadata whole before displacing a title. */
export function admitTitleCard(update: SessionTitleUpdate, value: TitleCard | undefined): SessionTitleCard | undefined {
	const valid = validateTitleCard(value);
	if (!valid || !titleFitsSlot(update)) return undefined;
	const card = { ...valid, key: titleKey(update) };
	return Buffer.byteLength(titleSlotLine({ ...update, card, ref: undefined }), "utf8") <= SESSION_TITLE_SLOT_BYTES
		? card
		: undefined;
}

function isSessionTitleSource(value: unknown): value is SessionTitleSource {
	return value === "auto" || value === "user";
}

function parseTitleSlotObject(value: unknown): SessionTitleSlotEntry | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== SESSION_TITLE_SLOT_ENTRY_TYPE || record.v !== 1) return undefined;
	if (typeof record.title !== "string" || typeof record.updatedAt !== "string" || typeof record.pad !== "string") {
		return undefined;
	}
	const source = record.source;
	if (source !== undefined && !isSessionTitleSource(source)) return undefined;
	if (record.ref !== undefined && (typeof record.ref !== "string" || !/^[0-9a-f]{16}$/.test(record.ref))) {
		return undefined;
	}
	const slot: SessionTitleSlotEntry = {
		type: SESSION_TITLE_SLOT_ENTRY_TYPE,
		v: 1,
		title: record.title,
		updatedAt: record.updatedAt,
		pad: record.pad,
	};
	if (source) slot.source = source;
	if (record.ref) slot.ref = record.ref as string;
	const update = titleUpdateFromSlot(slot)!;
	const card = boundTitleCard(update, record.card);
	if (card && admitTitleCard(update, card)) slot.card = card;
	return slot;
}

/** Parse a physical title slot JSONL line. Returns undefined for legacy headers. */
export function parseTitleSlotLine(line: string): SessionTitleSlotEntry | undefined {
	try {
		return parseTitleSlotObject(JSON.parse(line)) ?? undefined;
	} catch {
		return undefined;
	}
}

/** Parse the fixed-width title slot from a physical session body. */
export function parseTitleSlotFromContent(content: string): SessionTitleSlotEntry | undefined {
	const newlineIndex = content.indexOf("\n");
	if (newlineIndex < 0) return undefined;
	return parseTitleSlotLine(content.slice(0, newlineIndex));
}

/** Convert a parsed title slot to the semantic storage update shape. */
export function titleUpdateFromSlot(slot: SessionTitleSlotEntry | undefined): SessionTitleUpdate | undefined {
	if (!slot) return undefined;
	const update: SessionTitleUpdate = { title: slot.title, source: slot.source, updatedAt: slot.updatedAt };
	if (slot.ref) update.ref = slot.ref;
	const card = boundTitleCard(update, slot.card);
	if (card && admitTitleCard(update, card)) update.card = card;
	return update;
}

/** Serialize the fixed-width first-line title slot, exactly 256 UTF-8 bytes including newline. */
export function serializeTitleSlot(options: SessionTitleUpdate): string {
	let update: SessionTitleUpdate = { ...options, ref: undefined, card: boundTitleCard(options, options.card) };
	if (!titleFitsSlot(update)) update = { ...update, title: "", card: undefined, ref: titleKey(options) };
	else update.card = admitTitleCard(update, update.card);
	const bytes = Buffer.byteLength(titleSlotLine(update), "utf8");
	if (bytes > SESSION_TITLE_SLOT_BYTES) throw new Error("Session title slot metadata exceeds fixed slot size");
	return titleSlotLine(update, " ".repeat(SESSION_TITLE_SLOT_BYTES - bytes));
}

/** The winning container owns its card; a slot cannot borrow header metadata. */
export function applySessionTitleSlot(header: SessionHeader, slot: SessionTitleUpdate | undefined): void {
	if (!slot) {
		header.titleCard =
			typeof header.titleUpdatedAt === "string"
				? boundTitleCard(
						{ title: header.title, source: header.titleSource, updatedAt: header.titleUpdatedAt },
						header.titleCard,
					)
				: undefined;
		return;
	}
	if (slot.ref) {
		const update = { title: header.title, source: header.titleSource, updatedAt: header.titleUpdatedAt ?? "" };
		header.titleCard = undefined;
		if (
			header.titleUpdatedAt === slot.updatedAt &&
			header.titleSource === slot.source &&
			titleKey(update) === slot.ref
		)
			return;
		header.title = undefined;
	} else header.title = slot.title || undefined;
	header.titleSource = slot.source;
	header.titleUpdatedAt = slot.updatedAt;
	header.titleCard = slot.ref ? undefined : boundTitleCard(slot, slot.card);
}

/** Backend tuples retain the full semantic title, not the overflow placeholder. */
export function titleUpdateFromContent(content: string): SessionTitleUpdate | undefined {
	const slot = titleUpdateFromSlot(parseTitleSlotFromContent(content));
	if (!slot?.ref) return slot;
	const first = content.indexOf("\n");
	const end = content.indexOf("\n", first + 1);
	try {
		const header = JSON.parse(content.slice(first + 1, end < 0 ? undefined : end)) as SessionHeader;
		if (header.type !== "session") return undefined;
		applySessionTitleSlot(header, slot);
		return { title: header.title, source: header.titleSource, updatedAt: slot.updatedAt };
	} catch {
		return undefined;
	}
}

/** Replace the physical fixed-width title slot in a full session body. */
export function overlayTitleSlotContent(content: string, update: SessionTitleUpdate): string {
	const slot = serializeTitleSlot(update);
	const existing = Buffer.from(content, "utf8");
	if (!titleFitsSlot(update)) {
		const rest = existing.subarray(SESSION_TITLE_SLOT_BYTES).toString("utf8");
		const end = rest.indexOf("\n");
		if (end < 0) throw new Error("Overflow title requires a session header");
		const header = JSON.parse(rest.slice(0, end)) as SessionHeader;
		if (header.type !== "session") throw new Error("Overflow title requires a session header");
		header.title = update.title;
		header.titleSource = update.source;
		header.titleUpdatedAt = update.updatedAt;
		delete header.titleCard;
		return slot + JSON.stringify(header) + "\n" + rest.slice(end + 1);
	}
	return slot + existing.subarray(SESSION_TITLE_SLOT_BYTES).toString("utf8");
}

/** Replace the physical fixed-width title slot in a prefix byte window. */
export function overlayTitleSlotPrefix(prefix: string, prefixBytes: number, update: SessionTitleUpdate): string {
	if (prefixBytes <= 0) return "";
	const slot = Buffer.from(serializeTitleSlot(update), "utf-8");
	if (prefixBytes <= slot.length) return slot.subarray(0, prefixBytes).toString("utf-8");
	const existing = Buffer.from(prefix, "utf-8");
	return Buffer.concat([slot, existing.subarray(slot.length)])
		.subarray(0, prefixBytes)
		.toString("utf-8");
}
