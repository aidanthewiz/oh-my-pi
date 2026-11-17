import {
	formatMCPProgress,
	MCP_TOOL_NAME_PREFIX,
	type MCPProgress,
	type MCPToolDetails,
} from "@oh-my-pi/pi-tui/tools/mcp";
/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */
import * as os from "node:os";
import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { SourceMeta } from "../capability/types";
import { Settings } from "../config/settings";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import {
	type AwsAuthenticationRecoveryBudget,
	AwsTool,
	awsFailureCode,
	awsSessionAuthGroups,
	describeTrustedAwsLogin,
	recoverTrustedAwsAuthentication,
	resolveTrustedAwsProfile,
} from "../tools/aws";
import { formatApprovalArguments, type ToolApproval } from "../tools/approval";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { schemaDeclaresIntentField } from "../utils/tool-schema";
import { mcpToolApproval } from "./approval-policy";
import { callTool, isAuthenticatedAwsTool, listTools } from "./client";
import { formatMCPToolFailure, getMCPToolDiagnostic, MCPTransportError } from "./errors";
import { describeMCPCall, describeMCPResult, renderMCPCall, renderMCPResult } from "@oh-my-pi/pi-tui/tools/mcp";
import type {
	MCPAuthChallenge,
	MCPCallToolOptions,
	MCPHostCallContext,
	MCPRequestOptions,
	MCPServerConnection,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
} from "./types";
import type { MCPContent } from "@oh-my-pi/pi-tui/tools/mcp";

/** Reconnect callback: tears down a stale connection, optionally authorizing first. */
export type MCPReconnect = (options?: {
	authChallenge?: MCPAuthChallenge;
	awsProfile?: string;
}) => Promise<MCPServerConnection | null>;

/**
 * Told about every MCP tool call when it starts, by tool-call id; returns the
 * callback the call awaits before it returns its result. Lets the owning
 * manager settle the tool-list changes the call provoked into the caller's view.
 */
export type MCPToolCallObserver = (toolCallId: string) => () => Promise<void>;

/**
 * Network-level and stale-session errors that warrant a reconnect + single retry.
 * Conservative: only catches errors where the server is likely alive but the
 * connection object is stale (dead SSE, expired session, refused after restart).
 */
const RETRIABLE_PATTERNS = [
	"econnrefused",
	"econnreset",
	"epipe",
	"enetunreach",
	"ehostunreach",
	"fetch failed",
	"transport not connected",
	"transport closed",
	"network error",
];
export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError" || error instanceof ToolAbortError) return false;
	if (error instanceof MCPTransportError) {
		if (!error.retryable) return false;
		if (
			error.failure === "connect" ||
			error.failure === "reset" ||
			error.failure === "eof" ||
			error.failure === "closed"
		) {
			return error.retryable;
		}
		return error.failure === "http_status" && (error.code === 404 || error.code === 502 || error.code === 503);
	}
	const msg = error.message.toLowerCase();
	// Stale session (server restarted, old session ID is gone)
	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;

/** An unknown tool is not replay-safe, regardless of the transport failure. */
export function canReplayMCPTool(tool: MCPToolDefinition): boolean {
	return tool.annotations?.readOnlyHint === true || tool.annotations?.idempotentHint === true;
}
const UNDELIVERED_CONNECT_CODES = new Set([
	"ECONNREFUSED",
	"CONNECTIONREFUSED",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"ENOTFOUND",
	"EAI_AGAIN",
	"FAILEDTOOPENSOCKET",
]);

function isUndeliveredMCPCall(error: unknown): boolean {
	if (!(error instanceof MCPTransportError) || !error.retryable) return false;
	if (error.transport === "stdio") return error.stage === "connect" && error.failure === "closed";
	if (error.transport !== "http") return false;
	if (error.stage === "receive" && error.failure === "http_status" && error.code === 404) return true;
	return (
		error.stage === "connect" &&
		error.failure === "connect" &&
		typeof error.code === "string" &&
		UNDELIVERED_CONNECT_CODES.has(error.code.toUpperCase())
	);
}

function isRecoverableMCPConnection(error: unknown, replaySafe: boolean): boolean {
	if (isRetriableConnectionError(error)) return true;
	if (!replaySafe || !(error instanceof MCPTransportError)) return false;
	return error.failure === "http_status" && (error.code === 404 || error.code === 502 || error.code === 503);
}

function assertMcpLocalOwnerCurrent(context?: MCPHostCallContext, signal?: AbortSignal): void {
	throwIfAborted(signal);
	if (context?.mcpOwnerCurrent?.() === false) throw new ToolAbortError("MCP call owner changed");
}

async function assertMcpOwnerCurrent(context?: MCPHostCallContext, signal?: AbortSignal): Promise<void> {
	assertMcpLocalOwnerCurrent(context, signal);
	if (context?.mcpCheckOwner) {
		await context.mcpCheckOwner();
		assertMcpLocalOwnerCurrent(context, signal);
	}
}

function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return (
		value === undefined ||
		value === "" ||
		(typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
	);
}

function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	const properties = inputSchema.properties;
	if (!properties) return args;

	let cleaned: MCPToolArgs | undefined;
	const required = new Set(inputSchema.required ?? []);
	for (const [key, value] of Object.entries(args)) {
		if (required.has(key) || !Object.hasOwn(properties, key) || !isUnusedOptionalPlaceholder(value)) {
			continue;
		}
		cleaned ??= { ...args };
		delete cleaned[key];
	}

	return cleaned ?? args;
}

/**
 * Drop the harness-internal intent field (`INTENT_FIELD`) before forwarding
 * args to an MCP server. The harness injects `i` into every tool's wire
 * schema; the direct model tool-call path strips it via `extractIntent` and
 * the `eval` `tool.*` bridge drops it in `callSessionTool`, but other
 * in-process callers (Task proxies, `ctx.invokeTool`) may still forward args
 * verbatim. Strict-schema servers (Linear, anything with
 * `additionalProperties:false` / Zod `.strict()`) reject every call that
 * carries `i`. The MCP boundary is the authoritative guard so callers don't
 * have to pre-strip.
 *
 * Leaves `i` in place when the server's own input schema declares or
 * constrains it, so legitimate tool data is not discarded at forwarding.
 */
