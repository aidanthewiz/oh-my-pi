/**
 * Subagent session discovery shared by `/export` (HTML) and `/dump all` (zip of text dumps).
 *
 * A session at `<dir>/<name>.jsonl` keeps its subagent sessions at `<dir>/<name>/<AgentId>.jsonl`;
 * each subagent's own children nest the same way under `<dir>/<name>/<AgentId>/`. Advisor
 * transcripts (`__advisor*.jsonl`) share those directories and are not subagents.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { isAdvisorTranscriptName } from "../advisor/transcript-recorder";
import { getAgentTombstonePath } from "../registry/agent-tombstone";
import type { SessionEntry, SessionHeader } from "./session-entries";
import { loadSessionFile, type SessionLoadResult } from "./session-loader";

/** Persisted subagent session transcript, keyed by slash-joined agent path. */
export interface SubSession {
	/** Bare agent id (session file stem), e.g. "ToolAsk". */
	agentId: string;
	/** Key of the parent sub-session, or null when spawned by the main session. */
	parent: string | null;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** The subagent was explicitly killed (a tombstone sidecar sits next to its transcript). */
	aborted: boolean;
	/** JSONL records skipped as malformed while loading this transcript. */
	malformedRecords: number;
}

/** Receives the key of a subagent transcript that exists but has no readable session header. */
export type UnreadableSubSessionHandler = (key: string) => void;

/**
 * Collect subagent session transcripts stored next to a session file.
 *
 * Keys in the returned record are slash-joined ids relative to the main session
 * ("ToolAsk", "ToolAsk/Helper"). Empty files are skipped silently; corrupt ones
 * are skipped and reported to `onUnreadable`.
 * Filesystem errors propagate unless `onError` is supplied; a handler preserves readable siblings.
 */
export async function collectSubSessions(
	sessionFile: string,
	onUnreadable?: UnreadableSubSessionHandler,
	onError?: (error: unknown) => void,
): Promise<Record<string, SubSession>> {
	const result: Record<string, SubSession> = Object.create(null);
	if (!sessionFile.endsWith(".jsonl")) return result;
	await collectSubSessionsFromDir(sessionFile.slice(0, -6), null, result, onUnreadable, onError);
	return result;
}

async function collectSubSessionsFromDir(
	dir: string,
	parentKey: string | null,
	out: Record<string, SubSession>,
	onUnreadable: UnreadableSubSessionHandler | undefined,
	onError: ((error: unknown) => void) | undefined,
): Promise<void> {
	let dirents: fs.Dirent[];
	try {
		if (!(await fs.promises.lstat(dir)).isDirectory()) return;
		dirents = await fs.promises.readdir(dir, { withFileTypes: true });
	} catch (err) {
		if (isEnoent(err) || (err as NodeJS.ErrnoException).code === "ENOTDIR") return;
		if (!onError) throw err;
		onError(err);
		return;
	}
	const fileNames = new Set<string>();
	const childDirectories = new Set<string>();
	for (const dirent of dirents) {
		if (dirent.isFile()) fileNames.add(dirent.name);
		else if (dirent.isDirectory()) childDirectories.add(dirent.name);
	}
	for (const name of [...fileNames].sort()) {
		if (!name.endsWith(".jsonl") || name.includes(".bak") || isAdvisorTranscriptName(name)) continue;
		const agentId = name.slice(0, -6);
		if (!agentId || agentId === "." || agentId === ".." || agentId.includes("\\")) continue;
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		let loaded: SessionLoadResult;
		try {
			const file = path.join(dir, name);
			if (!(await fs.promises.lstat(file)).isFile()) continue;
			loaded = await loadSessionFile(file);
		} catch (error) {
			if (!onError) throw error;
			onError(error);
			continue;
		}
		const { entries: fileEntries, malformedRecords, invalidHeader } = loaded;
		if (fileEntries.length > 0) {
			const header = (fileEntries.find(e => e.type === "session") as SessionHeader | undefined) ?? null;
			const entries = fileEntries.filter((e): e is SessionEntry => e.type !== "session");
			out[key] = {
				agentId,
				parent: parentKey,
				header,
				entries,
				leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
				aborted: fileNames.has(getAgentTombstonePath(name)),
				malformedRecords,
			};
		} else if (invalidHeader) {
			onUnreadable?.(key);
		}
		if (childDirectories.has(agentId)) {
			await collectSubSessionsFromDir(path.join(dir, agentId), key, out, onUnreadable, onError);
		}
	}
}
