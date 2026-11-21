import {
	AWS_SECRET_INPUT_FAILURE_CODES,
	AWS_SECRET_INPUT_LIMITS,
	assertAwsSecretInputPlainData,
	AwsSecretInputFailure,
	type AwsSecretInputFailureCode,
	type AwsSecretInputRequest,
	type AwsSecretInputCapability,
	type AwsSecretInputResult,
} from "./aws-secret-input-contract";
import type {
	AwsSecretInputAuthorize,
	AwsSecretInputLaunchFiles,
	AwsSecretInputStep,
	AwsSecretInputScopeResult,
	AwsSecretInputConsumerAdmission,
} from "./aws-secret-input-scope";
export const AWS_SECRET_INPUT_WORKER_ID = "aws-secret-input-isolated-process/v1";
export const AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID = "parent-consumer-admission/v1";
export type AwsSecretInputWorkerInbound =
	| { type: "run"; request: AwsSecretInputRequest; launch: AwsSecretInputLaunchFiles }
	| { type: "authorize-result"; id: number; allowed: boolean; code?: AwsSecretInputFailureCode }
	| { type: "consumer-admission-result"; id: number; allowed: boolean; code?: AwsSecretInputFailureCode }
	| { type: "consumer-registered" }
	| { type: "stop" };
export type AwsSecretInputWorkerOutbound =
	| {
			type: "capabilities";
			value: AwsSecretInputCapability;
			consumerAdmission: typeof AWS_SECRET_INPUT_CONSUMER_ADMISSION_ID;
	  }
	| { type: "authorize"; id: number; step: AwsSecretInputStep }
	| { type: "consumer-admission"; id: number }
	| { type: "consumer-start"; pid: number; groupId: number; receiverPid: number | null }
	| { type: "result"; value: AwsSecretInputScopeResult }
	| { type: "failure"; code: AwsSecretInputFailureCode };
export interface AwsSecretInputWorkerDependencies {
	probeWorker?: (signal?: AbortSignal) => Promise<AwsSecretInputCapability>;
	runWorker?: (
		request: AwsSecretInputRequest,
		launch: AwsSecretInputLaunchFiles,
		authorize: AwsSecretInputAuthorize,
		signal: AbortSignal,
		admitConsumer: AwsSecretInputConsumerAdmission,
	) => Promise<AwsSecretInputResult>;
}
export function assertAwsSecretInputResult(value: unknown, workerReaped = true): asserts value is AwsSecretInputResult {
	assertAwsSecretInputPlainData(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
	const result = value as Record<string, unknown>;
	const keys = [
		"stdout",
		"stderr",
		"exitCode",
		"signal",
		"timedOut",
		"cancelled",
		"stdoutTruncated",
		"stderrTruncated",
		"completion",
		"teardown",
	];
	if (
		Object.keys(result).length !== keys.length ||
		Object.keys(result).some(key => !keys.includes(key)) ||
		typeof result.stdout !== "string" ||
		typeof result.stderr !== "string" ||
		Buffer.byteLength(result.stdout) > AWS_SECRET_INPUT_LIMITS.maxStdoutBytes * 3 + 3 ||
		Buffer.byteLength(result.stderr) > AWS_SECRET_INPUT_LIMITS.maxStderrBytes * 3 + 3 ||
		(result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || (result.exitCode as number) < 0)) ||
		(result.signal !== null && (typeof result.signal !== "string" || !/^SIG[A-Z0-9]+$/u.test(result.signal))) ||
		["timedOut", "cancelled", "stdoutTruncated", "stderrTruncated"].some(key => typeof result[key] !== "boolean") ||
		(result.completion !== "exited" && result.completion !== "uncertain") ||
		((result.timedOut === true || result.cancelled === true) && result.completion !== "uncertain")
	)
		throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
	const teardown = result.teardown;
	const teardownKeys = ["consumerReaped", "referencesReleased", ...(workerReaped ? ["workerReaped"] : [])];
	if (
		!teardown ||
		typeof teardown !== "object" ||
		Array.isArray(teardown) ||
		Object.keys(teardown).length !== teardownKeys.length ||
		teardownKeys.some(key => (teardown as Record<string, unknown>)[key] !== true)
	)
		throw new AwsSecretInputFailure("UNSAFE_OUTPUT");
}
export function workerFailureCode(value: unknown): AwsSecretInputFailureCode {
	return typeof value === "string" && AWS_SECRET_INPUT_FAILURE_CODES.some(code => code === value)
		? (value as AwsSecretInputFailureCode)
		: "WORKER_FAILED";
}
