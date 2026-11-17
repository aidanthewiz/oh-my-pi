import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	AwsSecretInputFailure,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
	type AwsSecretInputResult,
	normalizeAwsSecretInputRequest,
} from "../src/tools/aws-secret-input-contract";
import type { AwsSecretInputAuthorize, AwsSecretInputLaunchFiles } from "../src/tools/aws-secret-input-provider";
import type { AwsSecretInputConsumerAdmission } from "../src/tools/aws-secret-input-scope";
import {
	awsSecretInputLifecycleLaunch,
	awsSecretInputLifecycleProcessExists,
	awsSecretInputLifecycleRequest,
	cleanupAwsSecretInputLifecycleProcesses,
	createAwsSecretInputLifecycleWorkerClient,
	waitForAwsSecretInputLifecycleConsumerReady,
	type AwsSecretInputLifecycleClient,
	type AwsSecretInputLifecycleWorker,
	type AwsSecretInputLifecycleWorkerScenario,
} from "./fixtures/aws-secret-input-lifecycle-client";
import {
	createAwsSecretInputLifecycleControl,
	awsSecretInputLifecycleSocketIdentitiesAvailable,
	measureAwsSecretInputLifecycleDescriptors,
	type AwsSecretInputLifecycleControl,
	type AwsSecretInputLifecycleDescriptor,
	type AwsSecretInputLifecycleEvent,
} from "./fixtures/aws-secret-input-lifecycle-control";
import {
	type AwsSecretInputLifecycleConsumerMode,
	LIFECYCLE_DIAGNOSTIC,
	LIFECYCLE_OUTPUT_LIMIT,
	LIFECYCLE_STDERR,
	LIFECYCLE_STDOUT,
	lifecycleContainsSensitive,
} from "./fixtures/aws-secret-input-lifecycle-values";
import { isVerifiedFiniteStdinHandoff } from "./fixtures/aws-secret-input-stdin-metadata";

interface DirectoryObservation {
	directory: string;
	files: string[];
	clean: boolean;
	workersExited: boolean;
}
interface LifecycleBoundary {
	root: string;
	client: AwsSecretInputLifecycleClient;
	control: AwsSecretInputLifecycleControl;
	controller: AbortController;
	request: AwsSecretInputRequest;
	launch: AwsSecretInputLaunchFiles;
	workers: AwsSecretInputLifecycleWorker[];
	exited: Set<number>;
	messages: { direction: string; message: unknown }[];
	directories: DirectoryObservation[];
	run(
		request?: AwsSecretInputRequest,
		authorize?: AwsSecretInputAuthorize,
		admitConsumer?: AwsSecretInputConsumerAdmission,
	): Promise<AwsSecretInputResult>;
}
interface FileSnapshot {
	files: string[];
	clean: boolean;
}

async function snapshot(directory: string): Promise<FileSnapshot> {
	const files: string[] = [];
	let clean = !lifecycleContainsSensitive(directory);
	const walk = async (current: string): Promise<void> => {
		for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
			const filename = path.join(current, entry.name);
			clean &&= !lifecycleContainsSensitive(entry.name);
			if (entry.isDirectory()) await walk(filename);
			else if (entry.isFile()) {
				files.push(path.relative(directory, filename));
				clean &&= !lifecycleContainsSensitive(await fsp.readFile(filename));
			} else clean = false;
		}
	};
	await walk(directory);
	return { files: files.sort(), clean };
}