function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (schemaDeclaresIntentField(inputSchema)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

/** Replace string args that are file-backed internal URLs with the local path backing them. */
async function resolveOutboundUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		// Only arguments that are themselves URLs: the router's repair of a
		// cwd-prefixed `…/local://x` path must not rewrite free text that merely
		// mentions one.
		if (!extractUriScheme(value)) return value;
		const router = InternalUrlRouter.instance();
		const url = router.normalize(value);
		if (!router.canHandle(url)) return value;
		const scheme = extractUriScheme(url);
		if (!scheme || router.spec(scheme)?.backing !== "file") return value;
		const located = await router.locate(url, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return located ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundUrlArgs(item, context, seen);
			if (next === item && !resolved) continue;
			resolved ??= value.slice();
			resolved[index] = next;
		}
		return resolved ?? value;
	}

	const input = value as Record<string, unknown>;
	let resolved: Record<string, unknown> | undefined;
	for (const key in input) {
		const item = input[key];
		const next = await resolveOutboundUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

/**
 * Normalize raw tool params into the outbound `tools/call` arguments: strip
 * the harness intent field, drop optional empty placeholders the server
 * declares but doesn't require, then translate file-backed internal URLs to paths
 * external MCP servers can read.
 */
async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	return (await resolveOutboundUrlArgs(args, context)) as MCPToolArgs;
}

/**
 * Convert MCP content to agent content while retaining image payloads.
 */
function formatMCPContent(content: MCPContent[]): Array<TextContent | ImageContent> {
	const blocks: Array<TextContent | ImageContent> = [];
	let text = "";
	const flushText = () => {
		if (!text) return;
		blocks.push({ type: "text", text });
		text = "";
	};
	const appendText = (value: string) => {
		text += text ? `\n\n${value}` : value;
	};

	for (const item of content) {
		switch (item.type) {
			case "text":
				appendText(item.text);
				break;
			case "image":
				flushText();
				blocks.push(item);
				break;
			case "resource":
				appendText(
					item.resource.text
						? `[Resource: ${item.resource.uri}]\n${item.resource.text}`
						: `[Resource: ${item.resource.uri}]`,
				);
				break;
		}
	}
	flushText();
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * Serialize an MCP result's structured payload as a fenced JSON block so it
 * reaches the model through the standard content channel — and the eval
 * `tool.*` and subagent proxy bridges that read the same result. Subject to the
 * usual spill/byte-cap machinery like any other text block.
 * Programmatic consumers use details.structuredContent instead of parsing this rendering.
 */
function formatStructuredContent(structured: Record<string, unknown>): string {
	let json: string;
	try {
		json = JSON.stringify(structured, null, 2);
	} catch {
		return "";
	}
	return `\`\`\`json\n${json}\n\`\`\``;
}

/**
 * True when a trimmed text block carries a value: a verbatim string echo, or a
 * JSON block parsing to a deep-equal value. `parsed` is `undefined` when the
 * block is not JSON (`JSON.parse` never yields `undefined` itself).
 */
function textCarries(trimmed: string, parsed: unknown, value: unknown): boolean {
	return (typeof value === "string" && trimmed === value) || (parsed !== undefined && Bun.deepEquals(parsed, value));
}

/**
 * True when text already carries the structured payload. Beyond a verbatim
 * echo, this covers the MCP SDK's `{ result: value }` wrapper for non-object
 * tool returns: the SDK auto-wraps list/string returns, so `structuredContent`
 * never verbatim-matches the `content` text blocks that carry the same value.
 *
 * A partial match does NOT count: if content covers only part of the wrapped
 * payload (extra items, extra keys), the rendering is kept so the model still
 * sees the full structured result.
 *
 * Out of scope: the Python SDK's `_convert_to_content` flattens nested lists via
 * `chain.from_iterable` (`[[1,2],[3]]` → 3 blocks vs 2), drops `None` items, and
 * whitespace-padded item strings fail the verbatim comparison — those shapes still render.
 */
function structuredContentAlreadyInText(structured: Record<string, unknown>, content: MCPContent[]): boolean {
	const wrapped =
		Object.hasOwn(structured, "result") && Object.keys(structured).length === 1 ? structured.result : undefined;
	const wrappedItems = Array.isArray(wrapped) ? wrapped : undefined;
	const blocks: Array<{ trimmed: string; parsed: unknown }> = [];
	for (const item of content) {
		if (item.type !== "text") continue;
		const trimmed = item.text.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = undefined;
		}
		if (textCarries(trimmed, parsed, structured)) return true;
		if (wrapped !== undefined && textCarries(trimmed, parsed, wrapped)) return true;
		blocks.push({ trimmed, parsed });
	}
	return (
		wrappedItems !== undefined &&
		blocks.length > 0 &&
		wrappedItems.length === blocks.length &&
		wrappedItems.every((value, i) => {
			const block = blocks[i];
			return block !== undefined && value !== undefined && textCarries(block.trimmed, block.parsed, value);
		})
	);
}

/** Build a CustomToolResult from a callTool response. */
export function buildResult(
	result: MCPToolCallResult,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const content = formatMCPContent(result.content);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		rawContent: result.content,
		mcpMeta: result._meta,
		provider,
		providerName,
	};
	if (result.isError) {
		if (content[0]?.type === "text") {
			content[0] = { type: "text", text: `Error: ${content[0].text}` };
		} else {
			content.unshift({ type: "text", text: "Error:" });
		}
	}
	const structured = result.structuredContent;
	if (structured !== undefined) details.structuredContent = structured;
	if (structured !== undefined && !structuredContentAlreadyInText(structured, result.content)) {
		const rendered = formatStructuredContent(structured);
		if (rendered.length > 0) {
			content.push({ type: "text", text: rendered });
		}
	}
	const toolResult: CustomToolResult<MCPToolDetails> = { content, details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

/** Build an error CustomToolResult from a caught exception. */
export function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const message = formatMCPToolFailure(error, serverName, mcpToolName);
	return {
		content: [{ type: "text", text: message }],
		details: {
			serverName,
			mcpToolName,
			isError: true,
			protocolError: getMCPToolDiagnostic(error),
			provider,
			providerName,
		},
		isError: true,
	};
}

type MCPToolCallAttempt = {
	connection: MCPServerConnection;
	result?: MCPToolCallResult;
	error?: unknown;
};

/** Minimum spacing between one call's progress updates; a burst coalesces to its newest progress. */
export const PROGRESS_UPDATE_INTERVAL_MS = 50;

interface ProgressUpdater {
	onProgress: NonNullable<MCPRequestOptions["onProgress"]>;
	/** Stop updating once the call settles; a coalesced update still waiting is dropped. */
	close(): void;
}

/**
 * Turn a call's progress notifications into tool updates. The first progress
 * shows immediately; progress inside the following interval waits and only
 * the newest is shown when it ends. Heartbeats that repeat the displayed text
 * (the same phase message) emit nothing.
 */
