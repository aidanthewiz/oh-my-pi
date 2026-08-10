import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolAbortError, ToolError } from "./tool-errors";

const DCG_TIMEOUT_MS = 3_000;
const DCG_MAX_OUTPUT_BYTES = 64 * 1024;
const DCG_TERMINATION_GRACE_MS = 250;

const REQUIRED_ENV_KEYS = [
	"OMP_DCG_PATH",
	"OMP_DCG_VERSION",
	"OMP_DCG_BINARY_SHA256",
	"OMP_DCG_CONFIG",
	"OMP_DCG_CONFIG_SHA256",
] as const;
const DCG_EXPECTED_AT_STARTUP = REQUIRED_ENV_KEYS.some(key => (process.env[key]?.trim() ?? "") !== "");
const CHILD_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"PATH",
	"Path",
	"PATHEXT",
	"SYSTEMROOT",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"TERM",
	"COLORTERM",
] as const;

type GuardEnvironment = Record<string, string | undefined>;

export interface DcgProcessResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export type DcgProcessRunner = (options: {
	binaryPath: string;
	command: string;
	cwd: string;
	env: Record<string, string>;
	signal?: AbortSignal;
}) => Promise<DcgProcessResult>;

export interface DestructiveCommandGuardRuntime {
	env?: GuardEnvironment;
	run?: DcgProcessRunner;
	required?: boolean;
}

interface DcgTestOutput {
	schema_version?: unknown;
	dcg_version?: unknown;
	robot_mode?: unknown;
	command?: unknown;
	decision?: unknown;
	rule_id?: unknown;
	reason?: unknown;
	explanation?: unknown;
	allowlist?: unknown;
	agent?: { detected?: unknown };
}

export interface DcgAskDecision {
	decision: "ask";
	ruleId?: string;
	reason: string;
}

export type DcgDecision = { decision: "allow" } | DcgAskDecision;

interface DcgConfiguration {
	binaryPath: string;
	version: string;
	configPath: string;
	binarySha256: string;
	configSha256: string;
}

function safetyFailure(reason: string): ToolError {
	return new ToolError(`Command blocked because Destructive Command Guard could not verify safety: ${reason}`);
}

function resolveConfiguration(env: GuardEnvironment, required: boolean): DcgConfiguration | undefined {
	const values = REQUIRED_ENV_KEYS.map(key => env[key]?.trim() ?? "");
	if (values.every(value => value === "")) {
		if (required) throw safetyFailure("managed configuration disappeared after startup");
		return undefined;
	}

	const missing = REQUIRED_ENV_KEYS.filter((_, index) => values[index] === "");
	if (missing.length > 0) {
		throw safetyFailure(`incomplete managed configuration (missing ${missing.join(", ")})`);
	}

	const [binaryPath, version, binarySha256, configPath, configSha256] = values as [
		string,
		string,
		string,
		string,
		string,
	];
	if (!path.isAbsolute(binaryPath)) throw safetyFailure("OMP_DCG_PATH must be absolute");
	if (!path.isAbsolute(configPath)) throw safetyFailure("OMP_DCG_CONFIG must be absolute");
	for (const [key, value] of [
		["OMP_DCG_BINARY_SHA256", binarySha256],
		["OMP_DCG_CONFIG_SHA256", configSha256],
	] as const) {
		if (!/^[0-9a-f]{64}$/iu.test(value)) throw safetyFailure(`${key} must be a SHA-256 digest`);
	}
	return {
		binaryPath,
		version,
		binarySha256: binarySha256.toLowerCase(),
		configPath,
		configSha256: configSha256.toLowerCase(),
	};
}

export function isDestructiveCommandGuardConfigured(env: GuardEnvironment = process.env): boolean {
	return REQUIRED_ENV_KEYS.every(key => (env[key]?.trim() ?? "") !== "");
}

async function verifyManagedFile(filePath: string, expectedSha256: string, description: string): Promise<void> {
	let contents: Buffer;
	try {
		contents = await fs.promises.readFile(filePath);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw safetyFailure(`${description} is unreadable (${detail})`);
	}
	const actual = createHash("sha256").update(contents).digest("hex");
	if (actual !== expectedSha256) throw safetyFailure(`${description} checksum does not match the Coreforge pin`);
}

function buildChildEnvironment(env: GuardEnvironment, configPath: string): Record<string, string> {
	const childEnv: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = env[key];
		if (value !== undefined) childEnv[key] = value;
	}

	childEnv.DCG_CONFIG = configPath;
	childEnv.DCG_ALLOWLIST_SYSTEM_PATH = "";
	childEnv.DCG_HISTORY_DISABLED = "1";
	childEnv.DCG_ROBOT = "1";
	childEnv.PI_CODING_AGENT = "true";
	childEnv.XDG_CONFIG_HOME = path.join(path.dirname(configPath), ".dcg-runtime");
	return childEnv;
}

