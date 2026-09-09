import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ToolAbortError, ToolError } from "./tool-errors";

const DCG_PROCESS_TIMEOUT_MS = 30_000;
const DCG_PIPE_DRAIN_GRACE_MS = 250;
const DCG_OBSERVATION_GRACE_MS = DCG_PIPE_DRAIN_GRACE_MS * 2;
const DCG_MAX_OUTPUT_BYTES = 64 * 1024;
const DCG_STDIN_CHUNK_CODE_UNITS = DCG_MAX_OUTPUT_BYTES / 4;

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

export type DcgShellDialect = "posix" | "cmd" | "ps";

export type DcgProcessRunner = (options: {
	binaryPath: string;
	command: string;
	cwd: string;
	dialect: DcgShellDialect;
	env: Record<string, string>;
	signal?: AbortSignal;
	timeoutMs: number;
}) => Promise<DcgProcessResult>;

export interface DestructiveCommandGuardRuntime {
	env?: GuardEnvironment;
	run?: DcgProcessRunner;
	required?: boolean;
	timeoutMs?: number;
}

interface DcgTestOutput {
	decision?: unknown;
	rule_id?: unknown;
	reason?: unknown;
}

export interface DcgAskDecision {
	decision: "ask";
	ruleId?: string;
	reason: string;
}

export type DcgDecision = { decision: "allow" } | DcgAskDecision;

interface DcgConfiguration {
	binaryPath: string;
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

	const [binaryPath, , binarySha256, configPath, configSha256] = values as [string, string, string, string, string];
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
	childEnv.XDG_CONFIG_HOME = path.join(path.dirname(configPath), ".dcg-runtime");
	return childEnv;
}

function commandStdin(command: string): Uint8Array | ReadableStream<Uint8Array> {
	if (command.length <= DCG_STDIN_CHUNK_CODE_UNITS) return new TextEncoder().encode(command);

	let offset = 0;
	const text = new ReadableStream<string>({
		pull(controller): void {
			if (offset >= command.length) {
				controller.close();
				return;
			}
			let end = Math.min(offset + DCG_STDIN_CHUNK_CODE_UNITS, command.length);
			if (
				end < command.length &&
				command.charCodeAt(end - 1) >= 0xd800 &&
				command.charCodeAt(end - 1) <= 0xdbff &&
				command.charCodeAt(end) >= 0xdc00 &&
				command.charCodeAt(end) <= 0xdfff
			) {
				end++;
			}
			controller.enqueue(command.slice(offset, end));
			offset = end;
		},
	});
	return text.pipeThrough(new TextEncoderStream());
}

async function readBounded(stream: ReadableStream<Uint8Array>, label: string, signal: AbortSignal): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let output = "";
	const cancel = () => {
		try {
			void reader.cancel().catch(() => undefined);
		} catch {
			// The observation deadline still bounds standards-compliant streams.
		}
	};
	if (signal.aborted) cancel();
	else signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > DCG_MAX_OUTPUT_BYTES) throw safetyFailure(`${label} exceeded ${DCG_MAX_OUTPUT_BYTES} bytes`);
			output += decoder.decode(value, { stream: true });
		}
		return output + decoder.decode();
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
}

async function terminateDcgProcess(process: Bun.ReadableSubprocess): Promise<void> {
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
		Bun.sleep(DCG_PIPE_DRAIN_GRACE_MS),
	]);
	process.unref();
}

