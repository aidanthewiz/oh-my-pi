import { withoutCleanupOwnedToolCall } from "@oh-my-pi/pi-agent-core/agent-loop";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../../tools";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { findEnabledEvalPrelude, invokeEvalPrelude } from "../preludes";
import { EVAL_AGENT_BRIDGE_NAME, type EvalAgentHandleResult, runEvalAgent } from "../agent-bridge";
import { EVAL_BUDGET_BRIDGE_NAME, type EvalBudgetResult, runEvalBudget } from "../budget-bridge";
import { withBridgeTimeoutPause } from "../bridge-timeout";
import { EVAL_COMPLETION_BRIDGE_NAME, type EvalCompletionHandleResult, runEvalCompletion } from "../completion-bridge";
import {
	EVAL_JUDGMENT_BATCH_BRIDGE_NAME,
	type EvalJudgmentBatchResult,
	runEvalJudgmentBatch,
} from "../judgment-batch-bridge";
import { EVAL_JUDGMENT_BRIDGE_NAME, type EvalJudgmentResult, runEvalJudgment } from "../judgment-bridge";
import { EVAL_SHELL_BRIDGE_NAME, type EvalShellResult, runEvalShell } from "../shell-bridge";
import {
	EVAL_CANCEL_BRIDGE_NAME,
	type EvalHandleSnapshot,
	EVAL_STATUS_BRIDGE_NAME,
	EVAL_WAIT_BRIDGE_NAME,
	runEvalCancel,
	runEvalStatus,
	runEvalWait,
} from "../handle-bridge";
import { withEvalBridgeToolCall } from "../tool-bridge-policy";
import { EVAL_WORKPOOL_BRIDGE_NAME, type EvalWorkpoolResult, runEvalWorkpool } from "../workpool-bridge";
import {
	bridgeValueFromToolResult,
	getSessionTool,
	runSessionTool,
	type SessionToolCallOptions,
	type SessionToolValue,
	type StatusSummarizer,
} from "./session-tool";
import {
	EVAL_MCP_BRIDGE_NAME,
	isEvalNamespaceTool,
	type MCPNamespaceValue,
	mcpNamespaceValue,
	parseMCPNamespaceCall,
} from "../../mcp/eval-namespaces";

export type { JsStatusEvent } from "./shared/types";

export interface ToolBridgeOptions extends SessionToolCallOptions {
	/** The cell's timeout in ms, used by prelude calls that set none. */
	cellTimeoutMs?: number;
}

type ToolValue =
	| SessionToolValue
	| EvalBudgetResult
	| EvalShellResult
	| EvalAgentHandleResult
	| EvalCompletionHandleResult
	| EvalJudgmentResult
	| EvalJudgmentBatchResult
	| EvalHandleSnapshot
	| EvalWorkpoolResult
	| MCPNamespaceValue
	| { items: EvalHandleSnapshot[] }
	| { cancelled: boolean };

function parsePreludeRequest(args: unknown): { name: string; parameters: unknown } {
	if (!isRecord(args)) throw new ToolError("Invalid eval prelude bridge request");
	const name = args.name;
	if (typeof name !== "string" || name.length === 0) {
		throw new ToolError("Invalid eval prelude bridge name");
	}
	return { name, parameters: args.parameters };
}

/**
 * Prelude calls (browser, computer) describe themselves: a bare op name with a
 * byte count is noise, so a prelude without a `status` hook records nothing on
 * success. Failures always surface.
 */
function summarizePreludeResult(session: ToolSession): StatusSummarizer {
	return (name, args, result, text, hasError) => {
		if (hasError) {
			const details = isRecord(result.details) ? result.details : {};
			const error = isRecord(details.error) ? details.error : {};
			return { op: name, error: (typeof error.message === "string" ? error.message : text).slice(0, 500) };
		}
		const detail = findEnabledEvalPrelude(session, name)?.status?.(args, result);
		return detail === undefined ? undefined : { op: name, detail };
	};
}

export function callSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	return withEvalBridgeToolCall(options.session.toolCommands, () => dispatchSessionTool(name, args, options));
}

async function dispatchSessionTool(name: string, args: unknown, options: ToolBridgeOptions): Promise<ToolValue> {
	if (name === "__prelude__") {
		const request = parsePreludeRequest(args);
		const toolCallId = `prelude-${request.name}-${crypto.randomUUID()}`;
		try {
			// Browser/computer operations own their deadlines. Charging their host
			// wait to Eval as well can kill its kernel during a first-use browser
			// install or an explicitly longer navigation. Caller abort still flows
			// through; only the runtime-work watchdog is paused.
			const result = await withBridgeTimeoutPause(options.emitStatus, () =>
				invokeEvalPrelude(request.name, request.parameters, {
					session: options.session,
					toolCallId,
					signal: options.signal,
					cellTimeoutMs: options.cellTimeoutMs,
					context: options.session.getToolContext?.(),
				}),
			);
			return bridgeValueFromToolResult(
				request.name,
				request.parameters,
				result,
				options.emitStatus,
				summarizePreludeResult(options.session),
			);
		} catch (error) {
			options.emitStatus?.({
				op: request.name,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
	if (name === EVAL_COMPLETION_BRIDGE_NAME) {
		return await runEvalCompletion(args, options);
	}
	if (name === EVAL_JUDGMENT_BRIDGE_NAME) {
		return await runEvalJudgment(args, options);
	}
	if (name === EVAL_JUDGMENT_BATCH_BRIDGE_NAME) {
		return await runEvalJudgmentBatch(args, options);
	}
	if (name === EVAL_AGENT_BRIDGE_NAME) {
		return await runEvalAgent(args, options);
	}
	if (name === EVAL_BUDGET_BRIDGE_NAME) {
		return await runEvalBudget(args, options);
	}
	if (name === EVAL_SHELL_BRIDGE_NAME) {
		return await runEvalShell(args, options);
	}
	if (name === EVAL_WAIT_BRIDGE_NAME) {
		return await runEvalWait(args, options);
	}
	if (name === EVAL_STATUS_BRIDGE_NAME) {
		return runEvalStatus(args, options);
	}
	if (name === EVAL_CANCEL_BRIDGE_NAME) {
		return runEvalCancel(args, options);
	}
	if (name === EVAL_WORKPOOL_BRIDGE_NAME) {
		return await runEvalWorkpool(args, options);
	}
	if (name === EVAL_MCP_BRIDGE_NAME) {
		return await withoutCleanupOwnedToolCall(() => runEvalMcpCall(args, options));
	}
	const call = await withoutCleanupOwnedToolCall(() =>
		runSessionTool(getSessionTool(options.session, name), args, options),
	);
	return bridgeValueFromToolResult(call.name, call.args, call.result, options.emitStatus);
}

/** An MCP eval namespace method (`github.search(…)`): the tool's own call, mapped by `mcpNamespaceValue`. */
async function runEvalMcpCall(args: unknown, options: ToolBridgeOptions): Promise<MCPNamespaceValue> {
	const request = parseMCPNamespaceCall(args);
	const tool = getSessionTool(options.session, request.tool);
	if (!isEvalNamespaceTool(tool)) throw new ToolError(`${request.label} is not an MCP namespace method`);
	const { result } = await runSessionTool(tool, request.args, options);
	try {
		const value = await mcpNamespaceValue(request.label, result, options.session.localProtocolOptions ?? {});
		options.emitStatus?.({ op: request.label });
		return value;
	} catch (error) {
		options.emitStatus?.({ op: request.label, error: error instanceof Error ? error.message : String(error) });
		throw error;
	}
}
