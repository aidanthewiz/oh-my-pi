import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { Process } from "@oh-my-pi/pi-natives";
import stsPackage from "@aws-sdk/client-sts/package.json" with { type: "json" };
import secretPackage from "@aws-sdk/client-secrets-manager/package.json" with { type: "json" };
import ssoPackage from "@aws-sdk/client-sso/package.json" with { type: "json" };
import { TOOL_CANCELLATION_CLEANUP_VERSION } from "@oh-my-pi/pi-agent-core/tool-cancellation";
import { ptree } from "@oh-my-pi/pi-utils";
import {
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_MANIFEST,
	AwsSecretInputFailure,
	assertAwsSecretInputPlainData,
	normalizeAwsSecretInputRequest,
	safeAwsSecretInputFailure,
} from "./aws-secret-input-contract";
import { AWS_SECRET_INPUT_PROVIDER_POLICY_ID } from "./aws-secret-input-provider";
import {
	AWS_SECRET_INPUT_SCOPE_ID,
	AWS_SECRET_INPUT_DELIVERY_POLICY_ID,
	AWS_SECRET_INPUT_OUTPUT_POLICY_ID,
	AWS_SECRET_INPUT_SCOPE_CONSUMER_ADMISSION_ID,
	runAwsSecretInputScope,
	type AwsSecretInputScopeDependencies,
	type AwsSecretInputStep,
} from "./aws-secret-input-scope";
import {
	AWS_SECRET_INPUT_WORKER_ID,
	AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID,
	assertAwsSecretInputResult,
	workerFailureCode,
	type AwsSecretInputWorkerInbound,
	type AwsSecretInputWorkerOutbound,
} from "./aws-secret-input-worker-protocol";

function loadedCapability() {
	if (!ptree.PTREE_OWNED_INPUT_SUPPORTED) throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	if (
		process.platform === "win32" ||
		ptree.PTREE_EXEC_INPUT_POLICY !== AWS_SECRET_INPUT_MANIFEST.deliveryPolicy ||
		AWS_SECRET_INPUT_WORKER_ID !== AWS_SECRET_INPUT_MANIFEST.worker ||
		AWS_SECRET_INPUT_SCOPE_ID !== AWS_SECRET_INPUT_MANIFEST.scope ||
		AWS_SECRET_INPUT_SCOPE_CONSUMER_ADMISSION_ID !== AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID ||
		TOOL_CANCELLATION_CLEANUP_VERSION !== AWS_SECRET_INPUT_MANIFEST.executionPolicy ||
		AWS_SECRET_INPUT_PROVIDER_POLICY_ID !== AWS_SECRET_INPUT_MANIFEST.authPolicy ||
		AWS_SECRET_INPUT_DELIVERY_POLICY_ID !== AWS_SECRET_INPUT_MANIFEST.deliveryPolicy ||
		AWS_SECRET_INPUT_OUTPUT_POLICY_ID !== AWS_SECRET_INPUT_MANIFEST.outputPolicy ||
		[stsPackage, secretPackage, ssoPackage].some(value => value.version !== "3.1150.0")
	)
		throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	return AWS_SECRET_INPUT_CAPABILITY;
}

interface PrivateWorkerReaper {
	reap(): Promise<void>;
	close(): void;
}

