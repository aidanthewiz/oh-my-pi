import * as fs from "node:fs";
import { Socket } from "node:net";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { ptree } from "@oh-my-pi/pi-utils";
import { AwsSecretInputFailure } from "../../src/tools/aws-secret-input-contract";
import type { AwsSecretInputClientConfig } from "../../src/tools/aws-secret-input-provider";
import type { AwsSecretInputScopeDependencies } from "../../src/tools/aws-secret-input-scope";
import { startAwsSecretInputWorker } from "../../src/tools/aws-secret-input-worker";
import {
	awsSecretInputLifecycleProcessIdentity,
	awsSecretInputLifecycleSocketIdentitiesAvailable,
	connectAwsSecretInputLifecycleControl,
	snapshotAwsSecretInputLifecycleDescriptors,
} from "./aws-secret-input-lifecycle-control";
import {
	AWS_SECRET_INPUT_STARTUP_MARKER,
	awsSecretInputLifecycleStartupPreloadSource,
} from "./aws-secret-input-lifecycle-startup-preload";
import { createStdinProducerWitnessObserver } from "./aws-secret-input-stdin-metadata";
import {
	LIFECYCLE_CREDENTIALS,
	LIFECYCLE_DIAGNOSTIC,
	LIFECYCLE_FAILURE,
	LIFECYCLE_SECRET_BINARY,
	LIFECYCLE_SECRET_LIMIT_INPUT,
	LIFECYCLE_SECRET_TEXT,
	lifecycleContainsSensitive,
} from "./aws-secret-input-lifecycle-values";

function privateDiagnostic(denied = false): Error {
	return Object.assign(
		new Error(LIFECYCLE_DIAGNOSTIC, {
			cause: { SecretString: LIFECYCLE_SECRET_TEXT, credentials: LIFECYCLE_CREDENTIALS },
		}),
		{
			name: denied ? "AccessDeniedException" : "SyntheticProviderError",
			$metadata: { httpStatusCode: denied ? 403 : 500, diagnostic: LIFECYCLE_DIAGNOSTIC },
		},
	);
}