async function withBoundary(
	scenario: AwsSecretInputLifecycleWorkerScenario,
	mode: AwsSecretInputLifecycleConsumerMode,
	exercise: (boundary: LifecycleBoundary) => Promise<void>,
	options: { timeoutSeconds?: number; withControlDescriptor?: boolean } = {},
): Promise<void> {
	const root = await fsp.mkdtemp(path.join(os.tmpdir(), "aws-secret-input-lifecycle-"));
	let cleanupControl: AwsSecretInputLifecycleControl | undefined;
	const workers: AwsSecretInputLifecycleWorker[] = [];
	const exited = new Set<number>();
	const messages: LifecycleBoundary["messages"] = [];
	const directories: DirectoryObservation[] = [];
	const active: Promise<unknown>[] = [];
	const controller = new AbortController();
	try {
		const control = await createAwsSecretInputLifecycleControl();
		cleanupControl = control;
		const client = createAwsSecretInputLifecycleWorkerClient({
			scenario,
			controlPort: control.port,
			withControlDescriptor: options.withControlDescriptor,
			onSpawn(child) {
				workers.push(child);
				void child.exited.then(() => {
					exited.add(child.pid);
				});
			},
			onMessage(message, direction) {
				messages.push({ direction, message });
			},
			async beforeDirectoryRemoval(directory) {
				const observation = await snapshot(directory);
				if (observation.files.includes("aws-secret-input-lifecycle-control-fd")) {
					observation.clean &&=
						(await fsp.readFile(path.join(directory, "aws-secret-input-lifecycle-control-fd"), "utf8")) ===
						"public control descriptor\n";
				}
				directories.push({
					directory,
					...observation,
					workersExited: workers.every(worker => exited.has(worker.pid)),
				});
			},
		});
		const request = awsSecretInputLifecycleRequest(root, mode, control.port, options.timeoutSeconds ?? 20);
		const launch = awsSecretInputLifecycleLaunch(root);
		await exercise({
			root,
			client,
			control,
			controller,
			request,
			launch,
			workers,
			exited,
			messages,
			directories,
			run(input = request, authorize = async () => {}, admitConsumer = async () => {}) {
				const operation = client.runAwsSecretInputWorker(
					input,
					launch,
					authorize,
					controller.signal,
					admitConsumer,
				);
				active.push(operation);
				void operation.catch(() => {});
				return operation;
			},
		});
	} finally {
		controller.abort();
		try {
			await cleanupAwsSecretInputLifecycleProcesses(workers);
			await Promise.allSettled(active);
		} finally {
			try {
				await cleanupControl?.close();
			} finally {
				await fsp.rm(root, { recursive: true, force: true });
			}
		}
	}
}

function expectFixedFailure(error: unknown, code: AwsSecretInputFailureCode): void {
	expect(lifecycleContainsSensitive(error), "private diagnostic escaped in an error or cause").toBe(false);
	expect(error instanceof AwsSecretInputFailure).toBe(true);
	if (!(error instanceof AwsSecretInputFailure)) return;
	expect(error.code === code, "worker returned a non-fixed failure code").toBe(true);
	expect(error.message === code, "worker exposed a diagnostic error message").toBe(true);
	expect(error.cause === undefined, "worker exposed a diagnostic cause").toBe(true);
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
	try {
		await operation;
		return undefined;
	} catch (error) {
		return error;
	}
}

async function expectQuiescent(boundary: LifecycleBoundary, cleanIpc = true): Promise<void> {
	expect(boundary.workers.length, "operation replaced or retried its private worker").toBe(1);
	const worker = boundary.workers[0]!;
	expect(boundary.exited.has(worker.pid), "operation returned before joining its worker").toBe(true);
	expect(awsSecretInputLifecycleProcessExists(worker.pid)).toBe(false);
	await boundary.control.waitForEvent("worker-control-closed");
	const pids = new Set<number>();
	const receiverStarts = new Set(
		boundary.control.events
			.filter(event => event.kind === "input-complete" || event.kind === "consumer-early-exit")
			.map(event => event.pid),
	);
	expect(receiverStarts.size <= 1, "operation replaced or retried its receiver").toBe(true);
	for (const event of boundary.control.events) {
		if (event.kind !== "input-complete" && !event.kind.startsWith("consumer-")) continue;
		if (typeof event.pid === "number") pids.add(event.pid);
		if (typeof event.descendantPid === "number") pids.add(event.descendantPid);
		if (typeof event.receiverPid === "number") pids.add(event.receiverPid);
	}
	for (const pid of pids)
		expect(awsSecretInputLifecycleProcessExists(pid), "owned consumer or descendant remained after completion").toBe(
			false,
		);
	if (boundary.control.events.some(event => event.source === "consumer"))
		await boundary.control.waitForEvent("consumer-control-closed");
	expect(boundary.control.clean).toBe(true);
	if (cleanIpc) expect(lifecycleContainsSensitive(boundary.messages), "secret entered worker control IPC").toBe(false);
	expect(boundary.directories.length).toBe(1);
	for (const observation of boundary.directories) {
		expect(observation.clean, "secret entered a worker artifact").toBe(true);
		expect(
			observation.files.every(file => file === "aws-secret-input-lifecycle-control-fd"),
			"private worker created an unexpected artifact",
		).toBe(true);
		expect(observation.workersExited, "private files were removed before worker exit").toBe(true);
		expect(fs.existsSync(observation.directory)).toBe(false);
	}
	const consumerFiles = await snapshot(boundary.root);
	expect(consumerFiles.clean, "secret entered a consumer artifact").toBe(true);
	expect(
		consumerFiles.files.every(file => file === "aws-secret-input-lifecycle-committed"),
		"receiver created an unexpected artifact",
	).toBe(true);
	if (consumerFiles.files.includes("aws-secret-input-lifecycle-committed")) {
		expect(
			(await fsp.readFile(path.join(boundary.root, "aws-secret-input-lifecycle-committed"), "utf8")) ===
				"public committed action\n",
			"writable receiver artifact contained unexpected data",
		).toBe(true);
	}
}

