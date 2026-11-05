import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { AwsDbTool, type AwsDbToolDependencies, type AwsDbToolDetails } from "@oh-my-pi/pi-coding-agent/tools/aws-db";
import {
	AWS_DB_CAPABILITY,
	AwsDbFailure,
	awsDbRequestFingerprint,
	type AwsDbCapability,
	type AwsDbFailureCode,
	type AwsDbInspectionRequest,
	type AwsDbRequest,
	type SafeTemplateResult,
} from "@oh-my-pi/pi-coding-agent/tools/aws-db-contract";
import { cfgToolsApproval } from "@oh-my-pi/pi-coding-agent/tools/settings";
import {
	TOOL_EXECUTION_HOST_CAPABILITIES,
	type ToolExecutionHostCapabilities,
} from "@oh-my-pi/pi-coding-agent/tools/tool-execution-host";

type NativeResult = AgentToolResult<AwsDbToolDetails>;
type Policies = Record<string, "allow" | "deny" | "prompt">;

function inspection(): AwsDbInspectionRequest {
	return {
		action: "inspect-automation-template",
		capability: AWS_DB_CAPABILITY.capability,
		profile: "fixture-reader",
		expected: {
			accountId: "123456789012",
			principalArn: "arn:aws:sts::123456789012:assumed-role/FixtureReader/fixture-session",
			partition: "aws",
			region: "us-east-1",
			tenantId: "fixture-tenant",
			clusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:fixture-cluster",
			clusterResourceId: "cluster-FIXTURE123",
			instanceArn: "arn:aws:rds:us-east-1:123456789012:db:fixture-reader",
			instanceResourceId: "db-FIXTURE123",
			endpoint: "fixture-reader.example.invalid",
			port: 3306,
			database: "fixture_database",
			secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-reader-AbCdEf",
			secretVersionId: "12345678-1234-1234-1234-123456789012",
		},
		agencyId: "17",
		automationId: "23",
		stepId: "31",
		limits: { maxRows: 1, maxBytes: 4096, timeoutMs: 1000 },
	};
}

function safeResult(disposition: SafeTemplateResult["disposition"] = "sanitized"): SafeTemplateResult {
	return {
		disposition,
		...(disposition === "sanitized" ? { structure: "SELECT IDENTIFIER FROM IDENTIFIER" } : {}),
		proof: { sameConnection: true, reader: true },
		teardown: { connectionClosed: true, referencesReleased: true },
	};
}

function fixture(
	overrides: AwsDbToolDependencies = {},
	policies: Policies = { aws_db: "allow", aws: "allow" },
	mode: "always-ask" | "yolo" = "always-ask",
	configureSession?: (session: ToolSession) => void,
) {
	let currentSessionId = "fixture-session";
	let disposed = false;
	const settings = Settings.isolated({ "tools.approvalMode": mode, "tools.approval": policies });
	let context = { settings } as AgentToolContext;
	const beginDisposeCallbacks = new Set<() => void>();
	const completeDisposeCallbacks = new Set<() => void>();
	const changeCallbacks = new Set<() => void>();
	const calls = { probe: 0, launch: 0, worker: 0 };
	const host: { tool?: AwsDbTool; capabilities: ToolExecutionHostCapabilities | undefined } = {
		capabilities: TOOL_EXECUTION_HOST_CAPABILITIES,
	};
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => currentSessionId,
		getToolContext: () => context,
		isDisposed: () => disposed,
		getToolExecutionCapabilities: candidate => {
			if (
				disposed ||
				candidate !== host.tool ||
				candidate.cancellationBehavior !== "await-cleanup" ||
				beginDisposeCallbacks.size === 0 ||
				changeCallbacks.size === 0
			)
				return undefined;
			return host.capabilities;
		},
		registerDisposeCallback: (callback, options) => {
			const callbacks = options?.phase === "begin" ? beginDisposeCallbacks : completeDisposeCallbacks;
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
		registerSessionChangeCallback: callback => {
			changeCallbacks.add(callback);
			return () => {
				changeCallbacks.delete(callback);
			};
		},
	};
	configureSession?.(session);
	const tool = new AwsDbTool(session, {
		probeWorker: async signal => {
			calls.probe++;
			return overrides.probeWorker ? overrides.probeWorker(signal) : AWS_DB_CAPABILITY;
		},
		launch: () => {
			calls.launch++;
			return overrides.launch
				? overrides.launch()
				: {
						homeDir: "/unused/aws-db-fixture-home",
						configFile: "/unused/aws-db-fixture-config",
						sharedCredentialsFile: "/unused/aws-db-fixture-credentials",
						reservedProfiles: ["coreforge"],
					};
		},
		runWorker: async (...args) => {
			calls.worker++;
			return overrides.runWorker ? overrides.runWorker(...args) : safeResult();
		},
	});
	host.tool = tool;
	return {
		tool,
		calls,
		setHostCapabilities(capabilities: ToolExecutionHostCapabilities | undefined): void {
			host.capabilities = capabilities;
		},
		changeSession(id: string): void {
			if (id === currentSessionId) return;
			currentSessionId = id;
			for (const callback of changeCallbacks) callback();
		},
		setPolicies(next: Policies): void {
			context = {
				settings: Settings.isolated({ "tools.approvalMode": mode, "tools.approval": next }),
			} as AgentToolContext;
		},
		revisePolicies(next: Policies): void {
			cfgToolsApproval.set(context.settings ?? settings, next);
		},
		clearContextSettings(): void {
			context = {} as AgentToolContext;
		},
		dispose(): void {
			disposed = true;
			for (const callback of beginDisposeCallbacks) callback();
			for (const callback of completeDisposeCallbacks) callback();
		},
	};
}

