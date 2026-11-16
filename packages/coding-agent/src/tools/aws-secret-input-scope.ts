import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { ptree } from "@oh-my-pi/pi-utils";
import {
	AWS_SECRET_INPUT_LIMITS,
	AwsSecretInputFailure,
	awsSecretInputTimeoutMs,
	normalizeAwsSecretInputRequest,
	safeAwsSecretInputFailure,
	type AwsSecretInputRequest,
	type AwsSecretInputResult,
} from "./aws-secret-input-contract";
import {
	AwsSecretInputProvider,
	releaseAwsSecretInputResponse,
	type AwsSecretInputAuthorize,
	type AwsSecretInputLaunchFiles,
	type AwsSecretInputProviderDependencies,
} from "./aws-secret-input-provider";
import { AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID } from "./aws-secret-input-worker-protocol";
export type {
	AwsSecretInputAuthorize,
	AwsSecretInputClient,
	AwsSecretInputClientConfig,
	AwsSecretInputClientFactory,
	AwsSecretInputCommand,
	AwsSecretInputFileReader,
	AwsSecretInputLaunchFiles,
	AwsSecretInputService,
	AwsSecretInputStep,
} from "./aws-secret-input-provider";

export const AWS_SECRET_INPUT_SCOPE_ID = "aws-secret-input-sdk-scope/v2";
export const AWS_SECRET_INPUT_DELIVERY_POLICY_ID = "finite-stdin-owned-process-group/v2";
export const AWS_SECRET_INPUT_OUTPUT_POLICY_ID = "raw-bounded-consumer-output/v1";
export const AWS_SECRET_INPUT_SCOPE_CONSUMER_ADMISSION_ID = AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID;
export type AwsSecretInputConsumerAdmission = () => Promise<void>;
export type AwsSecretInputScopeResult = Omit<AwsSecretInputResult, "teardown"> & {
	teardown: { consumerReaped: true; referencesReleased: true };
};
export interface AwsSecretInputScopeDependencies extends AwsSecretInputProviderDependencies {
	executeConsumer?: typeof ptree.exec;
	onConsumerSpawn?: (child: ptree.ChildProcess) => void | Promise<void>;
}
function own(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
function selectInput(response: unknown, request: AwsSecretInputRequest): Uint8Array {
	if (
		own(response, "ARN") !== request.parameters.SecretId ||
		own(response, "VersionId") !== request.parameters.VersionId
	)
		throw new AwsSecretInputFailure("SECRET_MISMATCH");
	const stages = own(response, "VersionStages");
	if (
		stages !== undefined &&
		(!Array.isArray(stages) ||
			stages.length > 20 ||
			stages.some(stage => typeof stage !== "string" || !stage || stage.length > 256) ||
			new Set(stages).size !== stages.length)
	)
		throw new AwsSecretInputFailure("SECRET_MISMATCH");
	if (
		request.parameters.VersionStage !== undefined &&
		(!Array.isArray(stages) || !stages.includes(request.parameters.VersionStage))
	)
		throw new AwsSecretInputFailure("SECRET_MISMATCH");
	const text = own(response, "SecretString");
	const binary = own(response, "SecretBinary");
	if ((text === undefined) === (binary === undefined)) throw new AwsSecretInputFailure("SECRET_MISMATCH");
	if ((text !== undefined && typeof text !== "string") || (binary !== undefined && !(binary instanceof Uint8Array)))
		throw new AwsSecretInputFailure("SECRET_MISMATCH");
	if (
		(typeof text === "string" && Buffer.byteLength(text) > AWS_SECRET_INPUT_LIMITS.maxInputBytes) ||
		(binary instanceof Uint8Array && binary.byteLength > AWS_SECRET_INPUT_LIMITS.maxInputBytes)
	)
		throw new AwsSecretInputFailure("INPUT_LIMIT_EXCEEDED");
	const pointer = request.secretInput.jsonPointer;
	let selected: string | Uint8Array;
	if (pointer === undefined) selected = typeof text === "string" ? text : (binary as Uint8Array);
	else {
		if (typeof text !== "string") throw new AwsSecretInputFailure("INPUT_SELECTION_FAILED");
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			throw new AwsSecretInputFailure("INPUT_SELECTION_FAILED");
		}
		if (pointer !== "")
			for (const encoded of pointer.slice(1).split("/")) {
				const key = encoded.replace(/~1/gu, "/").replace(/~0/gu, "~");
				if (
					value === null ||
					typeof value !== "object" ||
					!Object.hasOwn(value, key) ||
					(Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/u.test(key))
				)
					throw new AwsSecretInputFailure("INPUT_SELECTION_FAILED");
				value = (value as Record<string, unknown>)[key];
			}
		if (typeof value !== "string") throw new AwsSecretInputFailure("INPUT_SELECTION_FAILED");
		selected = value;
		value = undefined;
	}
	const length = typeof selected === "string" ? Buffer.byteLength(selected) : selected.byteLength;
	const newline = request.secretInput.appendNewline === true;
	if (length + Number(newline) > AWS_SECRET_INPUT_LIMITS.maxInputBytes)
		throw new AwsSecretInputFailure("INPUT_LIMIT_EXCEEDED");
	const bytes = Buffer.alloc(length + Number(newline));
	if (typeof selected === "string") bytes.write(selected, "utf8");
	else bytes.set(selected);
	if (newline) bytes[length] = 10;
	return bytes;
}

