import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { AWS_SECRET_INPUT_WORKER_ARG } from "../cli/worker-selectors";
import {
	assertAwsSecretInputCapability,
	assertAwsSecretInputPlainData,
	AwsSecretInputFailure,
	awsSecretInputTimeoutMs,
	safeAwsSecretInputFailure,
	type AwsSecretInputCapability,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
	type AwsSecretInputResult,
} from "./aws-secret-input-contract";
import type {
	AwsSecretInputAuthorize,
	AwsSecretInputLaunchFiles,
	AwsSecretInputScopeResult,
	AwsSecretInputConsumerAdmission,
} from "./aws-secret-input-scope";
import {
	AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID,
	assertAwsSecretInputResult,
	workerFailureCode,
	type AwsSecretInputWorkerInbound,
	type AwsSecretInputWorkerOutbound,
} from "./aws-secret-input-worker-protocol";

type OwnedWorker = Subprocess<"ignore", "ignore", "ignore">;
export interface AwsSecretInputWorkerSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	stdin: "ignore";
	stdout: "ignore";
	stderr: "ignore";
	windowsHide: boolean;
	detached: boolean;
	ipc(data: unknown): void;
	onExit(): void;
}
export interface AwsSecretInputWorkerProcessDependencies {
	spawn?: (command: string[], options: AwsSecretInputWorkerSpawnOptions) => OwnedWorker;
	beforeDirectoryRemoval?: (directory: string) => void | Promise<void>;
}

interface OwnedConsumerCreation {
	readonly pid: number;
	readonly creation: string;
}

interface OwnedConsumerIdentity extends OwnedConsumerCreation {
	readonly parentPid: number;
	readonly groupId: number;
	readonly state: "live" | "zombie";
}

function ownedConsumerIdentity(pid: number): OwnedConsumerIdentity | null {
	if (process.platform === "linux") {
		try {
			const record = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = record.lastIndexOf(")");
			const fields = record
				.slice(close + 2)
				.trim()
				.split(/\s+/u);
			const parentPid = Number(fields[1]);
			const groupId = Number(fields[2]);
			const creation = fields[19];
			if (
				!record.startsWith(`${pid} (`) ||
				close < 0 ||
				!fields[0] ||
				!/^[RSDTtWKPIZXx]$/u.test(fields[0]) ||
				!Number.isSafeInteger(parentPid) ||
				parentPid < 0 ||
				!Number.isSafeInteger(groupId) ||
				groupId <= 0 ||
				!creation ||
				!/^[0-9]+$/u.test(creation)
			)
				throw new AwsSecretInputFailure("WORKER_FAILED");
			return { pid, parentPid, groupId, creation, state: /^[ZXx]$/u.test(fields[0]) ? "zombie" : "live" };
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
			throw new AwsSecretInputFailure("WORKER_FAILED");
		}
	}
	if (process.platform !== "darwin") throw new AwsSecretInputFailure("WORKER_FAILED");
	const library = dlopen("/usr/lib/libproc.dylib", {
		proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	try {
		const data = new Uint8Array(136);
		if (library.symbols.proc_pidinfo(pid, 3, 1, ptr(data), data.byteLength) !== data.byteLength) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return null;
			}
			throw new AwsSecretInputFailure("WORKER_FAILED");
		}
		const view = new DataView(data.buffer);
		const parentPid = view.getUint32(16, true);
		const groupId = view.getUint32(100, true);
		const status = view.getUint32(4, true);
		const seconds = view.getBigUint64(120, true);
		const microseconds = view.getBigUint64(128, true);
		if (
			view.getUint32(12, true) !== pid ||
			groupId <= 0 ||
			status < 1 ||
			status > 5 ||
			seconds === 0n ||
			microseconds >= 1_000_000n
		)
			throw new AwsSecretInputFailure("WORKER_FAILED");
		return {
			pid,
			parentPid,
			groupId,
			creation: `${seconds}:${microseconds}`,
			state: status === 5 ? "zombie" : "live",
		};
	} finally {
		library.close();
	}
}

