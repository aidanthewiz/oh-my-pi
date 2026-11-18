import type { AgentTool, AgentToolContext, AgentToolResult, ToolApprovalDecision } from "@oh-my-pi/pi-agent-core";
import { getOperationalAwsLaunchMetadata, getReservedManagedAwsProfiles } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { ToolSession } from ".";
import type { Settings } from "../config/settings";
import {
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_LIMITS,
	AWS_SECRET_INPUT_MANIFEST,
	AwsSecretInputFailure,
	assertAwsSecretInputCapability,
	assertAwsSecretInputPlainData,
	awsSecretInputRegionPartition,
	awsSecretInputRequestFingerprint,
	awsSecretInputTimeoutMs,
	normalizeAwsSecretInputRequest,
	quoteAwsSecretInputArgv,
	safeAwsSecretInputFailure,
	type AwsSecretInputLocalRequest,
	type AwsSecretInputRequest,
} from "./aws-secret-input-contract";
import type { AwsSecretInputLaunchFiles, AwsSecretInputStep } from "./aws-secret-input-provider";
import { assertAwsSecretInputResult, type AwsSecretInputWorkerDependencies } from "./aws-secret-input-worker-protocol";
import { probeAwsSecretInputWorker, runAwsSecretInputWorker } from "./aws-secret-input-worker-client";
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