function expectFailure(result: NativeResult, code: AwsDbFailureCode): void {
	const expected = JSON.stringify({ ok: false, code });
	expect(result.isError === true).toBe(true);
	expect(JSON.stringify(result.details?.response) === expected).toBe(true);
	expect(
		result.content.length === 1 && result.content[0]?.type === "text" && result.content[0].text === expected,
	).toBe(true);
}

function expectSuccess(result: NativeResult, disposition: SafeTemplateResult["disposition"] = "sanitized"): void {
	const value = result.details?.response as Record<string, unknown> | undefined;
	expect(result.isError !== true && value?.ok === true).toBe(true);
	expect(JSON.stringify(value?.result) === JSON.stringify(safeResult(disposition))).toBe(true);
	expect(
		result.content.length === 1 &&
			result.content[0]?.type === "text" &&
			result.content[0].text === JSON.stringify(value),
	).toBe(true);
}

function expectNoAccess(calls: { launch: number; worker: number }): void {
	expect(calls.launch === 0 && calls.worker === 0).toBe(true);
}

async function expectRejectedCode(operation: () => Promise<unknown>, code: AwsDbFailureCode): Promise<void> {
	let failure: unknown;
	try {
		await operation();
	} catch (error) {
		failure = error;
	}
	expect(failure instanceof Error && failure.message === code && !Object.hasOwn(failure, "cause")).toBe(true);
}

async function approve(tool: AwsDbTool, id: string, request: AwsDbInspectionRequest): Promise<void> {
	const approval = await tool.prepareRuntimeApproval(id, request);
	expect(approval?.allowSessionApproval === false).toBe(true);
	tool.approveRuntimeApproval(id, request);
}

describe("aws_db execution host admission", () => {
	const unsupported: Array<[string, (session: ToolSession) => void]> = [
		[
			"missing handshake",
			session => {
				delete session.getToolExecutionCapabilities;
			},
		],
		[
			"inactive dispatcher",
			session => {
				session.getToolExecutionCapabilities = () => undefined;
			},
		],
		[
			"older dispatcher protocol",
			session => {
				session.getToolExecutionCapabilities = () =>
					({
						...TOOL_EXECUTION_HOST_CAPABILITIES,
						protocol: "native-tool-host/v0",
					}) as unknown as ToolExecutionHostCapabilities;
			},
		],
		[
			"unsupported cancellation cleanup",
			session => {
				session.getToolExecutionCapabilities = () =>
					({
						...TOOL_EXECUTION_HOST_CAPABILITIES,
						cancellationCleanup: "tool-cancellation-cleanup/v0",
					}) as unknown as ToolExecutionHostCapabilities;
			},
		],
		[
			"older lifecycle protocol",
			session => {
				session.getToolExecutionCapabilities = () =>
					({
						...TOOL_EXECUTION_HOST_CAPABILITIES,
						sessionLifecycle: "tool-session-lifecycle/v0",
					}) as unknown as ToolExecutionHostCapabilities;
			},
		],
		[
			"unknown handshake field",
			session => {
				session.getToolExecutionCapabilities = () => ({
					...TOOL_EXECUTION_HOST_CAPABILITIES,
					approved: true,
				});
			},
		],
		[
			"missing session identity getter",
			session => {
				delete session.getSessionId;
			},
		],
		[
			"null registered session identity",
			session => {
				session.getSessionId = () => null;
			},
		],
		[
			"empty registered session identity",
			session => {
				session.getSessionId = () => "";
			},
		],
		[
			"missing disposal state",
			session => {
				delete session.isDisposed;
			},
		],
		[
			"missing disposal registration",
			session => {
				delete session.registerDisposeCallback;
			},
		],
		[
			"missing session-change registration",
			session => {
				delete session.registerSessionChangeCallback;
			},
		],
		[
			"disposal registration without unsubscribe",
			session => {
				const register = session.registerDisposeCallback;
				session.registerDisposeCallback = (callback, options) => {
					register?.(callback, options);
				};
			},
		],
		[
			"session-change registration without unsubscribe",
			session => {
				const register = session.registerSessionChangeCallback;
				session.registerSessionChangeCallback = callback => {
					register?.(callback);
				};
			},
		],
		[
			"legacy registration ignoring begin phase",
			session => {
				const register = session.registerDisposeCallback;
				session.registerDisposeCallback = callback => register?.(callback);
			},
		],
		[
			"throwing lifecycle registration",
			session => {
				session.registerSessionChangeCallback = () => {
					throw new Error("Unsupported lifecycle ABI");
				};
			},
		],
		[
			"throwing host handshake",
			session => {
				session.getToolExecutionCapabilities = () => {
					throw new Error("Unsupported execution host");
				};
			},
		],
	];
	for (const [name, configure] of unsupported) {
		it(`rejects ${name} before any probe, approval, or resource access`, async () => {
			const { tool, calls } = fixture({}, { aws_db: "allow", aws: "allow" }, "yolo", configure);
			const request = inspection();
			await expectRejectedCode(async () => tool.approval({ action: "capabilities" }), "CAPABILITY_INCOMPATIBLE");
			await expectRejectedCode(() => tool.prepareApprovalTier(request), "CAPABILITY_INCOMPATIBLE");
			await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", request), "CAPABILITY_INCOMPATIBLE");
			tool.approveRuntimeApproval("inspect", request);
			expectFailure(await tool.execute("inspect", request), "CAPABILITY_INCOMPATIBLE");
			expectFailure(await tool.execute("capability", { action: "capabilities" }), "CAPABILITY_INCOMPATIBLE");
			expect(calls.probe === 0).toBe(true);
			expectNoAccess(calls);
		});
	}

	it("rejects a host reporting live disposal even before its callback has fired", async () => {
		const { tool, calls } = fixture({}, { aws_db: "allow", aws: "allow" }, "yolo", session => {
			session.isDisposed = () => true;
		});
		await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", inspection()), "CANCELLED");
		expectFailure(await tool.execute("capability", { action: "capabilities" }), "CANCELLED");
		expect(calls.probe === 0).toBe(true);
		expectNoAccess(calls);
	});

	it("consumes a prepared grant if its execution host is withdrawn before execution", async () => {
		const { tool, calls, setHostCapabilities } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		setHostCapabilities(undefined);
		expectFailure(await tool.execute("inspect", request), "CAPABILITY_INCOMPATIBLE");
		setHostCapabilities(TOOL_EXECUTION_HOST_CAPABILITIES);
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expect(calls.probe === 1).toBe(true);
		expectNoAccess(calls);
	});
});

