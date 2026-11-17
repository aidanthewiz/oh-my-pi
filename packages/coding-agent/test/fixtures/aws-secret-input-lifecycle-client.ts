import * as fs from "node:fs";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	AWS_SECRET_INPUT_PROTOCOL,
	type AwsSecretInputCapability,
	type AwsSecretInputRequest,
	type AwsSecretInputResult,
	normalizeAwsSecretInputRequest,
} from "../../src/tools/aws-secret-input-contract";
import type { AwsSecretInputAuthorize, AwsSecretInputLaunchFiles } from "../../src/tools/aws-secret-input-provider";
import type { AwsSecretInputConsumerAdmission } from "../../src/tools/aws-secret-input-scope";
import { createAwsSecretInputWorkerClient } from "../../src/tools/aws-secret-input-worker-client";
import type {
	AwsSecretInputLifecycleControl,
	AwsSecretInputLifecycleEvent,
} from "./aws-secret-input-lifecycle-control";
import {
	type AwsSecretInputLifecycleConsumerMode,
	LIFECYCLE_DIAGNOSTIC,
	LIFECYCLE_FAILURE,
} from "./aws-secret-input-lifecycle-values";

export type AwsSecretInputLifecycleWorker = Subprocess<"ignore", "ignore", "ignore">;
interface OwnedConsumerScope {
	guardian: Process;
	receiver: Process | null;
	descendants: Process[];
}
interface OwnedWorkerState {
	scopes: OwnedConsumerScope[];
	registered: Promise<void>;
	resolveRegistration(): void;
}
const ownedWorkers = new WeakMap<AwsSecretInputLifecycleWorker, OwnedWorkerState>();

function ownedWorkerState(worker: AwsSecretInputLifecycleWorker): OwnedWorkerState {
	const existing = ownedWorkers.get(worker);
	if (existing) return existing;
	const registration = Promise.withResolvers<void>();
	void registration.promise.catch(() => {});
	const state: OwnedWorkerState = {
		scopes: [],
		registered: registration.promise,
		resolveRegistration: () => registration.resolve(),
	};
	ownedWorkers.set(worker, state);
	void worker.exited.then(() => {
		if (state.scopes.length === 0) registration.reject(new Error(LIFECYCLE_FAILURE));
	});
	return state;
}
export type AwsSecretInputLifecycleWorkerScenario =
	| "success"
	| "zombie-registration"
	| "pause-capabilities"
	| "global-bun-preload"
	| "pause-result"
	| "binary"
	| "input-limit"
	| "empty"
	| "provider-error"
	| "provider-denied"
	| "provider-pending"
	| "paused-secret"
	| "paused-identity"
	| "malformed-capability"
	| "missing-consumer-admission"
	| "skewed-capability"
	| "result-before-capability"
	| "malformed-result-after-consumer"
	| "unknown-failure"
	| "early-exit"
	| "disconnect"
	| "authorization-out-of-order"
	| "malformed-request"
	| "malformed-authorization";

export interface AwsSecretInputLifecycleClient {
	probeAwsSecretInputWorker(signal?: AbortSignal): Promise<AwsSecretInputCapability>;
	runAwsSecretInputWorker(
		request: AwsSecretInputRequest,
		launch: AwsSecretInputLaunchFiles,
		authorize: AwsSecretInputAuthorize,
		signal: AbortSignal,
		admitConsumer: AwsSecretInputConsumerAdmission,
	): Promise<AwsSecretInputResult>;
}
export interface AwsSecretInputLifecycleClientOptions {
	scenario?: AwsSecretInputLifecycleWorkerScenario;
	controlPort?: number;
	withControlDescriptor?: boolean;
	onSpawn?: (child: AwsSecretInputLifecycleWorker) => void;
	onMessage?: (message: unknown, direction: "parent-to-worker" | "worker-to-parent") => void;
	beforeDirectoryRemoval?: (directory: string) => void | Promise<void>;
}

