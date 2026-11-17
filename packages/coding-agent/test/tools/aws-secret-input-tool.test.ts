import { describe, expect, it } from "bun:test";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { resolveToolCancellationBehavior } from "@oh-my-pi/pi-agent-core/tool-cancellation";
import { Settings } from "../../src/config/settings";
import type { ToolSession } from "../../src/tools";
import { AwsTool } from "../../src/tools/aws";
import {
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_PROTOCOL,
	AwsSecretInputFailure,
	type AwsSecretInputCapability,
	type AwsSecretInputCapabilityRequest,
	type AwsSecretInputFailureCode,
} from "../../src/tools/aws-secret-input-contract";
import {
	TOOL_EXECUTION_HOST_CAPABILITIES,
	type ToolExecutionHostCapabilities,
} from "../../src/tools/tool-execution-host";
import { awsSecretInputLifecycleRequest } from "../fixtures/aws-secret-input-lifecycle-client";

type Dependencies = NonNullable<ConstructorParameters<typeof AwsTool>[2]>;

const capabilityRequest: AwsSecretInputCapabilityRequest = {
	action: "secret-input-capabilities",
	protocol: AWS_SECRET_INPUT_PROTOCOL,
};

function fixture(
	options: {
		configureSession?: (session: ToolSession) => void;
		workerCapability?: unknown;
		failFirstProbe?: boolean;
	} = {},
) {
	const settings = Settings.isolated({
		"tools.approvalMode": "always-ask",
		"tools.approval": { aws: "allow", bash: "allow" },
	});
	const begin = new Set<() => void>();
	const complete = new Set<() => void>();
	const changes = new Set<() => void>();
	const counts = { probes: 0, launch: 0, workers: 0 };
	let disposed = false;
	const session: ToolSession = {
		cwd: import.meta.dir,
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getSessionId: () => "local-input-session",
		getToolContext: () => ({ settings }) as AgentToolContext,
		isDisposed: () => disposed,
		getToolExecutionCapabilities: (candidate, args) => {
			if (
				disposed ||
				candidate !== tool ||
				resolveToolCancellationBehavior(candidate, args) !== "await-cleanup" ||
				begin.size === 0 ||
				changes.size === 0
			)
				return undefined;
			return TOOL_EXECUTION_HOST_CAPABILITIES;
		},
		registerDisposeCallback: (callback, options) => {
			const callbacks = options?.phase === "begin" ? begin : complete;
			callbacks.add(callback);
			return () => {
				callbacks.delete(callback);
			};
		},
		registerSessionChangeCallback: callback => {
			changes.add(callback);
			return () => {
				changes.delete(callback);
			};
		},
	};
	options.configureSession?.(session);
	const dependencies: Dependencies = {
		probeWorker: async () => {
			counts.probes++;
			if (options.failFirstProbe && counts.probes === 1) throw new AwsSecretInputFailure("WORKER_FAILED");
			return (options.workerCapability ?? AWS_SECRET_INPUT_CAPABILITY) as AwsSecretInputCapability;
		},
		launch: () => {
			counts.launch++;
			throw new Error("Capability discovery must not load AWS launch files");
		},
		runWorker: async () => {
			counts.workers++;
			throw new Error("Capability discovery must not enter a secret scope");
		},
	};
	const tool = new AwsTool(session, undefined, dependencies);
	return {
		tool,
		counts,
		dispose() {
			disposed = true;
			for (const callback of begin) callback();
			for (const callback of complete) callback();
		},
	};
}

function failure(result: AgentToolResult<unknown>, code: AwsSecretInputFailureCode): void {
	expect(result.isError).toBe(true);
	const blocks = result.content.filter(block => block.type === "text");
	expect(blocks).toHaveLength(1);
	expect(JSON.parse(blocks[0]!.text)).toEqual({ ok: false, code });
	expect((result.details as { response?: unknown } | undefined)?.response).toEqual({ ok: false, code });
}

const unsupportedHosts: Array<[string, (session: ToolSession) => void]> = [
	[
		"no host handshake",
		session => {
			delete session.getToolExecutionCapabilities;
		},
	],
	[
		"a dispatcher that does not own this tool",
		session => {
			session.getToolExecutionCapabilities = () => undefined;
		},
	],
	[
		"the registry-only dispatcher protocol",
		session => {
			session.getToolExecutionCapabilities = () =>
				({
					...TOOL_EXECUTION_HOST_CAPABILITIES,
					protocol: "native-tool-host/v1",
				}) as unknown as ToolExecutionHostCapabilities;
		},
	],
	[
		"unjoined cancellation",
		session => {
			session.getToolExecutionCapabilities = () =>
				({
					...TOOL_EXECUTION_HOST_CAPABILITIES,
					cancellationCleanup: "tool-cancellation-cleanup/v0",
				}) as unknown as ToolExecutionHostCapabilities;
		},
	],
	[
		"no session lifecycle",
		session => {
			session.getToolExecutionCapabilities = () =>
				({
					...TOOL_EXECUTION_HOST_CAPABILITIES,
					sessionLifecycle: "tool-session-lifecycle/v1",
				}) as unknown as ToolExecutionHostCapabilities;
		},
	],
	[
		"an unknown host claim",
		session => {
			session.getToolExecutionCapabilities = () =>
				({ ...TOOL_EXECUTION_HOST_CAPABILITIES, unchecked: true }) as unknown as ToolExecutionHostCapabilities;
		},
	],
	[
		"no disposal registration",
		session => {
			delete session.registerDisposeCallback;
		},
	],
	[
		"no session-change registration",
		session => {
			delete session.registerSessionChangeCallback;
		},
	],
	[
		"no disposal-state query",
		session => {
			delete session.isDisposed;
		},
	],
];