async function expectWorkerDone(
	boundary: LifecycleBoundary,
	counts: Record<string, number>,
): Promise<AwsSecretInputLifecycleEvent> {
	const done = await boundary.control.waitForEvent("worker-done");
	expect(done.counts).toEqual(counts);
	expect(done.cleanSurfaces, "private worker argv, environment, or IPC contained secret data").toBe(true);
	expect(done.unexpectedOutput, "private worker emitted diagnostic output").toBe(false);
	expect(done.retryDisabled).toBe(true);
	expect(done.filesReleased).toBe(true);
	expect(done.inputsObserved).toBe(counts.consumer);
	expect(done.inputsReleased).toBe((counts.consumer ?? 0) > 0 ? true : null);
	expect(done.responsesReleased).toBe(true);
	expect(done.credentialsReleased).toBe(true);
	return done;
}

const COMPLETE_COUNTS = { files: 2, clients: 2, identity: 1, secret: 1, consumer: 1, destroyed: 2 };
const NO_PROVIDER_COUNTS = { files: 0, clients: 0, identity: 0, secret: 0, consumer: 0, destroyed: 0 };

test.skipIf(process.platform !== "linux")(
	"compares Linux socket endpoint identities without treating descriptor aliases as unknown",
	() => {
		const measured = measureAwsSecretInputLifecycleDescriptors([
			{ fd: 3, dev: "9", ino: "41", target: "socket:[41]", kind: "socket" },
			{ fd: 7, dev: "9", ino: "41", target: "socket:[41]", kind: "socket" },
			{ fd: 8, dev: "9", ino: "42", target: "socket:[42]", kind: "socket" },
			{ fd: 9, dev: "9", ino: "43", target: "socket:[44]", kind: "socket" },
		]);
		expect(measured[0]?.aliases).toEqual([3, 7]);
		expect(measured[1]?.aliases).toEqual([3, 7]);
		expect(measured[2]?.aliases).toEqual([8]);
		expect(awsSecretInputLifecycleSocketIdentitiesAvailable(measured.slice(0, 3))).toBe(true);
		expect(measured[3]?.measurable).toBe(false);
		expect(awsSecretInputLifecycleSocketIdentitiesAvailable(measured)).toBe(false);
	},
);

