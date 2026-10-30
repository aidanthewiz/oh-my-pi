import { Process } from "@oh-my-pi/pi-natives";
import * as path from "node:path";
import { $which, filterForgeChildEnv, untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { REJECT_PROMPT_COMMAND } from "../exec/non-interactive-env";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";

/** A changed credential source cannot be replaced by a stale cached result. */
export class ForgeCredentialsChangedError extends ToolError {}

/**
 * Process-lifetime cache of a forge's default-repo lookup (`gh repo view`,
 * `glab repo view`) keyed by absolute cwd.
 *
 * The shared lookup is intentionally **not** bound to any caller's
 * AbortSignal. Cancelling one caller would otherwise kill the underlying
 * subprocess for every concurrent waiter on the same cwd. Each caller's
 * signal is honored at the wait point via `untilAborted` instead, so an abort
 * unwinds only that caller. Failures are not cached.
 */
export class CwdLookupMemo {
	readonly #resolved = new Map<string, string>();
	readonly #inflight = new Map<string, Promise<string>>();

	constructor(private readonly lookup: (cwd: string) => Promise<string>) {}

	get(cwd: string, signal?: AbortSignal): Promise<string> {
		const key = path.resolve(cwd);
		const ready = this.#resolved.get(key);
		if (ready) return Promise.resolve(ready);
		let pending = this.#inflight.get(key);
		if (!pending) {
			pending = this.lookup(cwd).then(value => {
				this.#resolved.set(key, value);
				return value;
			});
			const settled = () => this.#inflight.delete(key);
			void pending.then(settled, settled);
			this.#inflight.set(key, pending);
		}
		return untilAborted(signal, pending);
	}

	clear(): void {
		this.#resolved.clear();
		this.#inflight.clear();
	}
}

/** Captured result of a completed forge CLI (`gh`/`glab`) invocation. */
export interface ForgeCliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	/** True when stdout exceeded the subprocess capture byte cap. */
	stdoutTruncated?: boolean;
}

/** Static description of a forge CLI binary and how to spawn it. */
export interface ForgeCliSpec {
	bin: string;
	displayName: string;
	/** Thrown as a `ToolError` when the binary is not on PATH. */
	installMessage: string;
	env: Record<string, string | undefined>;
	timeoutMs: number;
}

/** Env shared by every forge CLI: disables git/ssh credential and editor prompts. */
export const FORGE_NON_INTERACTIVE_ENV: Record<string, string | undefined> = {
	GIT_ASKPASS: "true",
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	LC_ALL: undefined,
	LC_MESSAGES: "C",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
};

/** Capture one private, authenticated forge environment before asynchronous work starts. */
export function captureForgeCliEnvironment(cwd: string, bin: "gh" | "glab"): Readonly<Record<string, string>> {
	const env = filterForgeChildEnv(Bun.env, cwd, bin);
	const configName = bin === "gh" ? "GH_CONFIG_DIR" : "GLAB_CONFIG_DIR";
	if (env[configName]) env[configName] = path.resolve(cwd, env[configName]);
	return Object.freeze(env);
}

const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

interface CapturedForgeText {
	text: string;
	truncated: boolean;
}

async function readCappedText(stream: ReadableStream<Uint8Array>, bin: string): Promise<CapturedForgeText> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let captured = 0;
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (captured < OUTPUT_LIMIT_BYTES) {
				const take = Math.min(value.byteLength, OUTPUT_LIMIT_BYTES - captured);
				if (take > 0) chunks.push(value.subarray(0, take));
				captured += take;
			}
		}
	} finally {
		reader.releaseLock();
	}
	const text = Buffer.concat(chunks).toString("utf8");
	const truncated = total > OUTPUT_LIMIT_BYTES;
	return { text: truncated ? `${text}\n[${bin} subprocess output truncated after 8 MiB]\n` : text, truncated };
}

/** Run a forge CLI command with bounded capture and a deadline. Does not throw on non-zero exit. */
export async function runForgeCli(
	spec: ForgeCliSpec,
	cwd: string,
	args: string[],
	signal: AbortSignal | undefined,
	trimOutput: boolean,
	env: Readonly<Record<string, string | undefined>> = captureForgeCliEnvironment(
		cwd,
		spec.bin === "glab" ? "glab" : "gh",
	),
): Promise<ForgeCliResult> {
	throwIfAborted(signal);
	const executable = $which(spec.bin, { cwd, PATH: env.PATH, requireAbsolutePaths: true });
	if (!executable) throw new ToolError(spec.installMessage);
	const timeoutSignal = AbortSignal.timeout(spec.timeoutMs);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		const child = Bun.spawn([executable, ...args], {
			cwd,
			env: { ...env, ...spec.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			detached: true,
		});
		let root: Process | null = null;
		try {
			root = Process.fromPid(child.pid);
		} catch {}
		let complete = false;
		let pendingStreams = 2;
		const stop = () => {
			try {
				root?.killTree(9);
			} catch {}
			try {
				if (process.platform !== "win32" && (child.exitCode === null || pendingStreams > 0))
					process.kill(-child.pid, "SIGKILL");
				else if (child.exitCode === null) child.kill("SIGKILL");
			} catch {
				try {
					if (child.exitCode === null) child.kill("SIGKILL");
				} catch {}
			}
		};
		combinedSignal.addEventListener("abort", stop, { once: true });
		if (combinedSignal.aborted) stop();
		const stdout = readCappedText(child.stdout, spec.bin);
		const stderr = readCappedText(child.stderr, spec.bin);
		const settled = () => {
			pendingStreams--;
		};
		void stdout.then(settled, settled);
		void stderr.then(settled, settled);
		try {
			const [out, err, exitCode] = await Promise.all([stdout, stderr, child.exited]);
			complete = true;
			throwIfAborted(signal);
			if (timeoutSignal.aborted) throw new ToolError(`${spec.displayName} command timed out: ${spec.bin}`);
			return {
				exitCode: exitCode ?? 0,
				stdout: trimOutput ? out.text.trim() : out.text,
				stderr: trimOutput ? err.text.trim() : err.text,
				stdoutTruncated: out.truncated,
			};
		} finally {
			if (!complete) stop();
			await Promise.allSettled([stdout, stderr, child.exited]);
			combinedSignal.removeEventListener("abort", stop);
		}
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`${spec.displayName} command timed out: ${spec.bin}`);
		}
		throw error;
	}
}