function progressUpdater(
	onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): ProgressUpdater | undefined {
	if (!onUpdate) return undefined;
	let lastText: string | undefined;
	let waiting: MCPProgress | undefined;
	let cooldown: NodeJS.Timeout | undefined;
	let closed = false;
	const show = (progress: MCPProgress) => {
		const text = formatMCPProgress(progress);
		if (text === lastText) return;
		lastText = text;
		try {
			onUpdate({
				content: [{ type: "text", text }],
				details: { serverName, mcpToolName, provider, providerName, progress },
			});
		} catch (error) {
			logger.debug("MCP progress callback failed", { error });
		}
		cooldown = setTimeout(() => {
			cooldown = undefined;
			const next = waiting;
			waiting = undefined;
			if (next) show(next);
		}, PROGRESS_UPDATE_INTERVAL_MS);
	};
	return {
		onProgress: progress => {
			if (closed) return;
			if (cooldown) waiting = progress;
			else show(progress);
		},
		close: () => {
			closed = true;
			clearTimeout(cooldown);
			cooldown = undefined;
			waiting = undefined;
		},
	};
}

function getMcpAuthChallenge(result: MCPToolCallResult): MCPAuthChallenge | undefined {
	if (!result.isError) return undefined;
	const values = result._meta?.["mcp/www_authenticate"];
	if (!Array.isArray(values)) return undefined;
	const wwwAuthenticate = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
	return wwwAuthenticate.length > 0 ? { wwwAuthenticate } : undefined;
}

async function isAwsAuthenticationFailure(
	message: string,
	profile: string,
	authenticationGeneration: number,
	signal?: AbortSignal,
	context?: MCPHostCallContext,
): Promise<boolean> {
	await assertMcpOwnerCurrent(context, signal);
	if (awsFailureCode(message, false) === "AUTH_REQUIRED") return true;
	// Proxy 1.6.5 maps both HTTP 401 and 403 to this ambiguous credential error.
	if (!message.includes("expired or invalid AWS credentials")) return false;
	const probe = new AwsTool(
		{
			cwd: os.tmpdir(),
			hasUI: false,
			settings: context?.settings ?? Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		},
		{ attempted: true },
	);
	try {
		assertMcpLocalOwnerCurrent(context, signal);
		const result = await probe.execute(
			"aws-mcp-authentication-check",
			{
				profile,
				service: "sts",
				operation: "get-caller-identity",
				timeout: 15,
			},
			signal,
			undefined,
			context,
		);
		await assertMcpOwnerCurrent(context, signal);
		if (result.details?.code === "AUTH_REQUIRED") return true;
		const group = (await resolveTrustedAwsProfile(profile))?.ssoGroup;
		await assertMcpOwnerCurrent(context, signal);
		return (
			!!group &&
			awsSessionAuthGroups.generation(group) !== authenticationGeneration &&
			awsSessionAuthGroups.status(group) === "authenticated"
		);
	} catch (error) {
		rethrowIfAborted(error, signal);
		await assertMcpOwnerCurrent(context, signal);
		return false;
	}
}

async function callProfileAwareTool(
	connection: MCPServerConnection,
	toolName: string,
	args: MCPToolArgs,
	authenticationRecovery: AwsAuthenticationRecoveryBudget,
	replaySafe: boolean,
	signal?: AbortSignal,
	context?: MCPHostCallContext,
	onProgress?: MCPRequestOptions["onProgress"],
): Promise<MCPToolCallResult> {
	await assertMcpOwnerCurrent(context, signal);
	const profile = String(args.aws_profile);
	const group =
		replaySafe && isAuthenticatedAwsTool(connection.name, toolName)
			? (await resolveTrustedAwsProfile(profile))?.ssoGroup
			: undefined;
	await assertMcpOwnerCurrent(context, signal);
	let retried = false;
	while (true) {
		const authenticationGeneration = group ? awsSessionAuthGroups.generation(group) : 0;
		try {
			await assertMcpOwnerCurrent(context, signal);
			const result = await callTool(connection, toolName, args, {
				signal,
				onProgress,
				allowAuthRetry: replaySafe,
				mcpOwnerCurrent: context?.mcpOwnerCurrent,
				mcpCheckOwner: context?.mcpCheckOwner,
			});
			await assertMcpOwnerCurrent(context, signal);
			if (
				!replaySafe ||
				!result.isError ||
				!isAuthenticatedAwsTool(connection.name, toolName) ||
				!(await isAwsAuthenticationFailure(
					result.content
						.filter(item => item.type === "text")
						.map(item => item.text)
						.join("\n"),
					profile,
					authenticationGeneration,
					signal,
					context,
				))
			)
				return result;
		} catch (error) {
			rethrowIfAborted(error, signal);
			await assertMcpOwnerCurrent(context, signal);
			if (!replaySafe) throw error;
			if (error instanceof MCPTransportError && error.stage !== "protocol") throw error;
			if (
				!isAuthenticatedAwsTool(connection.name, toolName) ||
				!(await isAwsAuthenticationFailure(
					error instanceof Error ? error.message : String(error),
					profile,
					authenticationGeneration,
					signal,
					context,
				))
			)
				throw error;
		}
		if (!retried && !authenticationRecovery.attempted) {
			authenticationRecovery.attempted = true;
			assertMcpLocalOwnerCurrent(context, signal);
			const recovered = await recoverTrustedAwsAuthentication(
				profile,
				`managed AWS MCP: ${toolName}`,
				context,
				signal,
			);
			await assertMcpOwnerCurrent(context, signal);
			if (recovered) {
				retried = true;
				continue;
			}
		}
		if (authenticationRecovery.attempted && group)
			awsSessionAuthGroups.recordAuthenticationFailure(group, authenticationGeneration);
		throw new Error(
			`AUTH_REQUIRED: commercial MCP profile authentication is unavailable. ${await describeTrustedAwsLogin(profile)}`,
		);
	}
}