describe.skipIf(process.platform === "win32")("AWS secret input real worker and process lifecycle", () => {
	test("private capability probe joins its worker without opening credentials or creating a consumer", async () => {
		await withBoundary("success", "text", async boundary => {
			const capability = await boundary.client.probeAwsSecretInputWorker(boundary.controller.signal);
			expect(capability.capability).toBe("sha256:4936396a3a935e4582d42be1d73ef096353d23802dcea2394f7e969ffb42a358");
			await expectWorkerDone(boundary, NO_PROVIDER_COUNTS);
			await expectQuiescent(boundary);
			expect(boundary.directories[0]?.files).toEqual([]);
		});
	}, 30_000);

	for (const mode of ["text", "newline", "binary", "input-limit", "empty"] as const) {
		test(`delivers exact ${mode} stdin then EOF, excludes private env and descriptors, and preserves raw output and exit`, async () => {
			const scenario = mode === "binary" || mode === "input-limit" || mode === "empty" ? mode : "success";
			await withBoundary(
				scenario,
				mode,
				async boundary => {
					const result = await boundary.run();
					expect(lifecycleContainsSensitive(result), "secret entered the returned consumer result").toBe(false);
					expect(result).toEqual({
						stdout: LIFECYCLE_STDOUT,
						stderr: LIFECYCLE_STDERR,
						exitCode: 7,
						signal: null,
						timedOut: false,
						cancelled: false,
						stdoutTruncated: false,
						stderrTruncated: false,
						completion: "exited",
						teardown: { consumerReaped: true, workerReaped: true, referencesReleased: true },
					});
					const input = await boundary.control.waitForEvent("input-complete");
					const spawned = await boundary.control.waitForEvent("consumer-spawned");
					expect(input.exactInput).toBe(true);
					expect(input.inputWasEmpty).toBe(mode === "empty");
					expect(spawned.stdinProducerWitness?.inputWasEmpty).toBe(mode === "empty");
					expect(input.eof).toBe(true);
					expect(input.credentialEnv).toEqual([]);
					expect(input.ipcAvailable).toBe(false);
					expect(input.controlFdInherited).toBe(false);
					expect(input.argvClean).toBe(true);
					expect(input.envClean).toBe(true);
					expect(input.stdinIsTTY).toBe(false);
					expect(
						isVerifiedFiniteStdinHandoff(input.stdinPrivateChannel, spawned.stdinProducerWitness, input, spawned),
						"finite stdin handoff lacks independent producer and receiver evidence",
					).toBe(true);
					expect(input.stdinIsRegularFile, "receiver stdin used a file or memfd transport").toBe(false);
					expect(input.noControllingTty, "receiver retained a controlling terminal").toBe(true);
					const ready = await boundary.control.waitForEvent("worker-ready");
					expect(ready.ipcAvailable).toBe(true);
					expect(spawned.groupId).toBe(spawned.pid);
					expect(spawned.receiverPid).toBe(input.pid);
					expect(input.parentPid).toBe(spawned.pid);
					const childFds = input.descriptors as AwsSecretInputLifecycleDescriptor[];
					expect(spawned.privateFdSnapshotAvailable).toBe(true);
					if (process.platform === "linux") {
						expect(spawned.guardianFdSnapshotAvailable).toBe(true);
						const guardianFds = spawned.guardianDescriptors as AwsSecretInputLifecycleDescriptor[];
						if (guardianFds.some(fd => fd.kind === "socket")) {
							expect(spawned.guardianSocketIdentitiesAvailable).toBe(true);
							expect(input.socketIdentitiesAvailable).toBe(true);
						}
						expect(
							childFds.some(
								childFd =>
									childFd.measurable &&
									guardianFds.some(
										guardianFd =>
											guardianFd.measurable &&
											childFd.dev === guardianFd.dev &&
											childFd.ino === guardianFd.ino,
									),
							),
							"guardian control or relay descriptor reached the receiver",
						).toBe(false);
					} else {
						expect(spawned.guardianFdSnapshotAvailable).toBe(false);
						expect(spawned.guardianDescriptors).toBeNull();
						expect(spawned.guardianSocketIdentitiesAvailable).toBeNull();
					}
					if (mode === "text") {
						expect(ready.controlFdPresent, "positive control descriptor did not reach the private worker").toBe(
							true,
						);
						const privateFds = spawned.privateDescriptors as AwsSecretInputLifecycleDescriptor[];
						const canary = privateFds.find(fd => fd.target.endsWith("aws-secret-input-lifecycle-control-fd"));
						expect(canary?.measurable, "private control canary has no measurable inode identity").toBe(true);
						if (process.platform === "linux") {
							expect(ready.socketIdentitiesAvailable, "worker IPC socket identity is unavailable").toBe(true);
							expect(spawned.privateSocketIdentitiesAvailable).toBe(true);
							expect(input.socketIdentitiesAvailable, "receiver socket identity is unavailable").toBe(true);
						}
						expect(
							childFds.some(
								childFd =>
									childFd.measurable &&
									privateFds.some(
										privateFd =>
											privateFd.measurable && childFd.dev === privateFd.dev && childFd.ino === privateFd.ino,
									),
							),
							"measurable worker IPC or control descriptor reached the receiver",
						).toBe(false);
					}
					const done = await expectWorkerDone(boundary, COMPLETE_COUNTS);
					expect(done.realConsumer).toBe(true);
					await expectQuiescent(boundary);
					expect(boundary.directories[0]?.files).toEqual(
						mode === "text" ? ["aws-secret-input-lifecycle-control-fd"] : [],
					);
					expect((await snapshot(boundary.root)).files).toEqual([]);
				},
				{ withControlDescriptor: mode === "text" },
			);
		}, 30_000);
	}

	for (const mode of ["boundary", "overflow"] as const) {
		test(`drains both real output streams at ${mode} without inventing success or hiding truncation`, async () => {
			await withBoundary("success", mode, async boundary => {
				const result = await boundary.run();
				expect(lifecycleContainsSensitive(result)).toBe(false);
				expect(result.stdout).toBe("O".repeat(LIFECYCLE_OUTPUT_LIMIT));
				expect(result.stderr).toBe("E".repeat(LIFECYCLE_OUTPUT_LIMIT));
				expect(result.stdoutTruncated).toBe(mode === "overflow");
				expect(result.stderrTruncated).toBe(mode === "overflow");
				expect(result.exitCode).toBe(7);
				expect(result.signal).toBeNull();
				expect(result.completion).toBe("exited");
				await expectWorkerDone(boundary, COMPLETE_COUNTS);
				await expectQuiescent(boundary);
			});
		}, 30_000);
	}

	test("reports a consumer's early refusal as its raw stderr and actual nonzero exit, without retrying", async () => {
		await withBoundary("success", "early-exit", async boundary => {
			const result = await boundary.run();
			expect(lifecycleContainsSensitive(result)).toBe(false);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("public consumer refused input\n");
			expect(result.exitCode).toBe(23);
			expect(result.completion).toBe("exited");
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("preserves a real terminating signal instead of claiming a successful exit", async () => {
		await withBoundary("success", "signal", async boundary => {
			const result = await boundary.run();
			expect(lifecycleContainsSensitive(result)).toBe(false);
			expect(result.signal).toBe("SIGKILL");
			expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
			expect(result.cancelled).toBe(false);
			expect(result.timedOut).toBe(false);
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("normal receiver exit reaps a stubborn pipe-holding descendant without converting success to a timeout", async () => {
		await withBoundary("success", "exit-with-descendant", async boundary => {
			const operation = boundary.run();
			const ready = await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
			expect(typeof ready.descendantPid).toBe("number");
			expect(awsSecretInputLifecycleProcessExists(ready.descendantPid!)).toBe(true);
			boundary.control.send("exit-consumer");
			const result = await operation;
			expect(lifecycleContainsSensitive(result)).toBe(false);
			expect(result.stdout).toBe(LIFECYCLE_STDOUT);
			expect(result.stderr).toBe(LIFECYCLE_STDERR);
			expect(result.exitCode).toBe(0);
			expect(result.signal).toBeNull();
			expect(result.cancelled).toBe(false);
			expect(result.timedOut).toBe(false);
			expect(result.completion).toBe("exited");
			expect(result.teardown).toEqual({ consumerReaped: true, workerReaped: true, referencesReleased: true });
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	for (const [scenario, code] of [
		["provider-error", "AWS_FAILED"],
		["provider-denied", "AWS_ACCESS_DENIED"],
	] as const) {
		test(`contains secret-bearing ${scenario} diagnostics below real worker IPC, with one provider attempt`, async () => {
			await withBoundary(scenario, "text", async boundary => {
				expectFixedFailure(await captureFailure(boundary.run()), code);
				await expectWorkerDone(boundary, { ...COMPLETE_COUNTS, consumer: 0 });
				await expectQuiescent(boundary);
			});
		}, 30_000);
	}

	test("reports supervised receiver spawn failure without a cleanup acknowledgment as a worker failure", async () => {
		await withBoundary("success", "text", async boundary => {
			const request = normalizeAwsSecretInputRequest({
				...boundary.request,
				secretInput: {
					...boundary.request.secretInput,
					consumer: { argv: [path.join(boundary.root, "missing-public-executable")], cwd: boundary.root },
				},
			});
			if ("action" in request) throw new Error("UNEXPECTED_CAPABILITY_REQUEST");
			expectFixedFailure(await captureFailure(boundary.run(request)), "WORKER_FAILED");
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("cancels an undispatched request without misreporting a worker ownership failure", async () => {
		await withBoundary("pause-capabilities", "text", async boundary => {
			const operation = boundary.run();
			await boundary.control.waitForEvent("worker-capabilities-blocked");
			boundary.controller.abort();
			boundary.control.send("release-capabilities");
			expectFixedFailure(await captureFailure(operation), "CANCELLED");
			await expectWorkerDone(boundary, NO_PROVIDER_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("cancels a pending provider before consumer launch without sending the AbortSignal reason over IPC", async () => {
		await withBoundary("provider-pending", "text", async boundary => {
			const operation = boundary.run();
			await boundary.control.waitForEvent("provider-pending");
			boundary.controller.abort(new Error(LIFECYCLE_DIAGNOSTIC, { cause: { message: LIFECYCLE_DIAGNOSTIC } }));
			expectFixedFailure(await captureFailure(operation), "CANCELLED");
			await expectWorkerDone(boundary, { ...COMPLETE_COUNTS, consumer: 0 });
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("cancellation joins worker, stubborn consumer, and descendant after a writable action; completion stays uncertain", async () => {
		await withBoundary("success", "commit-hold", async boundary => {
			const operation = boundary.run();
			const ready = await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
			expect(ready.committed).toBe(true);
			expect(await fsp.readFile(path.join(boundary.root, "aws-secret-input-lifecycle-committed"), "utf8")).toBe(
				"public committed action\n",
			);
			boundary.controller.abort();
			const result = await operation;
			expect(lifecycleContainsSensitive(result)).toBe(false);
			expect(result.stdout).toBe("public action committed\n");
			expect(result.cancelled).toBe(true);
			expect(result.timedOut).toBe(false);
			expect(result.completion).toBe("uncertain");
			expect(result.teardown).toEqual({ consumerReaped: true, workerReaped: true, referencesReleased: true });
			expect(await fsp.readFile(path.join(boundary.root, "aws-secret-input-lifecycle-committed"), "utf8")).toBe(
				"public committed action\n",
			);
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("deadline cancellation reaps a ready stubborn descendant group and closes all owned streams", async () => {
		await withBoundary(
			"success",
			"hold",
			async boundary => {
				const operation = boundary.run();
				await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
				const result = await operation;
				expect(lifecycleContainsSensitive(result)).toBe(false);
				expect(result.timedOut).toBe(true);
				expect(result.cancelled).toBe(false);
				expect(result.completion).toBe("uncertain");
				expect(result.teardown).toEqual({ consumerReaped: true, workerReaped: true, referencesReleased: true });
				await expectWorkerDone(boundary, COMPLETE_COUNTS);
				await expectQuiescent(boundary);
			},
			{ timeoutSeconds: 10 },
		);
	}, 40_000);

	for (const fault of ["worker-uncaught", "worker-unhandled"] as const) {
		test(`${fault} cancels the real group without exposing the exception or its private cause`, async () => {
			await withBoundary("success", "hold", async boundary => {
				const operation = boundary.run();
				await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
				boundary.control.send(fault);
				const result = await operation;
				expect(lifecycleContainsSensitive(result)).toBe(false);
				expect(result.cancelled).toBe(true);
				expect(result.completion).toBe("uncertain");
				await expectWorkerDone(boundary, COMPLETE_COUNTS);
				await expectQuiescent(boundary);
			});
		}, 30_000);
	}

	for (const [fault, abortAfterWorkerLoss] of [
		["disconnect", false],
		["kill", false],
		["kill", true],
	] as const) {
		const cancellation = abortAfterWorkerLoss ? " racing cancellation" : "";
		test(`unexpected worker ${fault}${cancellation} cannot orphan a ready receiver or its descendant`, async () => {
			await withBoundary("success", "hold", async boundary => {
				const operation = boundary.run();
				await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
				if (fault === "disconnect") boundary.workers[0]!.disconnect();
				else boundary.workers[0]!.kill("SIGKILL");
				if (abortAfterWorkerLoss) boundary.controller.abort();
				expectFixedFailure(await captureFailure(operation), "WORKER_FAILED");
				if (fault === "disconnect") await expectWorkerDone(boundary, COMPLETE_COUNTS);
				await expectQuiescent(boundary);
			});
		}, 30_000);
	}

	for (const abortAfterGuardianLoss of [false, true]) {
		const cancellation = abortAfterGuardianLoss ? "racing cancellation" : "without cancellation";
		test(`guardian-only SIGKILL ${cancellation} reaps the receiver and descendant and preserves ownership failure`, async () => {
			await withBoundary("success", "hold", async boundary => {
				const operation = boundary.run();
				const ready = await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
				expect(boundary.workers.length).toBe(1);
				expect(typeof ready.parentPid).toBe("number");
				expect(typeof ready.pid).toBe("number");
				expect(typeof ready.descendantPid).toBe("number");
				const guardian = Process.fromPid(ready.parentPid as number);
				const receiver = Process.fromPid(ready.pid!);
				const descendant = Process.fromPid(ready.descendantPid!);
				expect(guardian?.status()).toBe(ProcessStatus.Running);
				expect(guardian?.ppid, "fault target was not the tracked synthetic worker's guardian").toBe(
					boundary.workers[0]!.pid,
				);
				expect(guardian?.groupId()).toBe(guardian!.pid);
				expect(receiver?.status()).toBe(ProcessStatus.Running);
				expect(receiver?.ppid).toBe(guardian!.pid);
				expect(receiver?.groupId()).toBe(guardian!.pid);
				expect(descendant?.status()).toBe(ProcessStatus.Running);
				expect(descendant?.ppid).toBe(receiver!.pid);
				expect(descendant?.groupId()).toBe(guardian!.pid);

				// Fake timers cannot bound real child-process exit notifications.
				const deadline = Promise.withResolvers<never>();
				const timer = setTimeout(
					() => deadline.reject(new Error("AWS_SECRET_INPUT_LIFECYCLE_GUARDIAN_DISPOSITION_TIMEOUT")),
					10_000,
				);
				let failure: unknown;
				try {
					process.kill(guardian!.pid, "SIGKILL");
					if (abortAfterGuardianLoss) boundary.controller.abort();
					failure = await Promise.race([captureFailure(operation), deadline.promise]);
				} finally {
					clearTimeout(timer);
				}

				expect(guardian!.status(), "positive control guardian survived SIGKILL").toBe(ProcessStatus.Exited);
				expect(receiver!.status(), "guardian loss abandoned the ordinary owned receiver").toBe(
					ProcessStatus.Exited,
				);
				expect(descendant!.status(), "guardian loss abandoned the ordinary owned descendant").toBe(
					ProcessStatus.Exited,
				);
				expectFixedFailure(failure, "WORKER_FAILED");
				await expectQuiescent(boundary);
			});
		}, 60_000);
	}

	test("worker failure still sweeps its owned group after the actual receiver has exited", async () => {
		await withBoundary("pause-result", "hold", async boundary => {
			const operation = boundary.run();
			const ready = await waitForAwsSecretInputLifecycleConsumerReady(boundary.control, boundary.workers);
			expect(typeof ready.pid).toBe("number");
			expect(typeof ready.descendantPid).toBe("number");
			const receiverPid = ready.pid!;
			const descendantPid = ready.descendantPid!;
			const receiver = Process.fromPid(receiverPid);
			expect(receiver?.status()).toBe(ProcessStatus.Running);
			expect(
				awsSecretInputLifecycleProcessExists(descendantPid),
				"positive control descendant was not running before receiver exit",
			).toBe(true);
			process.kill(receiverPid, "SIGKILL");
			expect(await receiver!.waitForExit({ timeoutMs: 5_000 })).toBe(true);
			expect(receiver!.status()).toBe(ProcessStatus.Exited);
			boundary.workers[0]!.kill("SIGKILL");
			expectFixedFailure(await captureFailure(operation), "WORKER_FAILED");
			await expectQuiescent(boundary);
		});
	}, 30_000);

	test("rejects an old worker without consumer admission support before sending run or authorizing access", async () => {
		await withBoundary("missing-consumer-admission", "text", async boundary => {
			let authorizations = 0;
			let admissions = 0;
			expectFixedFailure(
				await captureFailure(
					boundary.run(
						undefined,
						async () => {
							authorizations++;
						},
						async () => {
							admissions++;
						},
					),
				),
				"CAPABILITY_INCOMPATIBLE",
			);
			expect(authorizations).toBe(0);
			expect(admissions).toBe(0);
			expect(
				boundary.messages.some(
					entry =>
						entry.direction === "parent-to-worker" &&
						!!entry.message &&
						typeof entry.message === "object" &&
						"type" in entry.message &&
						entry.message.type === "run",
				),
			).toBe(false);
			expect(boundary.control.events.some(event => event.kind === "malformed-worker-run")).toBe(false);
			await expectQuiescent(boundary);
		});
	}, 30_000);

	for (const [scenario, code] of [
		["malformed-capability", "CAPABILITY_INCOMPATIBLE"],
		["skewed-capability", "CAPABILITY_INCOMPATIBLE"],
		["result-before-capability", "UNSAFE_OUTPUT"],
		["unknown-failure", "WORKER_FAILED"],
		["authorization-out-of-order", "UNSAFE_OUTPUT"],
		["early-exit", "WORKER_FAILED"],
		["disconnect", "WORKER_FAILED"],
	] as const) {
		test(`rejects ${scenario} from a real IPC peer with a fixed code and no replacement worker`, async () => {
			await withBoundary(scenario, "text", async boundary => {
				let authorizations = 0;
				expectFixedFailure(
					await captureFailure(
						boundary.run(undefined, async () => {
							authorizations++;
						}),
					),
					code,
				);
				expect(authorizations).toBe(0);
				await expectQuiescent(boundary, false);
			});
		}, 30_000);
	}

	for (const [scenario, code] of [
		["malformed-request", "INVALID_REQUEST"],
		["malformed-authorization", "CANCELLED"],
	] as const) {
		test(`real worker rejects ${scenario} before provider activity and never returns injected private data`, async () => {
			await withBoundary(scenario, "text", async boundary => {
				expectFixedFailure(await captureFailure(boundary.run()), code);
				await expectWorkerDone(boundary, NO_PROVIDER_COUNTS);
				await expectQuiescent(boundary, false);
			});
		}, 30_000);
	}

	test("rejects a malformed result after an actual consumer ran, while still joining the process group and worker", async () => {
		await withBoundary("malformed-result-after-consumer", "text", async boundary => {
			expectFixedFailure(await captureFailure(boundary.run()), "UNSAFE_OUTPUT");
			await expectWorkerDone(boundary, COMPLETE_COUNTS);
			await expectQuiescent(boundary, false);
		});
	}, 30_000);

	test("an already-aborted invocation cannot launch a worker, provider, or receiver", async () => {
		await withBoundary("success", "text", async boundary => {
			boundary.controller.abort();
			expectFixedFailure(await captureFailure(boundary.run()), "CANCELLED");
			expect(boundary.workers).toEqual([]);
			expect(boundary.control.events).toEqual([]);
			expect(boundary.directories).toEqual([]);
			expect((await snapshot(boundary.root)).files).toEqual([]);
		});
	}, 30_000);
});