describe("aws_db native capability preflight", () => {
	it("executes capabilities without inspection approval or launch metadata, even when AWS access is denied", async () => {
		const loadedCapability = Object.fromEntries(Object.entries(AWS_DB_CAPABILITY).reverse()) as AwsDbCapability;
		loadedCapability.manifest = Object.fromEntries(
			Object.entries(AWS_DB_CAPABILITY.manifest).reverse(),
		) as AwsDbCapability["manifest"];
		const { tool, calls } = fixture({ probeWorker: async () => loadedCapability }, { aws_db: "allow", aws: "deny" });
		const result = await tool.execute("capability", { action: "capabilities" });
		expect(result.isError !== true).toBe(true);
		expect(Bun.deepEquals(result.details?.response, AWS_DB_CAPABILITY)).toBe(true);
		expect((await tool.prepareRuntimeApproval("capability", { action: "capabilities" })) === undefined).toBe(true);
		expect(calls.probe === 2).toBe(true);
		expectNoAccess(calls);
	});

	const incompatible: Array<[string, () => unknown]> = [
		["protocol", () => ({ ...AWS_DB_CAPABILITY, protocol: "aws-db-memory/v0" })],
		[
			"worker manifest with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, worker: "aws-db-isolated-process/v0" },
			}),
		],
		[
			"sanitizer manifest with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, sanitizerPolicy: "restricted-template-structure/v0" },
			}),
		],
		[
			"execution cleanup policy with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, executionPolicy: "tool-cancellation-cleanup/v0" },
			}),
		],
		[
			"execution host policy with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, hostPolicy: "native-tool-host/v0" },
			}),
		],
		[
			"session lifecycle policy with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, lifecyclePolicy: "tool-session-lifecycle/v0" },
			}),
		],
		[
			"TLS policy with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: { ...AWS_DB_CAPABILITY.manifest, tlsPolicy: "amazon-rds-partition-roots/v0" },
			}),
		],
		[
			"TLS trust identity with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: {
					...AWS_DB_CAPABILITY.manifest,
					tlsTrust: AWS_DB_CAPABILITY.manifest.tlsTrust.replace(
						/.$/u,
						AWS_DB_CAPABILITY.manifest.tlsTrust.endsWith("0") ? "1" : "0",
					),
				},
			}),
		],
		[
			"TLS coverage expansion with valid unchanged digest",
			() => ({
				...AWS_DB_CAPABILITY,
				manifest: {
					...AWS_DB_CAPABILITY.manifest,
					tlsRegions: {
						...AWS_DB_CAPABILITY.manifest.tlsRegions,
						aws: [...AWS_DB_CAPABILITY.manifest.tlsRegions.aws, "us-west-3"],
					},
				},
			}),
		],
		[
			"provider expansion",
			() => ({
				...AWS_DB_CAPABILITY,
				supportedProviders: [...AWS_DB_CAPABILITY.supportedProviders, "credential-process"],
			}),
		],
	];
	for (const [name, loadedCapability] of incompatible) {
		it(`rejects loaded ${name} before approval can authorize access`, async () => {
			const { tool, calls } = fixture({ probeWorker: async () => loadedCapability() as AwsDbCapability });
			const request = inspection();
			await expectRejectedCode(() => tool.prepareApprovalTier(request), "CAPABILITY_INCOMPATIBLE");
			await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", request), "CAPABILITY_INCOMPATIBLE");
			tool.approveRuntimeApproval("inspect", request);
			expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			expectFailure(await tool.execute("capability", { action: "capabilities" }), "CAPABILITY_INCOMPATIBLE");
			expectNoAccess(calls);
		});
	}

	it("rejects a mismatched caller capability before probing or approving", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		request.capability = request.capability.replace(/.$/u, request.capability.endsWith("0") ? "1" : "0");
		await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", request), "CAPABILITY_INCOMPATIBLE");
		expectFailure(await tool.execute("inspect", request), "CAPABILITY_INCOMPATIBLE");
		expect(calls.probe === 0).toBe(true);
		expectNoAccess(calls);
	});

	it("rejects an uncovered but completely bound TLS region before any probe or approval", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		request.expected.region = "us-west-3";
		for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
			request.expected[field] = request.expected[field].replace("us-east-1", request.expected.region);
		}
		await expectRejectedCode(async () => tool.approval(request), "CAPABILITY_INCOMPATIBLE");
		await expectRejectedCode(() => tool.prepareApprovalTier(request), "CAPABILITY_INCOMPATIBLE");
		await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", request), "CAPABILITY_INCOMPATIBLE");
		tool.approveRuntimeApproval("inspect", request);
		expectFailure(await tool.execute("inspect", request), "CAPABILITY_INCOMPATIBLE");
		expect(calls.probe === 0).toBe(true);
		expectNoAccess(calls);
	});

	it("withholds probe failures and their nested provider causes", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		const { tool, calls } = fixture({
			probeWorker: async () => {
				throw new Error(privateValue, { cause: { providerResponse: privateValue } });
			},
		});
		await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", inspection()), "WORKER_FAILED");
		const result = await tool.execute("capability", { action: "capabilities" });
		expectFailure(result, "WORKER_FAILED");
		expect(JSON.stringify(result).includes(privateValue)).toBe(false);
		expectNoAccess(calls);
	});

	for (const transition of ["session-change", "away-and-back", "dispose", "cancel"] as const) {
		it(`cannot create an inspection grant after ${transition} during capability preflight`, async () => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<AwsDbCapability>();
			const { tool, calls, changeSession, dispose } = fixture({
				probeWorker: async () => {
					entered.resolve();
					return release.promise;
				},
			});
			const controller = new AbortController();
			const request = inspection();
			const pending = tool.prepareRuntimeApproval("inspect", request, controller.signal);
			const rejected = expectRejectedCode(
				() => pending,
				transition === "cancel" || transition === "dispose" ? "CANCELLED" : "APPROVAL_REQUIRED",
			);
			try {
				await entered.promise;
				if (transition === "cancel") controller.abort();
				else if (transition === "dispose") dispose();
				else {
					changeSession("other-session");
					if (transition === "away-and-back") changeSession("fixture-session");
				}
				release.resolve(AWS_DB_CAPABILITY);
				await rejected;
				tool.approveRuntimeApproval("inspect", request);
				expectFailure(
					await tool.execute("inspect", request),
					transition === "dispose" ? "CANCELLED" : "APPROVAL_REQUIRED",
				);
				expectNoAccess(calls);
			} finally {
				controller.abort();
				release.resolve(AWS_DB_CAPABILITY);
				await rejected;
			}
		});
	}
});