async function callToolWithAuthRetry(
	connection: MCPServerConnection,
	toolName: string,
	args: MCPToolArgs,
	authenticationRecovery: AwsAuthenticationRecoveryBudget,
	replaySafe: boolean,
	reconnect: MCPReconnect | undefined,
	signal?: AbortSignal,
	context?: MCPHostCallContext,
	prepareConnection?: (connection: MCPServerConnection) => Promise<MCPServerConnection>,
	onProgress?: MCPRequestOptions["onProgress"],
): Promise<MCPToolCallAttempt> {
	const result = await callProfileAwareTool(
		connection,
		toolName,
		args,
		authenticationRecovery,
		replaySafe,
		signal,
		context,
		onProgress,
	);
	await assertMcpOwnerCurrent(context, signal);
	if (!replaySafe) return { connection, result };
	const authChallenge = getMcpAuthChallenge(result);
	if (!authChallenge || !reconnect) return { connection, result };

	let newConnection: MCPServerConnection | null;
	try {
		newConnection = await reconnectWithAbort(
			reconnect,
			signal,
			{
				authChallenge,
				...(isAuthenticatedAwsTool(connection.name, toolName) ? { awsProfile: String(args.aws_profile) } : {}),
			},
			context,
		);
	} catch (error) {
		rethrowIfAborted(error, signal);
		await assertMcpOwnerCurrent(context, signal);
		return { connection, error };
	}
	if (!newConnection) return { connection, result };

	try {
		const readyConnection = prepareConnection ? await prepareConnection(newConnection) : newConnection;
		await assertMcpOwnerCurrent(context, signal);
		return {
			connection: readyConnection,
			result: await callProfileAwareTool(
				readyConnection,
				toolName,
				args,
				authenticationRecovery,
				replaySafe,
				signal,
				context,
				onProgress,
			),
		};
	} catch (error) {
		rethrowIfAborted(error, signal);
		await assertMcpOwnerCurrent(context, signal);
		return { connection: newConnection, error };
	}
}

/** Re-throw abort-related errors so they bypass error-result handling. */
function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	if (signal?.aborted) throw new ToolAbortError();
}

async function reconnectWithAbort(
	reconnect: MCPReconnect,
	signal?: AbortSignal,
	options?: { authChallenge?: MCPAuthChallenge; awsProfile?: string },
	context?: MCPHostCallContext,
): Promise<MCPServerConnection | null> {
	await assertMcpOwnerCurrent(context, signal);
	try {
		const connection = await untilAborted(signal, () => {
			assertMcpLocalOwnerCurrent(context, signal);
			return reconnect(options);
		});
		await assertMcpOwnerCurrent(context, signal);
		return connection;
	} catch (error) {
		rethrowIfAborted(error, signal);
		await assertMcpOwnerCurrent(context, signal);
		return null;
	}
}