export async function runAwsSecretInputScope(
	input: AwsSecretInputRequest,
	launch: AwsSecretInputLaunchFiles,
	authorize: AwsSecretInputAuthorize,
	signal: AbortSignal,
	admitConsumer: AwsSecretInputConsumerAdmission,
	dependencies: AwsSecretInputScopeDependencies = {},
): Promise<AwsSecretInputScopeResult> {
	const normalized = normalizeAwsSecretInputRequest(input);
	if ("action" in normalized) throw new AwsSecretInputFailure("INVALID_REQUEST");
	const request = normalized;
	if (signal.aborted) throw new AwsSecretInputFailure("CANCELLED");
	if (typeof admitConsumer !== "function") throw new AwsSecretInputFailure("CAPABILITY_INCOMPATIBLE");
	const controller = new AbortController();
	let consumer: ptree.ChildProcess | undefined;
	const cancel = (): void => {
		controller.abort();
		consumer?.kill(new ptree.AbortError("CANCELLED", ""), -1);
	};
	signal.addEventListener("abort", cancel, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		cancel();
	}, awsSecretInputTimeoutMs(request));
	const files = Object.freeze({ ...launch, reservedProfiles: Object.freeze([...launch.reservedProfiles]) });
	const provider = new AwsSecretInputProvider(request, files, authorize, controller.signal, dependencies);
	let response: unknown;
	let bytes: Uint8Array | undefined;
	let consumerHome: string | undefined;
	let result: AwsSecretInputScopeResult | undefined;
	let failedCleanup = false;
	let failure: AwsSecretInputFailure | undefined;
	try {
		await authorize(Object.freeze({ service: "sts", operation: "get-caller-identity", region: request.region }));
		await authorize(
			Object.freeze({
				service: "secretsmanager",
				operation: "get-secret-value",
				resource: request.parameters.SecretId,
				region: request.region,
			}),
		);
		if (controller.signal.aborted) throw new AwsSecretInputFailure(timedOut ? "TIMEOUT" : "CANCELLED");
		if (
			files.runtimeDirectory !== undefined &&
			(!path.isAbsolute(files.runtimeDirectory) ||
				(await fs.realpath(files.runtimeDirectory)) !== (await fs.realpath(process.cwd())))
		)
			throw new AwsSecretInputFailure("INVALID_REQUEST");
		await provider.prepare();
		await provider.initialize();
		const identity = await provider.send(
			{ service: "sts", operation: "get-caller-identity", region: request.region },
			new GetCallerIdentityCommand({}),
		);
		const expected = request.secretInput.expectedIdentity;
		if (own(identity, "Account") !== expected.account || own(identity, "Arn") !== expected.arn)
			throw new AwsSecretInputFailure("IDENTITY_MISMATCH");
		response = await provider.send(
			{
				service: "secretsmanager",
				operation: "get-secret-value",
				resource: request.parameters.SecretId,
				region: request.region,
			},
			new GetSecretValueCommand({ ...request.parameters }),
		);
		bytes = selectInput(response, request);
		if (!releaseAwsSecretInputResponse(response)) throw new AwsSecretInputFailure("WORKER_FAILED");
		response = undefined;
		if (!provider.dispose()) throw new AwsSecretInputFailure("WORKER_FAILED");
		if (controller.signal.aborted) throw new AwsSecretInputFailure(timedOut ? "TIMEOUT" : "CANCELLED");
		consumerHome = await fs.mkdtemp(path.join(files.runtimeDirectory ?? os.tmpdir(), "omp-secret-input-consumer-"));
		await admitConsumer();
		if (controller.signal.aborted) throw new AwsSecretInputFailure(timedOut ? "TIMEOUT" : "CANCELLED");
		let output: ptree.ExecResult;
		try {
			output = await (dependencies.executeConsumer ?? ptree.exec)([...request.secretInput.consumer.argv], {
				cwd: request.secretInput.consumer.cwd,
				env: {
					HOME: consumerHome,
					USERPROFILE: consumerHome,
					XDG_CONFIG_HOME: consumerHome,
					XDG_CACHE_HOME: consumerHome,
					XDG_DATA_HOME: consumerHome,
					XDG_STATE_HOME: consumerHome,
					TMPDIR: consumerHome,
					TMP: consumerHome,
					TEMP: consumerHome,
					PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
					TERM: "dumb",
					DO_NOT_TRACK: "1",
					BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
				},
				input: bytes,
				detached: true,
				subreaper: true,
				ownedInput: true,
				signal: controller.signal,
				timeout: awsSecretInputTimeoutMs(request),
				maxOutputBytes: AWS_SECRET_INPUT_LIMITS.maxStdoutBytes,
				maxStderrBytes: AWS_SECRET_INPUT_LIMITS.maxStderrBytes,
				stderr: "full",
				allowAbort: true,
				allowNonZero: true,
				onSpawn(child) {
					consumer = child;
					if (controller.signal.aborted) child.kill(new ptree.AbortError("CANCELLED", ""), -1);
					return dependencies.onConsumerSpawn?.(child);
				},
			});
		} catch (error) {
			if (
				error instanceof ptree.OwnedInputError ||
				(error instanceof AwsSecretInputFailure && safeAwsSecretInputFailure(error) === "WORKER_FAILED") ||
				(consumer && consumer.ownedInputCleanedUp !== true)
			)
				throw new AwsSecretInputFailure("WORKER_FAILED");
			throw new AwsSecretInputFailure(
				controller.signal.aborted ? (timedOut ? "TIMEOUT" : "CANCELLED") : "CONSUMER_FAILED",
			);
		}
		if (output.ownedInputCleanedUp !== true) throw new AwsSecretInputFailure("WORKER_FAILED");
		const cancelled = !timedOut && (controller.signal.aborted || output.exitError?.aborted === true);
		result = {
			stdout: output.stdout,
			stderr: output.stderr,
			exitCode: output.exitCode,
			signal: output.signalCode ?? null,
			timedOut: timedOut || output.exitError instanceof ptree.TimeoutError,
			cancelled,
			stdoutTruncated: output.stdoutTruncated === true,
			stderrTruncated: output.stderrTruncated === true,
			completion: controller.signal.aborted || output.exitError?.aborted ? "uncertain" : "exited",
			teardown: { consumerReaped: true, referencesReleased: true },
		};
	} catch (error) {
		const code = safeAwsSecretInputFailure(error);
		failure = new AwsSecretInputFailure(
			code === "WORKER_FAILED" ? code : timedOut ? "TIMEOUT" : controller.signal.aborted ? "CANCELLED" : code,
		);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
		if (consumer && consumer.ownedInputCleanedUp !== true) {
			try {
				consumer.kill(new ptree.AbortError("CANCELLED", ""), -1);
				const cleanup = await consumer.wait({ allowAbort: true, allowNonZero: true, maxOutputBytes: 0 });
				if (cleanup.ownedInputCleanedUp !== true) failedCleanup = true;
			} catch {
				failedCleanup = true;
			}
		}
		consumer = undefined;
		bytes?.fill(0);
		bytes = undefined;
		if (!releaseAwsSecretInputResponse(response)) failedCleanup = true;
		response = undefined;
		if (!provider.dispose()) failedCleanup = true;
		if (consumerHome)
			try {
				await fs.rm(consumerHome, { force: true, recursive: true });
			} catch {
				failedCleanup = true;
			}
	}
	if (failedCleanup) throw new AwsSecretInputFailure("WORKER_FAILED");
	if (failure) throw failure;
	return result!;
}