describe("aws_db fresh exact one-use inspection approval", () => {
	for (const mode of ["always-ask", "yolo"] as const) {
		it(`requires a fresh runtime grant despite broad configured allow in ${mode}`, async () => {
			const { tool, calls } = fixture({}, { aws_db: "allow", aws: "allow" }, mode);
			const request = inspection();
			expectFailure(await tool.execute("direct", request), "APPROVAL_REQUIRED");
			tool.approveRuntimeApproval("unprepared", request);
			expectFailure(await tool.execute("unprepared", request), "APPROVAL_REQUIRED");
			const approval = await tool.prepareRuntimeApproval("prepared", request);
			expect(approval?.allowSessionApproval === false).toBe(true);
			expectFailure(await tool.execute("prepared", request), "APPROVAL_REQUIRED");
			expectNoAccess(calls);
		});
	}

	it("permits an exact approved inspection once and requires fresh approval for the next read", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		expectSuccess(await tool.execute("inspect", structuredClone(request)));
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectFailure(await tool.execute("next-inspect", request), "APPROVAL_REQUIRED");
		expect(calls.launch === 1 && calls.worker === 1).toBe(true);
		await approve(tool, "next-inspect", request);
		expectSuccess(await tool.execute("next-inspect", request));
		expect(calls.launch === 2 && calls.worker === 2).toBe(true);
	});

	it("does not transfer an approved request to another call ID", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "approved", request);
		expectFailure(await tool.execute("different", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
		expectSuccess(await tool.execute("approved", request));
	});

	const alterations: Array<[string, (request: AwsDbInspectionRequest) => void]> = [
		[
			"profile",
			request => {
				request.profile = "other-reader";
			},
		],
		[
			"account",
			request => {
				request.expected.accountId = "210987654321";
				for (const field of ["principalArn", "clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field].replace("123456789012", request.expected.accountId);
				}
			},
		],
		[
			"region",
			request => {
				request.expected.region = "us-west-2";
				for (const field of ["clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field].replace("us-east-1", request.expected.region);
				}
			},
		],
		[
			"partition",
			request => {
				request.expected.partition = "aws-us-gov";
				request.expected.region = "us-gov-west-1";
				for (const field of ["principalArn", "clusterArn", "instanceArn", "secretArn"] as const) {
					request.expected[field] = request.expected[field]
						.replace("arn:aws:", "arn:aws-us-gov:")
						.replace("us-east-1", request.expected.region);
				}
			},
		],
		[
			"principal",
			request => {
				request.expected.principalArn = "arn:aws:sts::123456789012:assumed-role/OtherReader/fixture-session";
			},
		],
		[
			"tenant",
			request => {
				request.expected.tenantId = "other-tenant";
			},
		],
		[
			"cluster",
			request => {
				request.expected.clusterArn += "-other";
			},
		],
		[
			"cluster resource ID",
			request => {
				request.expected.clusterResourceId += "OTHER";
			},
		],
		[
			"instance",
			request => {
				request.expected.instanceArn += "-other";
			},
		],
		[
			"instance resource ID",
			request => {
				request.expected.instanceResourceId += "OTHER";
			},
		],
		[
			"endpoint",
			request => {
				request.expected.endpoint = "other.example.invalid";
			},
		],
		[
			"port",
			request => {
				request.expected.port = 3307;
			},
		],
		[
			"database",
			request => {
				request.expected.database = "other_database";
			},
		],
		[
			"secret",
			request => {
				request.expected.secretArn += "-other";
			},
		],
		[
			"secret version",
			request => {
				request.expected.secretVersionId = "b".repeat(32);
			},
		],
		[
			"agency",
			request => {
				request.agencyId = "18";
			},
		],
		[
			"automation",
			request => {
				request.automationId = "24";
			},
		],
		[
			"step",
			request => {
				request.stepId = "32";
			},
		],
		[
			"byte limit",
			request => {
				request.limits.maxBytes = 4095;
			},
		],
		[
			"timeout",
			request => {
				request.limits.timeoutMs = 999;
			},
		],
	];
	for (const [name, alter] of alterations) {
		it(`rejects an altered ${name} and consumes the old grant before access`, async () => {
			const { tool, calls } = fixture();
			const original = inspection();
			await approve(tool, "inspect", original);
			const altered = inspection();
			alter(altered);
			expectFailure(await tool.execute("inspect", altered), "APPROVAL_REQUIRED");
			expectFailure(await tool.execute("inspect", original), "APPROVAL_REQUIRED");
			expectNoAccess(calls);
		});
	}

	it("rejects a changed approval callback rather than approving the prepared original", async () => {
		const { tool, calls } = fixture();
		const original = inspection();
		await tool.prepareRuntimeApproval("inspect", original);
		const altered = inspection();
		altered.limits.maxBytes--;
		tool.approveRuntimeApproval("inspect", altered);
		tool.approveRuntimeApproval("inspect", original);
		expectFailure(await tool.execute("inspect", original), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});

	it("invalidates an earlier approval when the same call ID is prepared again", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		await tool.prepareRuntimeApproval("inspect", request);
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});

	it("does not retain an approved call after user denial", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		tool.denyRuntimeApproval("inspect", request);
		tool.approveRuntimeApproval("inspect", request);
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});

	for (const stage of ["prepare", "approve", "execute"] as const) {
		it(`cannot reuse a call ID grant after invalid arguments at ${stage}`, async () => {
			const { tool, calls } = fixture();
			const request = inspection();
			await approve(tool, "inspect", request);
			const invalid = { ...inspection(), approved: true } as unknown as AwsDbRequest;
			if (stage === "prepare") {
				await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", invalid), "INVALID_REQUEST");
			} else if (stage === "approve") {
				tool.approveRuntimeApproval("inspect", invalid);
			} else {
				expectFailure(await tool.execute("inspect", invalid), "INVALID_REQUEST");
			}
			tool.approveRuntimeApproval("inspect", request);
			expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			expectNoAccess(calls);
		});
	}

	for (const stage of ["approve", "execute", "away-and-back"] as const) {
		it(`invalidates session-bound approval at ${stage}`, async () => {
			const { tool, calls, changeSession } = fixture();
			const request = inspection();
			await tool.prepareRuntimeApproval("inspect", request);
			if (stage !== "approve") tool.approveRuntimeApproval("inspect", request);
			changeSession("other-session");
			if (stage === "away-and-back") changeSession("fixture-session");
			tool.approveRuntimeApproval("inspect", request);
			expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			expectNoAccess(calls);
		});
	}

	for (const denied of ["aws_db", "aws"] as const) {
		it(`rejects explicit ${denied} policy denial before resource access`, async () => {
			const { tool, calls } = fixture({}, { aws_db: "allow", aws: "allow", [denied]: "deny" });
			const request = inspection();
			await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", request), "POLICY_DENIED");
			expectNoAccess(calls);
		});
	}

	for (const denied of ["aws_db", "aws"] as const) {
		it(`retains the ToolSession ${denied} denial when execute context has no settings`, async () => {
			const { tool, calls, clearContextSettings } = fixture({}, { aws_db: "allow", aws: "allow", [denied]: "deny" });
			clearContextSettings();
			await expectRejectedCode(() => tool.prepareRuntimeApproval("inspect", inspection()), "POLICY_DENIED");
			expectNoAccess(calls);
		});
	}

	it("rechecks a changed execute-time policy and consumes the grant on denial", async () => {
		const { tool, calls, setPolicies } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		setPolicies({ aws_db: "allow", aws: "deny" });
		expectFailure(await tool.execute("inspect", request), "POLICY_DENIED");
		setPolicies({ aws_db: "allow", aws: "allow" });
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});

	for (const stage of ["awaiting-approval", "approved"] as const) {
		it(`does not revive ${stage} authority after an allow-deny-allow policy transition`, async () => {
			const { tool, calls, revisePolicies } = fixture();
			const request = inspection();
			await tool.prepareRuntimeApproval("inspect", request);
			if (stage === "approved") tool.approveRuntimeApproval("inspect", request);
			revisePolicies({ aws_db: "allow", aws: "deny" });
			revisePolicies({ aws_db: "allow", aws: "allow" });
			if (stage === "awaiting-approval") tool.approveRuntimeApproval("inspect", request);
			expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			expectNoAccess(calls);
		});
	}

	it("captures an immutable request before asynchronous worker compatibility preflight", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<AwsDbCapability>();
		const raw = inspection();
		const original = structuredClone(raw);
		let receivedApprovedSnapshot = false;
		const { tool } = fixture({
			probeWorker: async () => {
				entered.resolve();
				return release.promise;
			},
			runWorker: async request => {
				receivedApprovedSnapshot =
					Object.isFrozen(request) &&
					Object.isFrozen(request.expected) &&
					Object.isFrozen(request.limits) &&
					awsDbRequestFingerprint(request) === awsDbRequestFingerprint(original);
				return safeResult();
			},
		});
		const pending = tool.prepareRuntimeApproval("inspect", raw);
		try {
			await entered.promise;
			raw.expected.endpoint = "changed.example.invalid";
			raw.expected.secretVersionId = "c".repeat(32);
			raw.agencyId = "99";
			raw.limits.maxBytes = 1;
			release.resolve(AWS_DB_CAPABILITY);
			const approval = await pending;
			expect(approval?.allowSessionApproval === false).toBe(true);
			tool.approveRuntimeApproval("inspect", original);
			expectSuccess(await tool.execute("inspect", original));
			expect(receivedApprovedSnapshot).toBe(true);
		} finally {
			release.resolve(AWS_DB_CAPABILITY);
			await pending;
		}
	});

	it("consumes approval before a concurrent replay can enter the worker", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<SafeTemplateResult>();
		const { tool, calls } = fixture({
			runWorker: async () => {
				entered.resolve();
				return release.promise;
			},
		});
		const request = inspection();
		await approve(tool, "inspect", request);
		const first = tool.execute("inspect", request);
		try {
			await entered.promise;
			expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			release.resolve(safeResult());
			expectSuccess(await first);
			expect(calls.worker === 1 && calls.launch === 1).toBe(true);
		} finally {
			release.resolve(safeResult());
			await first;
		}
	});
});