describe.skipIf(process.platform === "win32")("AWS secret input local host admission", () => {
	for (const [name, configureSession] of unsupportedHosts) {
		it(`rejects ${name} before private worker or AWS access`, async () => {
			const current = fixture({ configureSession });
			try {
				failure(await current.tool.execute("unsupported-host", capabilityRequest), "CAPABILITY_INCOMPATIBLE");
				expect(current.counts).toEqual({ probes: 0, launch: 0, workers: 0 });
			} finally {
				current.dispose();
			}
		});
	}

	it("rejects later secret approval and execution after a capability worker failure", async () => {
		const current = fixture({ failFirstProbe: true });
		const request = awsSecretInputLifecycleRequest(import.meta.dir);
		try {
			failure(await current.tool.execute("failed-capability-worker", capabilityRequest), "WORKER_FAILED");
			await expect(current.tool.prepareRuntimeApproval("blocked-secret-approval", request)).rejects.toThrow(
				"WORKER_FAILED",
			);
			failure(await current.tool.execute("blocked-secret-execution", request), "WORKER_FAILED");
			expect(current.counts).toEqual({ probes: 1, launch: 0, workers: 0 });
		} finally {
			current.dispose();
		}
	});

	const staleDeliveryCapability = {
		...AWS_SECRET_INPUT_CAPABILITY,
		capability: "sha256:bac95b8ce6d793c137902275a7fc42ea4970babd0d73788f34e15529750bca12",
		manifest: {
			...AWS_SECRET_INPUT_CAPABILITY.manifest,
			deliveryPolicy: "finite-stdin-owned-process-group/v2",
		},
	};
	for (const [name, workerCapability] of [
		["protocol", { ...AWS_SECRET_INPUT_CAPABILITY, protocol: "aws-secret-input/v0" }],
		[
			"registry-only host",
			{
				...AWS_SECRET_INPUT_CAPABILITY,
				capability: "sha256:d22786d4a043200a285344d1ce7316ed342e7a7de68e33af4de6e07a1b7f6469",
				manifest: { ...AWS_SECRET_INPUT_CAPABILITY.manifest, hostPolicy: "native-tool-host/v1" },
			},
		],
		["stale delivery tuple", staleDeliveryCapability],
		[
			"current fingerprint with stale delivery policy",
			{ ...staleDeliveryCapability, capability: AWS_SECRET_INPUT_CAPABILITY.capability },
		],
		[
			"stale fingerprint with current delivery policy",
			{ ...staleDeliveryCapability, manifest: AWS_SECRET_INPUT_CAPABILITY.manifest },
		],
		[
			"manifest",
			{
				...AWS_SECRET_INPUT_CAPABILITY,
				manifest: { ...AWS_SECRET_INPUT_CAPABILITY.manifest, deliveryPolicy: "pty/v0" },
			},
		],
		[
			"limits",
			{ ...AWS_SECRET_INPUT_CAPABILITY, limits: { ...AWS_SECRET_INPUT_CAPABILITY.limits, maxInputBytes: 65_537 } },
		],
		["providers", { ...AWS_SECRET_INPUT_CAPABILITY, supportedProviders: ["default-chain"] }],
		["missing worker", {}],
	] as const) {
		it(`rejects worker ${name} skew before AWS access`, async () => {
			const current = fixture({ workerCapability });
			try {
				failure(await current.tool.execute("skewed-worker", capabilityRequest), "CAPABILITY_INCOMPATIBLE");
				expect(current.counts).toEqual({ probes: 1, launch: 0, workers: 0 });
			} finally {
				current.dispose();
			}
		});
	}

	it("rejects hostile worker capability accessors without reading their values", async () => {
		let evaluations = 0;
		const workerCapability = Object.defineProperty({ ...AWS_SECRET_INPUT_CAPABILITY }, "manifest", {
			enumerable: true,
			get() {
				evaluations++;
				throw new Error("untrusted worker getter");
			},
		});
		const current = fixture({ workerCapability });
		try {
			failure(await current.tool.execute("hostile-worker", capabilityRequest), "CAPABILITY_INCOMPATIBLE");
			expect(evaluations).toBe(0);
			expect(current.counts).toEqual({ probes: 1, launch: 0, workers: 0 });
		} finally {
			current.dispose();
		}
	});

	it("rejects invalid local requests before private worker discovery", async () => {
		const current = fixture();
		try {
			for (const [index, value] of [
				{ action: "secret-input-capabilities", protocol: "aws-secret-input/v0" },
				{ ...capabilityRequest, provider: "synthetic-public-provider" },
			].entries()) {
				failure(
					await current.tool.execute(`invalid-capability-${index}`, value as AwsSecretInputCapabilityRequest),
					"INVALID_REQUEST",
				);
			}
			expect(current.counts).toEqual({ probes: 0, launch: 0, workers: 0 });
		} finally {
			current.dispose();
		}
	});
});
