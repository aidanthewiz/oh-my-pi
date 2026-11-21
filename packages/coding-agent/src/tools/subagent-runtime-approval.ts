import { TERMINAL } from "@oh-my-pi/pi-tui";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import { type AgentRef, MAIN_AGENT_ID, type AgentRegistryApi } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import {
	approvalRestrictions,
	captureApprovalAuthority,
	captureApprovalTargets,
	resolveApproval,
	resolveApprovalFromContext,
	type RuntimeToolApprovalRequest,
	sameApprovalAuthority,
} from "./approval";
import type { ToolSession } from "./index";
import { cfgApprovalNotify } from "./settings";
import type { AgentSessionHandle } from "../session/agent-session-handle";
import { registerRpcError, rpcSync } from "../thread/rpc";

export interface SubagentRuntimeApprovalRequest {
	readonly agentId: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly toolName: string;
	readonly toolCallId: string;
	readonly args: unknown;
	readonly approval: RuntimeToolApprovalRequest;
	readonly policyReason?: string;
}

export type SubagentRuntimeApprovalResult =
	| { readonly decision: "approved"; readonly validate: () => void }
	| { readonly decision: "denied" }
	| { readonly decision: "cancelled"; readonly reason: "request-aborted" | "selector-cancelled" }
	| {
			readonly decision: "unavailable";
			readonly reason:
				| "host-unavailable"
				| "host-retired"
				| "host-ineligible"
				| "requester-invalid"
				| "context-unavailable"
				| "authority-changed"
				| "tool-unregistered"
				| "parent-policy"
				| "state-changed"
				| "unsupported-decision";
			readonly detail: string;
	  };

type SubagentRuntimeApprovalRefusal = Exclude<SubagentRuntimeApprovalResult, { decision: "approved" }>;

export class ParentRuntimeApprovalError extends Error {
	readonly code: `parent_approval_${SubagentRuntimeApprovalRefusal["decision"]}`;
	readonly decision: SubagentRuntimeApprovalRefusal["decision"];
	readonly reason: string | undefined;
	readonly detail: string | undefined;

	constructor(toolName: string, result: SubagentRuntimeApprovalRefusal) {
		const code = `parent_approval_${result.decision}` as const;
		const reason = "reason" in result ? result.reason : undefined;
		const detail = "detail" in result ? result.detail : undefined;
		super(
			`Parent runtime approval ${result.decision} [${code}${reason ? `/${reason}` : ""}]: ${toolName}${detail ? `. ${detail}` : ""}`,
		);
		this.name = "ParentRuntimeApprovalError";
		this.code = code;
		this.decision = result.decision;
		this.reason = reason;
		this.detail = detail;
	}
}

registerRpcError("ParentRuntimeApprovalError", message =>
	Object.assign(Object.setPrototypeOf(new Error(message), ParentRuntimeApprovalError.prototype), {
		name: "ParentRuntimeApprovalError",
	}),
);

interface ApprovalHostState {
	readonly registry: AgentRegistryApi;
	readonly lifetime: AbortSignal;
	readonly rootReference: WeakRef<AgentSession>;
	readonly rootAgentReference?: WeakRef<AgentRef>;
	readonly rootId: string;
	readonly rootSessionId: string;
	readonly toolSessionReference: WeakRef<ToolSession>;
}

/** A live host capability, never a persisted grant or a model-visible tool. */
export type SubagentRuntimeApprovalHandler = (
	request: SubagentRuntimeApprovalRequest,
	signal?: AbortSignal,
) => Promise<SubagentRuntimeApprovalResult>;

export function createSubagentRuntimeApprovalHandler(options: {
	root: AgentSession;
	registry: AgentRegistryApi;
	toolSession: ToolSession;
	signal: AbortSignal;
}): SubagentRuntimeApprovalHandler {
	const { registry, signal: lifetime } = options;
	const rootReference = new WeakRef(options.root);
	const rootId = options.root.getAgentId() ?? MAIN_AGENT_ID;
	const rootIdentity = registry.get(rootId);
	const rootAgentReference = rootIdentity ? new WeakRef(rootIdentity) : undefined;
	const rootSessionId = options.root.sessionId;
	return requestSubagentRuntimeApproval.bind({
		registry,
		lifetime,
		rootReference,
		rootAgentReference,
		rootId,
		rootSessionId,
		toolSessionReference: new WeakRef(options.toolSession),
	});
}