async function runWorker() {
	const scenario = process.argv[2] ?? "success";
	const descriptorSnapshot = snapshotAwsSecretInputLifecycleDescriptors();
	const port = Number(process.argv[3]);
	const control = port ? await connectAwsSecretInputLifecycleControl(port, "worker") : undefined;
	const counts = { files: 0, clients: 0, identity: 0, secret: 0, consumer: 0, destroyed: 0 };
	const configs: AwsSecretInputClientConfig[] = [];
	const files: Uint8Array[] = [];
	const responses: Record<string, unknown>[] = [];
	const inputs: Uint8Array[] = [];
	let cleanSurfaces = true;
	let unexpectedOutput = false;
	let retryDisabled = true;
	let realConsumer = false;
	const observe = (value: unknown): void => {
		if (lifecycleContainsSensitive(value)) cleanSurfaces = false;
	};
	const socketWrites = new WeakMap<object, string>();
	const socketReads = new WeakMap<object, string>();
	const guardians = new Map<number, Process>();
	const guardianChildren = new Map<number, ReturnType<typeof Bun.spawn>>();
	let stoppedRegistration: { anchor: Process; child: ReturnType<typeof Bun.spawn>; creation: string } | undefined;
	let registrationGate: Promise<void> | undefined;
	const registrationCancelled = Promise.withResolvers<never>();
	void registrationCancelled.promise.catch(() => {});
	const resumeRegistrationGuardian = (): void => {
		const stopped = stoppedRegistration;
		if (!stopped) return;
		const current = awsSecretInputLifecycleProcessIdentity(stopped.anchor.pid);
		if (current === null || current.creation !== stopped.creation || current.state === "zombie") {
			stoppedRegistration = undefined;
			return;
		}
		if (
			current.parentPid !== process.pid ||
			current.groupId !== stopped.anchor.pid ||
			stopped.anchor.status() !== ProcessStatus.Running ||
			stopped.anchor.ppid !== process.pid ||
			stopped.anchor.groupId() !== stopped.anchor.pid
		)
			throw new Error(LIFECYCLE_FAILURE);
		stopped.child.kill("SIGCONT");
		stoppedRegistration = undefined;
	};
	const registrationMessage = (message: unknown): void => {
		if (!message || typeof message !== "object" || !("type" in message)) return;
		if (message.type !== "consumer-registered" && message.type !== "stop") return;
		if (message.type === "stop") registrationCancelled.reject(new Error(LIFECYCLE_FAILURE));
		try {
			resumeRegistrationGuardian();
		} catch {
			if (process.connected) process.disconnect?.();
		}
	};
	process.on("message", registrationMessage);
	const keeperFrames = new WeakMap<object, string>();
	const observeKeeper = (socket: object, chunk: unknown): void => {
		if (process.platform !== "darwin" || (typeof chunk !== "string" && !(chunk instanceof Uint8Array))) return;
		try {
			const pending =
				(keeperFrames.get(socket) ?? "") +
				(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			if (pending.length > 4096) {
				keeperFrames.delete(socket);
				return;
			}
			const lines = pending.split("\n");
			keeperFrames.set(socket, lines.pop()!);
			for (const line of lines) {
				const value = JSON.parse(line) as { type?: unknown; keeperPid?: unknown };
				if (value.type !== "ready" || !Number.isSafeInteger(value.keeperPid) || (value.keeperPid as number) <= 1)
					continue;
				const keeper = Process.fromPid(value.keeperPid as number);
				const guardian = keeper?.ppid ? guardians.get(keeper.ppid) : undefined;
				if (
					!guardian ||
					guardian.status() !== ProcessStatus.Running ||
					guardian.ppid !== process.pid ||
					guardian.groupId() !== guardian.pid ||
					keeper?.status() !== ProcessStatus.Running ||
					keeper.groupId() !== guardian.pid
				)
					continue;
				const identity = awsSecretInputLifecycleProcessIdentity(keeper.pid);
				control?.send({
					kind: "keeper-ready",
					pid: process.pid,
					guardianPid: guardian.pid,
					keeperIdentity:
						identity?.state === "live" && identity.parentPid === guardian.pid && identity.groupId === guardian.pid
							? identity
							: null,
				});
			}
		} catch {}
	};
	const observeControl = (socket: object, chunk: unknown, tails: WeakMap<object, string>): void => {
		const text =
			typeof chunk === "string" ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk).toString("utf8") : "";
		const combined = (tails.get(socket) ?? "") + text;
		observe(combined);
		tails.set(socket, combined.slice(-128));
	};
	const originalSocketWrite = Socket.prototype.write;
	const originalSocketEmit = Socket.prototype.emit;
	Socket.prototype.write = new Proxy(originalSocketWrite, {
		apply(target, receiver, args) {
			observeControl(receiver, args[0], socketWrites);
			return Reflect.apply(target, receiver, args);
		},
	});
	Socket.prototype.emit = new Proxy(originalSocketEmit, {
		apply(target, receiver, args) {
			if (args[0] === "data") {
				observeControl(receiver, args[1], socketReads);
				observeKeeper(receiver, args[1]);
			}
			return Reflect.apply(target, receiver, args);
		},
	});
	const originalSend = process.send;
	if (originalSend)
		process.send = new Proxy(originalSend, {
			apply(target, receiver, args) {
				observe(args[0]);
				if (scenario === "pause-capabilities" && args[0]?.type === "capabilities" && control) {
					control.send({ kind: "worker-capabilities-blocked", pid: process.pid });
					void control.waitForCommand("release-capabilities").then(() => Reflect.apply(target, receiver, args));
					return true;
				}
				if (scenario === "zombie-registration" && args[0]?.type === "consumer-start" && control) {
					if (process.platform !== "linux" || registrationGate) throw new Error(LIFECYCLE_FAILURE);
					const message = args[0];
					const guardian = guardians.get(message.pid);
					const child = guardianChildren.get(message.pid);
					const original = awsSecretInputLifecycleProcessIdentity(message.pid);
					const receiverIdentity = awsSecretInputLifecycleProcessIdentity(message.receiverPid);
					if (
						!guardian ||
						!child ||
						!original ||
						original.state !== "live" ||
						original.parentPid !== process.pid ||
						original.groupId !== guardian.pid ||
						guardian.status() !== ProcessStatus.Running ||
						guardian.ppid !== process.pid ||
						guardian.groupId() !== guardian.pid ||
						!receiverIdentity ||
						receiverIdentity.parentPid !== guardian.pid ||
						receiverIdentity.groupId !== guardian.pid
					)
						throw new Error(LIFECYCLE_FAILURE);
					stoppedRegistration = { anchor: guardian, child, creation: original.creation };
					child.kill("SIGSTOP");
					registrationGate = (async () => {
						const deadline = Date.now() + 5_000;
						while (true) {
							const current = awsSecretInputLifecycleProcessIdentity(guardian.pid);
							if (
								!current ||
								current.creation !== original.creation ||
								current.parentPid !== process.pid ||
								current.groupId !== guardian.pid
							)
								throw new Error(LIFECYCLE_FAILURE);
							if (current.state === "stopped") break;
							if (Date.now() >= deadline) throw new Error(LIFECYCLE_FAILURE);
							await Promise.race([Bun.sleep(5), registrationCancelled.promise]);
						}
						control.send({
							kind: "consumer-registration-held",
							pid: process.pid,
							guardianPid: guardian.pid,
							receiverPid: receiverIdentity.pid,
							guardianIdentity: original,
						});
						let zombie = receiverIdentity;
						while (true) {
							const current = awsSecretInputLifecycleProcessIdentity(receiverIdentity.pid);
							if (
								!current ||
								current.creation !== receiverIdentity.creation ||
								current.parentPid !== guardian.pid ||
								current.groupId !== guardian.pid
							)
								throw new Error(LIFECYCLE_FAILURE);
							if (current.state === "zombie") {
								zombie = current;
								break;
							}
							if (Date.now() >= deadline) throw new Error(LIFECYCLE_FAILURE);
							await Promise.race([Bun.sleep(5), registrationCancelled.promise]);
						}
						control.send({
							kind: "receiver-registration-zombie",
							pid: process.pid,
							guardianPid: guardian.pid,
							receiverPid: zombie.pid,
							zombieIdentity: zombie,
						});
						const limit = Promise.withResolvers<never>();
						const timer = setTimeout(() => limit.reject(new Error(LIFECYCLE_FAILURE)), 5_000);
						let wrongParent: boolean;
						try {
							wrongParent = await Promise.race([
								control.waitForCommand("release-zombie-registration").then(() => false),
								control.waitForCommand("forward-zombie-wrong-parent").then(() => true),
								registrationCancelled.promise,
								limit.promise,
							]);
						} finally {
							clearTimeout(timer);
						}
						const current = awsSecretInputLifecycleProcessIdentity(zombie.pid);
						const owner = awsSecretInputLifecycleProcessIdentity(guardian.pid);
						if (
							!current ||
							current.creation !== zombie.creation ||
							current.state !== "zombie" ||
							current.parentPid !== guardian.pid ||
							current.groupId !== guardian.pid ||
							!owner ||
							owner.creation !== original.creation ||
							owner.state !== "stopped" ||
							owner.parentPid !== process.pid ||
							owner.groupId !== guardian.pid
						)
							throw new Error(LIFECYCLE_FAILURE);
						if (wrongParent) args[0] = { ...message, receiverPid: process.pid };
						Reflect.apply(target, receiver, args);
					})().catch(() => {
						try {
							resumeRegistrationGuardian();
						} catch {}
						try {
							control.send({ kind: "zombie-registration-failed", pid: process.pid });
						} catch {}
						try {
							if (process.connected) process.disconnect?.();
						} catch {}
					});
					return true;
				}
				if (scenario === "malformed-result-after-consumer" && args[0]?.type === "result") {
					args[0] = { ...args[0], value: { ...args[0].value, cause: { message: LIFECYCLE_DIAGNOSTIC } } };
				}
				if (scenario === "pause-result" && args[0]?.type === "result" && control) {
					control.send({ kind: "worker-result-blocked", pid: process.pid });
					void control.waitForCommand("release-result").then(() => Reflect.apply(target, receiver, args));
					return true;
				}
				return Reflect.apply(target, receiver, args);
			},
		});
	const originalSpawn = Bun.spawn;
	const stdinProducerObserver = createStdinProducerWitnessObserver();
	let producerCompletion: Promise<void> | undefined;

	let pendingGuardianPid: number | undefined;
	Bun.spawn = new Proxy(originalSpawn, {
		apply(target, receiver, args) {
			const command = args[0];
			const options = args[1];
			observe(command);
			if (options && typeof options === "object") {
				observe({ env: options.env, cwd: options.cwd });
			}
			const bind = stdinProducerObserver.captureSpawn(args[1]);

			const child = Reflect.apply(target, receiver, args);
			try {
				const guardian = Process.fromPid(child.pid);
				if (guardian?.ppid === process.pid && guardian.groupId() === child.pid) {
					guardians.set(child.pid, guardian);
					guardianChildren.set(child.pid, child);
				}
			} catch {}

			const observedChild = bind(child);

			return observedChild;
		},
	});
	for (const stream of [process.stdout, process.stderr]) {
		stream.write = new Proxy(stream.write, {
			apply(target, receiver, args) {
				unexpectedOutput = true;
				observe(args[0]);
				return Reflect.apply(target, receiver, args);
			},
		});
	}
	for (const key of [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_PROFILE",
		"AWS_CONFIG_FILE",
		"AWS_SHARED_CREDENTIALS_FILE",
		"AWS_CONTAINER_CREDENTIALS_FULL_URI",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
	]) {
		process.env[key] = "public-fixture-ambient-value";
	}
	control?.send({
		kind: "worker-ready",
		pid: process.pid,
		processIdentity: awsSecretInputLifecycleProcessIdentity(process.pid),
		ipcAvailable: typeof process.send === "function" && process.connected === true,
		controlFdPresent: descriptorSnapshot.descriptors.some(descriptor =>
			descriptor.target.endsWith("aws-secret-input-lifecycle-control-fd"),
		),
		descriptors: descriptorSnapshot.descriptors,
		fdSnapshotAvailable: descriptorSnapshot.available,
		socketIdentitiesAvailable: awsSecretInputLifecycleSocketIdentitiesAvailable(descriptorSnapshot.descriptors),
	});
	if (control) {
		for (const [command, kind] of [
			["check-input-backpressure", "stdin-writer-blocked"],
			["confirm-input-backpressure", "stdin-writer-still-blocked"],
		] as const) {
			void control
				.waitForCommand(command)
				.then(() => {
					const pending =
						pendingGuardianPid === undefined ? undefined : stdinProducerObserver.pendingFor(pendingGuardianPid);
					control.send({ kind, pid: process.pid, pending: pending !== undefined, ...pending });
				})
				.catch(() => {});
		}
		void control.waitForCommand("worker-uncaught").then(() => {
			queueMicrotask(() => {
				throw privateDiagnostic();
			});
		});
		void control.waitForCommand("worker-unhandled").then(() => {
			void Promise.reject(privateDiagnostic());
		});
	}
	const pauseProviderResponse = async (phase: "identity" | "secret", abortSignal: AbortSignal): Promise<void> => {
		const pending = Promise.withResolvers<void>();
		const aborted = () => pending.reject(privateDiagnostic());
		abortSignal.addEventListener("abort", aborted, { once: true });
		if (abortSignal.aborted) aborted();
		control?.send({
			kind: scenario === "provider-pending" ? "provider-pending" : `${phase}-response-pending`,
			pid: process.pid,
		});
		try {
			if (scenario !== "provider-pending") {
				if (!control) throw new Error(LIFECYCLE_FAILURE);
				void control.waitForCommand(`release-${phase}-response`).then(() => pending.resolve(), pending.reject);
			}
			await pending.promise;
		} finally {
			abortSignal.removeEventListener("abort", aborted);
		}
	};
	const dependencies: AwsSecretInputScopeDependencies = {
		readFile: async (filename, maxBytes, signal) => {
			if (signal.aborted || maxBytes < 1) throw new Error(LIFECYCLE_FAILURE);
			counts.files++;
			let text: string;
			if (path.basename(filename) === "synthetic-config-not-written")
				text = "[profile fixture]\nregion = us-east-1\n";
			else if (path.basename(filename) === "synthetic-credentials-not-written") {
				text = `[fixture]\naws_access_key_id = ${LIFECYCLE_CREDENTIALS.accessKeyId}\naws_secret_access_key = ${LIFECYCLE_CREDENTIALS.secretAccessKey}\naws_session_token = ${LIFECYCLE_CREDENTIALS.sessionToken}\n`;
			} else throw new AwsSecretInputFailure("PROFILE_UNSUPPORTED");
			const bytes = new TextEncoder().encode(text);
			if (bytes.byteLength > maxBytes) throw new Error(LIFECYCLE_FAILURE);
			files.push(bytes);
			return bytes;
		},
		createClient: (service, config) => {
			counts.clients++;
			configs.push(config);
			retryDisabled &&= config.maxAttempts === 1;
			if (
				config.credentials.accessKeyId !== LIFECYCLE_CREDENTIALS.accessKeyId ||
				config.credentials.secretAccessKey !== LIFECYCLE_CREDENTIALS.secretAccessKey ||
				config.credentials.sessionToken !== LIFECYCLE_CREDENTIALS.sessionToken
			)
				throw new Error(LIFECYCLE_FAILURE);
			return {
				async send(command, { abortSignal }) {
					if (abortSignal.aborted) throw privateDiagnostic();
					if (service === "sts") {
						counts.identity++;
						if (scenario === "paused-identity") await pauseProviderResponse("identity", abortSignal);
						return { Account: "123456789012", Arn: "arn:aws:sts::123456789012:assumed-role/FixtureRole/fixture" };
					}
					if (service !== "secretsmanager" || !("SecretId" in command.input)) throw new Error(LIFECYCLE_FAILURE);
					counts.secret++;
					if (scenario === "provider-error" || scenario === "provider-denied")
						throw privateDiagnostic(scenario === "provider-denied");
					if (scenario === "provider-pending" || scenario === "paused-secret") {
						await pauseProviderResponse("secret", abortSignal);
					}
					const response: Record<string, unknown> = {
						ARN: command.input.SecretId,
						VersionId: "01234567-89ab-cdef-0123-456789abcdef",
						VersionStages: ["AWSCURRENT"],
						...(scenario === "binary" || scenario === "input-limit"
							? {
									SecretBinary: new Uint8Array(
										scenario === "binary" ? LIFECYCLE_SECRET_BINARY : LIFECYCLE_SECRET_LIMIT_INPUT,
									),
								}
							: { SecretString: scenario === "empty" ? "" : LIFECYCLE_SECRET_TEXT }),
					};
					responses.push(response);
					return response;
				},
				destroy() {
					counts.destroyed++;
				},
			};
		},
		executeConsumer: async (argv, options) => {
			counts.consumer++;
			observe({ argv, cwd: options?.cwd, env: options?.env });
			if (!(options?.input instanceof Uint8Array)) throw new Error(LIFECYCLE_FAILURE);
			inputs.push(options.input);
			stdinProducerObserver.begin(
				options.input,
				argv.includes("input-paused")
					? {
							constrainBuffer: true,
							onPending(pending) {
								pendingGuardianPid = pending.guardianPid;
								control?.send({ kind: "stdin-write-pending", pid: process.pid, ...pending });
							},
							onStressChannel(evidence) {
								control?.send({ kind: "stdin-stress-channel", pid: process.pid, ...evidence });
							},
							onStressClosed(evidence) {
								control?.send({ kind: "stdin-stress-closed", pid: process.pid, ...evidence });
							},
						}
					: undefined,
			);
			let globalMarkerPath: string | undefined;
			try {
				if (scenario === "global-bun-preload") {
					const configuredHome = options?.env?.HOME;
					if (typeof configuredHome !== "string" || !path.isAbsolute(configuredHome)) {
						throw new Error(LIFECYCLE_FAILURE);
					}
					const home = fs.realpathSync(configuredHome);
					const relativeHome = path.relative(fs.realpathSync(process.cwd()), home);
					if (
						!relativeHome ||
						relativeHome === ".." ||
						relativeHome.startsWith(`..${path.sep}`) ||
						path.isAbsolute(relativeHome)
					) {
						throw new Error(LIFECYCLE_FAILURE);
					}
					const preloadPath = path.join(home, "aws-secret-input-lifecycle-startup-preload.ts");
					globalMarkerPath = path.join(home, AWS_SECRET_INPUT_STARTUP_MARKER);
					fs.writeFileSync(preloadPath, awsSecretInputLifecycleStartupPreloadSource(globalMarkerPath), {
						flag: "wx",
						mode: 0o600,
					});
					fs.writeFileSync(path.join(home, ".bunfig.toml"), `preload = [${JSON.stringify(preloadPath)}]\n`, {
						flag: "wx",
						mode: 0o600,
					});
					control?.send({
						kind: "global-bun-preload-seeded",
						pid: process.pid,
						home,
						preloadPath,
						markerPath: globalMarkerPath,
					});
				}
				realConsumer = true;
				return await ptree.exec(argv, options);
			} finally {
				try {
					if (producerCompletion) {
						const deadline = Promise.withResolvers<never>();
						const timer = setTimeout(() => deadline.reject(new Error(LIFECYCLE_FAILURE)), 5_000);
						try {
							await Promise.race([producerCompletion, deadline.promise]);
						} finally {
							clearTimeout(timer);
						}
					}
				} finally {
					await stdinProducerObserver.end();
				}
				if (globalMarkerPath) {
					control?.send({
						kind: "global-preload-probe",
						pid: process.pid,
						executed: fs.existsSync(globalMarkerPath),
					});
				}
			}
		},
		async onConsumerSpawn(child) {
			const identity = child.ownedInputIdentity;
			if (!identity) throw new Error(LIFECYCLE_FAILURE);
			if (scenario === "zombie-registration") {
				const deadline = Date.now() + 5_000;
				while (awsSecretInputLifecycleProcessIdentity(identity.pid)?.state !== "live") {
					if (Date.now() >= deadline) throw new Error(LIFECYCLE_FAILURE);
					await Bun.sleep(5);
				}
			}
			const workerDescriptors = snapshotAwsSecretInputLifecycleDescriptors();
			const guardianDescriptors = snapshotAwsSecretInputLifecycleDescriptors(identity.pid);
			const spawned = {
				pid: identity.pid,
				groupId: identity.groupId,
				receiverPid: identity.receiverPid,
				workerPid: process.pid,
				guardianIdentity: awsSecretInputLifecycleProcessIdentity(identity.pid),
				stdinProducerWitness: null,
				privateDescriptors: workerDescriptors.descriptors,
				privateFdSnapshotAvailable: workerDescriptors.available,
				privateSocketIdentitiesAvailable: awsSecretInputLifecycleSocketIdentitiesAvailable(
					workerDescriptors.descriptors,
				),
				guardianDescriptors: guardianDescriptors.available ? guardianDescriptors.descriptors : null,
				guardianFdSnapshotAvailable: guardianDescriptors.available,
				guardianSocketIdentitiesAvailable: guardianDescriptors.available
					? awsSecretInputLifecycleSocketIdentitiesAvailable(guardianDescriptors.descriptors)
					: null,
			};
			control?.send({ ...spawned, kind: "consumer-channel-ready" });
			if (identity.receiverPid !== null) {
				producerCompletion = stdinProducerObserver.witnessFor(identity.pid, identity.receiverPid).then(witness => {
					control?.send({ ...spawned, kind: "consumer-spawned", stdinProducerWitness: witness ?? null });
				});
				void producerCompletion.catch(() => {});
			}
		},
	};
	try {
		await startAwsSecretInputWorker(dependencies);
		control?.send({
			kind: "worker-done",
			pid: process.pid,
			counts,
			cleanSurfaces,
			unexpectedOutput,
			retryDisabled,
			realConsumer,
			filesReleased: files.every(bytes => bytes.every(byte => byte === 0)),
			inputsObserved: inputs.length,
			inputsReleased: inputs.length > 0 ? inputs.every(bytes => bytes.every(byte => byte === 0)) : null,
			responsesObserved: responses.length,
			responsesReleased: responses.every(
				response => response.SecretString === undefined && response.SecretBinary === undefined,
			),
			credentialReferencesObserved: configs.length,
			credentialsReleased: configs.every(
				config =>
					config.credentials.accessKeyId === "" &&
					config.credentials.secretAccessKey === "" &&
					config.credentials.sessionToken === undefined,
			),
		});
	} finally {
		Bun.spawn = originalSpawn;
		if (originalSend) process.send = originalSend;
		Socket.prototype.write = originalSocketWrite;
		Socket.prototype.emit = originalSocketEmit;
		registrationCancelled.reject(new Error(LIFECYCLE_FAILURE));
		try {
			resumeRegistrationGuardian();
		} catch {}
		await registrationGate;
		process.off("message", registrationMessage);
		await control?.close();
	}
}

if (import.meta.main) {
	void runWorker().catch(() => {
		process.exitCode = 92;
		if (process.connected) process.disconnect?.();
	});
}
