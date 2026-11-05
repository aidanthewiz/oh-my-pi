export const AWS_DB_SMOKE_FAILURE_STAGES = [
	"SETUP",
	"CASE_BODY",
	"CAPABILITY_INVOKE",
	"CAPABILITY_RESULT",
	"CAPABILITY_APPROVAL",
	"CAPABILITY_ACCESS",
	"CAPABILITY_VALUE",
	"CAPABILITY_SCHEMA",
	"CASE_WORKERS",
	"CASE_SURFACES",
	"CASE_FILES",
	"CASE_COMPLETE",
] as const;
export type AwsDbSmokeFailureStage = (typeof AWS_DB_SMOKE_FAILURE_STAGES)[number];
export const AWS_DB_SMOKE_FAILURE_CHECKS = [
	"hostIdentity",
	"nativeCleanup",
	"mountedCleanup",
	"canonicalWriterCleanup",
	"decoratedWriterCleanup",
	"invokeSucceeded",
	"resultPresent",
	"zeroApproval",
	"zeroProvider",
	"zeroGuard",
	"workerCapabilities",
	"workerFailure",
	"workersExited",
	"workerExitSuccess",
	"cleanSurfaces",
	"zeroArtifacts",
	"cleanFiles",
	"workerRootUnobserved",
	"workerRootNonempty",
	"workerWatcherMutation",
	"workerCleanupObserved",
	"workerCleanupBeforeExit",
	"workerRootsRemoved",
] as const;
const nativeCodes = [
	"NONE",
	"CAPABILITY_INCOMPATIBLE",
	"INVALID_REQUEST",
	"APPROVAL_REQUIRED",
	"POLICY_DENIED",
	"GUARD_DENIED",
	"PROFILE_UNSUPPORTED",
	"AUTH_REQUIRED",
	"IDENTITY_MISMATCH",
	"RESOURCE_MISMATCH",
	"SECRET_MISMATCH",
	"AWS_ACCESS_DENIED",
	"AWS_FAILED",
	"DB_CONNECT_FAILED",
	"DB_READER_REQUIRED",
	"DB_IDENTITY_CHANGED",
	"DB_POLICY_DENIED",
	"DB_LIMIT_EXCEEDED",
	"DB_TIMEOUT",
	"DB_CANCELLED",
	"DB_READ_FAILED",
	"DB_TLS_REQUIRED",
	"CANCELLED",
	"TIMEOUT",
	"WORKER_FAILED",
	"UNSAFE_OUTPUT",
] as const;

export function describeAwsDbSmokeFailure(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "UNCLASSIFIED";
	try {
		const fields = Object.getOwnPropertyDescriptors(value);
		const stage = AWS_DB_SMOKE_FAILURE_STAGES.find(stage => stage === fields.stage?.value);
		const code = nativeCodes.find(code => code === fields.code?.value);
		const workerCode = nativeCodes.find(code => code === fields.workerCode?.value);
		const checks = fields.checks?.value;
		if (!stage || !code || !workerCode || !checks || typeof checks !== "object" || Array.isArray(checks))
			return "UNCLASSIFIED";
		const descriptors = Object.getOwnPropertyDescriptors(checks);
		if (Object.keys(descriptors).length !== AWS_DB_SMOKE_FAILURE_CHECKS.length) return "UNCLASSIFIED";
		if (AWS_DB_SMOKE_FAILURE_CHECKS.some(name => typeof descriptors[name]?.value !== "boolean"))
			return "UNCLASSIFIED";
		const flags = AWS_DB_SMOKE_FAILURE_CHECKS.map(name => `${name}=${descriptors[name]!.value === true}`).join(",");
		return `${stage};code=${code};workerCode=${workerCode};${flags}`;
	} catch {
		return "UNCLASSIFIED";
	}
}

export type AwsDbSmokeStartupFailure =
	| "NATIVE_ADDON_UNAVAILABLE"
	| "NATIVE_PLATFORM_UNSUPPORTED"
	| "MYSQL_DRIVER_UNAVAILABLE"
	| "AWS_RDS_PACKAGE_UNAVAILABLE"
	| "AWS_STS_PACKAGE_UNAVAILABLE"
	| "AWS_SECRETS_PACKAGE_UNAVAILABLE"
	| "AWS_SSO_PACKAGE_UNAVAILABLE"
	| "NATIVE_PACKAGE_UNAVAILABLE"
	| "CANCELLATION_ABI_UNAVAILABLE"
	| "SCHEMA_PACKAGE_UNAVAILABLE"
	| "NODE_MODULE_EXPORT_UNAVAILABLE"
	| "NATIVE_CONTRACT_EXPORT_UNAVAILABLE"
	| "FIXTURE_SYNTAX_FAILURE"
	| "BUN_FLAG_UNSUPPORTED"
	| "STARTUP_UNCLASSIFIED";