export function createAwsSecretInputLifecycleWorkerClient(
	options: AwsSecretInputLifecycleClientOptions = {},
): AwsSecretInputLifecycleClient {
	return createAwsSecretInputWorkerClient({
		beforeDirectoryRemoval: options.beforeDirectoryRemoval,
		spawn: (_command, spawnOptions) => {
			const scenario = options.scenario ?? "success";
			const entry = [
				"malformed-capability",
				"missing-consumer-admission",
				"skewed-capability",
				"result-before-capability",
				"unknown-failure",
				"early-exit",
				"disconnect",
				"authorization-out-of-order",
			].includes(scenario)
				? "aws-secret-input-lifecycle-malformed-worker.ts"
				: "aws-secret-input-lifecycle-worker.ts";
			const standardBinary = process.env.PI_TEST_AWS_SECRET_INPUT_WORKER_BINARY;
			const malformedBinary = process.env.PI_TEST_AWS_SECRET_INPUT_MALFORMED_WORKER_BINARY;
			if (
				(standardBinary !== undefined || malformedBinary !== undefined) &&
				(!standardBinary ||
					!malformedBinary ||
					!path.isAbsolute(standardBinary) ||
					!path.isAbsolute(malformedBinary))
			)
				throw new Error(LIFECYCLE_FAILURE);
			const binary = entry === "aws-secret-input-lifecycle-malformed-worker.ts" ? malformedBinary : standardBinary;
			let controlFd: number | undefined;
			try {
				if (options.withControlDescriptor) {
					controlFd = fs.openSync(
						path.join(spawnOptions.cwd, "aws-secret-input-lifecycle-control-fd"),
						"wx+",
						0o600,
					);
					fs.writeSync(controlFd, "public control descriptor\n");
				}
				const { stdin, stdout, stderr, ...processOptions } = spawnOptions;
				const child = Bun.spawn(
					binary
						? [binary, scenario, String(options.controlPort ?? 0)]
						: [
								process.execPath,
								"--no-env-file",
								"--no-install",
								path.join(import.meta.dir, entry),
								scenario,
								String(options.controlPort ?? 0),
							],
					{
						...processOptions,
						...(controlFd === undefined
							? { stdin, stdout, stderr }
							: {
									stdio: [stdin, stdout, stderr, "ignore", controlFd] as [
										"ignore",
										"ignore",
										"ignore",
										"ignore",
										number,
									],
								}),
						ipc(message, subprocess) {
							options.onMessage?.(message, "worker-to-parent");
							if (
								message &&
								typeof message === "object" &&
								message.type === "consumer-start" &&
								Number.isSafeInteger(message.pid)
							) {
								const guardian = Process.fromPid(message.pid);
								if (
									guardian?.ppid === subprocess.pid &&
									guardian.groupId() === message.pid &&
									guardian.status() === ProcessStatus.Running
								) {
									const observedReceiver = Number.isSafeInteger(message.receiverPid)
										? Process.fromPid(message.receiverPid)
										: null;
									const receiver =
										observedReceiver?.status() === ProcessStatus.Running &&
										observedReceiver.ppid === guardian.pid &&
										observedReceiver.groupId() === guardian.pid
											? observedReceiver
											: null;
									const state = ownedWorkerState(subprocess);
									state.scopes.push({ guardian, receiver, descendants: [] });
									state.resolveRegistration();
								}
							}
							spawnOptions.ipc(message);
						},
					},
				);
				ownedWorkerState(child);
				const send = child.send.bind(child);
				child.send = message => {
					let wire: unknown = message;
					if (message && typeof message === "object" && "type" in message) {
						if (scenario === "malformed-request" && message.type === "run" && "request" in message) {
							wire = {
								...message,
								request: { ...(message.request as object), unexpected: LIFECYCLE_DIAGNOSTIC },
							};
						} else if (scenario === "malformed-authorization" && message.type === "authorize-result") {
							wire = { ...message, id: -1, cause: LIFECYCLE_DIAGNOSTIC };
						}
					}
					options.onMessage?.(wire, "parent-to-worker");
					send(wire);
				};
				options.onSpawn?.(child);
				return child;
			} finally {
				if (controlFd !== undefined) fs.closeSync(controlFd);
			}
		},
	});
}

export function awsSecretInputLifecycleLaunch(root: string): AwsSecretInputLaunchFiles {
	return {
		homeDir: root,
		configFile: path.join(root, "synthetic-config-not-written"),
		sharedCredentialsFile: path.join(root, "synthetic-credentials-not-written"),
		reservedProfiles: ["coreforge"],
	};
}

export function awsSecretInputLifecycleRequest(
	root: string,
	mode: AwsSecretInputLifecycleConsumerMode = "text",
	controlPort = 0,
	timeoutSeconds = 20,
): AwsSecretInputRequest {
	const request = normalizeAwsSecretInputRequest({
		profile: "fixture",
		region: "us-east-1",
		service: "secretsmanager",
		operation: "get-secret-value",
		parameters: {
			SecretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture/generic-input-AbCd12",
			VersionId: "01234567-89ab-cdef-0123-456789abcdef",
			VersionStage: "AWSCURRENT",
		},
		timeout: timeoutSeconds,
		secretInput: {
			protocol: AWS_SECRET_INPUT_PROTOCOL,
			capability: "sha256:4936396a3a935e4582d42be1d73ef096353d23802dcea2394f7e969ffb42a358",
			expectedIdentity: {
				account: "123456789012",
				arn: "arn:aws:sts::123456789012:assumed-role/FixtureRole/fixture",
				partition: "aws",
			},
			...(mode === "newline" ? { appendNewline: true } : {}),
			consumer: {
				argv: [
					process.execPath,
					"--no-env-file",
					"--no-install",
					path.join(import.meta.dir, "aws-secret-input-lifecycle-consumer.ts"),
					mode,
					String(controlPort),
				],
				cwd: root,
			},
		},
	});
	if ("action" in request) throw new Error("AWS_SECRET_INPUT_LIFECYCLE_FIXTURE_FAILED");
	return request;
}

export function awsSecretInputLifecycleProcessExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false;
		throw error;
	}
}

export async function waitForAwsSecretInputLifecycleConsumerReady(
	control: AwsSecretInputLifecycleControl,
	workers: readonly AwsSecretInputLifecycleWorker[],
): Promise<AwsSecretInputLifecycleEvent> {
	const ready = await control.waitForEvent("consumer-ready");
	if (
		typeof ready.pid !== "number" ||
		typeof ready.parentPid !== "number" ||
		typeof ready.descendantPid !== "number"
	) {
		throw new Error(LIFECYCLE_FAILURE);
	}
	let scope: OwnedConsumerScope;
	try {
		scope = await Promise.any(
			workers.map(async worker => {
				const state = ownedWorkerState(worker);
				await state.registered;
				const candidate = state.scopes.find(
					entry => entry.guardian.pid === ready.parentPid && entry.receiver?.pid === ready.pid,
				);
				if (!candidate) throw new Error(LIFECYCLE_FAILURE);
				return candidate;
			}),
		);
	} catch {
		throw new Error(LIFECYCLE_FAILURE);
	}
	const receiver = scope.receiver;
	if (
		!receiver ||
		scope.guardian.status() !== ProcessStatus.Running ||
		receiver.status() !== ProcessStatus.Running ||
		receiver.ppid !== scope.guardian.pid ||
		receiver.groupId() !== scope.guardian.pid
	) {
		throw new Error(LIFECYCLE_FAILURE);
	}
	const descendant = Process.fromPid(ready.descendantPid);
	if (
		!descendant ||
		descendant.status() !== ProcessStatus.Running ||
		descendant.ppid !== receiver.pid ||
		descendant.groupId() !== scope.guardian.pid
	) {
		throw new Error(LIFECYCLE_FAILURE);
	}
	if (!scope.descendants.some(entry => entry.pid === descendant.pid)) scope.descendants.push(descendant);
	return ready;
}

export async function cleanupAwsSecretInputLifecycleProcesses(
	workers: readonly AwsSecretInputLifecycleWorker[],
): Promise<void> {
	let failed = false;
	await Promise.all(
		workers.map(async worker => {
			try {
				if (worker.exitCode === null && worker.signalCode === null) {
					try {
						worker.send({ type: "stop" });
					} catch {}
					const stopped = Promise.withResolvers<void>();
					const deadline = setTimeout(stopped.resolve, 5_000);
					void worker.exited.then(() => stopped.resolve());
					await stopped.promise;
					clearTimeout(deadline);
				}
				for (const scope of ownedWorkers.get(worker)?.scopes ?? []) {
					const recipients = scope.receiver ? [...scope.descendants, scope.receiver] : scope.descendants;
					for (const recipient of recipients) {
						try {
							if (
								recipient.status() === ProcessStatus.Running &&
								!(await recipient.terminate({ group: false, gracefulMs: -1, timeoutMs: 5_000 })) &&
								recipient.status() !== ProcessStatus.Exited
							)
								failed = true;
							if (!(await recipient.waitForExit({ timeoutMs: 5_000 }))) failed = true;
						} catch {
							failed = true;
						}
					}
					try {
						if (!(await scope.guardian.waitForExit({ timeoutMs: 5_000 }))) {
							if (
								!(await scope.guardian.terminate({ group: true, gracefulMs: -1, timeoutMs: 5_000 })) &&
								scope.guardian.status() !== ProcessStatus.Exited
							)
								failed = true;
						}
					} catch {
						failed = true;
					}
				}
			} finally {
				if (worker.exitCode === null && worker.signalCode === null) {
					try {
						worker.kill("SIGKILL");
					} catch {
						failed = true;
					}
				}
				await worker.exited;
				ownedWorkers.delete(worker);
			}
		}),
	);
	if (failed) throw new Error("AWS_SECRET_INPUT_LIFECYCLE_CLEANUP_FAILED");
}