const runDcgProcess: DcgProcessRunner = async ({ binaryPath, command, cwd, dialect, env, signal, timeoutMs }) => {
	if (signal?.aborted) throw new ToolAbortError("Command aborted");

	let process: Bun.ReadableSubprocess;
	try {
		process = Bun.spawn(
			[
				binaryPath,
				"--robot",
				"test",
				"--stdin",
				"--agent",
				"omp",
				"--dialect",
				dialect,
				"--format",
				"json",
				"--omp-bridge-output",
			],
			{
				cwd,
				env,
				stdin: commandStdin(command),
				stdout: "pipe",
				stderr: "pipe",
				timeout: timeoutMs,
				killSignal: "SIGKILL",
			},
		);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw safetyFailure(`failed to start dcg (${detail})`);
	}

	const observationAbort = new AbortController();
	const output = Promise.all([
		readBounded(process.stdout, "dcg stdout", observationAbort.signal),
		readBounded(process.stderr, "dcg stderr", observationAbort.signal),
	]);
	const outputOutcome = output.then(
		value => ({ kind: "output" as const, value }),
		error => ({ kind: "output-error" as const, error }),
	);
	const exitOutcome = process.exited.then(
		exitCode => ({ kind: "exit" as const, exitCode }),
		error => ({ kind: "exit-error" as const, error }),
	);
	const aborted = Promise.withResolvers<{ kind: "abort" }>();
	const onAbort = () => {
		try {
			process.kill("SIGKILL");
		} catch {
			// The process may already have exited.
		}
		aborted.resolve({ kind: "abort" });
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();

	const observationTimeoutMs = timeoutMs + DCG_OBSERVATION_GRACE_MS;
	let timeoutId: NodeJS.Timeout | undefined;
	const deadline = new Promise<{ kind: "timeout" }>(resolve => {
		timeoutId = setTimeout(() => resolve({ kind: "timeout" }), observationTimeoutMs);
	});

	try {
		const first = await Promise.race([outputOutcome, exitOutcome, aborted.promise, deadline]);
		if (first.kind === "abort") throw new ToolAbortError("Command aborted");
		if (first.kind === "timeout") {
			throw safetyFailure(`dcg exceeded the ${observationTimeoutMs}ms observation deadline`);
		}
		if (first.kind === "output-error") throw first.error;

		let exitCode: number;
		let streams: [string, string];
		if (first.kind === "output") {
			streams = first.value;
			const exit = await Promise.race([exitOutcome, aborted.promise, deadline]);
			if (exit.kind === "abort") throw new ToolAbortError("Command aborted");
			if (exit.kind === "timeout") {
				throw safetyFailure(`dcg exceeded the ${observationTimeoutMs}ms observation deadline`);
			}
			if (exit.kind === "exit-error") throw safetyFailure("dcg exit status could not be observed");
			exitCode = exit.exitCode;
		} else {
			if (first.kind === "exit-error") throw safetyFailure("dcg exit status could not be observed");
			exitCode = first.exitCode;
			const drain = await Promise.race([
				outputOutcome,
				Bun.sleep(DCG_PIPE_DRAIN_GRACE_MS).then(() => ({ kind: "pipe-timeout" as const })),
				aborted.promise,
				deadline,
			]);
			if (drain.kind === "abort") throw new ToolAbortError("Command aborted");
			if (drain.kind === "timeout") {
				throw safetyFailure(`dcg exceeded the ${observationTimeoutMs}ms observation deadline`);
			}
			if (drain.kind === "pipe-timeout") {
				throw safetyFailure(`dcg pipes exceeded the ${DCG_PIPE_DRAIN_GRACE_MS}ms post-exit drain grace`);
			}
			if (drain.kind === "output-error") throw drain.error;
			streams = drain.value;
		}

		if (process.signalCode !== null) {
			throw safetyFailure(`dcg terminated by signal ${String(process.signalCode)}`);
		}
		return { exitCode, stdout: streams[0], stderr: streams[1] };
	} catch (error) {
		observationAbort.abort();
		await terminateDcgProcess(process);
		throw error;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	}
};

function parseOutput(result: DcgProcessResult): DcgTestOutput {
	let output: DcgTestOutput;
	try {
		const parsed = JSON.parse(result.stdout) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid shape");
		output = parsed as DcgTestOutput;
	} catch {
		const stderr = result.stderr.trim();
		throw safetyFailure(`dcg returned invalid JSON${stderr ? ` (${stderr.slice(0, 500)})` : ""}`);
	}
	return output;
}

export async function enforceDestructiveCommandGuard(
	command: string,
	cwd: string,
	dialect: DcgShellDialect,
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
		dialect,
		env: buildChildEnvironment(env, config.configPath),
		signal,
		timeoutMs: Math.max(1, runtime.timeoutMs ?? DCG_PROCESS_TIMEOUT_MS),
	});
	const output = parseOutput(result);

	if (result.exitCode === 0 && output.decision === "allow") {
		return { decision: "allow" };
	}
	if (result.exitCode === 1 && (output.decision === "ask" || output.decision === "deny")) {
		const ruleId = typeof output.rule_id === "string" ? output.rule_id : undefined;
		const reason =
			typeof output.reason === "string"
				? output.reason
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
	if (result.exitCode === 1 && output.decision === "indeterminate") {
		const reason =
			typeof output.reason === "string" ? output.reason : "safety evaluation did not complete within its budget";
		throw safetyFailure(reason);
	}

	throw safetyFailure(`dcg returned inconsistent decision '${String(output.decision)}' with exit ${result.exitCode}`);
}