/**
 * Create a unique tool name for an MCP tool.
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 */
function sanitizeMCPToolNamePart(value: string, fallback: string, keepDigits: boolean): string {
	const sanitized = value
		.toLowerCase()
		.replace(keepDigits ? /[^a-z0-9_]+/g : /[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

/**
 * Shared mint pipeline. `keepDigits` selects the sanitizer variant: the
 * current mint keeps `0-9`, the legacy variant strips them exactly as the
 * pre-fix `sanitizeMCPToolNamePart` did. Both halves route through this one
 * function so the two mints can only ever differ by that character class —
 * if the prefix-strip or cap rules change, the legacy alias changes with them.
 */
function mintMCPToolName(serverName: string, toolName: string, keepDigits: boolean): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server", keepDigits);
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool", keepDigits);

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return capMCPToolNameLength(`mcp__${sanitizedServerName}_${normalizedToolName}`);
}

/**
 * Mint the name {@link createMCPToolName} produced before digits were kept in
 * sanitized parts (`[^a-z_]+` collapsed to `_`). Digit-bearing servers/tools
 * were renamed by that fix, so user config keys written against the old form
 * (`tools.approval`, `tools.xdevInlineDevices`) would no longer match.
 * Approval resolution consults this legacy key as a fail-closed fallback.
 * Returns `undefined` when minting is unchanged (no digits involved).
 */
export function createLegacyMCPToolName(serverName: string, toolName: string): string | undefined {
	const legacyName = mintMCPToolName(serverName, toolName, false);
	const currentName = createMCPToolName(serverName, toolName);
	return legacyName !== currentName ? legacyName : undefined;
}

/**
 * Longest tool name strict validators accept. OpenAI Responses/Completions and
 * Meta Responses enforce `^[a-zA-Z0-9_-]{1,64}$`; names over 64 chars are
 * rejected with HTTP 400 `name must be at most 64 characters` (#9130).
 */
const MAX_MCP_TOOL_NAME_LENGTH = 64;
/** Length of the deterministic hash suffix appended when a minted name overflows. */
const MCP_TOOL_NAME_HASH_LENGTH = 8;

/**
 * Cap a minted MCP tool name at {@link MAX_MCP_TOOL_NAME_LENGTH}. An overlong
 * name keeps a readable prefix and gains a deterministic base-36 hash suffix of
 * the full name, so distinct long names stay unique and the same name is stable
 * across turns — the model must call the exact registry key, and the hash is
 * seed-fixed so it never shifts between processes.
 */
function capMCPToolNameLength(name: string): string {
	if (name.length <= MAX_MCP_TOOL_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36).slice(0, MCP_TOOL_NAME_HASH_LENGTH);
	const keep = MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1;
	return `${name.slice(0, keep)}_${hash}`;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	return mintMCPToolName(serverName, toolName, true);
}

/**
 * Registry keys a model-emitted MCP tool name may have meant, in priority
 * order. Empty when the name is not `mcp__`-prefixed or is already canonical.
 *
 * {@link createMCPToolName} joins the sanitized server and tool with a SINGLE
 * underscore, but OMP presents itself as Claude Code, whose convention is
 * `mcp__<server>__<tool>` — so a primed model reliably emits the doubled
 * separator, often keeping the raw unsanitized server spelling as well
 * (`mcp__seedpatch-client__bank` for a server named `seedpatch-client`). Those
 * names are strictly unregistered, so dispatch dead-ends on a tool the session
 * really does expose.
 *
 * Candidates, because the doubled separator carries information the collapsed
 * form loses:
 *
 * 1. Split at a `__` and re-mint through the whole of `createMCPToolName`.
 *    Re-minting (rather than only sanitizing) is what reproduces
 *    redundant-server-prefix stripping — server `puppeteer` + tool
 *    `puppeteer_screenshot` registers as `mcp__puppeteer_screenshot`, not
 *    `mcp__puppeteer_puppeteer_screenshot` — and the 64-char
 *    {@link capMCPToolNameLength} hash. EVERY `__` is tried as the boundary:
 *    a *sanitized* server segment can never contain one, but the model
 *    routinely emits the RAW server name, which can (`foo__bar`), so the first
 *    occurrence is not necessarily the split. Earlier boundaries rank first
 *    since a server name without `__` is overwhelmingly the common case.
 * 2. Sanitize the whole suffix, for a single-separator name whose punctuation
 *    still differs from the minted key (`mcp__seedpatch-client_bank`). This
 *    candidate is capped too: without a boundary there is nothing to re-mint,
 *    but the registered key was still length-capped, so an overlong spelling
 *    would otherwise never match its hashed form. Unlike a split, it has no
 *    minted fallback shape to reproduce, so a suffix that sanitizes away yields
 *    nothing.
 *
 * This is normalization, not fuzzy matching: every candidate is derived from
 * the emitted name by the same rules that minted the registry, never selected
 * from siblings. `sanitizeMCPToolNamePart` is idempotent and registry keys are
 * already in its output form, so an already-registered name yields no
 * candidates at all and stays on the exact-match path. Callers try each
 * candidate as an exact lookup and keep failing when none is registered.
 */
export function canonicalMCPToolNameCandidates(name: string): string[] {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return [];
	const suffix = name.slice(MCP_TOOL_NAME_PREFIX.length);
	if (suffix.length === 0) return [];
	const candidates: string[] = [];
	const add = (candidate: string): void => {
		if (candidate !== name && !candidates.includes(candidate)) candidates.push(candidate);
	};

	// A split needs both halves NONEMPTY — not to survive sanitization.
	// `createMCPToolName` substitutes its `server`/`tool` placeholder for a part
	// that sanitizes away, and it is the same function registration uses, so a
	// server named `123` (valid per `validateServerName`) really does register as
	// `mcp__server_bank`. Re-minting therefore reproduces that key instead of
	// inventing one, and requiring the halves to survive sanitization would drop
	// exactly the names that need recovering. Only a genuinely absent half
	// (`mcp____bank`, `mcp__srv__`) describes no split at all.
	for (let boundary = suffix.indexOf("__"); boundary >= 0; boundary = suffix.indexOf("__", boundary + 1)) {
		const serverName = suffix.slice(0, boundary);
		const toolName = suffix.slice(boundary + 2);
		if (serverName.length > 0 && toolName.length > 0) add(createMCPToolName(serverName, toolName));
	}
	// The whole-suffix candidate has no boundary, so there is no minted fallback
	// shape to reproduce: a suffix that sanitizes away is a dead end.
	const sanitizedSuffix = sanitizeMCPToolNamePart(suffix, "", true);
	if (sanitizedSuffix.length > 0) {
		add(capMCPToolNameLength(`${MCP_TOOL_NAME_PREFIX}${sanitizedSuffix}`));
	}
	return candidates;
}

/**
 * Resolve a Claude Code-spelled MCP call through an EXPLICIT lookup.
 *
 * The lookup is a required argument rather than something read from ambient
 * state, because the set a call must resolve against is the one offered to the
 * agent that emitted it. A resolver closing over one agent's tools and then
 * shared with another — the primary session's resolver also handed to the
 * isolated auto-learn capture agent, say — would let a capture response reach a
 * main-session tool it was never offered. Naming the source at every call site
 * makes that mistake unrepresentable.
 *
 * A caller whose tools span several presentation sets (mounted `xd://` devices
 * plus advertised top-level tools) MUST pass one lookup covering the union.
 * Checking each set with its own call and taking the first hit would let set
 * order silently break the uniqueness rule below.
 *
 * Resolution requires a UNIQUE match. Two different boundaries can both name a
 * registered tool — server `foo` + tool `bar__foo_bar_baz` and server
 * `foo__bar` + tool `foo_bar_baz` mint distinct keys yet share the spelling
 * `mcp__foo__bar__foo_bar_baz` — and nothing in the emitted name says which was
 * meant. Picking whichever boundary sorts first would execute an MCP operation
 * the model did not ask for, side effects included, so an ambiguous alias
 * resolves to nothing and the call stays a recoverable `not found`.
 *
 * Returns `undefined` unless exactly one {@link canonicalMCPToolNameCandidates}
 * entry resolves, so an already-registered name never reaches here and a
 * non-MCP name can never resolve at all.
 */
export function resolveMCPToolAlias<T extends { readonly name: string }>(
	name: string,
	lookup: (candidate: string) => T | undefined,
): T | undefined {
	const matches: T[] = [];
	for (const candidate of canonicalMCPToolNameCandidates(name)) {
		const match = lookup(candidate);
		if (match !== undefined && !matches.some(seen => seen.name === match.name)) matches.push(match);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export interface MCPToolOriginSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

/** Stable identity for a tool's original MCP route, before its public name was normalized. */
export function getMCPToolOriginKey(tool: MCPToolOriginSource): string | undefined {
	if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") return undefined;
	return `${tool.mcpServerName}\u0000${tool.mcpToolName}`;
}

/**
 * Keeps one MCP tool per minted name and logs collisions between distinct MCP
 * origins. The winner is chosen by a stable origin key (server name + original
 * tool name), NOT array order: MCPManager re-appends a reconnecting server's
 * tools, so insertion order is mutable across reconnects and first-wins would
 * silently flip ownership of the minted name. Non-MCP tools pass through
 * unchanged.
 */
export function deduplicateMCPToolsByName<T extends MCPToolOriginSource>(tools: readonly T[]): T[] {
	const deduplicated: T[] = [];
	const registered = new Map<string, { tool: T; originKey: string; index: number }>();

	for (const tool of tools) {
		const originKey = getMCPToolOriginKey(tool);
		if (originKey === undefined) {
			deduplicated.push(tool);
			continue;
		}
		const existing = registered.get(tool.name);
		if (!existing) {
			registered.set(tool.name, {
				tool,
				originKey,
				index: deduplicated.length,
			});
			deduplicated.push(tool);
			continue;
		}

		if (existing.originKey === originKey) continue;

		// Deterministic winner regardless of encounter order across reconnects.
		const keepExisting = existing.originKey < originKey;
		const winner = keepExisting ? existing.tool : tool;
		const loser = keepExisting ? tool : existing.tool;
		if (!keepExisting) {
			deduplicated[existing.index] = tool;
			existing.tool = tool;
			existing.originKey = originKey;
		}
		logger.warn("MCP tool name collision; keeping stable winner", {
			name: tool.name,
			keptServer: winner.mcpServerName,
			keptTool: winner.mcpToolName,
			ignoredServer: loser.mcpServerName,
			ignoredTool: loser.mcpToolName,
		});
	}

	return deduplicated;
}

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

function addDeferredAwsProfileRequirement(serverName: string, tool: MCPToolDefinition): MCPToolDefinition {
	if (!isAuthenticatedAwsTool(serverName, tool.name) || tool.inputSchema.properties?.aws_profile) return tool;
	return {
		...tool,
		inputSchema: {
			...tool.inputSchema,
			properties: {
				...tool.inputSchema.properties,
				aws_profile: {
					type: "string",
					description: "Explicit AWS profile validated against the active managed proxy.",
				},
			},
			required: tool.inputSchema.required?.includes("aws_profile")
				? tool.inputSchema.required
				: [...(tool.inputSchema.required ?? []), "aws_profile"],
		},
	};
}

async function validateManagedAwsProfile(
	serverName: string,
	tool: MCPToolDefinition,
	args: MCPToolArgs,
	options?: { checkExposedProfile?: boolean },
): Promise<void> {
	if (!isAuthenticatedAwsTool(serverName, tool.name)) return;
	const selected = args.aws_profile;
	if (typeof selected !== "string" || !selected.trim()) {
		throw new Error("PROFILE_NOT_FOUND: authenticated AWS MCP calls require an explicit aws_profile.");
	}
	const profile = await resolveTrustedAwsProfile(selected);
	if (!profile) throw new Error("PROFILE_NOT_FOUND: the selected operational AWS profile is unavailable.");
	if (profile.partition !== "aws") {
		throw new Error("WRONG_PARTITION: use the native structured aws tool for this profile.");
	}
	if (options?.checkExposedProfile === false) return;
	const selector = tool.inputSchema.properties?.aws_profile as { enum?: unknown[] } | undefined;
	if (!selector?.enum?.includes(selected)) {
		throw new Error(
			"PROFILE_NOT_FOUND: the selected profile is not exposed by this managed AWS proxy. Use the native aws tool.",
		);
	}
}

async function getLiveManagedAwsTool(
	connection: MCPServerConnection,
	tool: MCPToolDefinition,
	signal?: AbortSignal,
): Promise<MCPToolDefinition> {
	if (!isAuthenticatedAwsTool(connection.name, tool.name)) return tool;
	const tools = await untilAborted(signal, () => listTools(connection, { signal }));
	const liveTool = tools.find(candidate => candidate.name === tool.name);
	if (!liveTool)
		throw new Error("PROFILE_NOT_FOUND: this authenticated AWS tool is not exposed by the managed proxy.");
	return liveTool;
}
const provenAwsProfiles = new WeakMap<MCPServerConnection, Set<string>>();

async function proveAwsProfile(
	connection: MCPServerConnection,
	profile: string,
	authenticationRecovery: AwsAuthenticationRecoveryBudget,
	signal?: AbortSignal,
	context?: MCPHostCallContext,
): Promise<void> {
	await assertMcpOwnerCurrent(context, signal);
	if (provenAwsProfiles.get(connection)?.has(profile)) return;
	const probe = new AwsTool(
		{
			cwd: os.tmpdir(),
			hasUI: context?.hasUI ?? false,
			settings: context?.settings ?? Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
		},
		authenticationRecovery,
	);
	assertMcpLocalOwnerCurrent(context, signal);
	const identity = await probe.execute(
		"aws-mcp-profile-identity",
		{ profile, service: "sts", operation: "get-caller-identity", timeout: 15 },
		signal,
		undefined,
		context,
	);
	await assertMcpOwnerCurrent(context, signal);
	if (identity.isError) {
		throw new Error(
			identity.content
				.filter((item): item is TextContent => item.type === "text")
				.map(item => item.text)
				.join("\n"),
		);
	}
	let proven = provenAwsProfiles.get(connection);
	if (!proven) provenAwsProfiles.set(connection, (proven = new Set()));
	proven.add(profile);
}

async function connectSignedAwsProxy(
	connection: MCPServerConnection,
	toolName: string,
	args: MCPToolArgs,
	authenticationRecovery: AwsAuthenticationRecoveryBudget,
	reconnect: MCPReconnect | undefined,
	signal?: AbortSignal,
	context?: MCPHostCallContext,
): Promise<MCPServerConnection> {
	await assertMcpOwnerCurrent(context, signal);
	if (!isAuthenticatedAwsTool(connection.name, toolName)) return connection;
	const profile = String(args.aws_profile);
	if (!connection.awsAnonymousBootstrap) {
		if (connection.awsPreferredProfile !== undefined || (connection.operationalAwsProfiles?.length ?? 0) > 1)
			await proveAwsProfile(connection, profile, authenticationRecovery, signal, context);
		await assertMcpOwnerCurrent(context, signal);
		return connection;
	}
	if (!reconnect) throw new Error("AUTH_REQUIRED: no signed AWS MCP connection is available.");
	await proveAwsProfile(connection, profile, authenticationRecovery, signal, context);
	const signed = await reconnectWithAbort(reconnect, signal, { awsProfile: profile }, context);
	if (!signed || signed.awsAnonymousBootstrap)
		throw new Error("AUTH_REQUIRED: the selected AWS profile could not open a signed MCP connection.");
	if (signed.awsPreferredProfile !== profile)
		throw new Error(
			"PROFILE_CONFLICT: the signed AWS MCP connection opened for a different profile. Retry the call.",
		);
	provenAwsProfiles.set(signed, new Set([profile]));
	return signed;
}

function describeMCPTool(serverName: string, tool: MCPToolDefinition): string {
	const description = tool.description ?? `MCP tool from ${serverName}`;
	if (!isAuthenticatedAwsTool(serverName, tool.name)) return description;
	const routing =
		"Require an explicit aws_profile for this authenticated call. Only compatible commercial profiles use this route; use the native structured aws tool for GovCloud and other partitions, never generic Bash.";
	if (tool.name !== "aws___run_script") return `${routing}\n\n${description}`;
	return (
		"call_boto3.operation_name uses AWS/Smithy PascalCase: GetCallerIdentity (not get_caller_identity), DescribeDBClusters (not describe_db_clusters), DescribeReplicationGroups (not describe_replication_groups).\n\n" +
		routing +
		`\n\n${description}`
	);
}

export async function dispatchMCPTool(
	connection: MCPServerConnection,
	tool: MCPToolDefinition,
	args: MCPToolArgs,
	reconnect?: MCPReconnect,
	options: MCPCallToolOptions & Pick<MCPRequestOptions, "onProgress"> = {},
	context?: MCPHostCallContext,
): Promise<{ connection: MCPServerConnection; result: MCPToolCallResult }> {
	const { signal, onProgress } = options;
	await assertMcpOwnerCurrent(context, signal);
	const managedAws = isAuthenticatedAwsTool(connection.name, tool.name);
	const authenticationRecovery: AwsAuthenticationRecoveryBudget = { attempted: false };
	await validateManagedAwsProfile(connection.name, tool, args);
	await assertMcpOwnerCurrent(context, signal);
	const originalConnection = connection;
	const prepareConnection = async (candidate: MCPServerConnection): Promise<MCPServerConnection> => {
		await assertMcpOwnerCurrent(context, signal);
		if (!managedAws) return candidate;
		const ready = await connectSignedAwsProxy(
			candidate,
			tool.name,
			args,
			authenticationRecovery,
			reconnect,
			signal,
			context,
		);
		await assertMcpOwnerCurrent(context, signal);
		const liveTool = ready === originalConnection ? tool : await getLiveManagedAwsTool(ready, tool, signal);
		await assertMcpOwnerCurrent(context, signal);
		await validateManagedAwsProfile(ready.name, liveTool, args);
		await assertMcpOwnerCurrent(context, signal);
		return ready;
	};
	const reconnectOptions = managedAws ? { awsProfile: String(args.aws_profile) } : undefined;
	if (!connection.transport.connected && reconnect) {
		connection = (await reconnectWithAbort(reconnect, signal, reconnectOptions, context)) ?? connection;
		await assertMcpOwnerCurrent(context, signal);
	}
	connection = await prepareConnection(connection);
	await assertMcpOwnerCurrent(context, signal);
	const replaySafe = options.retry === "read" || (options.retry !== "never" && canReplayMCPTool(tool));
	try {
		const attempt = await callToolWithAuthRetry(
			connection,
			tool.name,
			args,
			authenticationRecovery,
			replaySafe,
			reconnect,
			signal,
			context,
			prepareConnection,
			onProgress,
		);
		if (attempt.error !== undefined) throw attempt.error;
		if (!attempt.result) throw new Error("MCP tool call returned no result");
		await assertMcpOwnerCurrent(context, signal);
		return { connection: attempt.connection, result: attempt.result };
	} catch (error) {
		rethrowIfAborted(error, signal);
		await assertMcpOwnerCurrent(context, signal);
		if (
			!reconnect ||
			options.retry === "never" ||
			!isRecoverableMCPConnection(error, replaySafe) ||
			(!replaySafe && !isUndeliveredMCPCall(error))
		)
			throw error;
		const reconnected = await reconnectWithAbort(reconnect, signal, reconnectOptions, context);
		await assertMcpOwnerCurrent(context, signal);
		if (!reconnected) throw error;
		const ready = await prepareConnection(reconnected);
		return {
			connection: ready,
			result: await callProfileAwareTool(
				ready,
				tool.name,
				args,
				authenticationRecovery,
				replaySafe,
				signal,
				context,
				onProgress,
			),
		};
	}
}

/**
 * CustomTool wrapping an MCP tool with an active connection.
 */
export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	/**
	 * Name this tool had before digits were kept in minted names, if different.
	 * Approval resolution honors `deny`/`prompt` user policies written against
	 * this key so the rename cannot silently unblock a restricted MCP server.
	 */
	readonly legacyName?: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	/** Server-declared read-only behavior for prewalk; approval stays conservative. */
	readonly mcpReadOnlyHint: boolean | undefined;
	readonly approval: ToolApproval;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/**
	 * MCP-backed tools opt out of strict structured-output grammar. The server
	 * owns validation, and strict mode makes OpenAI-family models over-fill
	 * mutually exclusive optional fields (#4336/#4340). Serializers preserve an
	 * explicit `false`; an omitted flag would leave nothing to preserve.
	 */
	readonly strict = false as const;
	readonly formatApprovalDetails = formatApprovalArguments;

	/** Create MCPTool instances for all tools from an MCP server connection */
	static fromTools(
		connection: MCPServerConnection,
		tools: MCPToolDefinition[],
		reconnect?: MCPReconnect,
		observeCall?: MCPToolCallObserver,
	): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect, observeCall));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
		private readonly observeCall?: MCPToolCallObserver,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.legacyName = createLegacyMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = describeMCPTool(connection.name, tool);
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
		this.approval = mcpToolApproval(connection.name);
		this.mcpReadOnlyHint = tool.annotations?.readOnlyHint;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	describeCall(args: unknown, options: RenderResultOptions) {
		return describeMCPCall(normalizeToolArgs(args), this.label, options);
	}

	describeResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, args?: unknown) {
		return describeMCPResult(result, options, normalizeToolArgs(args));
	}

	async execute(
		toolCallId: string,
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		const settle = this.observeCall?.(toolCallId);
		try {
			return await this.#call(params, onUpdate, ctx, signal);
		} finally {
			await settle?.();
		}
	}

	async #call(
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		await assertMcpOwnerCurrent(_ctx, signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;
		const progress = progressUpdater(onUpdate, this.connection.name, this.tool.name, provider, providerName);
		const onProgress = progress?.onProgress;

		try {
			const attempt = await dispatchMCPTool(
				this.connection,
				this.tool,
				args,
				this.reconnect,
				{ signal, onProgress },
				_ctx,
			);
			this.connection = attempt.connection;
			return buildResult(
				attempt.result,
				attempt.connection.name,
				this.tool.name,
				attempt.connection._source?.provider ?? provider,
				attempt.connection._source?.providerName ?? providerName,
			);
		} catch (error) {
			rethrowIfAborted(error, signal);
			return buildErrorResult(error, this.connection.name, this.tool.name, provider, providerName);
		} finally {
			progress?.close();
		}
	}
}

