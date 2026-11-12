/**
 * Tool wrappers for extensions.
 */
import {
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	isNonBlankContext,
	type ToolLoadMode,
} from "@oh-my-pi/pi-agent-core";
import type { ComputerSafetyCheck, ImageContent, Static, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { TERMINAL } from "@oh-my-pi/pi-tui";
import { prompt, sanitizeText, untilAborted, toError } from "@oh-my-pi/pi-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import nativeDelegationTemplate from "../../prompts/tools/native-delegation.md" with { type: "text" };
import { cfgApprovalNotify } from "../../tools/settings";
import {
	approvalRestrictions,
	denyError,
	captureApprovalTargets,
	captureApprovalAuthority,
	sameApprovalAuthority,
	formatApprovalPrompt,
	type RuntimeApprovalCapableTool,
	recordApprovalGrant,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
	sessionApprovalScope,
} from "../../tools/approval";
import { getApprovalGrants } from "../../tools/approval-cache";
import { withToolApprovalScope } from "../../tools/approval-scope";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import { withFileMutationSession } from "../../tools/file-write-fallback";
import { mcpToolEventIdentity, normalizeToolEventInput, resolveToolEventInput } from "../tool-event-input";
import { applyToolProxy } from "../tool-proxy";
import type { ExtensionRunner } from "./runner";
import type { ExtensionAgentIdentity, RegisteredTool, ToolCallEventResult } from "./types";

/**
 * Second `renderCall` argument that satisfies both the omp and the upstream-pi
 * renderer contracts.
 *
 * omp invokes renderers as `renderCall(args, options, theme)` (see
 * `packages/tui/src/tools/renderer.ts`), while pi-era renderers — including
 * every third-party plugin written against pi's published example — are
 * declared `renderCall(args, theme, context)`. Both shapes take three
 * parameters, so arity cannot discriminate them. The returned value carries
 * both instead: own keys stay the render options, every other property
 * resolves against the live theme. `Theme` keeps its state in `#private`
 * fields, so delegated methods are bound to the theme instance rather than to
 * the proxy.
 */
function renderOptionsWithTheme<T extends object>(options: T, theme: Theme): T & Theme {
	const delegates = new Map<PropertyKey, unknown>();
	return new Proxy(options, {
		get(target, prop, receiver) {
			if (Object.hasOwn(target, prop)) return Reflect.get(target, prop, receiver);
			const delegate = delegates.get(prop);
			if (delegate !== undefined) return delegate;
			const value = Reflect.get(theme, prop, theme);
			if (typeof value !== "function") return value;
			const bound = value.bind(theme);
			delegates.set(prop, bound);
			return bound;
		},
	}) as T & Theme;
}

/**
 * Adapts a RegisteredTool into an AgentTool.
 */
export class RegisteredToolAdapter implements AgentTool<any, any, any> {
	declare name: string;
	get description(): string {
		const description = this.registeredTool.definition.description;
		const guidance = this.runner.getNativeDelegationGuidance(this.name);
		return guidance
			? prompt.render(nativeDelegationTemplate, { description, name: this.name, guidance })
			: description;
	}
	declare parameters: any;
	declare label: string;
	declare strict: boolean;

	renderCall?: (args: any, options: any, theme: any) => any;
	renderResult?: (result: any, options: any, theme: any, args?: any) => any;
	readonly loadMode: ToolLoadMode;
	readonly #isActive: () => boolean;

	constructor(
		private registeredTool: RegisteredTool,
		private runner: ExtensionRunner,
	) {
		const owner = registeredTool.owner;
		const activationCurrent = owner?.isActive;
		this.#isActive = () =>
			owner === null ||
			(owner !== undefined &&
				owner.tools.get(registeredTool.definition.name) === registeredTool &&
				activationCurrent?.() !== false);
		applyToolProxy(registeredTool.definition, this);
		this.loadMode = defaultLoadModeForToolName(registeredTool.definition.name, registeredTool.definition.loadMode);

		// Only define render methods when the underlying definition provides them.
		// If these exist unconditionally on the prototype, ToolExecutionComponent
		// enters the custom-renderer path, gets undefined back, and silently
		// discards tool result text (extensions without renderers show blank).
		if (registeredTool.definition.renderCall) {
			this.renderCall = (args: any, options: any, theme: any) =>
				registeredTool.definition.renderCall!(
					args,
					renderOptionsWithTheme(options, theme as Theme),
					theme as Theme,
				);
		}
		if (registeredTool.definition.renderResult) {
			this.renderResult = (result: any, options: any, theme: any, args?: any) =>
				registeredTool.definition.renderResult!(
					result,
					{
						expanded: options.expanded,
						isPartial: options.isPartial,
						spinnerFrame: options.spinnerFrame,
					},
					theme as Theme,
					args,
				);
		}
	}

	async execute(
		toolCallId: string,
		params: any,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<any>,
		context?: AgentToolContext,
	) {
		if (!this.#isActive()) throw new Error("Extension owner is no longer active");
		// Bind the extension context to this tool's own name so `ctx.invokeTool` delegates to the
		// native built-in of the same name (present only when this tool re-registers a built-in). The
		// wrapper's own context, abort signal, and progress callback are inherited by the delegated
		// call, so a bare `ctx.invokeTool(params)` keeps the caller's `toolCall`/provider metadata
		// (write/edit LSP batching, computer safety acknowledgement), stops when the outer call is
		// aborted, and still streams native progress.
		return this.registeredTool.definition.execute(
			toolCallId,
			params,
			signal,
			onUpdate,
			this.runner.createContext(undefined, {
				toolName: this.registeredTool.definition.name,
				context,
				signal,
				onUpdate,
			}),
		);
	}
}

/**
 * Backward-compatible factory function wrapper.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	return new RegisteredToolAdapter(registeredTool, runner);
}

/**
 * Wrap all registered tools into AgentTools.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map(rt => wrapRegisteredTool(rt, runner));
}

const LOOP_DISPATCH_CONTEXT = Symbol("omp.loop-dispatch");
type LoopAwareToolContext = AgentToolContext & { [LOOP_DISPATCH_CONTEXT]?: string };

function computerSafetyChecks(context: AgentToolContext | undefined): ComputerSafetyCheck[] {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? metadata.pendingSafetyChecks : [];
}

function approvalArgs(params: unknown, context: AgentToolContext | undefined): unknown {
	const metadata = context?.toolCall?.providerMetadata;
	return metadata?.type === "computer" ? { actions: metadata.actions } : params;
}

function toolEventArgs(params: unknown, context: AgentToolContext | undefined): Record<string, unknown> {
	const metadata = context?.toolCall?.providerMetadata;
	if (metadata?.type === "computer") {
		return {
			actions: metadata.actions,
			pendingSafetyChecks: metadata.pendingSafetyChecks,
		};
	}
	return params as Record<string, unknown>;
}

function approvalData(value: string): string {
	const sanitized = sanitizeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
	return sanitized.replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

function safetyCheckLines(checks: readonly ComputerSafetyCheck[]): string[] {
	return checks.map((check, index) => {
		const value = check.message || check.code || check.id;
		return `${index + 1}. ${approvalData(value)}`;
	});
}

/**
 * Wraps a tool with extension callbacks for interception.
 * - Emits tool_call event before execution (can block)
 * - Emits tool_result event after execution (can modify result)
 *
 * `agent` overrides the runner's own `ctx.agent` for those events when the tool
 * runs on behalf of a different agent than the runner's session — the advisor's
 * toolset shares the primary session's runner (for approval enforcement) but
 * must not be reported as the primary agent.
 */
export class ExtensionToolWrapper<TParameters extends TSchema = TSchema, TDetails = unknown> implements AgentTool<
	TParameters,
	TDetails
> {
	declare name: string;
	declare description: string;
	declare parameters: TParameters;
	declare label: string;
	declare strict: boolean;
	readonly #agent: ExtensionAgentIdentity | undefined;

	constructor(
		private tool: AgentTool<TParameters, TDetails>,
		private runner: ExtensionRunner,
		private resolveToolByName?: (name: string) => AgentTool | undefined,
		agent?: ExtensionAgentIdentity,
	) {
		this.#agent = agent;
		applyToolProxy(tool, this);
	}

	/**
	 * Forward browser mode changes when available.
	 */
	restartForModeChange(): Promise<void> {
		const target = this.tool as { restartForModeChange?: () => Promise<void> };
		if (!target.restartForModeChange) return Promise.resolve();
		return target.restartForModeChange();
	}

	async execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		return withToolApprovalScope(() => this.#execute(toolCallId, params, signal, onUpdate, context));
	}

	async #execute(
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TDetails, TParameters>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<TDetails, TParameters>> {
		// Loop dispatch checks TTSR both before and after the extension
		// `tool_call` event in session `beforeToolCall`, before scheduling.
		// Consume the loop marker so this wrapper does not emit the event or
		// preflight again. Direct and nested xd:// calls have no loop marker:
		// their final-input preflight still runs below.
		const dispatchKey = `${toolCallId}:${this.tool.name}`;
		const approvalSessionId = this.runner.sessionId;
		const inheritedLoopDispatch =
			(context as LoopAwareToolContext | undefined)?.[LOOP_DISPATCH_CONTEXT] === dispatchKey;
		const loopDispatchedToolCall =
			(this.runner.consumeLoopToolCall?.(toolCallId, this.tool.name) ?? false) || inheritedLoopDispatch;
		if (loopDispatchedToolCall && context && !inheritedLoopDispatch) {
			(context as LoopAwareToolContext)[LOOP_DISPATCH_CONTEXT] = dispatchKey;
		}
		const loopEmittedToolCall = this.runner.consumeToolCallEmitted(toolCallId, this.tool.name);
		// Resolve approval settings up front. A `deny` on the original input short-circuits before the
		// runner is touched — an already-denied tool never emits `tool_call` — while the full gate below
		// re-resolves against the (possibly revised) input so a handler cannot rewrite into a denied or
		// newly prompt-gated command and have it run unapproved.
		const approvalContext =
			context ?? (this.runner.sessionSettings ? { settings: this.runner.sessionSettings } : undefined);
		const initialApproval = resolveApprovalFromContext(approvalContext);
		const preResolved = resolveApproval(
			this.tool,
			approvalArgs(params, context),
			initialApproval.approvalMode,
			initialApproval.userPolicies,
			undefined,
			undefined,
			undefined,
			context,
		);
		if (preResolved.policy === "deny") {
			throw denyError(preResolved, this.tool.name);
		}

		// 1. Emit tool_call event first - extensions can block execution or revise the input the tool
		// runs with. Doing this BEFORE the approval gate means approval (below) resolves against the
		// input that actually executes, closing the "approve one thing, run another" gap: the prompt
		// text, policy resolution, and provider safety checks all see `effectiveParams`.
		// Passive context collected here is forwarded only once the call has run
		// and produced a non-error result: a block, deny, user reject, fail-closed
		// safety refusal, or failed execution never injects instructions. This
		// matches the loop's rule for context prepared at arg-prep time.
		let pendingAdditionalContext: string | undefined;
		let effectiveParams = params;
		const cancelPreflight = (): void => {
			if (!loopDispatchedToolCall) this.runner.cancelToolCallPreflight?.(toolCallId);
		};
		if (!loopEmittedToolCall && this.runner.hasHandlers("tool_call")) {
			try {
				const callResult = (await this.runner.emitToolCall(
					{
						type: "tool_call",
						toolName: this.tool.name,
						toolCallId,
						...mcpToolEventIdentity(this.tool, toolEventArgs(params, context), this.resolveToolByName),
						input: normalizeToolEventInput(
							this.tool.name,
							resolveToolEventInput(this.tool, toolEventArgs(params, context)),
						),
					},
					signal,
					this.#agent,
				)) as ToolCallEventResult | undefined;

				if (callResult?.block) {
					const reason = callResult.reason || "Tool execution was blocked by an extension";
					throw new Error(reason);
				}
				if (isNonBlankContext(callResult?.additionalContext)) {
					pendingAdditionalContext = callResult.additionalContext;
				}
				// A non-blocking handler may replace the execution input. The returned object is the raw
				// input passed to `execute` (handler-owned; not re-normalized). Skipped for `computer`
				// tool calls, whose event input is a synthetic {actions,pendingSafetyChecks} view
				// (see toolEventArgs) rather than the real execution params.
				if (callResult?.input !== undefined && context?.toolCall?.providerMetadata?.type !== "computer") {
					effectiveParams = callResult.input as typeof params;
				}
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		}
		const runtimeApprovalTool = this.tool as AgentTool<TParameters, TDetails> & RuntimeApprovalCapableTool;
		const captureAuthority = () => {
			try {
				return captureApprovalAuthority(
					this.runner.cwd,
					approvalSessionId,
					approvalContext?.settings,
					this.runner.createContext(),
				);
			} catch {
				return undefined;
			}
		};
		let recheckPreflight = false;
		for (;;) {
			try {
				signal?.throwIfAborted();
				if (this.runner.sessionId !== approvalSessionId) throw new Error("Approval session changed");
				const gateInput = structuredClone(effectiveParams);
				const gateAuthority = captureAuthority();
				if (!loopDispatchedToolCall || recheckPreflight) {
					const preflight = await this.runner.runToolCallPreflightBefore?.(
						toolCallId,
						this.tool,
						effectiveParams,
						context,
					);
					if (preflight?.block)
						throw new Error(preflight.reason || "Tool execution was blocked by a preflight rule");
				}
				const runtimeApproval = await runtimeApprovalTool.prepareRuntimeApproval?.(
					toolCallId,
					effectiveParams,
					signal,
					context,
				);
				if (
					!Bun.deepEquals(gateInput, effectiveParams) ||
					!sameApprovalAuthority(gateAuthority, captureAuthority())
				) {
					runtimeApprovalTool.denyRuntimeApproval?.(toolCallId, effectiveParams);
					recheckPreflight = true;
					continue;
				}
				if (runtimeApproval && !runtimeApprovalTool.approveRuntimeApproval) {
					throw new Error(`Tool "${this.tool.name}" requested runtime approval without a grant handler.`);
				}
				const { approvalMode, userPolicies } = resolveApprovalFromContext(approvalContext);
				const authority = captureAuthority();
				const scope = authority?.scope;
				const credentials = authority?.credentials;
				const approvalOwner = scope === undefined ? undefined : this.runner.createContext();
				const allowPersistentGrants =
					approvalOwner?.model !== undefined &&
					approvalOwner.modelRegistry.authStorage.sourceIdentity !== undefined &&
					approvalOwner.modelRegistry.authStorage.oauth
						.accounts(approvalOwner.model.provider, approvalSessionId)
						.some(account => account.active);
				const inputSnapshot = structuredClone(effectiveParams);
				const resolvedArgs = structuredClone(approvalArgs(inputSnapshot, context));
				const safetySnapshot = structuredClone(computerSafetyChecks(context));
				const targets = await captureApprovalTargets(this.tool, resolvedArgs, this.runner.cwd);
				const restrictions = approvalRestrictions(approvalContext?.settings, this.runner.cwd);
				const approvalGrants =
					approvalMode === "always-ask-cached" && scope !== undefined
						? getApprovalGrants(approvalContext?.settings?.getAgentDir(), approvalSessionId, scope, {
								allowPersistent: allowPersistentGrants,
								sessionAuthority: credentials,
							})
						: undefined;
				const resolved = resolveApproval(
					this.tool,
					resolvedArgs,
					approvalMode,
					userPolicies,
					approvalGrants,
					restrictions,
					targets,
					context,
				);
				context?.xdevTierResolved?.(resolved.tier);
				if (resolved.policy === "deny") throw denyError(resolved, this.tool.name);
				const policyKey = resolved.policyKey ?? this.tool.name;
				const explicitPrompt =
					resolved.override || (resolved.source !== "mode" && policyKey !== context?.xdevPolicyKey);
				const xdevBypass = context?.xdevPolicyKey !== undefined && effectiveParams === params;
				const acp = context?.acpApproval;
				const acpBypass =
					acp !== undefined &&
					acp.toolCallId === toolCallId &&
					acp.toolName === this.tool.name &&
					(resolved.source !== "restriction" || acp.perCall) &&
					!targets.failed &&
					!acp.targets.failed &&
					sameApprovalAuthority(acp.authority, authority) &&
					Bun.deepEquals(inputSnapshot, acp.args) &&
					Bun.deepEquals(targets, acp.targets) &&
					Bun.deepEquals({ approvalMode, userPolicies }, acp.policy) &&
					Bun.deepEquals(restrictions, acp.restrictions);
				const cacheTargets =
					approvalGrants !== undefined &&
					!targets.failed &&
					targets.targets.length > 0 &&
					resolved.policy === "prompt" &&
					resolved.source === "mode" &&
					safetySnapshot.length === 0 &&
					!runtimeApproval &&
					!runtimeApprovalTool.sessionApproval;
				const unboundSessionScope =
					scope !== undefined &&
					!targets.failed &&
					targets.targets.length === 0 &&
					safetySnapshot.length === 0 &&
					!runtimeApproval &&
					!runtimeApprovalTool.sessionApproval
						? sessionApprovalScope(resolved, this.tool.name)
						: undefined;
				const sessionScope = unboundSessionScope && {
					subject: unboundSessionScope.subject,
					key: JSON.stringify([scope, unboundSessionScope.key]),
				};
				const sessionApproved = sessionScope !== undefined && this.runner.hasSessionApproval(sessionScope.key);
				const required =
					runtimeApproval !== undefined ||
					safetySnapshot.length > 0 ||
					(resolved.policy === "prompt" && !acpBypass && !sessionApproved && (explicitPrompt || !xdevBypass));
				const reason = runtimeApproval?.reason ?? resolved.reason;
				const capability = runtimeApprovalTool.sessionApproval;
				const sessionApproval =
					resolved.source !== "restriction" &&
					safetySnapshot.length === 0 &&
					(!runtimeApproval || runtimeApproval.allowSessionApproval === true) &&
					capability?.label &&
					!["Deny", "Approve", "Approve once"].includes(capability.label)
						? capability
						: undefined;
				let approveSession = false;
				let approveModeSession = false;
				let targetGrant: { grant: "folder" | "target"; always: boolean } | undefined;
				if (required) {
					const scheduledCall = context?.toolCall?.toolCalls[context.toolCall.index];
					if (
						scheduledCall?.id === toolCallId &&
						(scheduledCall.name === this.tool.name || scheduledCall.name === this.tool.customWireName)
					) {
						await untilAborted(signal, () => this.runner.waitForToolApprovalPreview(toolCallId));
					}
					const hasApprovalHandlers =
						this.runner.hasHandlers("tool_approval_requested") ||
						this.runner.hasHandlers("tool_approval_resolved");
					if (hasApprovalHandlers) {
						await this.runner.emit({
							type: "tool_approval_requested",
							sessionId: approvalSessionId,
							toolName: this.tool.name,
							toolCallId,
							...(reason ? { reason } : {}),
							approvalMode,
						});
					}
					const emitResolved = async (approved: boolean, reason?: string): Promise<void> => {
						if (hasApprovalHandlers) {
							await this.runner.emit({
								type: "tool_approval_resolved",
								sessionId: approvalSessionId,
								toolName: this.tool.name,
								toolCallId,
								approved,
								...(reason ? { reason } : {}),
							});
						}
					};
					if (!this.runner.hasUI()) {
						await emitResolved(false, "no interactive UI available");
						if (runtimeApproval) {
							throw new Error(
								`Tool "${this.tool.name}" requires runtime approval but no interactive UI is available.`,
							);
						}
						if (safetySnapshot.length > 0) {
							throw new Error(
								`Tool "${this.tool.name}" has pending provider safety checks but no interactive UI is available.`,
							);
						}
						if (resolved.source === "restriction") {
							throw new Error(
								`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
									`Reason: ${resolved.reason}\n` +
									`A restricted folder (tools.restrictedFolders) asks in every approval mode.`,
							);
						}
						throw new Error(
							`Tool "${this.tool.name}" requires approval but no interactive UI available.\n` +
								`Options:\n` +
								`  1. Set tools.approvalMode: yolo in /settings\n` +
								`  2. Add tools.approval.${this.tool.name}: allow to config\n` +
								`  3. Use an interactive UI to approve the tool call`,
						);
					}
					const ui = this.runner.getUIContext();
					if (approvalContext?.settings && cfgApprovalNotify.get(approvalContext.settings) === "on") {
						TERMINAL.sendNotification({
							title: context?.sessionManager?.getSessionName() || "Coreforge",
							body: "Tool approval required",
							type: "approval",
							urgency: "normal",
							actions: "focus",
						});
					}
					let approved = false;
					try {
						if (runtimeApproval) {
							const safetySuffix = safetySnapshot.length
								? `\n\nProvider safety checks:\n${safetyCheckLines(safetySnapshot).join("\n")}`
								: "";
							const choice = await ui.select(
								`Approve ${this.tool.name}?\nReason: ${runtimeApproval.reason}\n${runtimeApproval.prompt}${safetySuffix}`,
								sessionApproval ? ["Deny", "Approve once", sessionApproval.label] : ["Deny", "Approve once"],
								{ tuiStyle: runtimeApproval.tuiStyle },
							);
							approveSession = sessionApproval !== undefined && choice === sessionApproval.label;
							approved = choice === "Approve once" || approveSession;
						} else if (sessionApproval || safetySnapshot.length) {
							const base = formatApprovalPrompt(this.tool, resolvedArgs, reason);
							const choice = await ui.select(
								safetySnapshot.length
									? `${base}\nProvider safety checks:\n${safetyCheckLines(safetySnapshot).join("\n")}`
									: base,
								sessionApproval ? ["Approve", "Deny", sessionApproval.label] : ["Deny", "Approve"],
							);
							approveSession = sessionApproval !== undefined && choice === sessionApproval.label;
							approved = choice === "Approve" || approveSession;
						} else {
							const answer = await requestApproval(ui, this.tool, resolvedArgs, {
								reason,
								sessionSubject: sessionScope?.subject,
								grants: cacheTargets,
								targets,
								allowPersistentGrants,
							});
							approveModeSession = answer === "session" && sessionScope !== undefined;
							targetGrant = typeof answer === "object" ? answer : undefined;
							approved = answer === "once" || approveModeSession || targetGrant !== undefined;
						}
						signal?.throwIfAborted();
						if (this.runner.sessionId !== approvalSessionId) throw new Error("Approval session changed");
					} catch (error) {
						await emitResolved(false, error instanceof Error ? error.message : "approval aborted");
						throw error;
					}
					await emitResolved(approved, approved ? undefined : "denied by user");
					if (!approved) throw new Error(`Tool call denied by user: ${this.tool.name}`);
				}
				const finalTargets = await captureApprovalTargets(
					this.tool,
					approvalArgs(effectiveParams, context),
					this.runner.cwd,
				);
				signal?.throwIfAborted();
				if (
					(approvalMode === "always-ask-cached" || resolved.source === "restriction") &&
					targets.failed &&
					finalTargets.failed
				) {
					throw new Error(`Tool "${this.tool.name}" approval target identity is unavailable; execution refused.`);
				}
				if (this.runner.sessionId !== approvalSessionId) throw new Error("Approval session changed");
				const finalPolicy = resolveApprovalFromContext(approvalContext);
				if (
					!Bun.deepEquals(inputSnapshot, effectiveParams) ||
					!Bun.deepEquals(resolvedArgs, approvalArgs(effectiveParams, context)) ||
					!Bun.deepEquals(targets, finalTargets) ||
					!sameApprovalAuthority(authority, captureAuthority()) ||
					!Bun.deepEquals(safetySnapshot, computerSafetyChecks(context)) ||
					!Bun.deepEquals({ approvalMode, userPolicies }, finalPolicy) ||
					!Bun.deepEquals(
						resolved,
						resolveApproval(
							this.tool,
							approvalArgs(effectiveParams, context),
							finalPolicy.approvalMode,
							finalPolicy.userPolicies,
							approvalGrants,
							approvalRestrictions(approvalContext?.settings, this.runner.cwd),
							finalTargets,
							context,
						),
					)
				) {
					runtimeApprovalTool.denyRuntimeApproval?.(toolCallId, effectiveParams);
					recheckPreflight = true;
					continue;
				}
				if (runtimeApproval && required) runtimeApprovalTool.approveRuntimeApproval!(toolCallId, effectiveParams);
				if (safetySnapshot.length) {
					if (!context) throw new Error("Provider safety approval context is unavailable");
					context.providerSafetyApproved = true;
				}
				if (approveSession) sessionApproval!.approve();
				if (approveModeSession) this.runner.grantSessionApproval(sessionScope!.key);
				if (targetGrant && approvalGrants) {
					recordApprovalGrant(this.tool, resolvedArgs, approvalGrants, resolved.tier, targetGrant, targets);
				}
				break;
			} catch (error) {
				cancelPreflight();
				runtimeApprovalTool.denyRuntimeApproval?.(toolCallId, effectiveParams);
				throw error;
			}
		}

		// Registry entries can change while the tool runs; preserve the identity selected for this execution.
		const resultMcpIdentity = this.runner.hasHandlers("tool_result")
			? mcpToolEventIdentity(this.tool, toolEventArgs(effectiveParams, context), this.resolveToolByName)
			: null;

		// Execute the actual tool
		let result: AgentToolResult<TDetails, TParameters>;
		let executionError: Error | undefined;

		try {
			// Name the owning session for process-wide file-mutation fallbacks and
			// expose its settings to registered tools and any fallback handlers they
			// trigger. `sdk.ts` wraps the whole tool registry with this class whenever
			// a runner exists.
			result = await this.runner.runScoped(() =>
				withFileMutationSession(this.runner.sessionId, () =>
					this.tool.execute(toolCallId, effectiveParams, signal, onUpdate, context),
				),
			);
		} catch (err) {
			executionError = toError(err);
			result = {
				content: [{ type: "text", text: executionError.message }],
				details: undefined as TDetails,
			};
		}
		if (!loopDispatchedToolCall) {
			const postflight = await this.runner.runToolCallPreflightAfter?.(toolCallId, result, context);
			if (postflight) result = postflight as AgentToolResult<TDetails, TParameters>;
		}

		// Emit tool_result event - extensions can modify the result and error status
		if (resultMcpIdentity) {
			const resultResult = await this.runner.emitToolResult(
				{
					type: "tool_result",
					toolName: this.tool.name,
					toolCallId,
					...resultMcpIdentity,
					input: normalizeToolEventInput(
						this.tool.name,
						resolveToolEventInput(this.tool, toolEventArgs(effectiveParams, context)),
					),
					content: result.content,
					details: result.details,
					isError: !!executionError || result.isError === true,
				},
				this.#agent,
			);

			// Handler context reports into this call's sink like tool-authored
			// context: it is delivered even for a failed call (the handler saw
			// `isError`), and precedes any pending `tool_call` context.
			if (resultResult?.additionalContext !== undefined) {
				context?.addAdditionalContext?.(resultResult.additionalContext);
			}

			// `content` is present only when a handler modified the result.
			if (resultResult?.content !== undefined) {
				const modifiedContent: (TextContent | ImageContent)[] = resultResult.content;
				const modifiedDetails = (resultResult.details ?? result.details) as TDetails;

				// Effective error state: an explicit handler override wins; otherwise the
				// original execution outcome stands. This lets a handler rewrite a failed
				// call's model-visible content/details while keeping it an error, flip a
				// failure to success, or flag a success as an error.
				const effectiveError = resultResult.isError ?? !!executionError;
				if (!effectiveError && pendingAdditionalContext !== undefined) {
					context?.addAdditionalContext?.(pendingAdditionalContext);
				}

				// Return the (possibly modified) result carrying the error flag rather than
				// rethrowing the original exception. The agent loop honors
				// `AgentToolResult.isError` and surfaces it as a tool error on the wire (see
				// `coerceToolResult` in agent-loop), so replacement failure content reaches
				// the model while the call remains an error — the original exception text is
				// no longer forced through, which previously discarded the replacement.
				return {
					content: modifiedContent,
					details: modifiedDetails,
					providerMetadata: result.providerMetadata,
					...(effectiveError ? { isError: true } : {}),
				};
			}
		}

		// No extension modification
		if (executionError) {
			throw executionError;
		}
		if (result.isError !== true && pendingAdditionalContext !== undefined) {
			context?.addAdditionalContext?.(pendingAdditionalContext);
		}
		return result;
	}
}