export interface AwsSecretInputDependencies extends AwsSecretInputWorkerDependencies {
	launch?: () => AwsSecretInputLaunchFiles;
}
export interface AwsSecretInputDetails {
	response: unknown;
	meta?: OutputMeta;
}
interface PreparedInput {
	request: AwsSecretInputRequest;
	fingerprint: string;
	sessionId: string | null;
	settings: Settings;
	revision: number;
	ownerSettings: Settings;
	ownerRevision: number;
	sessionSettings: Settings;
	sessionRevision: number;
	consumerGuard: Readonly<{ asks: boolean; reason?: string }>;
	generation: number;
	cwd: string;
	approved: boolean;
	guardedSteps: Map<string, Readonly<{ asks: boolean; reason?: string }>>;
}
export class AwsSecretInput {
	#prepared = new Map<string, PreparedInput>();
	#active = new Map<AbortController, Promise<void>>();
	#activeRequests = new Map<string, { prepared: PreparedInput; controller: AbortController }>();
	#barrier: Promise<void> = Promise.resolve();
	#generation = 0;
	#disposed = false;
	#lifecycleBound = false;
	constructor(
		private readonly session: ToolSession,
		private readonly owner: Pick<AgentTool, "name" | "cancellationBehavior">,
		private readonly dependencies: AwsSecretInputDependencies = {},
	) {
		const invalidate = (): Promise<void> => {
			this.#generation++;
			this.#prepared.clear();
			for (const controller of this.#active.keys()) controller.abort();
			this.#barrier = Promise.all([this.#barrier, ...this.#active.values()]).then(() => {});
			void this.#barrier.catch(() => {});
			return this.#barrier;
		};
		try {
			const dispose = session.registerDisposeCallback?.(
				() => {
					this.#disposed = true;
					return invalidate();
				},
				{ phase: "begin" },
			);
			const change = session.registerSessionChangeCallback?.(invalidate);
			this.#lifecycleBound = typeof dispose === "function" && typeof change === "function";
		} catch {
			this.#lifecycleBound = false;
		}
	}
	#sessionId(): string | null {
		return this.session.getSessionId?.() ?? this.session.sessionManager?.getSessionId?.() ?? null;
	}
	#settings(context?: AgentToolContext): Settings {
		return context?.settings ?? this.session.getToolContext?.()?.settings ?? this.session.settings;
	}
	#requireHost(request: AwsSecretInputLocalRequest): void {
		try {
			if (this.#disposed || this.session.isDisposed?.()) throw new AwsSecretInputFailure("CANCELLED");
			if (
				process.platform === "win32" ||
				!this.#lifecycleBound ||
				typeof this.session.isDisposed !== "function" ||
				typeof this.session.getToolExecutionCapabilities !== "function"
			)
				throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
			const host = this.session.getToolExecutionCapabilities(this.owner, request);
			assertAwsSecretInputPlainData(host, "CAPABILITY_INCOMPATIBLE");
			if (
				!host ||
				Object.keys(host).length !== 3 ||
				host.protocol !== AWS_SECRET_INPUT_MANIFEST.hostPolicy ||
				host.cancellationCleanup !== AWS_SECRET_INPUT_MANIFEST.executionPolicy ||
				host.sessionLifecycle !== AWS_SECRET_INPUT_MANIFEST.lifecyclePolicy
			)
				throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
		} catch (error) {
			throw new AwsSecretInputFailure(
				safeAwsSecretInputFailure(error) === "CANCELLED" ? "CANCELLED" : "CAPABILITY_INCOMPATIBLE",
			);
		}
	}
	#normalize(value: unknown): AwsSecretInputLocalRequest {
		const request = normalizeAwsSecretInputRequest(value);
		this.#requireHost(request);
		return request;
	}
	async #probe(request: AwsSecretInputLocalRequest, signal?: AbortSignal): Promise<void> {
		await this.#barrier;
		this.#requireHost(request);
		const controller = new AbortController();
		const cancel = () => controller.abort();
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) controller.abort();
		const { promise: joined, resolve: join, reject: failJoin } = Promise.withResolvers<void>();
		void joined.catch(() => {});
		this.#active.set(controller, joined);
		try {
			if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
			const value = await (this.dependencies.probeWorker ?? probeAwsSecretInputWorker)(controller.signal);
			if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
			this.#requireHost(request);
			assertAwsSecretInputCapability(value);
		} catch (error) {
			if (safeAwsSecretInputFailure(error) === "WORKER_FAILED") failJoin(new AwsSecretInputFailure("WORKER_FAILED"));
			throw error;
		} finally {
			signal?.removeEventListener("abort", cancel);
			this.#active.delete(controller);
			join();
		}
	}
	approval(args: unknown): ToolApprovalDecision {
		const request = normalizeAwsSecretInputRequest(args);
		return "action" in request ? { tier: "read", policy: "allow" } : "exec";
	}
	formatApprovalDetails(args: unknown): string[] {
		const request = this.#normalize(args);
		if ("action" in request) return [];
		return [
			"Private delivery only. Consumer stdout/stderr is raw and agent-visible; interruption can leave committed writes.",
			`Request fingerprint: ${awsSecretInputRequestFingerprint(request)}`,
			`Request: ${JSON.stringify(request)}`,
			`Input limit: ${AWS_SECRET_INPUT_LIMITS.maxInputBytes} bytes; stdout limit: ${AWS_SECRET_INPUT_LIMITS.maxStdoutBytes} bytes; stderr limit: ${AWS_SECRET_INPUT_LIMITS.maxStderrBytes} bytes; combined retained output limit: ${AWS_SECRET_INPUT_LIMITS.maxStdoutBytes + AWS_SECRET_INPUT_LIMITS.maxStderrBytes} bytes; timeout: ${awsSecretInputTimeoutMs(request)}ms`,
		];
	}
	async prepareApprovalTier(args: unknown, signal?: AbortSignal): Promise<void> {
		try {
			const request = this.#normalize(args);
			if ("action" in request) this.#policy("aws", request, "read");
			else this.#policies(request);
			await this.#probe(request, signal);
		} catch (error) {
			throw new ToolError(safeAwsSecretInputFailure(error));
		}
	}
	#policy(
		name: string,
		args: unknown,
		tier: "read" | "exec",
		context?: AgentToolContext,
		settingsOverride?: Settings,
	): "allow" | "prompt" {
		const active = context ?? this.session.getToolContext?.();
		const resolved = resolveApprovalFromContext({
			autoApprove: active?.autoApprove,
			settings: settingsOverride ?? this.#settings(active),
		});
		const decision = resolveApproval({ name, approval: tier }, args, resolved.approvalMode, resolved.userPolicies);
		if (decision.policy === "deny") throw new AwsSecretInputFailure("POLICY_DENIED");
		return decision.policy;
	}
	#policies(request: AwsSecretInputRequest, context?: AgentToolContext, settingsOverride?: Settings): void {
		this.#policy("aws", request, "exec", context, settingsOverride);
		this.#policy(
			"bash",
			{ command: quoteAwsSecretInputArgv(request.secretInput.consumer.argv), cwd: request.secretInput.consumer.cwd },
			"exec",
			context,
			settingsOverride,
		);
		this.#policy(
			"exec",
			{ argv: request.secretInput.consumer.argv, cwd: request.secretInput.consumer.cwd },
			"exec",
			context,
			settingsOverride,
		);
		this.#policy(
			"aws.sts.get-caller-identity",
			{ service: "sts", operation: "get-caller-identity", region: request.region },
			"read",
			context,
			settingsOverride,
		);
		this.#policy("aws.secretsmanager.get-secret-value", request, "read", context, settingsOverride);
	}
	#stepCommand(step: AwsSecretInputStep, request: AwsSecretInputRequest): string {
		assertAwsSecretInputPlainData(step, "GUARD_DENIED");
		if (
			!step ||
			typeof step !== "object" ||
			Array.isArray(step) ||
			Object.keys(step).some(key => !["service", "operation", "resource", "roleName", "region"].includes(key))
		)
			throw new AwsSecretInputFailure("GUARD_DENIED");
		const region = step.region;
		if (
			!region ||
			awsSecretInputRegionPartition(region) !== request.secretInput.expectedIdentity.partition ||
			(step.service !== "sso" && (region !== request.region || step.roleName !== undefined))
		)
			throw new AwsSecretInputFailure("GUARD_DENIED");
		let flags: string[];
		if (step.service === "sts" && step.operation === "get-caller-identity" && step.resource === undefined) flags = [];
		else if (
			step.service === "secretsmanager" &&
			step.operation === "get-secret-value" &&
			step.resource === request.parameters.SecretId
		)
			flags = [
				"--secret-id",
				request.parameters.SecretId,
				"--version-id",
				request.parameters.VersionId,
				...(request.parameters.VersionStage === undefined
					? []
					: ["--version-stage", request.parameters.VersionStage]),
			];
		else if (
			step.service === "sso" &&
			step.operation === "get-role-credentials" &&
			step.resource === request.secretInput.expectedIdentity.account &&
			typeof step.roleName === "string" &&
			/^[A-Za-z0-9_+=,.@-]{1,64}$/u.test(step.roleName) &&
			!/[\u0000-\u001f\u007f]/u.test(step.roleName)
		)
			flags = ["--account-id", step.resource, "--role-name", step.roleName];
		else throw new AwsSecretInputFailure("GUARD_DENIED");
		return quoteAwsSecretInputArgv([
			"aws",
			"--profile",
			request.profile,
			"--region",
			region,
			step.service,
			step.operation,
			...flags,
		]);
	}
	async #guard(command: string, cwd: string, signal?: AbortSignal): Promise<{ asks: boolean; reason?: string }> {
		try {
			const decision = await enforceDestructiveCommandGuard(command, cwd, "posix", signal);
			return {
				asks: decision?.decision === "ask",
				...(decision?.decision === "ask" ? { reason: decision.reason } : {}),
			};
		} catch {
			throw new AwsSecretInputFailure("GUARD_DENIED");
		}
	}
	#current(prepared: PreparedInput, context?: AgentToolContext): void {
		this.#requireHost(prepared.request);
		const settings = context?.settings ?? prepared.settings;
		const ownerContext = this.session.getToolContext?.();
		const ownerSettings = ownerContext?.settings ?? this.session.settings;
		if (
			prepared.generation !== this.#generation ||
			prepared.sessionId !== this.#sessionId() ||
			prepared.cwd !== this.session.cwd ||
			settings !== prepared.settings ||
			settings.revision !== prepared.revision ||
			ownerSettings !== prepared.ownerSettings ||
			ownerSettings.revision !== prepared.ownerRevision ||
			this.session.settings !== prepared.sessionSettings ||
			this.session.settings.revision !== prepared.sessionRevision
		)
			throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		this.#policies(prepared.request, context, settings);
		if (ownerSettings !== settings) this.#policies(prepared.request, ownerContext, ownerSettings);
		if (this.session.settings !== settings && this.session.settings !== ownerSettings)
			this.#policies(prepared.request, undefined, this.session.settings);
	}
	async #admitConsumer(prepared: PreparedInput, signal: AbortSignal, context?: AgentToolContext): Promise<void> {
		if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		this.#current(prepared, context);
		if (!prepared.approved || prepared.fingerprint !== awsSecretInputRequestFingerprint(prepared.request))
			throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		const guard = await this.#guard(
			quoteAwsSecretInputArgv(prepared.request.secretInput.consumer.argv),
			prepared.request.secretInput.consumer.cwd,
			signal,
		);
		this.#current(prepared, context);
		if (guard.asks !== prepared.consumerGuard.asks || guard.reason !== prepared.consumerGuard.reason)
			throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
	}
	async prepareRuntimeApproval(
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<RuntimeToolApprovalRequest | undefined> {
		this.denyRuntimeApproval(toolCallId);
		try {
			const request = this.#normalize(args);
			if ("action" in request) this.#policy("aws", request, "read", context);
			else this.#policies(request, context);
			const generation = this.#generation;
			const sessionId = this.#sessionId();
			await this.#probe(request, signal);
			if ("action" in request) return undefined;
			const settings = this.#settings(context);
			const revision = settings.revision;
			const ownerContext = this.session.getToolContext?.();
			const ownerSettings = ownerContext?.settings ?? this.session.settings;
			const ownerRevision = ownerSettings.revision;
			const sessionSettings = this.session.settings;
			const sessionRevision = sessionSettings.revision;
			const cwd = this.session.cwd;
			const guardedSteps = new Map<string, Readonly<{ asks: boolean; reason?: string }>>();
			this.#policies(request, context, settings);
			if (ownerSettings !== settings) this.#policies(request, ownerContext, ownerSettings);
			if (sessionSettings !== settings && sessionSettings !== ownerSettings)
				this.#policies(request, undefined, sessionSettings);
			const details = this.formatApprovalDetails(request);
			for (const step of [
				{ service: "sts", operation: "get-caller-identity", region: request.region },
				{
					service: "secretsmanager",
					operation: "get-secret-value",
					resource: request.parameters.SecretId,
					region: request.region,
				},
			] as const) {
				this.#policy(`aws.${step.service}.${step.operation}`, step, "read", context);
				const command = this.#stepCommand(step, request);
				const guard = await this.#guard(command, cwd, signal);
				details.push(
					`Exact AWS command: ${command}`,
					`AWS guard cwd: ${JSON.stringify(cwd)}`,
					...(guard.reason ? [`Guard confirmation reason: ${guard.reason}`] : []),
				);
				guardedSteps.set(command, Object.freeze(guard));
			}
			const command = quoteAwsSecretInputArgv(request.secretInput.consumer.argv);
			const guard = await this.#guard(command, request.secretInput.consumer.cwd, signal);
			details.push(
				`Exact consumer command: ${command}`,
				`Consumer cwd: ${JSON.stringify(request.secretInput.consumer.cwd)}`,
				...(guard.reason ? [`Guard confirmation reason: ${guard.reason}`] : []),
			);
			const prepared: PreparedInput = {
				request,
				fingerprint: awsSecretInputRequestFingerprint(request),
				sessionId,
				settings,
				revision,
				ownerSettings,
				ownerRevision,
				sessionSettings,
				sessionRevision,
				consumerGuard: Object.freeze(guard),
				generation,
				cwd,
				approved: false,
				guardedSteps,
			};
			this.#current(prepared, context);
			if (signal?.aborted) throw new AwsSecretInputFailure("CANCELLED");
			this.#prepared.set(toolCallId, prepared);
			return {
				reason: "Private AWS secret delivery to the exact approved process",
				prompt: details.join("\n"),
				allowSessionApproval: false,
			};
		} catch (error) {
			throw new ToolError(safeAwsSecretInputFailure(error));
		}
	}
	approveRuntimeApproval(toolCallId: string, args: unknown): void {
		const prepared = this.#prepared.get(toolCallId);
		if (!prepared) return;
		try {
			const request = this.#normalize(args);
			if ("action" in request || prepared.fingerprint !== awsSecretInputRequestFingerprint(request))
				throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
			this.#current(prepared);
			prepared.approved = true;
		} catch {
			this.#prepared.delete(toolCallId);
		}
	}
	denyRuntimeApproval(toolCallId: string): void {
		const prepared = this.#prepared.get(toolCallId);
		if (prepared) prepared.approved = false;
		this.#prepared.delete(toolCallId);
		const active = this.#activeRequests.get(toolCallId);
		if (active) {
			active.prepared.approved = false;
			active.controller.abort();
			this.#barrier = Promise.all([this.#barrier, this.#active.get(active.controller)]).then(() => {});
			void this.#barrier.catch(() => {});
		}
	}
	#launch(): AwsSecretInputLaunchFiles {
		if (this.dependencies.launch) return this.dependencies.launch();
		const metadata = getOperationalAwsLaunchMetadata();
		if (!metadata) throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
		return Object.freeze({
			configFile: metadata.configFile,
			sharedCredentialsFile: metadata.sharedCredentialsFile,
			homeDir: metadata.homeDirectory,
			reservedProfiles: Object.freeze([...getReservedManagedAwsProfiles()]),
		});
	}
	async #authorize(
		step: AwsSecretInputStep,
		prepared: PreparedInput,
		signal: AbortSignal,
		context?: AgentToolContext,
	): Promise<void> {
		this.#current(prepared, context);
		if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		if (!prepared.approved) throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		const command = this.#stepCommand(step, prepared.request);
		const policy = this.#policy(`aws.${step.service}.${step.operation}`, step, "read", context, prepared.settings);
		const ownerPolicy =
			prepared.ownerSettings === prepared.settings
				? policy
				: this.#policy(
						`aws.${step.service}.${step.operation}`,
						step,
						"read",
						this.session.getToolContext?.(),
						prepared.ownerSettings,
					);
		const sessionPolicy =
			prepared.sessionSettings === prepared.settings
				? policy
				: prepared.sessionSettings === prepared.ownerSettings
					? ownerPolicy
					: this.#policy(
							`aws.${step.service}.${step.operation}`,
							step,
							"read",
							undefined,
							prepared.sessionSettings,
						);
		const guard = await this.#guard(command, prepared.cwd, signal);
		const approvedGuard = prepared.guardedSteps.get(command);
		if (approvedGuard && (guard.asks !== approvedGuard.asks || guard.reason !== approvedGuard.reason))
			throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		if (
			!approvedGuard &&
			(guard.asks || policy === "prompt" || ownerPolicy === "prompt" || sessionPolicy === "prompt")
		) {
			const active = context ?? this.session.getToolContext?.();
			if (!active?.ui) throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
			const settings = this.#settings(active);
			const authority = captureApprovalAuthority(this.session.cwd, prepared.sessionId ?? "", settings, active);
			if (!authority) throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
			const accepted = await requestApproval(
				active.ui,
				{
					name: "aws",
					approval: "read",
					formatApprovalDetails: () => [
						`Exact AWS command: ${command}`,
						`AWS guard cwd: ${JSON.stringify(prepared.cwd)}`,
						`Request fingerprint: ${prepared.fingerprint}`,
						...(guard.reason ? [`Guard confirmation reason: ${guard.reason}`] : []),
					],
				},
				step,
				{ reason: "Guarded private AWS authentication step", allowPersistentGrants: false },
			);
			const current = this.session.getToolContext?.() ?? context;
			if (accepted !== "once") throw new AwsSecretInputFailure("GUARD_DENIED");
			if (
				!current ||
				!sameApprovalAuthority(
					authority,
					captureApprovalAuthority(this.session.cwd, this.#sessionId() ?? "", this.#settings(current), current),
				)
			)
				throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
		}
		this.#current(prepared, context);
		this.#policy(`aws.${step.service}.${step.operation}`, step, "read", context, prepared.settings);
		if (prepared.ownerSettings !== prepared.settings)
			this.#policy(
				`aws.${step.service}.${step.operation}`,
				step,
				"read",
				this.session.getToolContext?.(),
				prepared.ownerSettings,
			);
		if (prepared.sessionSettings !== prepared.settings && prepared.sessionSettings !== prepared.ownerSettings)
			this.#policy(`aws.${step.service}.${step.operation}`, step, "read", undefined, prepared.sessionSettings);
		if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		if (!approvedGuard) prepared.guardedSteps.set(command, Object.freeze(guard));
	}
	async execute(
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		context?: AgentToolContext,
	): Promise<AgentToolResult<AwsSecretInputDetails>> {
		const controller = new AbortController();
		const cancel = () => controller.abort();
		let join: (() => void) | undefined;
		let failJoin: ((error: AwsSecretInputFailure) => void) | undefined;
		let handoffStarted = false;
		let consumerAdmissionRequested = false;
		let consumerAdmitted = false;
		try {
			const request = this.#normalize(args);
			await this.#barrier;
			this.#requireHost(request);
			if ("action" in request) {
				this.#policy("aws", request, "read", context);
				await this.#probe(request, signal);
				return toolResult<AwsSecretInputDetails>({ response: AWS_SECRET_INPUT_CAPABILITY })
					.text(JSON.stringify(AWS_SECRET_INPUT_CAPABILITY))
					.done();
			}
			const prepared = this.#prepared.get(toolCallId);
			this.#prepared.delete(toolCallId);
			if (!prepared?.approved || prepared.fingerprint !== awsSecretInputRequestFingerprint(request))
				throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
			this.#current(prepared, context);
			await this.#probe(request, signal);
			this.#current(prepared, context);
			await this.#admitConsumer(prepared, signal ?? controller.signal, context);
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) controller.abort();
			if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
			const joined = Promise.withResolvers<void>();
			join = joined.resolve;
			failJoin = joined.reject;
			void joined.promise.catch(() => {});
			this.#active.set(controller, joined.promise);
			this.#activeRequests.set(toolCallId, { prepared, controller });
			const launch = this.#launch();
			handoffStarted = true;
			const result = await (this.dependencies.runWorker ?? runAwsSecretInputWorker)(
				prepared.request,
				launch,
				step => this.#authorize(step, prepared, controller.signal, context),
				controller.signal,
				async () => {
					if (consumerAdmissionRequested) throw new AwsSecretInputFailure("APPROVAL_REQUIRED");
					consumerAdmissionRequested = true;
					await this.#admitConsumer(prepared, controller.signal, context);
					consumerAdmitted = true;
				},
			);
			assertAwsSecretInputResult(result);
			if (!consumerAdmitted) throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
			const value = {
				ok: true,
				capability: AWS_SECRET_INPUT_CAPABILITY.capability,
				limits: AWS_SECRET_INPUT_LIMITS,
				result,
			};
			const output = toolResult<AwsSecretInputDetails>({ response: value }).text(JSON.stringify(value));
			if (
				result.exitCode !== 0 ||
				result.timedOut ||
				result.cancelled ||
				result.stdoutTruncated ||
				result.stderrTruncated
			)
				return output.error().done();
			return output.done();
		} catch (error) {
			const code = safeAwsSecretInputFailure(error);
			if (code === "WORKER_FAILED") {
				failJoin?.(new AwsSecretInputFailure("WORKER_FAILED"));
				this.#barrier = Promise.reject(new AwsSecretInputFailure("WORKER_FAILED"));
				void this.#barrier.catch(() => {});
			}
			const value = { ok: false, code, ...(handoffStarted ? { completion: "uncertain" as const } : {}) };
			return toolResult<AwsSecretInputDetails>({ response: value }).text(JSON.stringify(value)).error().done();
		} finally {
			signal?.removeEventListener("abort", cancel);
			this.#active.delete(controller);
			if (this.#activeRequests.get(toolCallId)?.controller === controller) this.#activeRequests.delete(toolCallId);
			join?.();
			this.#prepared.delete(toolCallId);
		}
	}
}
