import type { AgentTool } from "./types";

export const TOOL_CANCELLATION_CLEANUP_VERSION = "tool-cancellation-cleanup/v1";

/** Resolve only the tool's intrinsic policy, never a caller-supplied marker. */
export function resolveToolCancellationBehavior(
	tool: Pick<AgentTool, "cancellationBehavior">,
	args: unknown,
): "await-cleanup" | undefined {
	const policy = tool.cancellationBehavior;
	const resolved = typeof policy === "function" ? policy.call(tool, args) : policy;
	return resolved === "await-cleanup" ? resolved : undefined;
}