function captureOwnedReceiver(
	pid: number,
	guardianPid: number,
	groupId: number,
): { anchor?: Process; identity?: OwnedConsumerIdentity } {
	const before = ownedConsumerIdentity(pid);
	if (before === null) {
		if (ownedConsumerIdentity(pid) !== null) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
		return {};
	}
	const matches = (identity: OwnedConsumerIdentity): boolean =>
		identity.pid === pid &&
		identity.creation === before.creation &&
		identity.parentPid === guardianPid &&
		identity.groupId === groupId;
	if (!matches(before)) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
	const anchor = Process.fromPid(pid) ?? undefined;
	const after = ownedConsumerIdentity(pid);
	if (after === null) return { identity: before };
	if (!matches(after)) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
	if (anchor?.status() === ProcessStatus.Running && anchor.ppid === guardianPid && anchor.groupId() === groupId)
		return { anchor, identity: before };
	const terminal = ownedConsumerIdentity(pid);
	if (terminal === null) return { identity: before };
	if (!matches(terminal)) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
	if (terminal.state !== "zombie" || (anchor && anchor.status() !== ProcessStatus.Exited))
		throw new AwsSecretInputFailure("WORKER_FAILED");
	return { anchor, identity: before };
}

async function waitForOwnedConsumerReaping(owned: readonly OwnedConsumerCreation[]): Promise<boolean> {
	const pending = new Map(owned.map(identity => [identity.pid, identity.creation]));
	const deadline = Date.now() + 5_000;
	while (pending.size > 0) {
		for (const [pid, creation] of pending) {
			try {
				const current = ownedConsumerIdentity(pid);
				if (current === null || current.creation !== creation) pending.delete(pid);
			} catch {}
		}
		if (pending.size === 0) return true;
		if (Date.now() >= deadline) return false;
		await Bun.sleep(5);
	}
	return true;
}
async function reapOwnedConsumer(anchor: Process): Promise<boolean> {
	let reaped = true;
	try {
		if (anchor.status() === ProcessStatus.Running)
			reaped = await anchor.terminate({ group: true, gracefulMs: -1, timeoutMs: 5_000 });
	} catch {
		reaped = false;
	}
	try {
		if (!(await anchor.waitForExit({ timeoutMs: 5_000 }))) reaped = false;
	} catch {
		reaped = false;
	}
	return reaped;
}

async function reapOwnedConsumerScope(
	guardian: Process,
	receiver: Process | undefined,
	owned: readonly OwnedConsumerCreation[],
): Promise<boolean> {
	let reaped = true;
	let guardianExited = false;
	try {
		// Receiver group termination also kills the guardian.
		guardianExited = await guardian.waitForExit({ timeoutMs: 5_000 });
	} catch {
		reaped = false;
	}
	if (!guardianExited) {
		if (!(await reapOwnedConsumer(guardian))) reaped = false;
		try {
			guardianExited = guardian.status() === ProcessStatus.Exited;
		} catch {
			reaped = false;
		}
	}
	if (receiver && (!guardianExited || !(await reapOwnedConsumer(receiver)))) reaped = false;
	if (!(await waitForOwnedConsumerReaping(owned))) reaped = false;
	return reaped;
}