describe("aws_db native safe output boundary", () => {
	for (const disposition of ["sanitized", "withheld", "not-found"] as const) {
		it(`returns only the closed ${disposition} result after an approved read`, async () => {
			const { tool } = fixture({ runWorker: async () => safeResult(disposition) });
			const request = inspection();
			await approve(tool, "inspect", request);
			expectSuccess(await tool.execute("inspect", request), disposition);
		});
	}

	it("does not expose a retained worker object's later raw mutations through result details", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		const workerResult = safeResult();
		const { tool } = fixture({ runWorker: async () => workerResult });
		const request = inspection();
		await approve(tool, "inspect", request);
		const delivered = await tool.execute("inspect", request);
		Reflect.set(workerResult, "structure", privateValue);
		Reflect.set(workerResult.proof, "reader", false);
		Reflect.set(workerResult.teardown, "referencesReleased", false);
		Reflect.set(workerResult, "queryText", privateValue);
		expectSuccess(delivered);
		expect(JSON.stringify(delivered).includes(privateValue)).toBe(false);
	});

	const unsafe: Array<[string, (privateValue: string) => unknown]> = [
		["extra raw template field", privateValue => ({ ...safeResult(), queryText: privateValue })],
		[
			"raw SQL identifier",
			privateValue => ({ ...safeResult(), structure: `SELECT ${privateValue} FROM IDENTIFIER` }),
		],
		["raw SQL literal", privateValue => ({ ...safeResult(), structure: `SELECT '${privateValue}'` })],
		["raw placeholder path", privateValue => ({ ...safeResult(), structure: `SELECT {steps.${privateValue}}` })],
		[
			"SQL comment payload",
			privateValue => ({ ...safeResult(), structure: `SELECT IDENTIFIER /* ${privateValue} */` }),
		],
		["multiple statements", () => ({ ...safeResult(), structure: "SELECT IDENTIFIER ; SELECT IDENTIFIER" })],
		[
			"oversized structure",
			() => ({ ...safeResult(), structure: `SELECT ${"IDENTIFIER , ".repeat(6000)}IDENTIFIER` }),
		],
		["withheld result carrying source", privateValue => ({ ...safeResult("withheld"), structure: privateValue })],
		["not-found result carrying structure", () => ({ ...safeResult("not-found"), structure: "SELECT IDENTIFIER" })],
		["nested provider cause", privateValue => ({ ...safeResult(), error: { cause: { response: privateValue } } })],
		[
			"provider data in reader proof",
			privateValue => ({ ...safeResult(), proof: { sameConnection: true, reader: true, response: privateValue } }),
		],
		[
			"provider data in teardown proof",
			privateValue => ({
				...safeResult(),
				teardown: { connectionClosed: true, referencesReleased: true, cause: { message: privateValue } },
			}),
		],
		["unproved same connection", () => ({ ...safeResult(), proof: { sameConnection: false, reader: true } })],
		["unproved reader", () => ({ ...safeResult(), proof: { sameConnection: true, reader: false } })],
		[
			"unclosed connection",
			() => ({ ...safeResult(), teardown: { connectionClosed: false, referencesReleased: true } }),
		],
		[
			"retained references",
			() => ({ ...safeResult(), teardown: { connectionClosed: true, referencesReleased: false } }),
		],
		[
			"missing proof",
			() => ({ disposition: "sanitized", structure: "SELECT IDENTIFIER", teardown: safeResult().teardown }),
		],
		["unknown disposition", privateValue => ({ ...safeResult(), disposition: privateValue })],
		["array result", privateValue => [privateValue]],
		["null result", () => null],
		[
			"inherited serialization hook",
			privateValue => Object.assign(Object.create({ toJSON: () => ({ queryText: privateValue }) }), safeResult()),
		],
		["hidden raw field", privateValue => Object.defineProperty(safeResult(), "queryText", { value: privateValue })],
		["symbol raw field", privateValue => Object.defineProperty(safeResult(), Symbol("raw"), { value: privateValue })],
		[
			"nested custom prototype",
			privateValue => {
				const result = safeResult();
				Object.setPrototypeOf(result.proof, { toJSON: () => ({ providerResponse: privateValue }) });
				return result;
			},
		],
	];
	for (const [name, value] of unsafe) {
		it(`withholds an unsafe worker result: ${name}`, async () => {
			const privateValue = randomUUID().replaceAll("-", "");
			const { tool } = fixture({ runWorker: async () => value(privateValue) as SafeTemplateResult });
			const request = inspection();
			await approve(tool, "inspect", request);
			const result = await tool.execute("inspect", request);
			expectFailure(result, "UNSAFE_OUTPUT");
			expect(JSON.stringify(result).includes(privateValue)).toBe(false);
		});
	}

	it("rejects accessors before invoking worker-controlled property getters", async () => {
		let reads = 0;
		const result = Object.defineProperty(safeResult(), "structure", {
			enumerable: true,
			get() {
				reads++;
				return "SELECT IDENTIFIER FROM IDENTIFIER";
			},
		});
		const { tool } = fixture({ runWorker: async () => result });
		const request = inspection();
		await approve(tool, "inspect", request);
		expectFailure(await tool.execute("inspect", request), "UNSAFE_OUTPUT");
		expect(reads === 0).toBe(true);
	});

	const errors: Array<[string, AwsDbFailureCode, (privateValue: string) => unknown]> = [
		[
			"provider exception",
			"WORKER_FAILED",
			privateValue => new Error(privateValue, { cause: new Error(privateValue) }),
		],
		["primitive provider failure", "WORKER_FAILED", privateValue => privateValue],
		["oversized provider diagnostic", "WORKER_FAILED", privateValue => new Error(privateValue.repeat(10_000))],
		[
			"provider response object",
			"WORKER_FAILED",
			privateValue => ({ name: "AccessDeniedException", message: privateValue, cause: { raw: privateValue } }),
		],
		[
			"forged allowlisted failure",
			"WORKER_FAILED",
			privateValue => ({ name: "AwsDbFailure", code: "AWS_ACCESS_DENIED", message: privateValue }),
		],
		["unknown failure code", "WORKER_FAILED", privateValue => new AwsDbFailure(privateValue as AwsDbFailureCode)],
		[
			"typed AWS failure with raw message and cause",
			"AWS_FAILED",
			privateValue =>
				Object.assign(new AwsDbFailure("AWS_FAILED"), {
					message: privateValue,
					stack: privateValue,
					cause: { response: privateValue },
				}),
		],
		[
			"typed database failure with raw diagnostics",
			"DB_READ_FAILED",
			privateValue =>
				Object.assign(new AwsDbFailure("DB_READ_FAILED"), {
					message: privateValue,
					sql: privateValue,
					cause: new Error(privateValue),
				}),
		],
	];
	for (const [name, code, error] of errors) {
		it(`returns only an allowlisted failure code for ${name}`, async () => {
			const privateValue = randomUUID().replaceAll("-", "");
			const { tool } = fixture({
				runWorker: async () => {
					throw error(privateValue);
				},
			});
			const request = inspection();
			await approve(tool, "inspect", request);
			let updates = 0;
			const result = await tool.execute("inspect", request, undefined, () => {
				updates++;
			});
			expectFailure(result, code);
			expect(JSON.stringify(result).includes(privateValue)).toBe(false);
			expect(updates === 0).toBe(true);
		});
	}

	it("does not invoke a rejected error's code accessor or expose its thrown cause", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		let reads = 0;
		const error = Object.defineProperty(new AwsDbFailure("AWS_FAILED"), "code", {
			get() {
				reads++;
				throw new Error(privateValue, { cause: privateValue });
			},
		});
		const { tool } = fixture({
			runWorker: async () => {
				throw error;
			},
		});
		const request = inspection();
		await approve(tool, "inspect", request);
		const result = await tool.execute("inspect", request);
		expectFailure(result, "WORKER_FAILED");
		expect(reads === 0 && !JSON.stringify(result).includes(privateValue)).toBe(true);
	});

	it("withholds launch-metadata errors before any worker can start", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		const { tool, calls } = fixture({
			launch: () => {
				throw new Error(privateValue, { cause: { path: privateValue } });
			},
		});
		const request = inspection();
		await approve(tool, "inspect", request);
		const result = await tool.execute("inspect", request);
		expectFailure(result, "WORKER_FAILED");
		expect(JSON.stringify(result).includes(privateValue)).toBe(false);
		expect(calls.launch === 1 && calls.worker === 0).toBe(true);
	});

	it("withholds rejected request values and removes their call ID grant", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		const invalid = {
			...request,
			expected: { ...request.expected, raw: { cause: privateValue } },
		} as unknown as AwsDbRequest;
		const result = await tool.execute("inspect", invalid);
		expectFailure(result, "INVALID_REQUEST");
		expect(JSON.stringify(result).includes(privateValue)).toBe(false);
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});
});

