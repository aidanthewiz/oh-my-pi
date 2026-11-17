import { fstatSync } from "node:fs";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { exec, OwnedInputError, type ChildProcess } from "@oh-my-pi/pi-utils/ptree";
import { lifecycleExpectedInput } from "./aws-secret-input-lifecycle-values";
import {
	createStdinProducerWitnessObserver,
	inspectStdinPrivateChannel,
	isLocallyAnonymousStdinChannel,
	isVerifiedFiniteStdinHandoff,
	type PendingStdinOperation,
	type StdinPrivateChannelEvidence,
} from "./aws-secret-input-stdin-metadata";

const MODES = ["text", "newline", "binary", "input-limit", "empty"] as const;
const FAILURE = "OWNED_STDIN_PHYSICAL_PROOF_FAILED";
const compiled = process.env.PI_COMPILED === "true";
let activeMode = "startup";
let phase = "setup";

function requireProof(value: unknown): asserts value {
	if (!value) throw new Error(FAILURE);
}

async function receiver(mode: string): Promise<void> {
	const stdinPrivateChannel = inspectStdinPrivateChannel();
	requireProof(isLocallyAnonymousStdinChannel(stdinPrivateChannel));
	if (mode === "blocked") {
		await Bun.write(Bun.stdout, "blocked-ready\n");
		setInterval(() => {}, 1_000);
		await Promise.withResolvers<void>().promise;
		return;
	}
	if (mode === "refuse") {
		const reader = Bun.stdin.stream().getReader();
		requireProof(!(await reader.read()).done);
		reader.releaseLock();
		await Bun.write(Bun.stderr, "public receiver refused remaining input\n");
		process.exit(23);
	}
	requireProof(MODES.includes(mode as (typeof MODES)[number]));
	const stdinStat = fstatSync(0, { bigint: true });
	const input = await new Response(Bun.stdin.stream()).bytes();
	const expected = lifecycleExpectedInput(mode as (typeof MODES)[number]);
	const exactInput = Buffer.from(input).equals(Buffer.from(expected));
	const receipt = {
		mode,
		compiled,
		pid: process.pid,
		parentPid: process.ppid,
		exactInput,
		inputWasEmpty: input.byteLength === 0,
		eof: true,
		stdinPrivateChannel,
		stdinDev: String(stdinStat.dev),
		stdinIno: String(stdinStat.ino),
	};
	input.fill(0);
	expected.fill(0);
	requireProof(exactInput);
	await Bun.write(Bun.stdout, JSON.stringify(receipt));
}