/**
 * CustomTool wrapping an MCP tool with deferred connection resolution.
 */
export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	/** See {@link MCPTool.legacyName}. */
	readonly legacyName?: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	private readonly tool: MCPToolDefinition;
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	/** See {@link MCPTool.mcpReadOnlyHint}. */
	readonly mcpReadOnlyHint: boolean | undefined;
	readonly approval: ToolApproval;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/** See {@link MCPTool.strict}: MCP servers own validation, so stay non-strict. */
	readonly strict = false as const;
	readonly formatApprovalDetails = formatApprovalArguments;

	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;
	#liveAwsTool?: {
		connection: MCPServerConnection;
		definition: Promise<MCPToolDefinition>;
	};

	/** Create DeferredMCPTool instances for all tools from an MCP server */
	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
		observeCall?: MCPToolCallObserver,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect, observeCall));
	}

	constructor(
		private readonly serverName: string,
		tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
		private readonly observeCall?: MCPToolCallObserver,
	) {
		this.tool = addDeferredAwsProfileRequirement(serverName, tool);
		this.name = createMCPToolName(serverName, this.tool.name);
		this.legacyName = createLegacyMCPToolName(serverName, this.tool.name);
		this.label = `${serverName}/${this.tool.name}`;
		this.description = describeMCPTool(serverName, this.tool);
		this.parameters = normalizeSchemaForMCP(this.tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.approval = mcpToolApproval(serverName);
		this.mcpReadOnlyHint = tool.annotations?.readOnlyHint;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	describeCall(args: unknown, options: RenderResultOptions) {
		return describeMCPCall(normalizeToolArgs(args), this.label, options);
	}

	describeResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, args?: unknown) {
		return describeMCPResult(result, options, normalizeToolArgs(args));
	}

	async #validateLiveManagedAwsProfile(connection: MCPServerConnection, args: MCPToolArgs): Promise<void> {
		if (!isAuthenticatedAwsTool(this.serverName, this.tool.name)) return;
		if (this.#liveAwsTool?.connection !== connection) {
			const definition = getLiveManagedAwsTool(connection, this.tool);
			this.#liveAwsTool = { connection, definition };
			void definition.catch(() => {
				if (this.#liveAwsTool?.definition === definition) this.#liveAwsTool = undefined;
			});
		}
		await validateManagedAwsProfile(this.serverName, await this.#liveAwsTool.definition, args);
	}

	async execute(
		toolCallId: string,
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		const settle = this.observeCall?.(toolCallId);
		try {
			return await this.#call(params, onUpdate, ctx, signal);
		} finally {
			await settle?.();
		}
	}

	async #call(
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		await assertMcpOwnerCurrent(_ctx, signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		await assertMcpOwnerCurrent(_ctx, signal);
		const provider = this.#fallbackProvider;
		const providerName = this.#fallbackProviderName;
		const progress = progressUpdater(onUpdate, this.serverName, this.tool.name, provider, providerName);
		const onProgress = progress?.onProgress;

		const managedAws = isAuthenticatedAwsTool(this.serverName, this.tool.name);
		const replaySafe = canReplayMCPTool(this.tool);
		const authenticationRecovery: AwsAuthenticationRecoveryBudget = { attempted: false };
		if (managedAws) {
			try {
				await validateManagedAwsProfile(this.serverName, this.tool, args, {
					checkExposedProfile: false,
				});
				await assertMcpOwnerCurrent(_ctx, signal);
			} catch (error) {
				rethrowIfAborted(error, signal);
				await assertMcpOwnerCurrent(_ctx, signal);
				return buildErrorResult(error, this.serverName, this.tool.name, provider, providerName);
			}
		}
		const prepareConnection = async (candidate: MCPServerConnection): Promise<MCPServerConnection> => {
			await assertMcpOwnerCurrent(_ctx, signal);
			if (!managedAws) return candidate;
			const ready = await connectSignedAwsProxy(
				candidate,
				this.tool.name,
				args,
				authenticationRecovery,
				this.reconnect,
				signal,
				_ctx,
			);
			await untilAborted(signal, () => this.#validateLiveManagedAwsProfile(ready, args));
			await assertMcpOwnerCurrent(_ctx, signal);
			return ready;
		};
		try {
			const discovered = await untilAborted(signal, () => this.getConnection());
			await assertMcpOwnerCurrent(_ctx, signal);
			const connection = await prepareConnection(discovered);
			try {
				const attempt = await callToolWithAuthRetry(
					connection,
					this.tool.name,
					args,
					authenticationRecovery,
					replaySafe,
					this.reconnect,
					signal,
					_ctx,
					prepareConnection,
					onProgress,
				);
				if (attempt.error !== undefined) {
					return buildErrorResult(
						attempt.error,
						this.serverName,
						this.tool.name,
						attempt.connection._source?.provider ?? provider,
						attempt.connection._source?.providerName ?? providerName,
					);
				}
				if (!attempt.result) {
					return buildErrorResult(
						new Error("MCP tool call returned no result"),
						this.serverName,
						this.tool.name,
						provider,
						providerName,
					);
				}
				return buildResult(
					attempt.result,
					this.serverName,
					this.tool.name,
					attempt.connection._source?.provider ?? provider,
					attempt.connection._source?.providerName ?? providerName,
				);
			} catch (callError) {
				rethrowIfAborted(callError, signal);
				await assertMcpOwnerCurrent(_ctx, signal);
				if (
					this.reconnect &&
					isRecoverableMCPConnection(callError, replaySafe) &&
					(replaySafe || isUndeliveredMCPCall(callError))
				) {
					const newConn = await reconnectWithAbort(
						this.reconnect,
						signal,
						managedAws ? { awsProfile: String(args.aws_profile) } : undefined,
						_ctx,
					);
					if (newConn) {
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const readyConnection = await prepareConnection(newConn);
							const result = await callProfileAwareTool(
								readyConnection,
								this.tool.name,
								args,
								authenticationRecovery,
								replaySafe,
								signal,
								_ctx,
								onProgress,
							);
							return buildResult(result, this.serverName, this.tool.name, retryProvider, retryProviderName);
						} catch (retryError) {
							rethrowIfAborted(retryError, signal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
							);
						}
					}
				}
				return buildErrorResult(callError, this.serverName, this.tool.name, provider, providerName);
			}
		} catch (connError) {
			// getConnection() failed — server never connected or connection lost.
			// This is always worth a reconnect attempt for deferred tools, since the
			// error ("MCP server not connected") isn't a network error from callTool.
			rethrowIfAborted(connError, signal);
			await assertMcpOwnerCurrent(_ctx, signal);
			if (this.reconnect) {
				const newConn = await reconnectWithAbort(
					this.reconnect,
					signal,
					managedAws ? { awsProfile: String(args.aws_profile) } : undefined,
					_ctx,
				);
				if (newConn) {
					try {
						const readyConnection = await prepareConnection(newConn);
						const result = await callProfileAwareTool(
							readyConnection,
							this.tool.name,
							args,
							authenticationRecovery,
							replaySafe,
							signal,
							_ctx,
							onProgress,
						);
						return buildResult(
							result,
							this.serverName,
							this.tool.name,
							newConn._source?.provider ?? provider,
							newConn._source?.providerName ?? providerName,
						);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(retryError, this.serverName, this.tool.name, provider, providerName);
					}
				}
			}
			return buildErrorResult(connError, this.serverName, this.tool.name, provider, providerName);
		} finally {
			progress?.close();
		}
	}
}
