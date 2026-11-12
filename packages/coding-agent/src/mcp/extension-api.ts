import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import { formatArgsInline } from "@oh-my-pi/pi-tui/tools/json-tree";
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { ExtensionToolWrapper } from "../extensibility/extensions/wrapper";
import type { CustomToolResult } from "../extensibility/custom-tools/types";
import { throwIfAborted } from "../tools/tool-errors";
import { mcpToolApproval } from "./approval-policy";
import type { MCPManagerApi } from "./manager";
import { buildErrorResult, buildResult, createLegacyMCPToolName, createMCPToolName } from "./tool-bridge";
import type { ExtensionMCPContext } from "./types";

/** Bind extension calls to their owning session and its policy handlers. */
export function createExtensionMCPContext(
	getManager: () => MCPManagerApi | undefined,
	runner: ExtensionRunner,
	getToolContext: () => AgentToolContext,
	captureOwnerCurrent: () => () => boolean,
): ExtensionMCPContext {
	return {
		async callTool(serverName, toolName, args = {}, options = {}) {
			const { signal, retry } = options;
			throwIfAborted(signal);
			const manager = getManager();
			if (!manager) throw new Error("MCP is disabled for this session");
			const isOwnerCurrent = captureOwnerCurrent();
			const assertOwnerCurrent = () => {
				throwIfAborted(signal);
				if (getManager() !== manager || !isOwnerCurrent()) {
					throw new Error("MCP call owner changed");
				}
			};
			assertOwnerCurrent();
			let original!: CustomToolResult<MCPToolDetails>;
			let policyResult!: CustomToolResult<MCPToolDetails>;
			const tool: AgentTool & { mcpServerName: string; mcpToolName: string; legacyName?: string } = {
				name: createMCPToolName(serverName, toolName),
				legacyName: createLegacyMCPToolName(serverName, toolName),
				label: `${serverName}/${toolName}`,
				description: `Call ${serverName}/${toolName}`,
				formatApprovalDetails: input =>
					isRecord(input) ? formatArgsInline(input, 1200, { characterBudget: true }) : "Invalid MCP arguments",
				parameters: { type: "object", properties: {}, additionalProperties: true },
				approval: mcpToolApproval(serverName),
				mcpServerName: serverName,
				mcpToolName: toolName,
				async execute(_toolCallId, input, _signal, _onUpdate, context) {
					assertOwnerCurrent();
					if (!isRecord(input)) throw new Error("MCP tool arguments must be an object");
					if (!context) throw new Error("MCP tool execution context is unavailable");
					try {
						original = buildResult(
							await manager.callTool(
								serverName,
								toolName,
								input,
								{ retry, signal },
								{
									...context,
									hasUI: runner.hasUI(),
									ui: runner.getUIContext(),
									mcpOwnerCurrent: () => getManager() === manager && isOwnerCurrent(),
								},
							),
							serverName,
							toolName,
						);
						assertOwnerCurrent();
					} catch (error) {
						assertOwnerCurrent();
						if (error instanceof Error && error.name === "AbortError") throw error;
						original = buildErrorResult(error, serverName, toolName);
					}
					policyResult = structuredClone(original);
					return policyResult;
				},
			};
			const wrapper = new ExtensionToolWrapper(tool, runner);
			const result = await wrapper.execute(crypto.randomUUID(), args, signal, undefined, getToolContext());
			assertOwnerCurrent();
			const details: unknown = result.details;
			const changed =
				result.content !== policyResult.content ||
				!Bun.deepEquals(result.content, original.content) ||
				!Bun.deepEquals(details, original.details);
			if (changed) {
				// Authorization is per channel: unrelated detail edits cannot release original payloads.
				const structuredContent = isRecord(details) ? details.structuredContent : undefined;
				const meta = isRecord(details) ? details.mcpMeta : undefined;
				return {
					content: result.content,
					isError: result.isError ?? false,
					...(isRecord(structuredContent) &&
					!Bun.deepEquals(structuredContent, original.details?.structuredContent)
						? { structuredContent }
						: {}),
					...(isRecord(meta) && !Bun.deepEquals(meta, original.details?.mcpMeta) ? { _meta: meta } : {}),
				};
			}
			return {
				content: original.details?.rawContent ?? result.content,
				isError: result.isError ?? false,
				structuredContent: original.details?.protocolError
					? { error: original.details.protocolError }
					: original.details?.structuredContent,
				_meta: original.details?.mcpMeta,
			};
		},
	};
}