const packages: readonly (readonly [string, AwsDbSmokeStartupFailure])[] = [
	["mysql2", "MYSQL_DRIVER_UNAVAILABLE"],
	["@aws-sdk/client-rds", "AWS_RDS_PACKAGE_UNAVAILABLE"],
	["@aws-sdk/client-sts", "AWS_STS_PACKAGE_UNAVAILABLE"],
	["@aws-sdk/client-secrets-manager", "AWS_SECRETS_PACKAGE_UNAVAILABLE"],
	["@aws-sdk/client-sso", "AWS_SSO_PACKAGE_UNAVAILABLE"],
	["@oh-my-pi/pi-natives", "NATIVE_PACKAGE_UNAVAILABLE"],
	["@oh-my-pi/pi-natives/path", "NATIVE_PACKAGE_UNAVAILABLE"],
	["@oh-my-pi/pi-agent-core/tool-cancellation", "CANCELLATION_ABI_UNAVAILABLE"],
	["@oh-my-pi/omptype/typebox", "SCHEMA_PACKAGE_UNAVAILABLE"],
];

export function classifyAwsDbSmokeStartup(stderr: string): AwsDbSmokeStartupFailure {
	if (stderr.includes("Failed to load pi_natives native addon for ") && stderr.includes("Tried:")) {
		return "NATIVE_ADDON_UNAVAILABLE";
	}
	if (stderr.includes("Unsupported platform: ") && stderr.includes("Supported platforms:")) {
		return "NATIVE_PLATFORM_UNSUPPORTED";
	}
	if (
		stderr.includes("Cannot find module '") ||
		stderr.includes("Cannot find package '") ||
		stderr.includes('Cannot find module "') ||
		stderr.includes('Cannot find package "')
	) {
		for (const [name, code] of packages) {
			if (["'", '"'].some(quote => stderr.includes(`${quote}${name}${quote}`))) return code;
		}
	}
	if (stderr.includes("Export named '") || stderr.includes("does not provide an export named '")) {
		if (["createRequire", "syncBuiltinESMExports"].some(name => stderr.includes(`'${name}'`))) {
			return "NODE_MODULE_EXPORT_UNAVAILABLE";
		}
		if (
			[
				"resolveToolCancellationBehavior",
				"TOOL_EXECUTION_HOST_CAPABILITIES",
				"createAwsDbWorkerClient",
				"createAutomationTemplateReader",
				"startAwsDbWorker",
			].some(name => stderr.includes(`'${name}'`))
		) {
			return "NATIVE_CONTRACT_EXPORT_UNAVAILABLE";
		}
	}
	if (
		(stderr.includes("SyntaxError") || stderr.includes("error: Unexpected")) &&
		["aws-db-native-smoke.ts", "aws-db-mysql-fixture.ts", "sdk-aws-db-lifecycle-probe.ts"].some(name =>
			stderr.includes(name),
		)
	) {
		return "FIXTURE_SYNTAX_FAILURE";
	}
	if (
		(stderr.includes("Invalid command-line flag") || stderr.includes("unknown option")) &&
		["--no-env-file", "--no-install"].some(flag => stderr.includes(flag))
	) {
		return "BUN_FLAG_UNSUPPORTED";
	}
	return "STARTUP_UNCLASSIFIED";
}

export function classifyAwsDbSmokeStartupError(error: unknown): AwsDbSmokeStartupFailure {
	if (typeof error === "string") return classifyAwsDbSmokeStartup(error);
	if (error && typeof error === "object") {
		try {
			for (const name of ["message", "stack"]) {
				const descriptor = Object.getOwnPropertyDescriptor(error, name);
				if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") continue;
				const code = classifyAwsDbSmokeStartup(descriptor.value);
				if (code !== "STARTUP_UNCLASSIFIED") return code;
			}
		} catch {
			return "STARTUP_UNCLASSIFIED";
		}
	}
	return "STARTUP_UNCLASSIFIED";
}