function privateWorkerReaper(): PrivateWorkerReaper | undefined {
	if (process.platform !== "linux") return undefined;
	if (!process.connected || typeof process.send !== "function")
		throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	const symbols = {
		prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
		waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		__errno_location: { args: [], returns: FFIType.ptr },
	} as const;
	const musl = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
	for (const name of ["libc.so.6", "libc.so", ...(musl ? [`/lib/ld-musl-${musl}.so.1`] : [])]) {
		const library = (() => {
			try {
				return dlopen(name, symbols);
			} catch {
				return undefined;
			}
		})();
		if (!library) continue;
		if (library.symbols.prctl(36, 1, 0, 0, 0) !== 0) {
			library.close();
			continue;
		}
		const root = Process.fromPid(process.pid);
		if (!root) {
			library.close();
			throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
		}
		return {
			async reap(): Promise<void> {
				const deadline = Date.now() + 5_000;
				for (;;) {
					for (const child of root.children()) child.killTree(9);
					let pid;
					do {
						pid = library.symbols.waitpid(-1, null, 1);
					} while (pid > 0);
					if (pid < 0) {
						const address = library.symbols.__errno_location();
						if (!address) throw new AwsSecretInputFailure("WORKER_FAILED");
						const errno = new Int32Array(toArrayBuffer(address, 0, 4))[0];
						if (errno === 10 && root.children().length === 0) return;
						if (errno !== 4 && errno !== 10) throw new AwsSecretInputFailure("WORKER_FAILED");
					}
					if (Date.now() >= deadline) throw new AwsSecretInputFailure("WORKER_FAILED");
					await Bun.sleep(5);
				}
			},
			close() {
				library.close();
			},
		};
	}
	throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
}
export async function startAwsSecretInputWorker(dependencies: AwsSecretInputScopeDependencies = {}): Promise<void> {
	const controller = new AbortController();
	const pending = new Map<
		number,
		{ kind: "aws" | "consumer"; resolve: () => void; reject: (error: AwsSecretInputFailure) => void }
	>();
	const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
	let sequence = 0;
	let started = false;
	let completed = false;
	let registration: { resolve: () => void; reject: (error: AwsSecretInputFailure) => void } | undefined;
	let reaper: PrivateWorkerReaper | undefined;
	const send = async (message: AwsSecretInputWorkerOutbound): Promise<void> => {
		if (!process.send || !process.connected) throw new AwsSecretInputFailure("CANCELLED");
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		try {
			process.send(message, (error: Error | null) =>
				error ? reject(new AwsSecretInputFailure("WORKER_FAILED")) : resolve(),
			);
		} catch {
			reject(new AwsSecretInputFailure("WORKER_FAILED"));
		}
		await promise;
	};
	const close = (): void => {
		if (completed) return;
		completed = true;
		for (const waiter of pending.values()) waiter.reject(new AwsSecretInputFailure("CANCELLED"));
		pending.clear();
		registration?.reject(new AwsSecretInputFailure("CANCELLED"));
		registration = undefined;
		stop();
	};
	const cancel = (): void => {
		if (completed) return;
		controller.abort();
		for (const waiter of pending.values()) waiter.reject(new AwsSecretInputFailure("CANCELLED"));
		pending.clear();
		registration?.reject(new AwsSecretInputFailure("CANCELLED"));
		registration = undefined;
		if (!started) close();
	};
	const authorize = async (step: AwsSecretInputStep): Promise<void> => {
		if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		const id = ++sequence;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		pending.set(id, { kind: "aws", resolve, reject });
		void promise.catch(() => {});
		try {
			await send({ type: "authorize", id, step });
			await promise;
			if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		} finally {
			pending.delete(id);
		}
	};
	const admitConsumer = async (): Promise<void> => {
		if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		const id = ++sequence;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		pending.set(id, { kind: "consumer", resolve, reject });
		void promise.catch(() => {});
		try {
			await send({ type: "consumer-admission", id });
			await promise;
			if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
		} finally {
			pending.delete(id);
		}
	};
	const onMessage = (unknown: unknown): void => {
		try {
			assertAwsSecretInputPlainData(unknown);
		} catch {
			cancel();
			return;
		}
		if (!unknown || typeof unknown !== "object" || Array.isArray(unknown)) {
			cancel();
			return;
		}
		const message = unknown as AwsSecretInputWorkerInbound;
		if (message.type === "stop" && Object.keys(message).length === 1) {
			cancel();
			return;
		}
		if (message.type === "authorize-result" || message.type === "consumer-admission-result") {
			const waiter = pending.get(message.id);
			if (
				!waiter ||
				waiter.kind !== (message.type === "authorize-result" ? "aws" : "consumer") ||
				typeof message.allowed !== "boolean" ||
				Object.keys(message).some(key => !["type", "id", "allowed", "code"].includes(key))
			) {
				cancel();
				return;
			}
			message.allowed
				? waiter.resolve()
				: waiter.reject(
						new AwsSecretInputFailure(
							message.code === undefined ? "GUARD_DENIED" : workerFailureCode(message.code),
						),
					);
			return;
		}
		if (message.type === "consumer-registered" && Object.keys(message).length === 1) {
			if (!registration) {
				cancel();
				return;
			}
			const waiter = registration;
			registration = undefined;
			waiter.resolve();
			return;
		}
		if (message.type !== "run" || started || Object.keys(message).length !== 3) {
			cancel();
			return;
		}
		started = true;
		void (async () => {
			try {
				loadedCapability();
				const request = normalizeAwsSecretInputRequest(message.request);
				if ("action" in request) throw new AwsSecretInputFailure("INVALID_REQUEST");
				const result = await runAwsSecretInputScope(
					request,
					message.launch,
					authorize,
					controller.signal,
					admitConsumer,
					{
						...dependencies,
						async onConsumerSpawn(child) {
							if (!process.send || !process.connected || registration)
								throw new AwsSecretInputFailure("CANCELLED");
							const identity = child.ownedInputIdentity;
							if (!identity || identity.pid !== child.pid || identity.groupId !== child.pid)
								throw new AwsSecretInputFailure("WORKER_FAILED");
							const registered = Promise.withResolvers<void>();
							void registered.promise.catch(() => {});
							registration = registered;
							try {
								await send({
									type: "consumer-start",
									pid: identity.pid,
									groupId: identity.groupId,
									receiverPid: identity.receiverPid,
								});
								await registered.promise;
								if (controller.signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
								await dependencies.onConsumerSpawn?.(child);
							} finally {
								if (registration === registered) registration = undefined;
							}
						},
					},
				);
				assertAwsSecretInputResult(result, false);
				await reaper?.reap();
				await send({ type: "result", value: result });
			} catch (error) {
				let code = safeAwsSecretInputFailure(error);
				try {
					await reaper?.reap();
				} catch {
					code = "WORKER_FAILED";
				}
				try {
					await send({
						type: "failure",
						code: code === "WORKER_FAILED" ? code : controller.signal.aborted ? "CANCELLED" : code,
					});
				} catch {}
			} finally {
				close();
			}
		})();
	};
	process.on("message", onMessage);
	process.once("disconnect", cancel);
	process.once("SIGTERM", cancel);
	process.once("SIGINT", cancel);
	process.on("uncaughtException", cancel);
	process.on("unhandledRejection", cancel);
	try {
		reaper = privateWorkerReaper();
		await send({
			type: "capabilities",
			value: loadedCapability(),
			consumerAdmission: AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID,
		});
	} catch {
		try {
			await send({ type: "failure", code: "CAPABILITY_INCOMPATIBLE" });
		} catch {}
		close();
	}
	await stopped;
	process.off("message", onMessage);
	process.off("disconnect", cancel);
	process.off("SIGTERM", cancel);
	process.off("SIGINT", cancel);
	process.off("uncaughtException", cancel);
	process.off("unhandledRejection", cancel);
	reaper?.close();
	if (process.connected) process.disconnect?.();
}
if (import.meta.main)
	void startAwsSecretInputWorker().catch(async () => {
		process.exitCode = 1;
		try {
			if (process.connected && process.send) {
				const { promise, resolve } = Promise.withResolvers<void>();
				process.send({ type: "failure", code: "WORKER_FAILED" }, () => resolve());
				await promise;
			}
		} catch {
		} finally {
			try {
				if (process.connected) process.disconnect?.();
			} catch {}
		}
	});
