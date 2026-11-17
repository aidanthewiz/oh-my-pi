import * as fs from "node:fs";
import * as path from "node:path";
import {
	type AwsSecretInputLifecycleDescriptorIdentity,
	awsSecretInputLifecycleSocketIdentitiesAvailable,
	connectAwsSecretInputLifecycleControl,
	measureAwsSecretInputLifecycleDescriptors,
} from "./aws-secret-input-lifecycle-control";
import {
	type AwsSecretInputLifecycleConsumerMode,
	LIFECYCLE_FAILURE,
	LIFECYCLE_OUTPUT_LIMIT,
	LIFECYCLE_STDERR,
	LIFECYCLE_STDOUT,
	lifecycleContainsSensitive,
	lifecycleExpectedInput,
} from "./aws-secret-input-lifecycle-values";
import { inspectStdinPrivateChannel, isSupportedFiniteStdinDescriptor } from "./aws-secret-input-stdin-metadata";

function descriptors() {
	const directory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
	const result: AwsSecretInputLifecycleDescriptorIdentity[] = [];
	const entries = fs.readdirSync(directory);
	if (entries.length > 256) throw new Error(LIFECYCLE_FAILURE);
	for (const name of entries) {
		const fd = Number(name);
		if (!Number.isSafeInteger(fd) || fd < 3) continue;
		try {
			const stat = fs.fstatSync(fd, { bigint: true });
			let target = "";
			try {
				target = fs.readlinkSync(path.join(directory, name));
			} catch {}
			result.push({
				fd,
				dev: String(stat.dev),
				ino: String(stat.ino),
				target,
				kind: stat.isSocket() ? "socket" : stat.isFIFO() ? "pipe" : stat.isFile() ? "file" : "other",
			});
		} catch (error) {
			if (
				!error ||
				typeof error !== "object" ||
				!("code" in error) ||
				(error.code !== "EBADF" && error.code !== "ENOENT")
			)
				throw new Error(LIFECYCLE_FAILURE);
		}
	}
	return measureAwsSecretInputLifecycleDescriptors(result);
}

