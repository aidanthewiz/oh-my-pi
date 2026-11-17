import * as fs from "node:fs";
import { Socket } from "node:net";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";
import { AwsSecretInputFailure } from "../../src/tools/aws-secret-input-contract";
import type { AwsSecretInputClientConfig } from "../../src/tools/aws-secret-input-provider";
import type { AwsSecretInputScopeDependencies } from "../../src/tools/aws-secret-input-scope";
import { startAwsSecretInputWorker } from "../../src/tools/aws-secret-input-worker";
import {
	type AwsSecretInputLifecycleDescriptor,
	type AwsSecretInputLifecycleDescriptorIdentity,
	awsSecretInputLifecycleSocketIdentitiesAvailable,
	connectAwsSecretInputLifecycleControl,
	measureAwsSecretInputLifecycleDescriptors,
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

interface PrivateDescriptorSnapshot {
	descriptors: AwsSecretInputLifecycleDescriptor[];
	available: boolean;
}

function privateDescriptorSnapshot(pid = process.pid): PrivateDescriptorSnapshot {
	if (pid !== process.pid && process.platform !== "linux") return { descriptors: [], available: false };
	const directory = process.platform === "linux" ? `/proc/${pid}/fd` : "/dev/fd";
	const descriptors: AwsSecretInputLifecycleDescriptorIdentity[] = [];
	const controlPath = path.join(process.cwd(), "aws-secret-input-lifecycle-control-fd");
	let controlStat: fs.BigIntStats | undefined;
	try {
		controlStat = fs.statSync(controlPath, { bigint: true });
	} catch {}
	let entries: string[];
	try {
		entries = fs.readdirSync(directory);
	} catch {
		return { descriptors: [], available: false };
	}
	if (entries.length > 256) return { descriptors: [], available: false };
	for (const name of entries) {
		const fd = Number(name);
		if (!Number.isSafeInteger(fd) || fd < 3) continue;
		try {
			const stat =
				pid === process.pid
					? fs.fstatSync(fd, { bigint: true })
					: fs.statSync(path.join(directory, name), { bigint: true });
			let target = "";
			try {
				target = fs.readlinkSync(path.join(directory, name));
			} catch {}
			if (controlStat?.dev === stat.dev && controlStat.ino === stat.ino) target = controlPath;
			if (stat.isSocket() || stat.isFIFO() || target.endsWith("aws-secret-input-lifecycle-control-fd")) {
				descriptors.push({
					fd,
					dev: String(stat.dev),
					ino: String(stat.ino),
					target,
					kind: stat.isSocket() ? "socket" : stat.isFIFO() ? "pipe" : "file",
				});
			}
		} catch (error) {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				(error.code !== "EBADF" && error.code !== "ENOENT")
			)
				return { descriptors: [], available: false };
		}
	}
	return { descriptors: measureAwsSecretInputLifecycleDescriptors(descriptors), available: true };
}

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
	const descriptorSnapshot = privateDescriptorSnapshot();
	const port = Number(process.argv[3]);
	const control = port ? await connectAwsSecretInputLifecycleControl(port, "worker") : undefined;
	const counts = { files: 0, clients: 0, identity: 0, secret: 0, consumer: 0, destroyed: 0 };
	const configs: AwsSecretInputClientConfig[] = [];
	const files: Uint8Array[] = [];
	const responses: Record<string, unknown>[] = [];
	const inputs: Uint8Array[] = [];
	const stdinProducerObserver = createStdinProducerWitnessObserver();
	let cleanSurfaces = true;
	let unexpectedOutput = false;
	let retryDisabled = true;
	let realConsumer = false;
	const observe = (value: unknown): void => {
		if (lifecycleContainsSensitive(value)) cleanSurfaces = false;
	};
	const socketWrites = new WeakMap<object, string>();
	const socketReads = new WeakMap<object, string>();
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
			if (!stdinProducerObserver.isPrivateStdinWrite(receiver, args[0]))
				observeControl(receiver, args[0], socketWrites);
			return Reflect.apply(target, receiver, args);
		},
	});
	Socket.prototype.emit = new Proxy(originalSocketEmit, {
		apply(target, receiver, args) {
			if (args[0] === "data") observeControl(receiver, args[1], socketReads);
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
			bind(child.pid);
			return child;
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
		ipcAvailable: typeof process.send === "function" && process.connected === true,
		controlFdPresent: descriptorSnapshot.descriptors.some(descriptor =>
			descriptor.target.endsWith("aws-secret-input-lifecycle-control-fd"),
		),
		descriptors: descriptorSnapshot.descriptors,
		socketIdentitiesAvailable: awsSecretInputLifecycleSocketIdentitiesAvailable(descriptorSnapshot.descriptors),
	});
	if (control) {
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
			stdinProducerObserver.begin(options.input);
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
				stdinProducerObserver.end();
				if (globalMarkerPath) {
					control?.send({
						kind: "global-preload-probe",
						pid: process.pid,
						executed: fs.existsSync(globalMarkerPath),
					});
				}
			}
		},
		onConsumerSpawn(child) {
			const identity = child.ownedInputIdentity;
			if (!identity) throw new Error(LIFECYCLE_FAILURE);
			const workerDescriptors = privateDescriptorSnapshot();
			const guardianDescriptors = privateDescriptorSnapshot(identity.pid);
			control?.send({
				kind: "consumer-spawned",
				pid: identity.pid,
				groupId: identity.groupId,
				receiverPid: identity.receiverPid,
				workerPid: process.pid,
				stdinProducerWitness:
					identity.receiverPid === null
						? null
						: (stdinProducerObserver.witnessFor(identity.pid, identity.receiverPid) ?? null),
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
			});
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
		await control?.close();
	}
}

if (import.meta.main) {
	void runWorker().catch(() => {
		process.exitCode = 92;
		if (process.connected) process.disconnect?.();
	});
}