async function readBounded(stream: ReadableStream<Uint8Array>, label: string): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let output = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > DCG_MAX_OUTPUT_BYTES) throw safetyFailure(`${label} exceeded ${DCG_MAX_OUTPUT_BYTES} bytes`);
		output += decoder.decode(value, { stream: true });
	}
	return output + decoder.decode();
}

async function terminateDcgProcess(process: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
	try {
		process.kill("SIGKILL");
	} catch {
		// The process may already have exited.
	}
	await Promise.race([
		process.exited.then(
			() => undefined,
			() => undefined,
		),
		Bun.sleep(DCG_TERMINATION_GRACE_MS),
	]);
	process.unref();
}

const runDcgProcess: DcgProcessRunner = async ({ binaryPath, command, cwd, env, signal }) => {
	if (signal?.aborted) throw new ToolAbortError("Command aborted");

	let process: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		process = Bun.spawn([binaryPath, "--robot", "test", command], {
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw safetyFailure(`failed to start dcg (${detail})`);
	}

	let aborted = false;
	const onAbort = () => {
		aborted = true;
		try {
			process.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();

	const output = Promise.all([readBounded(process.stdout, "dcg stdout"), readBounded(process.stderr, "dcg stderr")]);
	const completion = output.then(
		async ([stdout, stderr]) => ({
			kind: "exit" as const,
			exitCode: await process.exited,
			stdout,
			stderr,
		}),
		error => ({ kind: "output-error" as const, error }),
	);
	let timeoutId: NodeJS.Timeout | undefined;
	const deadline = new Promise<{ kind: "timeout" }>(resolve => {
		timeoutId = setTimeout(() => resolve({ kind: "timeout" }), DCG_TIMEOUT_MS);
	});
	try {
		const outcome = await Promise.race([completion, deadline]);
		if (outcome.kind === "timeout") {
			throw safetyFailure(`dcg exceeded the ${DCG_TIMEOUT_MS}ms decision deadline`);
		}
		if (outcome.kind === "output-error") throw outcome.error;
		if (aborted || signal?.aborted) throw new ToolAbortError("Command aborted");
		return { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
	} catch (error) {
		await terminateDcgProcess(process);
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	}
};

function parseOutput(result: DcgProcessResult, config: DcgConfiguration, command: string): DcgTestOutput {
	let output: DcgTestOutput;
	try {
		output = JSON.parse(result.stdout) as DcgTestOutput;
	} catch {
		const stderr = result.stderr.trim();
		throw safetyFailure(`dcg returned invalid JSON${stderr ? ` (${stderr.slice(0, 500)})` : ""}`);
	}

	if (
		output.schema_version !== 1 ||
		output.dcg_version !== config.version ||
		output.robot_mode !== true ||
		output.command !== command ||
		output.agent?.detected !== "pi"
	) {
		throw safetyFailure("dcg returned an unexpected protocol, version, command, or agent identity");
	}
	return output;
}

export async function enforceDestructiveCommandGuard(
	command: string,
	cwd: string,
	signal?: AbortSignal,
	runtime: DestructiveCommandGuardRuntime = {},
): Promise<DcgDecision> {
	const env = runtime.env ?? process.env;
	const required = runtime.required ?? (runtime.env === undefined && DCG_EXPECTED_AT_STARTUP);
	const config = resolveConfiguration(env, required);
	if (!config) return { decision: "allow" };

	await Promise.all([
		verifyManagedFile(config.binaryPath, config.binarySha256, "managed executable"),
		verifyManagedFile(config.configPath, config.configSha256, "managed policy"),
	]);
	const run = runtime.run ?? runDcgProcess;
	const result = await run({
		binaryPath: config.binaryPath,
		command,
		cwd,
		env: buildChildEnvironment(env, config.configPath),
		signal,
	});
	const output = parseOutput(result, config, command);

	if (result.exitCode === 0 && output.decision === "allow" && output.allowlist === undefined) {
		return { decision: "allow" };
	}
	if (result.exitCode === 1 && (output.decision === "ask" || output.decision === "deny")) {
		const ruleId = typeof output.rule_id === "string" ? output.rule_id : undefined;
		const reason =
			typeof output.reason === "string"
				? output.reason
				: typeof output.explanation === "string"
					? output.explanation
					: output.decision === "ask"
						? "explicit approval required"
						: "destructive command detected";
		if (output.decision === "ask") {
			return {
				decision: "ask",
				...(ruleId ? { ruleId } : {}),
				reason,
			};
		}
		const rule = ruleId ? ` (${ruleId})` : "";
		throw new ToolError(`Command blocked by Destructive Command Guard${rule}: ${reason}`);
	}

	throw safetyFailure(`dcg returned inconsistent decision '${String(output.decision)}' with exit ${result.exitCode}`);
}
