import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export function required(name: string): string {
	const value = process.env[name];
	assert(value, `${name} is required`);
	return value;
}

export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const fingerprint = async (file: string): Promise<string> => sha256(await fs.readFile(file));

export function environment(work: string): Record<string, string> {
	assert(path.isAbsolute(work));
	const env: Record<string, string> = {
		PATH: required("PATH"),
		HOME: path.join(work, "home"),
		TMPDIR: path.join(work, "tmp"),
		TMP: path.join(work, "tmp"),
		TEMP: path.join(work, "tmp"),
		XDG_CONFIG_HOME: path.join(work, "home", ".config"),
		XDG_CACHE_HOME: path.join(work, "home", ".cache"),
		XDG_DATA_HOME: path.join(work, "home", ".local", "share"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		TZ: "UTC",
		TERM: "xterm-256color",
		CI: "true",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		OMP_TEST_CONCURRENCY: "2",
		CF_TEST_JOBS: "2",
		CARGO_BUILD_JOBS: "2",
		CARGO_INCREMENTAL: "0",
	};
	for (const [key, value] of Object.entries(process.env)) {
		if (key.startsWith("CF_QUAL_") && value !== undefined) env[key] = value;
	}
	return env;
}

export async function privateDirectory(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await fs.chmod(directory, 0o700);
}

export async function receipt(id: string, data: unknown): Promise<void> {
	assert.match(id, /^[a-zA-Z0-9._-]+$/);
	const output = required("CF_QUAL_OUTPUT");
	await privateDirectory(output);
	const manifestPath = process.env.CF_QUAL_MANIFEST;
	await fs.writeFile(
		path.join(output, `${id}.json`),
		JSON.stringify(
			{
				schema: "CoreforgeHostedQualificationReceipt",
				sourceSha: required("CF_QUAL_SOURCE_SHA"),
				nativeSha256: required("CF_QUAL_NATIVE_SHA256"),
				binarySha256: required("CF_QUAL_BINARY_SHA256"),
				manifestSha256: manifestPath ? await fingerprint(manifestPath) : null,
				...(data as object),
			},
			null,
			2,
		) + "\n",
		{ mode: 0o600 },
	);
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	allowFailure?: boolean;
}
export interface CommandResult {
	argv: string[];
	code: number;
	stdout: string;
	stderr: string;
}
let sequence = 0;

export async function run(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
	assert(argv.length > 0);
	const work = required("CF_QUAL_WORK");
	const env = { ...environment(work), ...options.env };
	await Promise.all([privateDirectory(env.HOME!), privateDirectory(env.TMPDIR!)]);
	const started = new Date().toISOString();
	let stdout = "",
		stderr = "",
		bytes = 0,
		reason: string | null = null;
	const result = await new Promise<CommandResult>(resolve => {
		const child = spawn(argv[0]!, argv.slice(1), {
			cwd: options.cwd ?? work,
			env,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let killTimer: NodeJS.Timeout | undefined;
		const killGroup = (signal: NodeJS.Signals) => {
			if (child.pid) {
				try {
					process.kill(-child.pid, signal);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		};
		const stop = (why: string) => {
			reason ??= why;
			killGroup("SIGTERM");
			killTimer ??= setTimeout(() => killGroup("SIGKILL"), 5000);
		};
		const signal = () => stop("orchestrator interrupted");
		process.once("SIGTERM", signal);
		process.once("SIGINT", signal);
		const timer = setTimeout(() => stop("deadline exceeded"), options.timeoutMs ?? 600_000);
		const capture = (channel: "stdout" | "stderr", chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 32 * 1024 ** 2) {
				stop("output budget exceeded");
				return;
			}
			if (channel === "stdout") stdout += chunk.toString();
			else stderr += chunk.toString();
		};
		child.stdout.on("data", chunk => capture("stdout", chunk));
		child.stderr.on("data", chunk => capture("stderr", chunk));
		const cleanup = () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			process.off("SIGTERM", signal);
			process.off("SIGINT", signal);
			killGroup("SIGKILL");
		};
		child.once("error", error => {
			reason ??= String(error);
			cleanup();
			resolve({ argv, code: 1, stdout, stderr });
		});
		child.once("close", (code, signalName) => {
			cleanup();
			if (signalName) reason ??= `signal ${signalName}`;
			resolve({ argv, code: code ?? 1, stdout, stderr });
		});
	});
	await receipt(`command-${process.pid}-${String(sequence++).padStart(4, "0")}`, {
		kind: "observed-command",
		...result,
		cwd: options.cwd ?? work,
		started,
		finished: new Date().toISOString(),
		stopReason: reason,
		passed: result.code === 0 && reason === null,
		privateHome: env.HOME,
		privateTmp: env.TMPDIR,
		environmentKeys: Object.keys(env).sort(),
	});
	assert.equal(reason, null, reason ?? undefined);
	if (!options.allowFailure) assert.equal(result.code, 0, `${argv.join(" ")}\n${result.stderr}\n${result.stdout}`);
	return result;
}

export async function compileFixture(entry: string, outfile: string): Promise<void> {
	const checkout = required("CF_QUAL_CHECKOUT");
	// Load the build graph only after restoring producer overlays and installing private HOME.
	const { compileCodingAgent } = await import(path.join(checkout, "packages/coding-agent/scripts/compile-binary.ts"));
	const before = await fingerprint(required("CF_QUAL_NATIVE_ORIGINAL"));
	assert.equal(before, required("CF_QUAL_NATIVE_SHA256"));
	await compileCodingAgent({
		repoRoot: checkout,
		entrypoint: entry,
		outfile,
		native: { platform: "linux", arch: "x64" },
		target: "bun-linux-x64",
		minifyIdentifiers: true,
	});
	assert.equal(
		await fingerprint(required("CF_QUAL_NATIVE_ORIGINAL")),
		before,
		"Fixture compiler must not rebuild native addon",
	);
	await receipt(`compile-${path.basename(outfile)}`, {
		kind: "fixture-compile",
		entry,
		outfile,
		compiler: "compileCodingAgent",
		bun: Bun.version,
		nativeRebuilt: false,
		outputSha256: await fingerprint(outfile),
	});
}

export async function runCompiled(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
	const checkout = required("CF_QUAL_CHECKOUT"),
		work = required("CF_QUAL_WORK"),
		output = required("CF_QUAL_OUTPUT");
	assert(path.isAbsolute(argv[0]!) && !argv[0]!.startsWith(checkout + path.sep));
	const sandbox = [
		"bwrap",
		"--die-with-parent",
		"--unshare-user",
		"--unshare-pid",
		"--ro-bind",
		"/",
		"/",
		"--bind",
		work,
		work,
		"--bind",
		output,
		output,
		"--tmpfs",
		checkout,
		"--dev",
		"/dev",
		"--proc",
		"/proc",
		"--chdir",
		options.cwd ?? work,
	];
	const control = await run(
		[
			...sandbox,
			"--",
			"/bin/sh",
			"-c",
			'test ! -e "$1/package.json" && test ! -e "$1/packages/coding-agent/src/cli.ts"',
			"source-denial",
			checkout,
		],
		options,
	);
	assert.equal(control.code, 0);
	return run([...sandbox, "--", ...argv], {
		...options,
		env: { ...options.env, PI_COMPILED: "true", CF_QUAL_SOURCE_DENIED: "true" },
	});
}
