import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";

export * from "./worker-host";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Strict shell-identifier shape. Used for dotenv keys we accept into
 * `Bun.env` — those should be referenceable as `$NAME` from POSIX shells,
 * so we reject anything outside `[A-Za-z_][A-Za-z0-9_]*`.
 */
export function isValidEnvName(name: string): boolean {
	return ENV_NAME_RE.test(name);
}

/**
 * The only names that are genuinely unsafe to forward to a native `execve`
 * spawn: empty, containing `=` (would corrupt the `KEY=VALUE` framing) or
 * NUL (terminates the C string mid-entry). Windows ships standard variables
 * whose names contain parentheses (e.g. `ProgramFiles(x86)`, `CommonProgramFiles(x86)`)
 * — those MUST survive the scrub so downstream resolvers (Git Bash discovery
 * in `procmgr.ts`, etc.) can still read them.
 */
export function isSafeEnvName(name: string): boolean {
	return name.length > 0 && !name.includes("=") && !name.includes("\0");
}

export function isSafeEnvValue(value: string): boolean {
	return !value.includes("\0");
}

export function isMacosMallocStackLoggingEnvName(name: string): boolean {
	return name === "MallocStackLogging" || name === "MallocStackLoggingNoCompact";
}

export function filterProcessEnv(env: Record<string, string | undefined>): Record<string, string> {
	const result: Record<string, string> = {};
	for (const key in env) {
		const value = env[key];
		if (
			!isSafeEnvName(key) ||
			isMacosMallocStackLoggingEnvName(key) ||
			value === undefined ||
			!isSafeEnvValue(value)
		) {
			continue;
		}
		result[key] = value;
	}
	return result;
}

/** Filters process env for child shells without launch-cwd `.env.local` values. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
): Record<string, string> {
	const result = filterProcessEnv(env);
	const launchLocalEnv = parseEnvFile(path.join(cwd, ".env.local"));
	for (const key in launchLocalEnv) {
		if (result[key] === launchLocalEnv[key]) delete result[key];
	}
	return result;
}

/**
 * Parses a .env file synchronously and extracts key-value string pairs.
 * Ignores lines that are empty or start with '#'. Trims whitespace.
 * Allows values to be quoted with single or double quotes.
 * Returns an object of key-value pairs.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			// Skip comments and blank lines
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex === -1) continue;

			const key = trimmed.slice(0, eqIndex).trim();
			if (!isValidEnvName(key)) continue;

			let value = trimmed.slice(eqIndex + 1).trim();

			// Remove surrounding quotes (" or ')
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!isSafeEnvValue(value)) continue;

			result[key] = value;
		}
	} catch {
		// File doesn't exist or can't be read - return empty result
	}

	// OMP_ overrides PI_
	for (const k in result) {
		if (k.startsWith("OMP_")) {
			result[`PI_${k.slice(4)}`] = result[k];
		}
	}

	return result;
}

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

// Scrub ambient entries that can't be forwarded to a native execve spawn
// (bad names, NUL values) or are macOS malloc toggles we never propagate.
for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}
// Managed mode — set by the coreforge launcher (`OMP_DOTENV_OVERRIDE=1`).
// The flag is a LAUNCHER-ONLY signal: it is honored from the process
// environment and never sourced from any `.env` file layer (see the loops
// below — no file layer can introduce it into `Bun.env`).
//
// Provenance is unrecoverable when Bun's dotenv autoload is on: the launch-cwd
// `.env` merges into `Bun.env` before this module runs, so a launcher-set flag
// and a project-file flag are byte-identical (`"1"`). The one observable that
// cannot be disambiguated is BOTH the ambient env and the project `.env`
// declaring `"1"` — a real managed launch colliding with a stray copy of the
// line, or a project file forging the flag under autoload. Guessing either way
// is unsafe (silent mode flip vs. silent downgrade + project-cred gap-fill),
// so we refuse loudly instead. (The shipped engine disables autoload —
// compiled `--no-compile-autoload-dotenv`, source mode a clean cwd — so this
// can only trigger there if the project `.env` literally carries the flag.)
if (Bun.env.OMP_DOTENV_OVERRIDE === "1" && projectEnv.OMP_DOTENV_OVERRIDE === "1") {
	throw new Error(
		`OMP_DOTENV_OVERRIDE=1 is set in both the process environment and ${path.join(process.cwd(), ".env")}. ` +
			"This flag is a launcher-only signal and must not appear in a project .env " +
			"(a managed launch cannot be told apart from a forged one). " +
			"Remove that line from the project .env, or unset the environment variable.",
	);
}
const managedDotenv = Bun.env.OMP_DOTENV_OVERRIDE === "1";

// Strip any ambient key whose value came from the launch-cwd `.env` (equality
// match, the subtraction `filterChildShellEnv` uses) up front, so the project
// file cannot linger as ambient fallback for a key the agent `.env` leaves
// empty. The flag key is exempt: it is launcher-only (collision already
// refused above), so stripping it could only erase a real launcher signal.
// The default branch below re-applies projectEnv as its normal gap-fill layer,
// so unmanaged precedence is unchanged; managed mode intentionally never re-adds it.
for (const key in projectEnv) {
	if (key === "OMP_DOTENV_OVERRIDE") continue;
	if (Bun.env[key] === projectEnv[key]) delete Bun.env[key];
}

// The agent/profile `.env` becomes the single authoritative credential source:
//   1. its non-empty keys OVERRIDE the ambient environment, so a stale shell
//      export (e.g. an old OPENAI_API_KEY in ~/.zshrc) can never shadow the
//      org-managed value — "just put it in .env" always wins;
//   2. the ambient environment only fills keys the profile `.env` leaves unset
//      or empty, so a machine whose shell is already configured still starts
//      with an empty .env (shell fallback);
//   3. the project / config-root / $HOME `.env` layers are skipped entirely, so
//      a random project's `.env` can never inject credentials.
// Default (flag unset) preserves upstream precedence exactly: ambient wins,
// then the file layers fill gaps in project > agent > config-root > home order.

if (managedDotenv) {
	// The agent/profile `.env` is authoritative. Non-empty values OVERRIDE the
	// ambient env; an empty value defers to the ambient value so a shipped
	// placeholder (`OPENAI_API_KEY=`) still allows shell fallback. Any key the
	// agent `.env` omits falls back to the remaining real ambient env — the
	// project `.env` was already evicted above, so the cwd cannot inject creds.
	for (const key in agentEnv) {
		if (isMacosMallocStackLoggingEnvName(key)) continue;
		if (key === "OMP_DOTENV_OVERRIDE") continue; // launcher-only — never file-sourced
		const value = agentEnv[key];
		if (value === "") continue; // placeholder — let the ambient value (if any) stand
		Bun.env[key] = value;
	}
} else {
	// Upstream default: ambient wins; files fill gaps, most-specific first.
	for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
		for (const key in file) {
			if (key === "OMP_DOTENV_OVERRIDE") continue; // launcher-only — never file-sourced
			if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
				Bun.env[key] = file[key];
			}
		}
	}
}

// Directory-affecting keys (XDG_*_HOME, and in default mode PI_CODING_AGENT_DIR)
// may have just arrived from the profile/agent `.env` applied above. The dirs
// resolver cached its paths at module load — before this file ran — so rebuild
// it now from the updated env. `getAgentDir()` already located the `.env` from
// the profile name + home, so this re-reads only the directory vars.
refreshDirsFromEnv();

/**
 * Intentional re-export of Bun.env.
 *
 * All users should import this env module (import { $env } from "@oh-my-pi/pi-utils")
 * before using environment variables. This ensures that .env files have been loaded and
 * overrides (project, home) have been applied, so $env always reflects the correct values.
 */
