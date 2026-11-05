import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { AWS_DB_WORKER_ARG } from "../cli/worker-selectors";
import {
	assertAwsDbCapability,
	AwsDbFailure,
	safeAwsDbFailure,
	type AwsDbCapability,
	type AwsDbInspectionRequest,
	type SafeTemplateResult,
} from "./aws-db-contract";
import type { AwsDbAuthorize, AwsDbLaunchFiles } from "./aws-db-scope";
import {
	assertSafeTemplateResult,
	workerFailureCode,
	type AwsDbWorkerInbound,
	type AwsDbWorkerOutbound,
} from "./aws-db-worker-protocol";

type OwnedWorker = Subprocess<"ignore", "ignore", "ignore">;
export interface AwsDbWorkerSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	stdin: "ignore";
	stdout: "ignore";
	stderr: "ignore";
	windowsHide: boolean;
	ipc(data: unknown): void;
	onExit(): void;
}
export interface AwsDbWorkerProcessDependencies {
	spawn?: (command: string[], options: AwsDbWorkerSpawnOptions) => OwnedWorker;
	beforeDirectoryRemoval?: (directory: string) => void;
}

async function workerOperation(
	request: AwsDbInspectionRequest | undefined,
	launch: AwsDbLaunchFiles | undefined,
	authorize: AwsDbAuthorize | undefined,
	signal: AbortSignal | undefined,
	dependencies: AwsDbWorkerProcessDependencies = {},
): Promise<AwsDbCapability | SafeTemplateResult> {
	if (signal?.aborted) throw new AwsDbFailure("CANCELLED");
	const host = workerHostEntry();
	const command = isCompiledBinary()
		? [process.execPath, AWS_DB_WORKER_ARG]
		: [
				process.execPath,
				"--no-env-file",
				"--no-install",
				...(host ? [host, AWS_DB_WORKER_ARG] : [path.join(import.meta.dir, "aws-db-worker.ts")]),
			];
	const { promise, resolve, reject } = Promise.withResolvers<AwsDbCapability | SafeTemplateResult>();
	void promise.catch(() => {});
	let runtimeDirectory: string | undefined;
	let child: OwnedWorker | undefined;
	let settled = false;
	let compatible = false;
	let authorizing = false;
	let lastAuthorization = 0;
	let finished = false;
	let killTimer: Timer | undefined;
	const send = (message: AwsDbWorkerInbound): void => {
		if (!child || child.killed) throw new AwsDbFailure("WORKER_FAILED");
		child.send(message);
	};
	const settleFailure = (
		code: "CANCELLED" | "TIMEOUT" | "WORKER_FAILED" | "CAPABILITY_INCOMPATIBLE" | "UNSAFE_OUTPUT",
	): void => {
		if (settled) return;
		settled = true;
		reject(new AwsDbFailure(code));
		try {
			send({ type: "stop" });
		} catch {
			/* Owned process termination remains mandatory. */
		}
		killTimer = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {}
		}, 1_000);
	};
	const cancel = (): void => settleFailure("CANCELLED");
	const deadline = setTimeout(() => settleFailure("TIMEOUT"), request?.limits.timeoutMs ?? 10_000);
	signal?.addEventListener("abort", cancel, { once: true });
	try {
		runtimeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aws-db-scope-"));
		if (settled) return await promise;
		const spawn =
			dependencies.spawn ?? ((command: string[], options: AwsDbWorkerSpawnOptions) => Bun.spawn(command, options));
		child = spawn(command, {
			cwd: runtimeDirectory,
			env: {
				HOME: runtimeDirectory,
				USERPROFILE: runtimeDirectory,
				XDG_CONFIG_HOME: runtimeDirectory,
				XDG_CACHE_HOME: runtimeDirectory,
				TMPDIR: runtimeDirectory,
				DO_NOT_TRACK: "1",
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
			},
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			windowsHide: true,
			ipc(data: unknown) {
				if (settled || !data || typeof data !== "object" || Array.isArray(data)) {
					if (!settled) settleFailure("UNSAFE_OUTPUT");
					return;
				}
				const message = data as AwsDbWorkerOutbound;
				try {
					if (message.type === "capabilities") {
						if (compatible || Object.keys(message).length !== 2) throw new AwsDbFailure("UNSAFE_OUTPUT");
						assertAwsDbCapability(message.value);
						compatible = true;
						if (request && launch) send({ type: "inspect", request, launch });
						else {
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
							Object.keys(message).length !== 3 ||
							!Number.isSafeInteger(message.id) ||
							message.id !== lastAuthorization + 1
						)
							throw new AwsDbFailure("UNSAFE_OUTPUT");
						lastAuthorization = message.id;
						authorizing = true;
						void authorize(message.step)
							.then(
								() => {
									if (!settled) send({ type: "authorize-result", id: message.id, allowed: true });
								},
								error => {
									if (!settled)
										send({
											type: "authorize-result",
											id: message.id,
											allowed: false,
											code: safeAwsDbFailure(error),
										});
								},
							)
							.catch(() => settleFailure("WORKER_FAILED"))
							.finally(() => {
								authorizing = false;
							});
						return;
					}
					if (message.type === "result") {
						if (!compatible || !request || authorizing || Object.keys(message).length !== 2)
							throw new AwsDbFailure("UNSAFE_OUTPUT");
						assertSafeTemplateResult(message.value);
						settled = true;
						resolve(message.value);
						return;
					}
					if (message.type === "failure" && Object.keys(message).length === 2) {
						settled = true;
						reject(new AwsDbFailure(workerFailureCode(message.code)));
						return;
					}
					throw new AwsDbFailure("UNSAFE_OUTPUT");
				} catch (error) {
					settleFailure(
						error instanceof AwsDbFailure && error.code === "CAPABILITY_INCOMPATIBLE"
							? "CAPABILITY_INCOMPATIBLE"
							: "UNSAFE_OUTPUT",
					);
				}
			},
			onExit() {
				finished = true;
				if (!settled) settleFailure(compatible ? "WORKER_FAILED" : "CAPABILITY_INCOMPATIBLE");
			},
		});
		if (signal?.aborted) cancel();
		return await promise;
	} catch (error) {
		throw error instanceof AwsDbFailure ? error : new AwsDbFailure("WORKER_FAILED");
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", cancel);
		try {
			if (!finished) send({ type: "stop" });
		} catch {}
		if (child && !finished) {
			const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(1_000).then(() => false)]);
			if (!exited) {
				try {
					child.kill("SIGKILL");
				} catch {}
				await child.exited;
			}
		}
		if (child) await child.exited;
		clearTimeout(killTimer);
		child = undefined;
		if (runtimeDirectory) {
			let observationFailed = false;
			try {
				if (dependencies.beforeDirectoryRemoval) await dependencies.beforeDirectoryRemoval(runtimeDirectory);
			} catch {
				observationFailed = true;
			} finally {
				try {
					await fs.rm(runtimeDirectory, { force: true, recursive: true });
				} catch {
					throw new AwsDbFailure("WORKER_FAILED");
				}
			}
			if (observationFailed) throw new AwsDbFailure("WORKER_FAILED");
		}
	}
}

export function createAwsDbWorkerClient(dependencies: AwsDbWorkerProcessDependencies = {}) {
	return {
		async probeAwsDbWorker(signal?: AbortSignal): Promise<AwsDbCapability> {
			const result = await workerOperation(undefined, undefined, undefined, signal, dependencies);
			assertAwsDbCapability(result);
			return result;
		},
		async runAwsDbWorker(
			request: AwsDbInspectionRequest,
			launch: AwsDbLaunchFiles,
			authorize: AwsDbAuthorize,
			signal: AbortSignal,
		): Promise<SafeTemplateResult> {
			const result = await workerOperation(request, launch, authorize, signal, dependencies);
			assertSafeTemplateResult(result);
			return result;
		},
	};
}
const nativeWorkerClient = createAwsDbWorkerClient();
export const probeAwsDbWorker = nativeWorkerClient.probeAwsDbWorker;
export const runAwsDbWorker = nativeWorkerClient.runAwsDbWorker;