async function workerOperation(
	request: AwsSecretInputRequest | undefined,
	launch: AwsSecretInputLaunchFiles | undefined,
	authorize: AwsSecretInputAuthorize | undefined,
	signal: AbortSignal | undefined,
	admitConsumer: AwsSecretInputConsumerAdmission | undefined,
	dependencies: AwsSecretInputWorkerProcessDependencies,
): Promise<AwsSecretInputCapability | AwsSecretInputResult> {
	if (signal?.aborted) throw new AwsSecretInputFailure("CANCELLED");
	if (request && typeof admitConsumer !== "function") throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	const host = workerHostEntry();
	const command = isCompiledBinary()
		? [process.execPath, AWS_SECRET_INPUT_WORKER_ARG]
		: [
				process.execPath,
				"--no-env-file",
				"--no-install",
				...(host
					? [host, AWS_SECRET_INPUT_WORKER_ARG]
					: [path.join(import.meta.dir, "aws-secret-input-worker.ts")]),
			];
	const { promise, resolve, reject } = Promise.withResolvers<AwsSecretInputCapability | AwsSecretInputScopeResult>();
	void promise.catch(() => {});
	let directory: string | undefined;
	let child: OwnedWorker | undefined;
	let worker: Process | undefined;
	let consumer: Process | undefined;
	let receiver: Process | undefined;
	const consumerCreations: OwnedConsumerCreation[] = [];
	let settled = false;
	let compatible = false;
	let runDispatched = false;
	let workerOutcomeReceived = false;
	let authorizing = false;
	let lastAuthorization = 0;
	let consumerStarted = false;
	let consumerAdmitted = false;
	let finished = false;
	let cancellation: "CANCELLED" | "TIMEOUT" | undefined;
	let escalation: Timer | undefined;
	let cleanupFailed = false;
	let failure: AwsSecretInputFailure | undefined;
	const send = (message: AwsSecretInputWorkerInbound): void => {
		if (!child || child.killed) throw new AwsSecretInputFailure("WORKER_FAILED");
		child.send(message);
	};
	const fail = (code: AwsSecretInputFailureCode): void => {
		if (code === "WORKER_FAILED") cleanupFailed = true;
		if (settled) return;
		settled = true;
		failure = new AwsSecretInputFailure(code);
		reject(failure);
	};
	const stop = (code: "CANCELLED" | "TIMEOUT"): void => {
		if (cancellation) return;
		cancellation = code;
		try {
			send({ type: "stop" });
		} catch {
			fail(runDispatched ? "WORKER_FAILED" : code);
		}
		escalation = setTimeout(() => fail(code), 5_000);
	};
	const cancel = (): void => stop("CANCELLED");
	const deadline = setTimeout(() => stop("TIMEOUT"), request ? awsSecretInputTimeoutMs(request) : 10_000);
	signal?.addEventListener("abort", cancel, { once: true });
	let value: AwsSecretInputCapability | AwsSecretInputScopeResult | undefined;
	try {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aws-secret-input-"));
		if (signal?.aborted) throw new AwsSecretInputFailure("CANCELLED");
		const spawn =
			dependencies.spawn ??
			((argv: string[], options: AwsSecretInputWorkerSpawnOptions) => Bun.spawn(argv, options));
		child = spawn(command, {
			cwd: directory,
			env: {
				HOME: directory,
				USERPROFILE: directory,
				XDG_CONFIG_HOME: directory,
				XDG_CACHE_HOME: directory,
				TMPDIR: directory,
				DO_NOT_TRACK: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			detached: true,
			windowsHide: true,
			ipc(data: unknown) {
				try {
					assertAwsSecretInputPlainData(data);
					if (!data || typeof data !== "object" || Array.isArray(data))
						throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
					const message = data as AwsSecretInputWorkerOutbound;
					if (message.type === "failure" && Object.keys(message).length === 2) {
						workerOutcomeReceived = true;
						const code = workerFailureCode(message.code);
						fail(code === "WORKER_FAILED" ? code : (cancellation ?? code));
						return;
					}
					if (settled) return;
					if (message.type === "capabilities") {
						if (compatible) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						if (
							Object.keys(message).length !== 3 ||
							message.consumerAdmission !== AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID
						)
							throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
						assertAwsSecretInputCapability(message.value);
						compatible = true;
						if (cancellation) {
							send({ type: "stop" });
							return;
						}
						if (!worker || worker.ppid !== process.pid || worker.groupId() !== child?.pid)
							throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
						if (request && launch && directory) {
							runDispatched = true;
							send({ type: "run", request, launch: { ...launch, runtimeDirectory: directory } });
						} else {
							settled = true;
							resolve(message.value);
							send({ type: "stop" });
						}
						return;
					}
					if (message.type === "authorize") {
						if (
							!compatible ||
							!request ||
							!authorize ||
							authorizing ||
							consumerStarted ||
							consumerAdmitted ||
							Object.keys(message).length !== 3 ||
							!Number.isSafeInteger(message.id) ||
							message.id !== lastAuthorization + 1
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						lastAuthorization = message.id;
						authorizing = true;
						void authorize(message.step)
							.then(
								() => {
									if (!settled)
										send({
											type: "authorize-result",
											id: message.id,
											allowed: !cancellation,
											...(cancellation ? { code: cancellation } : {}),
										});
								},
								error => {
									if (!settled)
										send({
											type: "authorize-result",
											id: message.id,
											allowed: false,
											code: safeAwsSecretInputFailure(error),
										});
								},
							)
							.catch(() => fail("WORKER_FAILED"))
							.finally(() => {
								authorizing = false;
							});
						return;
					}
					if (message.type === "consumer-admission") {
						if (
							!compatible ||
							!request ||
							!admitConsumer ||
							authorizing ||
							consumerAdmitted ||
							consumerStarted ||
							Object.keys(message).length !== 2 ||
							!Number.isSafeInteger(message.id) ||
							message.id !== lastAuthorization + 1
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						lastAuthorization = message.id;
						authorizing = true;
						void admitConsumer()
							.then(
								() => {
									if (settled) return;
									consumerAdmitted = !cancellation;
									send({
										type: "consumer-admission-result",
										id: message.id,
										allowed: consumerAdmitted,
										...(cancellation ? { code: cancellation } : {}),
									});
								},
								error => {
									if (!settled)
										send({
											type: "consumer-admission-result",
											id: message.id,
											allowed: false,
											code: safeAwsSecretInputFailure(error),
										});
								},
							)
							.catch(() => fail("WORKER_FAILED"))
							.finally(() => {
								authorizing = false;
							});
						return;
					}
					if (message.type === "consumer-start") {
						if (
							!compatible ||
							!request ||
							!consumerAdmitted ||
							authorizing ||
							consumerStarted ||
							Object.keys(message).length !== 4 ||
							!Number.isSafeInteger(message.pid) ||
							message.pid <= 1 ||
							message.groupId !== message.pid ||
							(message.receiverPid !== null &&
								(!Number.isSafeInteger(message.receiverPid) || message.receiverPid <= 1)) ||
							!child
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						const anchor = Process.fromPid(message.pid);
						if (
							!anchor ||
							anchor.status() !== ProcessStatus.Running ||
							anchor.ppid !== child.pid ||
							anchor.groupId() !== message.groupId
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						consumer = anchor;
						const guardianIdentity = ownedConsumerIdentity(anchor.pid);
						if (guardianIdentity === null) throw new AwsSecretInputFailure("WORKER_FAILED");
						if (
							guardianIdentity.state !== "live" ||
							guardianIdentity.parentPid !== child.pid ||
							guardianIdentity.groupId !== message.groupId
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						consumerCreations.push(guardianIdentity);
						const captured =
							message.receiverPid === null
								? undefined
								: captureOwnedReceiver(message.receiverPid, anchor.pid, message.groupId);
						const currentGuardian = ownedConsumerIdentity(anchor.pid);
						if (
							currentGuardian === null ||
							currentGuardian.creation !== guardianIdentity.creation ||
							currentGuardian.state !== "live" ||
							currentGuardian.parentPid !== child.pid ||
							currentGuardian.groupId !== message.groupId ||
							anchor.status() !== ProcessStatus.Running ||
							anchor.ppid !== child.pid ||
							anchor.groupId() !== message.groupId
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						receiver = captured?.anchor;
						if (captured?.identity) consumerCreations.push(captured.identity);
						consumerStarted = true;
						send({ type: "consumer-registered" });
						return;
					}
					if (message.type === "result") {
						if (
							!compatible ||
							!request ||
							authorizing ||
							!consumerAdmitted ||
							!consumerStarted ||
							Object.keys(message).length !== 2
						)
							throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
						workerOutcomeReceived = true;
						assertAwsSecretInputResult(message.value, false);
						settled = true;
						resolve(message.value);
						return;
					}
					throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
				} catch (error) {
					const code = safeAwsSecretInputFailure(error);
					fail(code === "CAPABILITY_INCOMPATIBLE" || code === "WORKER_FAILED" ? code : "UNSAFE_OUTPUT");
				}
			},
			onExit() {
				finished = true;
				if (
					!settled ||
					(runDispatched &&
						!workerOutcomeReceived &&
						(failure?.code === "CANCELLED" || failure?.code === "TIMEOUT"))
				)
					fail(
						cancellation && !runDispatched
							? cancellation
							: compatible
								? "WORKER_FAILED"
								: "CAPABILITY_INCOMPATIBLE",
					);
			},
		});
		worker = Process.fromPid(child.pid) ?? undefined;
		if (signal?.aborted) cancel();
		value = await promise;
	} catch (error) {
		failure = error instanceof AwsSecretInputFailure ? error : new AwsSecretInputFailure("WORKER_FAILED");
	} finally {
		clearTimeout(deadline);
		clearTimeout(escalation);
		signal?.removeEventListener("abort", cancel);
		try {
			if (!finished) send({ type: "stop" });
		} catch {}
		if (child && !finished) {
			const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(5_000).then(() => false)]);
			if (!exited) {
				if (consumer && !(await reapOwnedConsumerScope(consumer, receiver, consumerCreations)))
					cleanupFailed = true;
				try {
					if (worker) {
						if (!(await worker.terminate({ group: true, gracefulMs: -1, timeoutMs: 5_000 })))
							cleanupFailed = true;
					} else child.kill("SIGKILL");
				} catch {
					cleanupFailed = true;
				}
			}
		}
		if (consumer && !(await reapOwnedConsumerScope(consumer, receiver, consumerCreations))) cleanupFailed = true;
		if (child) {
			try {
				await child.exited;
			} catch {
				cleanupFailed = true;
			}
		}
		consumer = undefined;
		receiver = undefined;
		worker = undefined;
		child = undefined;
		if (directory) {
			try {
				await dependencies.beforeDirectoryRemoval?.(directory);
			} catch {
				cleanupFailed = true;
			}
			try {
				await fs.rm(directory, { force: true, recursive: true });
			} catch {
				cleanupFailed = true;
			}
		}
	}
	if (cleanupFailed) throw new AwsSecretInputFailure("WORKER_FAILED");
	if (failure) throw failure;
	if (!request) {
		assertAwsSecretInputCapability(value!);
		return value!;
	}
	const scope = value! as AwsSecretInputScopeResult;
	const result: AwsSecretInputResult = {
		...scope,
		...(cancellation
			? {
					cancelled: cancellation === "CANCELLED",
					timedOut: cancellation === "TIMEOUT",
					completion: "uncertain" as const,
				}
			: {}),
		teardown: { ...scope.teardown, workerReaped: true },
	};
	assertAwsSecretInputResult(result);
	return result;
}
export function createAwsSecretInputWorkerClient(dependencies: AwsSecretInputWorkerProcessDependencies = {}) {
	return {
		async probeAwsSecretInputWorker(signal?: AbortSignal): Promise<AwsSecretInputCapability> {
			const value = await workerOperation(undefined, undefined, undefined, signal, undefined, dependencies);
			assertAwsSecretInputCapability(value);
			return value;
		},
		async runAwsSecretInputWorker(
			request: AwsSecretInputRequest,
			launch: AwsSecretInputLaunchFiles,
			authorize: AwsSecretInputAuthorize,
			signal: AbortSignal,
			admitConsumer: AwsSecretInputConsumerAdmission,
		): Promise<AwsSecretInputResult> {
			const value = await workerOperation(request, launch, authorize, signal, admitConsumer, dependencies);
			assertAwsSecretInputResult(value);
			return value;
		},
	};
}
const nativeWorkerClient = createAwsSecretInputWorkerClient();
export const probeAwsSecretInputWorker = nativeWorkerClient.probeAwsSecretInputWorker;
export const runAwsSecretInputWorker = nativeWorkerClient.runAwsSecretInputWorker;
