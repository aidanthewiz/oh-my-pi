/**
 * Shared ACP client bridge routing for file-write sites.
 *
 * When an ACP client (e.g. Zed) advertises the `fs.writeTextFile` capability,
 * all write-mode tools must route through it so the editor's open buffer is
 * updated immediately. Internal artifacts ('/Users/theo/.omp/agent/sessions/-Projects-oh-my-pi/2026-06-10T09-11-41-506Z_019eb0cd-3ec2-7000-92aa-1b82aa4d78f0/local' plan files, other scheme
 * URLs) are always written directly to disk — those are OMP-owned and should
 * never be pushed into the editor.
 */

import { InternalUrlRouter } from "../internal-urls";
import { FileChangeType, notifyWorkspaceWatchedFiles } from "../lsp/client";
import { logger } from "@oh-my-pi/pi-utils";
import type { ToolSession } from ".";
import { resolvePlanPath, targetsLocalSandbox } from "./plan-mode-guard";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * Return `true` when an ACP client bridge write is appropriate for this path.
 *
 * Returns `false` for internal-URL paths (e.g. `'/Users/theo/.omp/agent/sessions/-Projects-oh-my-pi/2026-06-10T09-11-41-506Z_019eb0cd-3ec2-7000-92aa-1b82aa4d78f0/local/PLAN.md'`) and for the
 * active plan file while plan mode is enabled — both are OMP-internal artifacts
 * that must stay off the editor's buffer.
 */
export async function shouldRouteWriteThroughBridge(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
): Promise<boolean> {
	const router = InternalUrlRouter.instance();
	if (router.canHandle(requestedPath)) return false;
	// OMP-owned session artifacts (plan files, scratch notes) must stay off the
	// editor buffer even when addressed by their absolute sandbox path — e.g.
	// after tag-based path recovery rebinds a bare `plan.md#tag` onto the
	// `local://` artifact, `requestedPath` is the absolute path, not the URL.
	if (await targetsLocalSandbox(session, absolutePath)) return false;

	const state = session.getPlanModeState?.();
	if (!state?.enabled || !router.canHandle(state.planFilePath)) return true;

	return absolutePath !== (await resolvePlanPath(session, state.planFilePath));
}

/**
 * Result of a bridge-routed write: the content actually verified on disk
 * after the client processed the write, plus whether that content diverges
 * from what the tool asked to persist.
 *
 * ACP's `fs/write_text_file` has no "verbatim, no side effects" guarantee —
 * a client (e.g. Zed with `format_on_save: on`) may reformat the buffer as
 * part of handling the write before it settles on disk. Silently trusting
 * the requested `content` as "what's now on disk" lets that drift poison
 * every snapshot/tag/hash a caller derives from the write, which then reads
 * back as unrelated whole-file corruption on the *next* edit. Reading the
 * file back and reporting what's actually there keeps callers honest.
 */
export interface BridgeWriteResult {
	/** Content actually present on disk immediately after the bridge write. */
	text: string;
	/** `true` when `text` differs from the content the tool asked to write. */
	driftedFromRequest: boolean;
}

/**
 * Try to route a file write through the ACP client bridge.
 *
 * Performs the full guard check, bridge call (wrapped in {@link ToolError}),
 * a post-write read-back to detect client-side transformation (e.g.
 * format-on-save), FS-scan cache invalidation, and session mutation-version
 * bump.
 *
 * Returns `undefined` when the bridge is unavailable or the path should not
 * be routed through it — the caller must fall back to the writethrough path.
 * Returns a {@link BridgeWriteResult} when the bridge was used; callers MUST
 * use `result.text` (not the content they requested) for any snapshot, hash,
 * or tag derived from this write.
 */
export async function routeWriteThroughBridge(
	session: ToolSession,
	requestedPath: string,
	absolutePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<BridgeWriteResult | undefined> {
	const bridge = session.getClientBridge?.();
	if (!bridge?.capabilities.writeTextFile || !bridge.writeTextFile) return undefined;
	if (!(await shouldRouteWriteThroughBridge(session, requestedPath, absolutePath))) return undefined;

	const changeType = (await Bun.file(absolutePath).exists()) ? FileChangeType.Changed : FileChangeType.Created;
	// The ACP protocol has no cancellation for fs writes; the most we can do is
	// refuse to start one after the tool was aborted. Racing the promise would
	// report failure while the editor still applies the write.
	signal?.throwIfAborted();
	try {
		await bridge.writeTextFile({ path: absolutePath, content });
	} catch (error) {
		throw new ToolError(
			`ACP write did not return success; the file may have changed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		session.bumpFileMutationVersion?.(absolutePath);
	}
	let actualText: string;
	try {
		actualText = await Bun.file(absolutePath).text();
	} catch (error) {
		throw new ToolError(
			`ACP acknowledged the write to ${absolutePath}, but its persisted contents could not be verified; the file may have changed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (session.enableLsp ?? true) {
		try {
			// The editor already committed; notification cannot cancel or undo that operation.
			await notifyWorkspaceWatchedFiles(session.cwd, [{ filePath: absolutePath, type: changeType }]);
		} catch (error) {
			logger.warn("LSP notification failed after an acknowledged ACP write", { path: absolutePath, error });
		}
	}
	return { text: actualText, driftedFromRequest: actualText !== content };
}