async function parent(): Promise<void> {
	const cases: Record<string, unknown>[] = [];
	const registrationFailure = new Error("registration refused");
	for (const mode of [
		...MODES,
		"refuse",
		"blocked",
		"cancel-registration",
		"reject-registration",
		"unexpected-producer-failure",
	] as const) {
		activeMode = mode;
		phase = "delivery";
		const input = MODES.includes(mode as (typeof MODES)[number])
			? lifecycleExpectedInput(mode as (typeof MODES)[number])
			: new Uint8Array(2_097_152).fill(0xa5);
		const stress = mode === "blocked" || mode === "unexpected-producer-failure";
		const observer = createStdinProducerWitnessObserver();
		let stressChannel:
			| {
					guardianPid: number;
					transport: "fixture-socketpair";
					sendBufferBytes: number;
					channel: StdinPrivateChannelEvidence;
			  }
			| undefined;
		let stressClosed: { guardianPid: number; readerClosed: boolean; writerClosed: boolean } | undefined;
		observer.begin(
			input,
			stress
				? {
						constrainBuffer: true,
						onStressChannel(evidence) {
							stressChannel = evidence;
						},
						onStressClosed(evidence) {
							stressClosed = evidence;
						},
					}
				: undefined,
		);
		const originalSpawn = Bun.spawn;
		const nativeOperations: Promise<number>[] = [];
		let outstandingOperations = 0;
		let endStarted = false;
		let endSettled = false;
		let operationAfterEnd = false;
		let cancelPending: (() => void) | undefined;
		let cancellationInjected = false;
		let operationRejected = false;
		let pendingAtCancellation: PendingStdinOperation | undefined;
		let guardian: Process | undefined;
		let consumer: Process | undefined;
		let ownedChildren: Process[] = [];
		let identity: ChildProcess["ownedInputIdentity"];
		let waiting = "";
		let aborting: Promise<void> | undefined;
		const controller = new AbortController();
		let registrationCleanup: (() => boolean) | undefined;
		try {
			Bun.spawn = new Proxy(originalSpawn, {
				apply(target, owner, args) {
					const bind = observer.captureSpawn(args[1]);
					const child = bind(Reflect.apply(target, owner, args));
					const writer = child.stdin as Bun.FileSink;
					requireProof(writer && typeof writer.write === "function" && typeof writer.end === "function");
					const observeOperation = (
						operation: "write" | "flush" | "end",
						run: () => number | Promise<number>,
					): number | Promise<number> => {
						if (operation === "end") endStarted = true;
						else if (endStarted) operationAfterEnd = true;
						let result: number | Promise<number>;
						try {
							result = run();
						} catch (error) {
							if (operation === "end") endSettled = true;
							throw error;
						}
						if (typeof result === "number") {
							if (operation === "end") endSettled = true;
							return result;
						}
						outstandingOperations++;
						let settled = false;
						const native = result.then(
							bytes => {
								settled = true;
								outstandingOperations--;
								if (operation === "end") endSettled = true;
								return bytes;
							},
							error => {
								settled = true;
								outstandingOperations--;
								if (operation === "end") endSettled = true;
								throw error;
							},
						);
						nativeOperations.push(native);
						void native.catch(() => {});
						if (mode !== "unexpected-producer-failure" || operation === "end") return native;
						const cancellation = Promise.withResolvers<number>();
						cancelPending = () => {
							requireProof(!settled && observer.pendingFor(child.pid) !== undefined);
							cancellationInjected = true;
							cancellation.reject(
								Object.assign(new Error("synthetic writer cancellation"), { code: "ECANCELED" }),
							);
						};
						return Promise.race([native, cancellation.promise]);
					};
					const observedWriter = new Proxy(Object.create(null) as Bun.FileSink, {
						get(_target, property) {
							if (property === "write")
								return (chunk: Parameters<Bun.FileSink["write"]>[0]) =>
									observeOperation("write", () => writer.write(chunk));
							if (property === "flush") return () => observeOperation("flush", () => writer.flush());
							if (property === "end")
								return (error: Parameters<Bun.FileSink["end"]>[0]) =>
									observeOperation("end", () => writer.end(error));
							const value = Reflect.get(writer, property, writer);
							return typeof value === "function" ? value.bind(writer) : value;
						},
						getPrototypeOf: () => Object.getPrototypeOf(writer),
					});
					return new Proxy(Object.create(null) as typeof child, {
						get(_target, property) {
							if (property === "stdin") return observedWriter;
							const value = Reflect.get(child, property, child);
							return typeof value === "function" ? value.bind(child) : value;
						},
						getPrototypeOf: () => Object.getPrototypeOf(child),
					});
				},
			});
			const receiverMode =
				mode === "cancel-registration" || mode === "reject-registration" || mode === "unexpected-producer-failure"
					? "blocked"
					: mode;
			const command = compiled
				? [process.execPath, "receiver", receiverMode]
				: [process.execPath, "--no-env-file", "--no-install", import.meta.path, "receiver", receiverMode];
			const result = await exec(command, {
				cwd: process.cwd(),
				env: {
					HOME: process.cwd(),
					USERPROFILE: process.cwd(),
					TMPDIR: process.cwd(),
					XDG_CONFIG_HOME: process.cwd(),
					XDG_CACHE_HOME: process.cwd(),
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
					DO_NOT_TRACK: "1",
				},
				input,
				ownedInput: true,
				detached: true,
				timeout: 15_000,
				signal: controller.signal,
				allowAbort: true,
				allowNonZero: true,
				stderr: "full",
				maxOutputBytes: 8_192,
				maxStderrBytes: 1_024,
				onSpawn(child) {
					identity = child.ownedInputIdentity;
					requireProof(identity && identity.receiverPid !== null);
					guardian = Process.fromPid(identity.pid) ?? undefined;
					consumer = Process.fromPid(identity.receiverPid) ?? undefined;
					requireProof(
						guardian?.status() === ProcessStatus.Running &&
							guardian.ppid === process.pid &&
							guardian.groupId() === identity.pid &&
							consumer?.status() === ProcessStatus.Running &&
							consumer.ppid === identity.pid &&
							consumer.groupId() === identity.pid,
					);
					ownedChildren = guardian.children();
					requireProof(ownedChildren.every(child => child.groupId() === identity!.pid));
					if (mode === "cancel-registration") controller.abort();
					if (mode === "reject-registration" || mode === "unexpected-producer-failure")
						registrationCleanup = () => child.ownedInputCleanedUp === true;
					if (mode === "reject-registration") return Promise.reject(registrationFailure);
				},
				onStdout(chunk) {
					if (!stress) return;
					waiting += chunk;
					if (!waiting.includes("blocked-ready\n") || aborting) return;
					aborting = (async () => {
						const deadline = Date.now() + 3_000;
						for (;;) {
							const pending = identity ? observer.pendingFor(identity.pid) : undefined;
							if (pending && (mode !== "unexpected-producer-failure" || cancelPending)) {
								pendingAtCancellation = pending;
								break;
							}
							requireProof(Date.now() < deadline);
							await Bun.sleep(1);
						}
						if (mode === "unexpected-producer-failure") cancelPending!();
						else controller.abort();
					})();
					void aborting.catch(() => controller.abort());
				},
			}).catch(error => {
				if (mode === "unexpected-producer-failure") {
					requireProof(cancellationInjected && error instanceof OwnedInputError);
					operationRejected = true;
				} else if (mode === "reject-registration") requireProof(error === registrationFailure);
				else throw error;
				return undefined;
			});
			requireProof(identity && identity.receiverPid !== null);
			const producerSettledAtExecReturn =
				endStarted &&
				endSettled &&
				outstandingOperations === 0 &&
				!operationAfterEnd &&
				observer.pendingFor(identity.pid) === undefined;
			if (mode !== "unexpected-producer-failure") requireProof(producerSettledAtExecReturn);
			await aborting;
			phase = "cleanup";
			await Promise.allSettled(nativeOperations);
			requireProof(
				guardian?.status() === ProcessStatus.Exited &&
					consumer?.status() === ProcessStatus.Exited &&
					ownedChildren.every(child => child.status() === ProcessStatus.Exited),
			);
			requireProof(
				endStarted &&
					endSettled &&
					outstandingOperations === 0 &&
					!operationAfterEnd &&
					observer.pendingFor(identity.pid) === undefined,
			);
			const witness = await observer.witnessFor(identity.pid, identity.receiverPid);
			requireProof(
				witness &&
					witness.inputUnmodified &&
					witness.flushesCompleted &&
					witness.maxChunkBytes <= 4096 &&
					witness.pipeConfigured === !stress,
			);
			const evidence = {
				mode,
				transport: stress ? "fixture-socketpair" : "production-pipe",
				ownedProcessesTerminal: true,
				producerSettledAfterFixtureJoin: true,
				producerSettledAtExecReturn,
				writerEofClosed: witness.eofClosed,
				stdinProducerWitness: witness,
				...(stress
					? { pendingAtCancellation, nativePendingSettledAfterFixtureJoin: true, stressChannel, stressClosed }
					: {}),
			};
			if (stress) {
				requireProof(
					pendingAtCancellation?.guardianPid === identity.pid &&
						(pendingAtCancellation.operation === "write" || pendingAtCancellation.operation === "flush") &&
						pendingAtCancellation.bytesAccepted > 0 &&
						pendingAtCancellation.bytesAccepted < input.byteLength &&
						witness.backpressureObserved &&
						stressChannel?.guardianPid === identity.pid &&
						stressChannel.transport === "fixture-socketpair" &&
						stressChannel.sendBufferBytes > 0 &&
						stressChannel.sendBufferBytes < 65_536 &&
						isLocallyAnonymousStdinChannel(stressChannel.channel) &&
						stressClosed?.guardianPid === identity.pid &&
						stressClosed.readerClosed &&
						stressClosed.writerClosed,
				);
			}
			if (mode === "unexpected-producer-failure") {
				requireProof(
					result === undefined &&
						operationRejected &&
						cancellationInjected &&
						!controller.signal.aborted &&
						registrationCleanup?.() === false,
				);
				cases.push({ ...evidence, operationRejected: true, cleanupAcknowledged: false });
				continue;
			}
			if (mode === "reject-registration") {
				requireProof(result === undefined && !controller.signal.aborted && registrationCleanup?.());
				cases.push(evidence);
				continue;
			}
			requireProof(result && result.ownedInputCleanedUp === true);
			if (mode === "blocked" || mode === "cancel-registration") {
				requireProof(controller.signal.aborted && result.exitError?.aborted === true);
				cases.push(evidence);
			} else if (mode === "refuse") {
				requireProof(result.exitCode === 23 && result.stderr === "public receiver refused remaining input\n");
				cases.push(evidence);
			} else {
				phase = "receiver-evidence";
				requireProof(result.exitCode === 0 && result.stderr === "");
				const received = JSON.parse(result.stdout);
				requireProof(
					received.compiled === compiled &&
						received.parentPid === identity.pid &&
						isVerifiedFiniteStdinHandoff(received.stdinPrivateChannel, witness, received, {
							...identity,
							workerPid: process.pid,
						}),
				);
				cases.push({ ...evidence, received });
			}
		} finally {
			controller.abort();
			Bun.spawn = originalSpawn;
			try {
				await observer.end();
				await Promise.allSettled(nativeOperations);
			} finally {
				input.fill(0);
			}
		}
	}
	await Bun.write(Bun.stdout, JSON.stringify({ compiled, cases }));
}

if (import.meta.main) {
	void (process.argv[2] === "receiver" ? receiver(process.argv[3] ?? "") : parent()).catch(() => {
		process.stderr.write(`${FAILURE} ${activeMode} ${phase}\n`);
		process.exitCode = 91;
	});
}