async function requestSubagentRuntimeApproval(
	this: ApprovalHostState,
	originalRequest: SubagentRuntimeApprovalRequest,
	callerSignal?: AbortSignal,
): Promise<SubagentRuntimeApprovalResult> {
	const { registry, lifetime, rootReference, rootAgentReference, rootId, rootSessionId, toolSessionReference } = this;
	if (callerSignal?.aborted) return { decision: "cancelled", reason: "request-aborted" };
	if (lifetime.aborted)
		return { decision: "unavailable", reason: "host-retired", detail: "The owning session retired this capability." };
	const root = rootReference.deref();
	const rootRef = rootAgentReference?.deref();
	if (!root || !rootRef)
		return {
			decision: "unavailable",
			reason: "host-unavailable",
			detail: "The owning parent session is unavailable.",
		};
	const request = structuredClone(originalRequest);
	const runner = root.extensionRunner;
	const signals = [
		lifetime,
		...(callerSignal ? [callerSignal] : []),
		...(runner ? [runner.getUIContextSignal()] : []),
	];
	const signal = AbortSignal.any(signals);
	if (
		signal.aborted ||
		root.isDisposed ||
		root.isSessionTransitioning ||
		root.sessionId !== rootSessionId ||
		!rootRef ||
		registry.get(rootId) !== rootRef ||
		rootRef.session !== root ||
		rootRef.status === "aborted" ||
		!runner?.hasUI() ||
		runner.createContext().mode !== "tui" ||
		request.toolName !== "bash" ||
		request.approval.allowParentApproval !== true
	)
		return {
			decision: "unavailable",
			reason: "host-ineligible",
			detail: "A current owning TUI host is unavailable for this request.",
		};

	const origin = registry.get(request.agentId);
	const originSession = origin?.session;
	const chain: string[] = [];
	const ancestry: Array<{ reference: NonNullable<typeof origin>; session: AgentSessionHandle; parentId?: string }> =
		[];
	const visited = new Set<string>();
	let current = origin;
	while (current && current !== rootRef) {
		if (visited.has(current.id) || !current.session || current.session.isDisposed || current.status === "aborted")
			return {
				decision: "unavailable",
				reason: "requester-invalid",
				detail: "The requester ancestry is no longer current.",
			};
		visited.add(current.id);
		ancestry.push({ reference: current, session: current.session, parentId: current.parentId });
		chain.push(`${JSON.stringify(current.displayName)} (${JSON.stringify(current.id)})`);
		current = current.parentId ? registry.get(current.parentId) : undefined;
	}
	if (
		!origin ||
		!originSession ||
		origin === rootRef ||
		current !== rootRef ||
		originSession.sessionManager.getSessionId() !== request.sessionId ||
		originSession.sessionManager.getCwd() !== request.cwd
	)
		return {
			decision: "unavailable",
			reason: "requester-invalid",
			detail: "The requester identity, session or working directory is not current.",
		};

	const ui: ExtensionUIContext = runner.getUIContext();
	const toolSession = toolSessionReference.deref();
	const ownerCurrent = toolSession?.captureOwnerCurrent?.();
	const context = toolSession?.getToolContext?.();
	if (!ownerCurrent || !context)
		return {
			decision: "unavailable",
			reason: "context-unavailable",
			detail: "The parent tool context is unavailable.",
		};
	const authority = captureApprovalAuthority(root.sessionManager.getCwd(), rootSessionId, context.settings, context);
	if (!authority || !ownerCurrent())
		return {
			decision: "unavailable",
			reason: "authority-changed",
			detail: "The parent approval authority is no longer current.",
		};
	const tool = root.getToolByName(request.toolName);
	if (!tool)
		return {
			decision: "unavailable",
			reason: "tool-unregistered",
			detail: "The parent does not register this tool.",
		};
	const policy = resolveApprovalFromContext(context);
	const targets = await captureApprovalTargets(tool, request.args, request.cwd);
	const restrictions = approvalRestrictions(context.settings, request.cwd);
	const resolved = resolveApproval(
		tool,
		request.args,
		policy.approvalMode,
		policy.userPolicies,
		undefined,
		restrictions,
		targets,
		context,
	);
	if (resolved.policy !== "allow")
		return {
			decision: "unavailable",
			reason: "parent-policy",
			detail: `The parent policy does not permit this forwarding route (${resolved.policy}). Retrying with the same policy cannot approve the call.`,
		};
	const identity = [
		`Subagent approval: ${chain.reverse().join(" → ")}`,
		`Session: ${JSON.stringify(request.sessionId)}`,
		`Working directory: ${JSON.stringify(request.cwd)}`,
		`Tool call: ${JSON.stringify(request.toolCallId)}`,
		...(request.policyReason ? [`Child policy: ${JSON.stringify(request.policyReason)}`] : []),
		...(resolved.reason ? [`Parent policy: ${JSON.stringify(resolved.reason)}`] : []),
	].join("\n");
	const isCurrent = (): boolean =>
		!signal.aborted &&
		!root.isDisposed &&
		!root.isSessionTransitioning &&
		root.sessionId === rootSessionId &&
		registry.get(rootId) === rootRef &&
		rootRef.session === root &&
		rootRef.status !== "aborted" &&
		ancestry.every(
			({ reference, session, parentId }) =>
				registry.get(reference.id) === reference &&
				reference.parentId === parentId &&
				reference.session === session &&
				!session.isDisposed &&
				reference.status !== "aborted",
		) &&
		root.getToolByName(request.toolName) === tool &&
		originSession.sessionManager.getSessionId() === request.sessionId &&
		originSession.sessionManager.getCwd() === request.cwd &&
		ownerCurrent() &&
		runner.hasUI() &&
		runner.createContext().mode === "tui" &&
		runner.getUIContext() === ui &&
		Bun.deepEquals(originalRequest, request) &&
		sameApprovalAuthority(
			authority,
			captureApprovalAuthority(
				root.sessionManager.getCwd(),
				rootSessionId,
				context.settings,
				runner.createContext(),
			),
		);
	if (!isCurrent())
		return {
			decision: "unavailable",
			reason: "state-changed",
			detail: "The approval request or parent authority changed before presentation.",
		};
	if (context.settings && cfgApprovalNotify.get(context.settings) === "on") {
		TERMINAL.sendNotification({
			title: root.sessionManager.getSessionName() || "Coreforge",
			body: "Tool approval required",
			type: "approval",
			urgency: "normal",
			actions: "focus",
		});
	}
	try {
		const choice = await root.waitForUser(() =>
			untilAborted(signal, () =>
				ui.select(
					`${identity}\n\nApprove ${request.toolName}?\nReason: ${request.approval.reason}\n${request.approval.prompt}`,
					["Deny", "Approve once"],
					{ signal, tuiStyle: request.approval.tuiStyle },
				),
			),
		);
		if (signal.aborted) return { decision: "cancelled", reason: "request-aborted" };
		if (!isCurrent())
			return {
				decision: "unavailable",
				reason: "state-changed",
				detail: "The approval request or parent authority changed while awaiting a decision.",
			};
		if (choice === "Approve once")
			return {
				decision: "approved",
				validate: rpcSync(() => {
					callerSignal?.throwIfAborted();
					if (!isCurrent())
						throw new ParentRuntimeApprovalError(request.toolName, {
							decision: "unavailable",
							reason: "state-changed",
							detail: "The approval request or parent authority changed before execution.",
						});
				}),
			};
		if (choice === "Deny") return { decision: "denied" };
		if (choice === undefined) return { decision: "cancelled", reason: "selector-cancelled" };
		return {
			decision: "unavailable",
			reason: "unsupported-decision",
			detail: "The parent selector returned an unsupported decision.",
		};
	} catch (error) {
		if (signal.aborted) return { decision: "cancelled", reason: "request-aborted" };
		throw error;
	}
}