async function runConsumer() {
	if (process.argv[2] === "--descendant") {
		process.on("SIGTERM", () => {});
		await Bun.write(Bun.stdout, "descendant-ready\n");
		setInterval(() => {}, 1_000);
		await Promise.withResolvers<void>().promise;
		return;
	}
	const mode = process.argv[2] as AwsSecretInputLifecycleConsumerMode;
	const port = Number(process.argv[3]);
	const control = port ? await connectAwsSecretInputLifecycleControl(port, "consumer") : undefined;
	let descendant: Bun.Subprocess<"ignore", "pipe", "inherit"> | undefined;
	try {
		if (mode === "early-exit") {
			control?.send({ kind: "consumer-early-exit", pid: process.pid });
			await Bun.write(Bun.stderr, "public consumer refused input\n");
			process.exitCode = 23;
			return;
		}
		const stdinPrivateChannel = inspectStdinPrivateChannel();
		if (!isSupportedFiniteStdinDescriptor(stdinPrivateChannel)) throw new Error(LIFECYCLE_FAILURE);
		const stdinStat = fs.fstatSync(0, { bigint: true });
		let noControllingTty = false;
		try {
			const tty = fs.openSync("/dev/tty", fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
			fs.closeSync(tty);
		} catch (error) {
			noControllingTty =
				!!error &&
				typeof error === "object" &&
				"code" in error &&
				["ENXIO", "ENODEV", "ENOENT"].includes(String(error.code));
		}
		const input = await new Response(Bun.stdin.stream()).bytes();
		const expected = lifecycleExpectedInput(mode);
		const exactInput = Buffer.from(input).equals(Buffer.from(expected));
		const inheritedDescriptors = descriptors();
		const receipt = {
			kind: "input-complete",
			pid: process.pid,
			parentPid: process.ppid,
			exactInput,
			inputWasEmpty: input.byteLength === 0,
			eof: true,
			credentialEnv: Object.keys(process.env).filter(key =>
				/^(?:AWS_|AMAZON_|NODE_CHANNEL_|NODE_UNIQUE_ID$|BUN_CHANNEL_|BUN_INTERNAL_.*IPC)/u.test(key),
			),
			ipcAvailable:
				typeof process.send === "function" ||
				process.connected === true ||
				(process.channel !== undefined && process.channel !== null),
			controlFdInherited: inheritedDescriptors.some(descriptor =>
				descriptor.target.endsWith("aws-secret-input-lifecycle-control-fd"),
			),
			descriptors: inheritedDescriptors,
			socketIdentitiesAvailable: awsSecretInputLifecycleSocketIdentitiesAvailable(inheritedDescriptors),
			argvClean: !lifecycleContainsSensitive(process.argv),
			envClean: !lifecycleContainsSensitive(process.env),
			stdinIsTTY: stdinPrivateChannel.isTerminal,
			stdinPrivateChannel,
			stdinDev: String(stdinStat.dev),
			stdinIno: String(stdinStat.ino),
			stdinIsRegularFile: stdinPrivateChannel.isRegularFile,
			noControllingTty,
		};
		control?.send(receipt);
		input.fill(0);
		expected.fill(0);
		if (
			!exactInput ||
			receipt.credentialEnv.length ||
			receipt.ipcAvailable ||
			receipt.controlFdInherited ||
			!receipt.argvClean ||
			!receipt.envClean ||
			receipt.stdinIsTTY ||
			receipt.stdinIsRegularFile ||
			!receipt.noControllingTty
		) {
			throw new Error(LIFECYCLE_FAILURE);
		}
		if (mode === "hold" || mode === "commit-hold" || mode === "exit-with-descendant") {
			if (!control) throw new Error(LIFECYCLE_FAILURE);
			process.on("SIGTERM", () => {});
			descendant = Bun.spawn([process.execPath, "--no-env-file", "--no-install", import.meta.path, "--descendant"], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "inherit",
				env: process.env,
			});
			const reader = descendant.stdout.getReader();
			let ready = "";
			try {
				while (!ready.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error(LIFECYCLE_FAILURE);
					ready += new TextDecoder().decode(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			if (ready !== "descendant-ready\n") throw new Error(LIFECYCLE_FAILURE);
			if (mode === "commit-hold") {
				fs.writeFileSync(
					path.join(process.cwd(), "aws-secret-input-lifecycle-committed"),
					"public committed action\n",
					{ flag: "wx" },
				);
				await Bun.write(Bun.stdout, "public action committed\n");
			}
			control.send({
				kind: "consumer-ready",
				pid: process.pid,
				parentPid: process.ppid,
				descendantPid: descendant.pid,
				committed: mode === "commit-hold",
			});
			if (mode === "exit-with-descendant") {
				await control.waitForCommand("exit-consumer");
				await Promise.all([Bun.write(Bun.stdout, LIFECYCLE_STDOUT), Bun.write(Bun.stderr, LIFECYCLE_STDERR)]);
				process.exit(0);
			}
			await control.waitForCommand("release-consumer");
			descendant.kill("SIGKILL");
			await descendant.exited;
		} else if (mode === "boundary" || mode === "overflow") {
			const size = LIFECYCLE_OUTPUT_LIMIT + (mode === "overflow" ? 1 : 0);
			await Promise.all([Bun.write(Bun.stdout, "O".repeat(size)), Bun.write(Bun.stderr, "E".repeat(size))]);
			process.exitCode = 7;
			return;
		} else if (mode === "signal") {
			control?.send({ kind: "consumer-self-signalling", pid: process.pid });
			process.kill(process.pid, "SIGKILL");
			await Promise.withResolvers<void>().promise;
			return;
		}
		if (mode === "write") {
			fs.writeFileSync(
				path.join(process.cwd(), "aws-secret-input-lifecycle-committed"),
				"public committed action\n",
				{ flag: "wx" },
			);
			control?.send({ kind: "consumer-committed", pid: process.pid });
		}
		await Promise.all([Bun.write(Bun.stdout, LIFECYCLE_STDOUT), Bun.write(Bun.stderr, LIFECYCLE_STDERR)]);
		process.exitCode = mode === "success" ? 0 : 7;
	} finally {
		if (descendant && descendant.exitCode === null) descendant.kill("SIGKILL");
		if (descendant) await descendant.exited;
		await control?.close();
	}
}

if (import.meta.main) {
	void runConsumer().catch(async () => {
		await Bun.write(Bun.stderr, `${LIFECYCLE_FAILURE}\n`);
		process.exitCode = 91;
	});
}