describe("aws_db cancellation and session lifetime", () => {
	for (const operation of ["preparation", "capabilities"] as const) {
		it(`owns and aborts a pending ${operation} probe on session disposal`, async () => {
			const privateValue = randomUUID().replaceAll("-", "");
			const entered = Promise.withResolvers<void>();
			const completion = Promise.withResolvers<AwsDbCapability>();
			let probeAborted = false;
			const outcome: { result?: NativeResult; error?: unknown } = {};
			const { tool, calls, dispose } = fixture({
				probeWorker: async signal => {
					signal?.addEventListener(
						"abort",
						() => {
							probeAborted = signal?.aborted === true;
							completion.reject(new Error(privateValue, { cause: privateValue }));
						},
						{ once: true },
					);
					entered.resolve();
					return completion.promise;
				},
			});
			const request =
				operation === "capabilities"
					? tool.execute("capability", { action: "capabilities" })
					: tool.prepareRuntimeApproval("prepare", inspection());
			const pending = request.then(
				value => {
					if (operation === "capabilities") outcome.result = value as NativeResult;
				},
				error => {
					outcome.error = error;
				},
			);
			try {
				await entered.promise;
				dispose();
				expect(probeAborted).toBe(true);
				await pending;
				if (operation === "capabilities") {
					expect(outcome.result !== undefined).toBe(true);
					if (outcome.result) expectFailure(outcome.result, "CANCELLED");
				} else {
					expect(outcome.error instanceof Error && outcome.error.message === "CANCELLED").toBe(true);
				}
				expect(JSON.stringify(outcome).includes(privateValue)).toBe(false);
				expectNoAccess(calls);
			} finally {
				dispose();
				completion.reject(new AwsDbFailure("CANCELLED"));
				await pending;
			}
		});
	}

	it("rejects an already-cancelled inspection before resolving launch metadata or entering a worker", async () => {
		const { tool, calls } = fixture();
		const request = inspection();
		await approve(tool, "inspect", request);
		const controller = new AbortController();
		controller.abort();
		expectFailure(await tool.execute("inspect", request, controller.signal), "CANCELLED");
		expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
		expectNoAccess(calls);
	});

	it("cancels an active worker and withholds its nested abort diagnostic", async () => {
		const privateValue = randomUUID().replaceAll("-", "");
		const entered = Promise.withResolvers<void>();
		let sawAbort = false;
		const { tool } = fixture({
			runWorker: async (_request, _launch, _authorize, signal) => {
				entered.resolve();
				const completion = Promise.withResolvers<SafeTemplateResult>();
				signal.addEventListener(
					"abort",
					() => {
						sawAbort = signal.aborted;
						completion.reject(new Error(privateValue, { cause: { response: privateValue } }));
					},
					{ once: true },
				);
				return completion.promise;
			},
		});
		const request = inspection();
		await approve(tool, "inspect", request);
		const controller = new AbortController();
		const pending = tool.execute("inspect", request, controller.signal);
		try {
			await entered.promise;
			controller.abort();
			const result = await pending;
			expectFailure(result, "CANCELLED");
			expect(JSON.stringify(result).includes(privateValue)).toBe(false);
			expect(sawAbort).toBe(true);
		} finally {
			controller.abort();
			await pending;
		}
	});

	for (const cancellation of ["external", "timeout"] as const) {
		it(`never releases a late successful result after ${cancellation} cancellation`, async () => {
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const release = Promise.withResolvers<SafeTemplateResult>();
			const { tool } = fixture({
				runWorker: async (_request, _launch, _authorize, signal) => {
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					entered.resolve();
					return release.promise;
				},
			});
			const request = inspection();
			if (cancellation === "timeout") request.limits.timeoutMs = 1;
			await approve(tool, "inspect", request);
			const controller = new AbortController();
			const pending = tool.execute("inspect", request, controller.signal);
			try {
				await entered.promise;
				if (cancellation === "external") controller.abort();
				await aborted.promise;
				release.resolve(safeResult());
				expectFailure(await pending, cancellation === "timeout" ? "TIMEOUT" : "CANCELLED");
				expectFailure(await tool.execute("inspect", request), "APPROVAL_REQUIRED");
			} finally {
				controller.abort();
				release.resolve(safeResult());
				await pending;
			}
		});
	}

	it("aborts an active worker at the exact approved timeout and suppresses its apparent success", async () => {
		let sawAbort = false;
		const { tool } = fixture({
			runWorker: async (_request, _launch, _authorize, signal) => {
				const completion = Promise.withResolvers<SafeTemplateResult>();
				signal.addEventListener(
					"abort",
					() => {
						sawAbort = signal.aborted;
						completion.resolve(safeResult());
					},
					{ once: true },
				);
				return completion.promise;
			},
		});
		const request = inspection();
		request.limits.timeoutMs = 1;
		await approve(tool, "inspect", request);
		expectFailure(await tool.execute("inspect", request), "TIMEOUT");
		expect(sawAbort).toBe(true);
	});

	for (const transition of ["dispose", "session-change"] as const) {
		it(`aborts every active inspection and clears unused grants on ${transition}`, async () => {
			const entered = Promise.withResolvers<void>();
			let starts = 0;
			let aborts = 0;
			const { tool, dispose, changeSession } = fixture({
				runWorker: async (_request, _launch, _authorize, signal) => {
					const completion = Promise.withResolvers<SafeTemplateResult>();
					signal.addEventListener(
						"abort",
						() => {
							aborts++;
							completion.resolve(safeResult());
						},
						{ once: true },
					);
					starts++;
					if (starts === 2) entered.resolve();
					return completion.promise;
				},
			});
			const request = inspection();
			await approve(tool, "first", request);
			await approve(tool, "second", request);
			await approve(tool, "unused", request);
			const first = tool.execute("first", request);
			const second = tool.execute("second", request);
			try {
				await entered.promise;
				if (transition === "dispose") dispose();
				else changeSession("other-session");
				expectFailure(await first, "CANCELLED");
				expectFailure(await second, "CANCELLED");
				expect(aborts === 2).toBe(true);
				expectFailure(
					await tool.execute("unused", request),
					transition === "dispose" ? "CANCELLED" : "APPROVAL_REQUIRED",
				);
			} finally {
				dispose();
				await Promise.all([first, second]);
			}
		});
	}
});
