import { fstatSync } from "node:fs";
import { Socket } from "node:net";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { exec, OwnedInputError, type ChildProcess } from "@oh-my-pi/pi-utils/ptree";
import { lifecycleExpectedInput } from "./aws-secret-input-lifecycle-values";
import {
	createStdinProducerWitnessObserver,
	inspectStdinPrivateChannel,
	isLocallyAnonymousStdinChannel,
	isVerifiedFiniteStdinHandoff,
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
		"unproved-cancel",
	] as const) {
		activeMode = mode;
		phase = "delivery";
		const input = MODES.includes(mode as (typeof MODES)[number])
			? lifecycleExpectedInput(mode as (typeof MODES)[number])
			: new Uint8Array(2_097_152).fill(0xa5);
		const observer = createStdinProducerWitnessObserver();
		observer.begin(input);
		const originalSpawn = Bun.spawn;
		const originalWrite = Socket.prototype.write;
		let sender: Socket | undefined;
		let guardian: Process | undefined;
		let consumer: Process | undefined;
		let identity: ChildProcess["ownedInputIdentity"];
		let waiting = "";
		let aborting: Promise<void> | undefined;
		const controller = new AbortController();
		let registrationCleanup: (() => boolean) | undefined;
		try {
			Socket.prototype.write = new Proxy(originalWrite, {
				apply(target, socket, args) {
					if (socket instanceof Socket && observer.isPrivateStdinWrite(socket, args[0])) sender = socket;
					return Reflect.apply(target, socket, args);
				},
			});
			Bun.spawn = new Proxy(originalSpawn, {
				apply(target, owner, args) {
					const bind = observer.captureSpawn(args[1]);
					const child = Reflect.apply(target, owner, args);
					bind(child.pid);
					return child;
				},
			});
			const receiverMode =
				mode === "cancel-registration" || mode === "reject-registration" || mode === "unproved-cancel"
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
					if (mode === "cancel-registration") controller.abort();
					if (mode === "reject-registration" || mode === "unproved-cancel")
						registrationCleanup = () => child.ownedInputCleanedUp === true;
					if (mode === "reject-registration") return Promise.reject(registrationFailure);
				},
				onStdout(chunk) {
					if (mode !== "blocked" && mode !== "unproved-cancel") return;
					waiting += chunk;
					if (!waiting.includes("blocked-ready\n") || aborting) return;
					aborting = (async () => {
						const deadline = Date.now() + 3_000;
						while (!sender || sender.writableLength === 0) {
							requireProof(Date.now() < deadline);
							await Bun.sleep(1);
						}
						if (mode === "unproved-cancel")
							sender.destroy(Object.assign(new Error("synthetic writer cancellation"), { code: "ECANCELED" }));
						else controller.abort();
					})();
					void aborting.catch(() => controller.abort());
				},
			}).catch(error => {
				if (mode === "unproved-cancel")
					requireProof(error instanceof OwnedInputError && error.message === "PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				else if (mode === "reject-registration") requireProof(error === registrationFailure);
				else throw error;
				return undefined;
			});
			await aborting;
			phase = "cleanup";
			requireProof(identity && identity.receiverPid !== null);
			requireProof(guardian?.status() === ProcessStatus.Exited && consumer?.status() === ProcessStatus.Exited);
			if (mode === "unproved-cancel") {
				const senderError = sender?.errored;
				requireProof(
					result === undefined &&
						!controller.signal.aborted &&
						senderError &&
						"code" in senderError &&
						senderError.code === "ECANCELED" &&
						sender?.destroyed &&
						sender.closed &&
						sender.writableLength === 0 &&
						registrationCleanup?.() === false,
				);
				cases.push({ mode, reaped: true, writerClosed: true });
				continue;
			}
			if (mode === "reject-registration") {
				requireProof(
					result === undefined && !controller.signal.aborted && sender === undefined && registrationCleanup?.(),
				);
				cases.push({ mode, reaped: true, writerClosed: true });
				continue;
			}
			requireProof(result && result.ownedInputCleanedUp === true);
			if (mode === "blocked" || mode === "cancel-registration") {
				requireProof(controller.signal.aborted && result.exitError?.aborted === true);
				if (mode === "blocked") requireProof(sender?.destroyed && sender.closed && sender.writableLength === 0);
				else requireProof(sender === undefined);
				cases.push({ mode, reaped: true, writerClosed: true });
			} else if (mode === "refuse") {
				requireProof(result.exitCode === 23 && result.stderr === "public receiver refused remaining input\n");
				requireProof(sender?.destroyed && sender.closed && sender.writableLength === 0);
				cases.push({ mode, reaped: true, writerClosed: true });
			} else {
				phase = "receiver-evidence";
				requireProof(result.exitCode === 0 && result.stderr === "" && identity);
				const received = JSON.parse(result.stdout);
				const witness = observer.witnessFor(identity.pid, identity.receiverPid!);
				requireProof(
					received.compiled === compiled &&
						received.parentPid === identity.pid &&
						isVerifiedFiniteStdinHandoff(received.stdinPrivateChannel, witness, received, {
							...identity,
							workerPid: process.pid,
						}),
				);
				if (input.byteLength > 0) requireProof(sender?.destroyed && sender.closed && sender.writableLength === 0);
				cases.push({ mode, reaped: true, writerClosed: true, received });
			}
		} finally {
			controller.abort();
			Bun.spawn = originalSpawn;
			Socket.prototype.write = originalWrite;
			observer.end();
			input.fill(0);
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
