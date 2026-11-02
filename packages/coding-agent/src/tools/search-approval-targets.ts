import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import * as fs from "node:fs/promises";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import { approvalDirectoryKey } from "./approval-cache";
import { approvalTargetKey, approvalTreeSearchKey, isApprovalPublicUrl } from "./approval-targets";
import { isExternalSearchUrl, normalizePathLikeInput, resolveReadPath } from "./path-utils";

/** Key execution-ready roots supplied by the tool's own parser; unresolved scope cannot authorize. */
export async function searchApprovalCacheTargets(
	roots: readonly string[],
	cwd: string,
	splitBase: (root: string) => string | Promise<string>,
	isRecursive: (root: string) => boolean = () => true,
	includePublic = false,
	context?: Parameters<InternalUrlRouter["target"]>[1],
): Promise<readonly string[]> {
	const entries = roots.length > 0 ? roots : ["."];
	const keys = new Set<string>();
	for (const entry of entries) {
		const base = normalizePathLikeInput(await splitBase(entry));
		if (!base) throw new ToolError("Cannot derive approval target for an empty search root");
		if (await isExternalSearchUrl(base, cwd)) {
			if (includePublic || !isApprovalPublicUrl(base)) keys.add(approvalTargetKey(cwd, base)!);
			continue;
		}
		const router = InternalUrlRouter.instance();
		const normalized = router.normalize(base);
		let absolute: string;
		if (router.canResolve(normalized)) {
			if (router.spec(extractUriScheme(normalized) ?? "")?.backing !== "file") {
				throw new ToolError(`Cannot bind approval destination: ${normalized}`);
			}
			const target = await router.target(normalized, context);
			if (target?.kind !== "file") throw new ToolError(`Cannot bind approval destination: ${normalized}`);
			absolute = target.path;
		} else {
			absolute = resolveReadPath(base, cwd);
		}
		const stat = await fs.stat(absolute);
		if (stat.isDirectory()) {
			const directoryKey = approvalDirectoryKey(absolute);
			keys.add(isRecursive(entry) ? approvalTreeSearchKey(directoryKey) : directoryKey);
		} else {
			const key = approvalTargetKey(cwd, absolute);
			if (key === undefined) throw new ToolError(`Cannot derive approval target: ${entry}`);
			keys.add(key);
		}
	}
	return [...keys];
}
