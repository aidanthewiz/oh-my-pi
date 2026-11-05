import type {
	AgentTool,
	AgentToolContext,
	AgentToolDocTopic,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import { getOperationalAwsLaunchMetadata, getReservedManagedAwsProfiles, prompt } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { ToolSession } from ".";
import type { Settings } from "../config/settings";
import description from "../prompts/tools/aws-db.md" with { type: "text" };
import approvalPrompt from "../prompts/tools/aws-db-approval.md" with { type: "text" };
import stepPrompt from "../prompts/tools/aws-db-step-approval.md" with { type: "text" };
import {
	assertAwsDbCapability,
	assertAwsDbPlainData,
	AWS_DB_CAPABILITY,
	AWS_DB_MANIFEST,
	AwsDbFailure,
	awsDbRequestFingerprint,
	awsDbSchema,
	normalizeAwsDbRequest,
	safeAwsDbFailure,
	type AwsDbInspectionRequest,
	type AwsDbRequest,
} from "./aws-db-contract";
import type { AwsDbLaunchFiles, AwsDbStep } from "./aws-db-scope";
import { assertSafeTemplateResult, type AwsDbWorkerDependencies } from "./aws-db-worker-protocol";
import { probeAwsDbWorker, runAwsDbWorker } from "./aws-db-worker-client";
import {
	captureApprovalAuthority,
	requestApproval,
	resolveApproval,
	resolveApprovalFromContext,
	sameApprovalAuthority,
	type RuntimeToolApprovalRequest,
} from "./approval";
import { enforceDestructiveCommandGuard } from "./destructive-command-guard";
import { toolResult } from "./tool-result";

export interface AwsDbToolDependencies extends AwsDbWorkerDependencies {
	launch?: () => AwsDbLaunchFiles;
}
export interface AwsDbToolDetails {
	response: unknown;
	meta?: OutputMeta;
}
interface PreparedInspection {
	request: AwsDbInspectionRequest;
	fingerprint: string;
	sessionId: string | null;
	settings: Settings;
	revision: number;
	approved: boolean;
}

export class AwsDbTool implements AgentTool<typeof awsDbSchema, AwsDbToolDetails> {
	readonly name = "aws_db";
	readonly label = "AWS Database";
	readonly summary = "Inspect one approved automation template inside an isolated memory-only AWS database scope";
	readonly description = prompt.render(description);
	readonly parameters = awsDbSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly cancellationBehavior = "await-cleanup";
	#prepared = new Map<string, PreparedInspection>();
	#active = new Set<AbortController>();
	#generation = 0;
	#disposed = false;
	#lifecycleBound = false;

	constructor(
		private readonly session: ToolSession,
		private readonly dependencies: AwsDbToolDependencies = {},
	) {
		const invalidate = (): void => {
			this.#generation++;
			this.#prepared.clear();
			for (const controller of this.#active) controller.abort();
			this.#active.clear();
		};
		try {
			const dispose = session.registerDisposeCallback?.(
				() => {
					this.#disposed = true;
					invalidate();
				},
				{ phase: "begin" },
			);
			const change = session.registerSessionChangeCallback?.(invalidate);
			this.#lifecycleBound = typeof dispose === "function" && typeof change === "function";
		} catch {
			this.#lifecycleBound = false;
		}
	}

	docTopics(): Readonly<Record<string, AgentToolDocTopic>> {
		return {
			schema: { format: "json", value: { name: this.name, inputSchema: this.parameters.toJsonSchema() } },
		};
	}

	#sessionId(): string | null {
		return this.session.getSessionId?.() ?? this.session.sessionManager?.getSessionId?.() ?? null;
	}
	#requireHost(request: AwsDbRequest): void {
		try {
			if (this.#disposed) throw new AwsDbFailure("CANCELLED");
			if (
				!this.#lifecycleBound ||
				typeof this.session.isDisposed !== "function" ||
				typeof this.session.getToolExecutionCapabilities !== "function"
			)
				throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
			if (this.session.isDisposed()) throw new AwsDbFailure("CANCELLED");
			const sessionId = this.#sessionId();
			if (typeof sessionId !== "string" || sessionId.length === 0) throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
			const host = this.session.getToolExecutionCapabilities(this, request);
			assertAwsDbPlainData(host, "CAPABILITY_INCOMPATIBLE");
			if (
				!host ||
				Object.keys(host).length !== 3 ||
				host.protocol !== AWS_DB_MANIFEST.hostPolicy ||
				host.cancellationCleanup !== AWS_DB_MANIFEST.executionPolicy ||
				host.sessionLifecycle !== AWS_DB_MANIFEST.lifecyclePolicy
			)
				throw new AwsDbFailure("CAPABILITY_INCOMPATIBLE");
		} catch (error) {
			throw new AwsDbFailure(safeAwsDbFailure(error) === "CANCELLED" ? "CANCELLED" : "CAPABILITY_INCOMPATIBLE");
		}
	}
	#normalize(args: unknown): AwsDbRequest {
		if (this.#disposed) throw new AwsDbFailure("CANCELLED");
		const request = normalizeAwsDbRequest(args);
		this.#requireHost(request);
		return request;
	}
	async #probe(request: AwsDbRequest, signal?: AbortSignal): Promise<void> {
		const controller = new AbortController();
		const cancel = (): void => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) controller.abort();
		this.#active.add(controller);
		try {
			if (controller.signal.aborted) throw new AwsDbFailure("CANCELLED");
			this.#requireHost(request);
			const value = await (this.dependencies.probeWorker ?? probeAwsDbWorker)(controller.signal);
			if (controller.signal.aborted) throw new AwsDbFailure("CANCELLED");
			this.#requireHost(request);
			assertAwsDbCapability(value);
		} catch (error) {
			throw new AwsDbFailure(controller.signal.aborted ? "CANCELLED" : safeAwsDbFailure(error));
		} finally {
			signal?.removeEventListener("abort", cancel);
			this.#active.delete(controller);
		}
	}
	readonly approval = (args: unknown): ToolApprovalDecision => {
		const request = this.#normalize(args);
		return request.action === "capabilities" ? { tier: "read", policy: "allow" } : { tier: "read" };
	};
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const request = this.#normalize(args);
		return request.action === "capabilities"
			? []
			: prompt
					.render(approvalPrompt, {
						capability: request.capability,
						fingerprint: awsDbRequestFingerprint(request),
						sanitizerPolicy: AWS_DB_MANIFEST.sanitizerPolicy,
						readPolicy: AWS_DB_MANIFEST.readPolicy,
						request: JSON.stringify(request, null, 2),
					})
					.trim()
					.split("\n");
	};
	async prepareApprovalTier(args: unknown, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new AwsDbFailure("CANCELLED");
		const request = this.#normalize(args);
		try {
			await this.#probe(request, signal);
		} catch (error) {
			throw new ToolError(safeAwsDbFailure(error));
		}
		if (signal?.aborted) throw new AwsDbFailure("CANCELLED");
	}
	#approvalSettings(context?: AgentToolContext): Settings {
		return context?.settings ?? this.session.getToolContext?.()?.settings ?? this.session.settings;
	}
	#policy(name: string, args: unknown, context?: AgentToolContext): "allow" | "prompt" {
		const owner = context ?? this.session.getToolContext?.();
		const execution = resolveApprovalFromContext({
			autoApprove: owner?.autoApprove,
			settings: this.#approvalSettings(owner),
		});
		const decision = resolveApproval(
			{ name, approval: "read" },
			args,
			execution.approvalMode,
			execution.userPolicies,
		);
		if (decision.policy === "deny") throw new AwsDbFailure("POLICY_DENIED");
		return decision.policy;
	}
	async prepareRuntimeApproval(
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<RuntimeToolApprovalRequest | undefined> {
		this.#prepared.delete(toolCallId);
		const sessionId = this.#sessionId();
		const generation = this.#generation;
		const request = this.#normalize(args);
		try {
			await this.prepareApprovalTier(request, signal);
		} catch (error) {
			if (this.#disposed || this.session.isDisposed?.()) throw new ToolError("CANCELLED");
			if (generation !== this.#generation || sessionId !== this.#sessionId())
				throw new ToolError("APPROVAL_REQUIRED");
			throw error;
		}
		try {
			if (this.#disposed) throw new AwsDbFailure("CANCELLED");
			if (sessionId !== this.#sessionId() || generation !== this.#generation)
				throw new AwsDbFailure("APPROVAL_REQUIRED");
			this.#policy("aws_db", request, context);
			if (request.action === "capabilities") return undefined;
			this.#policy("aws", request, context);
			const fingerprint = awsDbRequestFingerprint(request);
			const settings = this.#approvalSettings(context);
			this.#prepared.set(toolCallId, {
				request,
				fingerprint,
				sessionId,
				settings,
				revision: settings.revision,
				approved: false,
			});
			return {
				reason: "Single memory-only AWS database inspection",
				prompt: prompt.render(approvalPrompt, {
					capability: request.capability,
					fingerprint,
					sanitizerPolicy: AWS_DB_MANIFEST.sanitizerPolicy,
					readPolicy: AWS_DB_MANIFEST.readPolicy,
					request: JSON.stringify(request, null, 2),
				}),
				allowSessionApproval: false,
			};
		} catch (error) {
			throw new ToolError(safeAwsDbFailure(error));
		}
	}
	approveRuntimeApproval(toolCallId: string, args: unknown): void {
		const prepared = this.#prepared.get(toolCallId);
		if (!prepared) return;
		try {
			const request = this.#normalize(args);
			if (
				request.action !== "inspect-automation-template" ||
				prepared.sessionId !== this.#sessionId() ||
				prepared.settings.revision !== prepared.revision ||
				prepared.fingerprint !== awsDbRequestFingerprint(request)
			) {
				this.#prepared.delete(toolCallId);
				return;
			}
			prepared.approved = true;
		} catch {
			this.#prepared.delete(toolCallId);
		}
	}
	denyRuntimeApproval(toolCallId: string, _args: unknown): void {
		this.#prepared.delete(toolCallId);
	}

	#launch(): AwsDbLaunchFiles {
		if (this.dependencies.launch) return this.dependencies.launch();
		const launch = getOperationalAwsLaunchMetadata();
		if (!launch) throw new AwsDbFailure("PROFILE_UNSUPPORTED");
		return Object.freeze({
			configFile: launch.configFile,
			sharedCredentialsFile: launch.sharedCredentialsFile,
			homeDir: launch.homeDirectory,
			reservedProfiles: Object.freeze([...getReservedManagedAwsProfiles()]),
		});
	}

	async #authorizeStep(
		step: AwsDbStep,
		request: AwsDbInspectionRequest,
		sessionId: string | null,
		signal: AbortSignal,
		context?: AgentToolContext,
	): Promise<void> {
		if (signal.aborted) throw new AwsDbFailure("CANCELLED");
		if (sessionId !== this.#sessionId()) throw new AwsDbFailure("APPROVAL_REQUIRED");
		this.#requireHost(request);
		assertAwsDbPlainData(step, "GUARD_DENIED");
		if (
			!step ||
			typeof step !== "object" ||
			Array.isArray(step) ||
			Object.keys(step).some(key => !["service", "operation", "resource", "roleName", "region"].includes(key))
		)
			throw new AwsDbFailure("GUARD_DENIED");
		const expected = request.expected;
		let flags: string[];
		switch (`${step.service}:${step.operation}`) {
			case "sts:get-caller-identity":
				if (step.resource || step.roleName) throw new AwsDbFailure("GUARD_DENIED");
				flags = [];
				break;
			case "rds:describe-db-clusters":
				if (step.resource !== expected.clusterArn) throw new AwsDbFailure("GUARD_DENIED");
				flags = ["--db-cluster-identifier", expected.clusterArn, "--max-records", "20"];
				break;
			case "rds:describe-db-instances":
				if (step.resource !== expected.instanceArn) throw new AwsDbFailure("GUARD_DENIED");
				flags = ["--db-instance-identifier", expected.instanceArn, "--max-records", "20"];
				break;
			case "rds:list-tags-for-resource":
				if (step.resource !== expected.clusterArn && step.resource !== expected.instanceArn)
					throw new AwsDbFailure("GUARD_DENIED");
				flags = ["--resource-name", step.resource];
				break;
			case "secretsmanager:describe-secret":
			case "secretsmanager:get-secret-value":
				if (step.resource !== expected.secretArn) throw new AwsDbFailure("GUARD_DENIED");
				flags = ["--secret-id", expected.secretArn];
				if (step.operation === "get-secret-value")
					flags.push("--version-id", expected.secretVersionId, "--version-stage", "AWSCURRENT");
				break;
			case "sso:get-role-credentials":
				if (
					step.resource !== expected.accountId ||
					typeof step.roleName !== "string" ||
					!/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(step.roleName) ||
					/[\u0000-\u001f\u007f]/u.test(step.roleName)
				)
					throw new AwsDbFailure("GUARD_DENIED");
				flags = ["--account-id", expected.accountId, "--role-name", step.roleName];
				break;
			default:
				throw new AwsDbFailure("GUARD_DENIED");
		}
		const region = step.region ?? expected.region;
		if (step.service !== "sso" ? region !== expected.region : !/^[a-z][a-z0-9-]{1,31}$/u.test(region))
			throw new AwsDbFailure("GUARD_DENIED");
		const partition = region.startsWith("us-gov-") ? "aws-us-gov" : region.startsWith("cn-") ? "aws-cn" : "aws";
		if (partition !== expected.partition || /[\u0000-\u001f\u007f]/u.test(region))
			throw new AwsDbFailure("GUARD_DENIED");
		if (step.service !== "sso" && step.roleName !== undefined) throw new AwsDbFailure("GUARD_DENIED");
		this.#policy("aws_db", request, context);
		this.#policy("aws", step, context);
		this.#policy(`aws.${step.service}.${step.operation}`, step, context);
		const command = ["aws", "--profile", request.profile, "--region", region, step.service, step.operation, ...flags]
			.map(word => JSON.stringify(word))
			.join(" ");
		let asks: boolean;
		try {
			asks = (await enforceDestructiveCommandGuard(command, this.session.cwd, "posix", signal))?.decision === "ask";
		} catch {
			throw new AwsDbFailure("GUARD_DENIED");
		}
		this.#policy("aws_db", request, context);
		const awsPolicy = this.#policy("aws", step, context);
		const stepPolicy = this.#policy(`aws.${step.service}.${step.operation}`, step, context);
		if (asks || awsPolicy === "prompt" || stepPolicy === "prompt") {
			const activeContext = context ?? this.session.getToolContext?.();
			if (!activeContext?.ui) throw new AwsDbFailure("APPROVAL_REQUIRED");
			const settings = this.#approvalSettings(activeContext);
			const authority = captureApprovalAuthority(this.session.cwd, sessionId ?? "", settings, activeContext);
			const revision = settings.revision;
			if (!authority) throw new AwsDbFailure("APPROVAL_REQUIRED");
			const accepted = await requestApproval(
				activeContext.ui,
				{
					name: "aws",
					approval: "read",
					formatApprovalDetails: () =>
						prompt
							.render(stepPrompt, { command, fingerprint: awsDbRequestFingerprint(request) })
							.trim()
							.split("\n"),
				},
				step,
				{ reason: "Guarded internal AWS database step", allowPersistentGrants: false },
			);
			if (accepted !== "once") throw new AwsDbFailure("GUARD_DENIED");
			const currentContext = this.session.getToolContext?.() ?? context;
			const currentSettings = this.#approvalSettings(currentContext);
			const currentAuthority = currentContext
				? captureApprovalAuthority(this.session.cwd, this.#sessionId() ?? "", currentSettings, currentContext)
				: undefined;
			if (
				settings !== currentSettings ||
				revision !== currentSettings.revision ||
				!sameApprovalAuthority(authority, currentAuthority)
			)
				throw new AwsDbFailure("APPROVAL_REQUIRED");
		}
		this.#policy("aws_db", request, context);
		this.#policy("aws", step, context);
		this.#policy(`aws.${step.service}.${step.operation}`, step, context);
		this.#requireHost(request);
		if (signal.aborted || sessionId !== this.#sessionId()) throw new AwsDbFailure("CANCELLED");
	}

	async execute(
		toolCallId: string,
		args: AwsDbRequest,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AwsDbToolDetails, typeof awsDbSchema>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AwsDbToolDetails>> {
		const controller = new AbortController();
		const cancel = (): void => controller.abort();
		let timer: Timer | undefined;
		let timedOut = false;
		try {
			const request = this.#normalize(args);
			this.#policy("aws_db", request, context);
			if (request.action === "capabilities") {
				await this.#probe(request, signal);
				return toolResult<AwsDbToolDetails>({ response: AWS_DB_CAPABILITY })
					.text(JSON.stringify(AWS_DB_CAPABILITY))
					.done();
			}
			this.#policy("aws", request, context);
			const prepared = this.#prepared.get(toolCallId);
			this.#prepared.delete(toolCallId);
			if (
				!prepared?.approved ||
				prepared.sessionId !== this.#sessionId() ||
				prepared.settings !== this.#approvalSettings(context) ||
				prepared.settings.revision !== prepared.revision ||
				prepared.fingerprint !== awsDbRequestFingerprint(request)
			)
				throw new AwsDbFailure("APPROVAL_REQUIRED");
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) controller.abort();
			if (controller.signal.aborted) throw new AwsDbFailure("CANCELLED");
			this.#active.add(controller);
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, request.limits.timeoutMs);
			const result = await (this.dependencies.runWorker ?? runAwsDbWorker)(
				prepared.request,
				this.#launch(),
				step => this.#authorizeStep(step, prepared.request, prepared.sessionId, controller.signal, context),
				controller.signal,
			);
			if (controller.signal.aborted) throw new AwsDbFailure(timedOut ? "TIMEOUT" : "CANCELLED");
			if (prepared.sessionId !== this.#sessionId()) throw new AwsDbFailure("APPROVAL_REQUIRED");
			this.#requireHost(prepared.request);
			assertSafeTemplateResult(result);
			const safeResult = Object.freeze({
				disposition: result.disposition,
				...(result.disposition === "sanitized" ? { structure: result.structure } : {}),
				proof: Object.freeze({ sameConnection: true, reader: true }),
				teardown: Object.freeze({ connectionClosed: true, referencesReleased: true }),
			});
			const value = Object.freeze({
				ok: true,
				capability: AWS_DB_CAPABILITY.capability,
				readPolicy: AWS_DB_MANIFEST.readPolicy,
				sanitizerPolicy: AWS_DB_MANIFEST.sanitizerPolicy,
				limits: Object.freeze({ ...prepared.request.limits }),
				result: safeResult,
			});
			return toolResult<AwsDbToolDetails>({ response: value }).text(JSON.stringify(value)).done();
		} catch (error) {
			const code = timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" : safeAwsDbFailure(error);
			const value = { ok: false, code };
			return toolResult<AwsDbToolDetails>({ response: value }).text(JSON.stringify(value)).error().done();
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			this.#active.delete(controller);
			this.#prepared.delete(toolCallId);
		}
	}
}
