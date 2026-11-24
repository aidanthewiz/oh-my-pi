/**
 * Decides which discovered extensions may bind after the interactive composer
 * accepts input instead of before the session exists.
 *
 * Previous factory registrations provide a startup scheduling hint, not trust
 * authority. The cache fingerprints only the entry file's size and mtime;
 * imported dependencies, environment changes and same-stat replacements can
 * change registrations without invalidating it. Admission and mandatory eager
 * loading remain the caller's responsibility.
 */
import * as fs from "node:fs/promises";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorageApi } from "../../session/agent-storage";
import { resolvePath } from "../utils";
import type { Extension } from "./types";

// Bumped whenever canBindAfterStartup counts a new registration, so verdicts recorded without it
// are not trusted.
const CACHE_PREFIX = "extension_startup:v3:";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StartupVerdict {
	fingerprint: string;
	deferrable: boolean;
	/** Todo backend ids the extension registered: selecting one keeps it eager. */
	todoBackends: string[];
}

/** Discovered extension paths split by whether they must bind before the session is created. */
export interface StartupExtensionPartition {
	eager: string[];
	deferred: string[];
}

async function fingerprintSource(resolvedPath: string): Promise<string | undefined> {
	try {
		const stat = await fs.stat(resolvedPath);
		return `${stat.size}:${stat.mtimeMs}`;
	} catch {
		return undefined;
	}
}

function readVerdict(storage: AgentStorageApi, resolvedPath: string): StartupVerdict | undefined {
	try {
		const raw = storage.getCache(`${CACHE_PREFIX}${resolvedPath}`);
		if (!raw) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (
			!isRecord(parsed) ||
			typeof parsed.fingerprint !== "string" ||
			typeof parsed.deferrable !== "boolean" ||
			!Array.isArray(parsed.todoBackends) ||
			!parsed.todoBackends.every(id => typeof id === "string")
		) {
			return undefined;
		}
		return { fingerprint: parsed.fingerprint, deferrable: parsed.deferrable, todoBackends: parsed.todoBackends };
	} catch {
		return undefined;
	}
}

/**
 * Whether observed factory registrations contain no startup-sensitive state.
 * Selected todo backends are kept eager by {@link partitionStartupExtensions}.
 */
export function canBindAfterStartup(extension: Extension): boolean {
	return (
		extension.registersProviders !== true &&
		extension.shortcuts.size === 0 &&
		extension.composerShapes.size === 0 &&
		extension.fileWriteFallbackHandlers.length === 0 &&
		extension.fileDeleteFallbackHandlers.length === 0 &&
		extension.assistantTextRenderers.length === 0 &&
		extension.assistantThinkingRenderers.length === 0 &&
		extension.linkSchemes.length === 0 &&
		extension.messageRenderers.size === 0
	);
}

/**
 * Split admitted extension paths using a prior factory's scheduling hint.
 * A matching entry-file fingerprint does not establish trust or current behavior.
 * The selected `todoBackend` stays eager. Order within each list follows `paths`.
 */
export async function partitionStartupExtensions(
	storage: AgentStorageApi,
	paths: readonly string[],
	cwd: string,
	todoBackend: string,
): Promise<StartupExtensionPartition> {
	const deferrable = await Promise.all(
		paths.map(async extensionPath => {
			const resolvedPath = resolvePath(extensionPath, cwd);
			const verdict = readVerdict(storage, resolvedPath);
			if (!verdict?.deferrable || verdict.todoBackends.includes(todoBackend)) return false;
			return verdict.fingerprint === (await fingerprintSource(resolvedPath));
		}),
	);
	const partition: StartupExtensionPartition = { eager: [], deferred: [] };
	for (let index = 0; index < paths.length; index++) {
		(deferrable[index] ? partition.deferred : partition.eager).push(paths[index]);
	}
	return partition;
}

/**
 * Record each freshly bound file-backed extension's observed startup verdict.
 * Later registrations and dependency/environment changes are not classified.
 */
export async function recordStartupVerdicts(storage: AgentStorageApi, extensions: readonly Extension[]): Promise<void> {
	const expiresAtSec = Math.floor((Date.now() + CACHE_TTL_MS) / 1000);
	await Promise.all(
		extensions.map(async extension => {
			if (extension.resolvedPath.startsWith("<inline")) return;
			const fingerprint = await fingerprintSource(extension.resolvedPath);
			if (fingerprint === undefined) return;
			const verdict: StartupVerdict = {
				fingerprint,
				deferrable: canBindAfterStartup(extension),
				todoBackends: [...(extension.todoBackends?.keys() ?? [])],
			};
			try {
				storage.setCache(`${CACHE_PREFIX}${extension.resolvedPath}`, JSON.stringify(verdict), expiresAtSec);
			} catch (error) {
				logger.warn("Failed to record extension startup verdict", {
					path: extension.resolvedPath,
					error: String(error),
				});
			}
		}),
	);
}