export const $env: Record<string, string> = Bun.env as Record<string, string>;

/**
 * Resolve the first environment variable value from the given keys.
 * @param keys - The keys to resolve.
 * @returns The first environment variable value, or undefined if no value is found.
 */
export function $pickenv(...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = Bun.env[key]?.trim();
		if (value) {
			return value;
		}
	}
	return undefined;
}

/**
 * Parses a positive decimal integer from `$env[name]`.
 * Empty, invalid, NaN, zero, or negative values return `defaultValue`.
 */
export function $envpos(name: string, defaultValue: number): number {
	const raw = $env[name];
	if (!raw) return defaultValue;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed) || parsed <= 0) return defaultValue;
	return parsed;
}

/** True when `BUN_ENV` or `NODE_ENV` is the string `test`. */
export function isBunTestRuntime(): boolean {
	return Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
}

let terminalHeadless = isBunTestRuntime();

/**
 * True when real-terminal side effects must be suppressed: stdout escape/frame
 * writes, stdin raw-mode + resume, CSI/OSC capability probes, SIGWINCH, window
 * title changes, and emergency restore. Defaults to {@link isBunTestRuntime} so
 * `bun test` launched inside a real TTY never paints the TUI, leaks probe
 * queries, or hijacks the developer's stdin; production runtimes stay
 * interactive.
 *
 * Terminal-contract tests that must exercise the real I/O path opt out with
 * `setTerminalHeadless(false)` and restore it afterwards.
 */
export function isTerminalHeadless(): boolean {
	return terminalHeadless;
}

/**
 * Override the {@link isTerminalHeadless} default and return the previous value
 * so callers can restore exact prior state (`const prev = setTerminalHeadless(false); … setTerminalHeadless(prev);`).
 */
export function setTerminalHeadless(headless: boolean): boolean {
	const previous = terminalHeadless;
	terminalHeadless = headless;
	return previous;
}

let interactiveHost = false;

/**
 * True when this process runs an interactive coding-agent host — the only
 * context where the operator can browse the Agent Hub and focus a live
 * subagent's session (`SessionFocusController`), so a subagent's session title
 * can become operator-visible. Off by default (print/RPC/ACP/eval/SDK/`bun
 * test` never render a focusable session tree); the interactive entrypoint
 * flips it on with {@link setInteractiveHost}.
 */
export function isInteractiveHost(): boolean {
	return interactiveHost;
}

/**
 * Set the interactive-host flag and return the previous value so callers can
 * restore exact prior state. See {@link isInteractiveHost}.
 */
export function setInteractiveHost(interactive: boolean): boolean {
	const previous = interactiveHost;
	interactiveHost = interactive;
	return previous;
}

/**
 * True when this code is running inside a `bun build --compile` standalone
 * binary. Detects via the embedded virtual-filesystem path markers
 * (`$bunfs`, `~BUN`, or its URL-encoded form `%7EBUN`) in `import.meta.url`,
 * which Bun rewrites for every module bundled into the executable. The
 * `PI_COMPILED` env var (set by the build script's `--define`) is checked
 * first for cheap fast-path detection.
 */
export function isCompiledBinary(): boolean {
	if (process.env.PI_COMPILED || Bun.env.PI_COMPILED) return true;
	const url = import.meta.url;
	return url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN");
}

const TRUTHY: Dict<boolean> = {
	"1": true,
	Y: true,
	y: true,
	TRUE: true,
	true: true,
	YES: true,
	yes: true,
	ON: true,
	on: true,
};
export function $flag(name: string, def: boolean = false): boolean {
	const value = $env[name];
	if (!value) return def;
	return TRUTHY[value] === true;
}
