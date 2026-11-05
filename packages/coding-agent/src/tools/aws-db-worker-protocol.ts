import {
	AWS_DB_FAILURE_CODES,
	assertAwsDbPlainData,
	AwsDbFailure,
	type AwsDbFailureCode,
	type SafeTemplateResult,
} from "./aws-db-contract";
import { isSafeTemplateStructure } from "./aws-db-sanitize";
import type { AwsDbInspectionRequest, AwsDbCapability } from "./aws-db-contract";
import type { AwsDbAuthorize, AwsDbLaunchFiles, AwsDbStep } from "./aws-db-scope";

export const AWS_DB_WORKER_ID = "aws-db-isolated-process/v1";
export type AwsDbWorkerInbound =
	| { type: "inspect"; request: AwsDbInspectionRequest; launch: AwsDbLaunchFiles }
	| { type: "authorize-result"; id: number; allowed: boolean; code?: AwsDbFailureCode }
	| { type: "stop" };
export type AwsDbWorkerOutbound =
	| { type: "capabilities"; value: AwsDbCapability }
	| { type: "authorize"; id: number; step: AwsDbStep }
	| { type: "result"; value: SafeTemplateResult }
	| { type: "failure"; code: AwsDbFailureCode };
export interface AwsDbWorkerDependencies {
	probeWorker?: (signal?: AbortSignal) => Promise<AwsDbCapability>;
	runWorker?: (
		request: AwsDbInspectionRequest,
		launch: AwsDbLaunchFiles,
		authorize: AwsDbAuthorize,
		signal: AbortSignal,
	) => Promise<SafeTemplateResult>;
}

export function assertSafeTemplateResult(value: unknown): asserts value is SafeTemplateResult {
	assertAwsDbPlainData(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new AwsDbFailure("UNSAFE_OUTPUT");
	const result = value as Record<string, unknown>;
	if (Object.keys(result).some(key => !["disposition", "structure", "proof", "teardown"].includes(key)))
		throw new AwsDbFailure("UNSAFE_OUTPUT");
	if (typeof result.disposition !== "string" || !["sanitized", "withheld", "not-found"].includes(result.disposition))
		throw new AwsDbFailure("UNSAFE_OUTPUT");
	if (
		result.disposition === "sanitized"
			? !isSafeTemplateStructure(result.structure)
			: Object.hasOwn(result, "structure")
	)
		throw new AwsDbFailure("UNSAFE_OUTPUT");
	for (const [key, names] of [
		["proof", ["sameConnection", "reader"]],
		["teardown", ["connectionClosed", "referencesReleased"]],
	] as const) {
		const record = result[key];
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			Object.keys(record).length !== names.length ||
			names.some(name => (record as Record<string, unknown>)[name] !== true)
		)
			throw new AwsDbFailure("UNSAFE_OUTPUT");
	}
	if (JSON.stringify(value).length > 65_536) throw new AwsDbFailure("UNSAFE_OUTPUT");
}
export function workerFailureCode(value: unknown): AwsDbFailureCode {
	return typeof value === "string" && AWS_DB_FAILURE_CODES.some(code => code === value)
		? (value as AwsDbFailureCode)
		: "WORKER_FAILED";
}
