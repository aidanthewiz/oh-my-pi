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
function managedEnvName(name: string): string {
	return process.platform === "win32" ? name.toUpperCase() : name;
}

// Bun autoloads the project's dotenv files into `process.env` before user code
// runs — including inside `bun build --compile` binaries. Linux keeps the
// original exec environment in procfs. Other platforms may use Bun.env only
// when the launcher disabled implicit dotenv loading or supplied an explicit
// env file; Coreforge's compiled launcher supplies an empty one.
function readLaunchEnv(): ReadonlyMap<string, string> | undefined {
	if (process.platform === "linux") {
		try {
			const values = new Map<string, string>();
			for (const entry of fs.readFileSync("/proc/self/environ", "utf8").split("\0")) {
				const separator = entry.indexOf("=");
				if (separator > 0) values.set(managedEnvName(entry.slice(0, separator)), entry.slice(separator + 1));
			}
			return values;
		} catch {}
	}
	const controlledDotenv = process.execArgv.some(arg => arg === "--no-env-file" || arg.startsWith("--env-file="));
	if (!controlledDotenv) return undefined;
	const values = new Map<string, string>();
	for (const key in Bun.env) {
		const value = Bun.env[key];
		if (value !== undefined) values.set(managedEnvName(key), value);
	}
	return values;
}

const launchEnvValues = readLaunchEnv();
const COREFORGE_MANAGED_LAUNCH_MARKERS = ["OMP_DOTENV_OVERRIDE", "OMP_CF_PRODUCT_VERSION"] as const;
const COREFORGE_MANAGED_RUNTIME_NAMES = [...COREFORGE_MANAGED_LAUNCH_MARKERS, "BUN_OPTIONS"] as const;
const COREFORGE_MANAGED_CHILD_POLICY = {
	AZURE_CORE_COLLECT_TELEMETRY: "no",
	GREPTILE_TELEMETRY_DISABLED: "1",
} as const;
const projectEnvNamesLoadedByOmp = new Set<string>();
const managedAgentEnvNames = new Set<string>();
const managedAgentEnvValues = new Set<string>();

function isCoreforgeManagedLaunch(): boolean {
	const override = launchEnvValues?.get(managedEnvName("OMP_DOTENV_OVERRIDE"));
	const productVersion = launchEnvValues?.get(managedEnvName("OMP_CF_PRODUCT_VERSION"));
	return override === "1" && productVersion !== undefined && productVersion.trim() !== "";
}

const coreforgeManagedLaunch = isCoreforgeManagedLaunch();
const launcherCapturedManagedChildEnv: Record<string, string> = {};
if (coreforgeManagedLaunch) {
	for (const name of COREFORGE_MANAGED_LAUNCH_MARKERS) {
		const value = launchEnvValues?.get(managedEnvName(name));
		if (value !== undefined) launcherCapturedManagedChildEnv[name] = value;
	}
	const bunOptions = launchEnvValues?.get(managedEnvName("BUN_OPTIONS"));
	if (bunOptions?.includes("--env-file=") && process.execArgv.some(arg => arg.startsWith("--env-file="))) {
		launcherCapturedManagedChildEnv.BUN_OPTIONS = bunOptions;
	}
	for (const [name, value] of Object.entries(COREFORGE_MANAGED_CHILD_POLICY)) {
		if (launchEnvValues?.get(managedEnvName(name)) === value) launcherCapturedManagedChildEnv[name] = value;
	}
}
const BUN_NO_ENV_FILE_OPTION = "--no-env-file";
const BUN_NO_ENV_FILE_OPTION_RE = /(?:^|\s)--no-env-file(?:\s|$)/;
const skipOmpDotenvFiles = Bun.env.OMP_NO_ENV_FILE === "1" && process.execArgv.includes(BUN_NO_ENV_FILE_OPTION);

const coreforgeManagedChildEnvNames = new Set(
	[...COREFORGE_MANAGED_RUNTIME_NAMES, ...Object.keys(COREFORGE_MANAGED_CHILD_POLICY)].map(managedEnvName),
);

export const OPERATIONAL_AWS_ENV_NAMES = [
	"AWS_PROFILE",
	"AWS_DEFAULT_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_ACCESS_KEY",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SECRET_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_SECURITY_TOKEN",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_SDK_LOAD_CONFIG",
	"AWS_ROLE_ARN",
	"AWS_ROLE_SESSION_NAME",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN",
	"AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT",
	"AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
	"AMAZON_ACCESS_KEY_ID",
	"AMAZON_SECRET_ACCESS_KEY",
	"AMAZON_SESSION_TOKEN",
] as const;
const operationalAwsEnvNames = new Set<string>(OPERATIONAL_AWS_ENV_NAMES.map(managedEnvName));
const trustedOperationalAwsValues = new Map<string, string>();
const CREDENTIAL_ENV_NAMES = new Set(
	[
		"ANTHROPIC_CUSTOM_HEADERS",
		"CLAUDE_CODE_CLIENT_KEY",
		"PERPLEXITY_COOKIES",
		"AZURE_CONFIG_DIR",
		"CLOUDSDK_CONFIG",
		"DOCKER_CONFIG",
		"GH_CONFIG_DIR",
		"GIT_ASKPASS",
		"GIT_SSH_COMMAND",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"GPG_AGENT_INFO",
		"KRB5CCNAME",
		"KRB5_CLIENT_KTNAME",
		"KRB5_KTNAME",
		"KUBECONFIG",
		"NETRC",
		"NPM_CONFIG_USERCONFIG",
		"SSH_AGENT_PID",
		"SSH_ASKPASS",
		"SSH_AUTH_SOCK",
	].map(managedEnvName),
);
const CREDENTIAL_ENV_NAME_RE =
	/(?:^|_)(?:ACCESS_KEY(?:_ID)?|API_KEY|BEARER|CREDENTIALS?|PASSWORD|PRIVATE_KEY|SECRET(?:_ACCESS_KEY)?|SESSION_TOKEN|TOKEN)(?:$|_)/;

function hasCredentialValue(name: string): boolean {
	const classified = name.toUpperCase();
	return (
		CREDENTIAL_ENV_NAMES.has(classified) ||
		CREDENTIAL_ENV_NAME_RE.test(classified) ||
		classified.startsWith("AWS_SSO_") ||
		classified.startsWith("OMP_OPERATIONAL_AWS_")
	);
}

const GIT_CREDENTIAL_ENV_NAMES: Readonly<Record<string, true>> = {
	GIT_ASKPASS: true,
	GIT_SSH: true,
	GIT_SSH_COMMAND: true,
	GPG_AGENT_INFO: true,
	SSH_AGENT_PID: true,
	SSH_ASKPASS: true,
	SSH_AUTH_SOCK: true,
};

function isCredentialEnvName(name: string): boolean {
	const classified = name.toUpperCase();
	return operationalAwsEnvNames.has(managedEnvName(name)) || hasCredentialValue(classified);
}

/** Prevent the named values and their current contents from crossing repository child-process boundaries. */
export function registerChildEnvRedactions(names: Iterable<string>, values: Iterable<string | undefined> = []): void {
	for (const name of names) {
		if (isSafeEnvName(name)) managedAgentEnvNames.add(managedEnvName(name));
	}
	for (const value of values) {
		if (value) managedAgentEnvValues.add(value);
	}
}

/**
 * Record exact launcher-captured AWS values. Trusted child modes may preserve
 * only these values when a repository dotenv assignment is indistinguishable
 * from Bun's preloaded environment on platforms without launch provenance.
 */
export function registerOperationalAwsEnvProvenance(entries: Iterable<readonly [string, string | undefined]>): void {
	for (const [name, value] of entries) {
		const normalized = managedEnvName(name);
		if (!operationalAwsEnvNames.has(normalized)) continue;
		if (value) trustedOperationalAwsValues.set(normalized, value);
		else trustedOperationalAwsValues.delete(normalized);
	}
}

function expandDotenvValues(values: Record<string, string>, env: Record<string, string>): Record<string, string> {
	const expanded: Record<string, string> = {};
	for (const key in values) {
		expanded[key] = values[key].replace(
			/(\\)?\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
			(match, escaped: string | undefined, braced: string | undefined, bare: string | undefined) => {
				if (escaped) return match.slice(1);
				const name = braced ?? bare;
				if (!name) return match;
				return env[name] ?? expanded[name] ?? "";
			},
		);
	}
	return expanded;
}

interface ChildEnvPolicy {
	preserveExplicitCredentials: boolean;
	preserveGitCredentials: boolean;
	preserveOperationalAws: boolean;
}

function scrubChildCredentials(
	result: Record<string, string>,
	protectedValues: ReadonlySet<string>,
	policy: ChildEnvPolicy,
	explicitOverlayNames: ReadonlySet<string> = new Set(),
): void {
	for (const key in result) {
		const normalized = managedEnvName(key);
		const managedName = managedAgentEnvNames.has(normalized);
		const managedValue = managedAgentEnvValues.has(result[key]);

		const credentialName = isCredentialEnvName(key);
		const protectedValue = protectedValues.has(result[key]);
		const trustedAws =
			policy.preserveOperationalAws && operationalAwsEnvNames.has(normalized) && !managedName && !managedValue;
		const trustedGitCredential =
			policy.preserveGitCredentials &&
			GIT_CREDENTIAL_ENV_NAMES[normalized] === true &&
			!managedName &&
			!managedValue;
		const explicitCredential =
			policy.preserveExplicitCredentials &&
			credentialName &&
			explicitOverlayNames.has(normalized) &&
			!managedName &&
			!managedValue;
		if (
			managedName ||
			managedValue ||
			(credentialName && !trustedAws && !trustedGitCredential && !explicitCredential) ||
			(protectedValue && !trustedAws && !trustedGitCredential && !explicitCredential)
		) {
			delete result[key];
		}
	}
}

export function applyLauncherCapturedChildPolicy(result: Record<string, string | undefined>): void {
	if (!coreforgeManagedLaunch) return;
	for (const key in result) {
		if (coreforgeManagedChildEnvNames.has(managedEnvName(key))) delete result[key];
	}
	for (const [name, value] of Object.entries(launcherCapturedManagedChildEnv)) result[name] = value;
}

function filterChildShellEnvInternal(
	policy: ChildEnvPolicy,
	env: Record<string, string | undefined>,
	cwd: string,
	overlays: Array<Readonly<Record<string, string | undefined>> | undefined>,
): Record<string, string> {
	const protectedValues = new Set(managedAgentEnvValues);
	for (const [key, value] of Object.entries(env)) {
		if (value && hasCredentialValue(key)) protectedValues.add(value);
	}
	const result = filterProcessEnv(env);
	scrubChildCredentials(result, protectedValues, policy);
	const projectEnv = parseEnvFile(path.join(cwd, ".env"));
	const nodeEnvName = `.env.${env.NODE_ENV || "development"}`;
	const modeEnv = parseEnvFile(path.join(cwd, nodeEnvName));
	const localEnv = parseEnvFile(path.join(cwd, ".env.local"));
	const launchEnv = { ...projectEnv, ...modeEnv, ...localEnv };
	const expandedLaunchEnv = {
		...expandDotenvValues(projectEnv, result),
		...expandDotenvValues(modeEnv, result),
		...expandDotenvValues(localEnv, result),
	};
	for (const key in launchEnv) {
		const normalized = managedEnvName(key);
		const trustedOperationalValue =
			policy.preserveOperationalAws &&
			operationalAwsEnvNames.has(normalized) &&
			trustedOperationalAwsValues.get(normalized) === result[key];
		if (trustedOperationalValue) continue;
		const launchValue = launchEnvValues?.get(normalized);
		if (launchValue !== undefined) {
			// Launcher-owned name: it keeps the launcher's own value. Bun overwrites
			// an empty launcher value with the dotenv one, so restore the launcher
			// value whenever what survived is exactly what the dotenv file defines.
			if (
				result[key] !== launchValue &&
				(result[key] === launchEnv[key] || result[key] === expandedLaunchEnv[key])
			) {
				result[key] = launchValue;
			}
			continue;
		}
		if (launchEnvValues || projectEnvNamesLoadedByOmp.has(key)) {
			// Strong provenance: the launch environment is known and this name is
			// absent from it, or OMP itself injected the value — either way it came
			// from a project dotenv file, not the parent shell.
			delete result[key];
		} else if (result[key] === launchEnv[key] || result[key] === expandedLaunchEnv[key]) {
			// No launch-env snapshot (dotenv autoloaded without procfs): best-effort
			// value match against the Bun-parsed dotenv.
			delete result[key];
		}
	}
	const explicitOverlayNames = new Set<string>();
	for (const overlay of overlays) {
		for (const [key, value] of Object.entries(overlay ?? {})) {
			explicitOverlayNames.add(managedEnvName(key));
			if (value === undefined) delete result[key];
			else result[key] = value;
		}
	}
	scrubChildCredentials(result, protectedValues, policy, explicitOverlayNames);
	applyLauncherCapturedChildPolicy(result);
	const hasExplicitAwsCredentials =
		policy.preserveExplicitCredentials &&
		Array.from(explicitOverlayNames).some(
			name =>
				operationalAwsEnvNames.has(name) &&
				name !== managedEnvName("AWS_REGION") &&
				name !== managedEnvName("AWS_DEFAULT_REGION"),
		);
	if (!policy.preserveOperationalAws && !hasExplicitAwsCredentials) {
		result.AWS_CONFIG_FILE = os.devNull;
		result.AWS_SHARED_CREDENTIALS_FILE = os.devNull;
		result.AWS_EC2_METADATA_DISABLED = "true";
	}
	// Bun autoloads cwd dotenv files after exec, which can repopulate values
	// removed above. BUN_OPTIONS also covers Bun shebang executables whose argv
	// cannot be amended at this spawn boundary.
	const bunOptions = result.BUN_OPTIONS?.trim();
	if (!bunOptions || !BUN_NO_ENV_FILE_OPTION_RE.test(bunOptions)) {
		result.BUN_OPTIONS = bunOptions ? `${bunOptions} ${BUN_NO_ENV_FILE_OPTION}` : BUN_NO_ENV_FILE_OPTION;
	}
	result.OMP_NO_ENV_FILE = "1";
	return result;
}

/** Builds a minimal environment for repository-controlled child processes. */
export function filterChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
	...overlays: Array<Readonly<Record<string, string | undefined>> | undefined>
): Record<string, string> {
	return filterChildShellEnvInternal(
		{ preserveExplicitCredentials: false, preserveGitCredentials: false, preserveOperationalAws: false },
		env,
		cwd,
		overlays,
	);
}

/** Preserves ambient operational AWS selectors for repository shell commands. */
export function filterTrustedChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
	...overlays: Array<Readonly<Record<string, string | undefined>> | undefined>
): Record<string, string> {
	return filterChildShellEnvInternal(
		{ preserveExplicitCredentials: false, preserveGitCredentials: false, preserveOperationalAws: true },
		env,
		cwd,
		overlays,
	);
}

/** Permits credentials explicitly configured by trusted user-level MCP config. */
export function filterUserMcpChildEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
	...overlays: Array<Readonly<Record<string, string | undefined>> | undefined>
): Record<string, string> {
	return filterChildShellEnvInternal(
		{ preserveExplicitCredentials: true, preserveGitCredentials: false, preserveOperationalAws: false },
		env,
		cwd,
		overlays,
	);
}

/** Preserves credential-agent paths used by authenticated Git commands. */
export function filterGitChildShellEnv(
	env: Record<string, string | undefined>,
	cwd: string = process.cwd(),
	...overlays: Array<Readonly<Record<string, string | undefined>> | undefined>
): Record<string, string> {
	return filterChildShellEnvInternal(
		{ preserveExplicitCredentials: false, preserveGitCredentials: true, preserveOperationalAws: false },
		env,
		cwd,
		overlays,
	);
}

/**
 * Parse one dotenv line with Bun-compatible semantics: an optional `export`
 * prefix, full-line `#` comments, inline `#` comments after whitespace on
 * unquoted values, and single/double/backtick quoting (a `#` inside quotes
 * stays literal). Returns undefined for blank lines, comments, and malformed
 * names.
 */
function parseEnvLine(line: string): { key: string; value: string } | undefined {
	const trimmed = line.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	const eqIndex = trimmed.indexOf("=");
	if (eqIndex === -1) return undefined;
	let key = trimmed.slice(0, eqIndex).trim();
	const exported = key.match(/^export[ \t]+(.*)$/);
	if (exported) key = exported[1].trim();
	if (!isValidEnvName(key)) return undefined;
	const raw = trimmed.slice(eqIndex + 1).replace(/^[ \t]+/, "");
	const quote = raw[0];
	if (quote === '"' || quote === "'" || quote === "`") {
		let close = raw.indexOf(quote, 1);
		while (close !== -1 && raw[close - 1] === "\\") close = raw.indexOf(quote, close + 1);
		return { key, value: close === -1 ? raw.slice(1) : raw.slice(1, close) };
	}
	const commentIndex = raw.search(/[ \t]#/);
	return { key, value: (commentIndex === -1 ? raw : raw.slice(0, commentIndex)).trimEnd() };
}

/**
 * Parses a .env file synchronously into key-value string pairs using
 * {@link parseEnvLine} for Bun-compatible line semantics, then mirrors valid
 * `OMP_` variables to their `PI_` aliases.
 */
export function parseEnvFile(filePath: string): Record<string, string> {
	const result: Record<string, string> = {};
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			const parsed = parseEnvLine(line);
			if (parsed && isSafeEnvValue(parsed.value)) result[parsed.key] = parsed.value;
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

// `filterChildShellEnv` pairs its private sentinel with Bun's launch-time
// `--no-env-file` option. Requiring both prevents a repository `.env` from
// forging the sentinel after process launch while also blocking OMP's explicit
// home/config/profile/project loaders in filtered Bun descendants.
const homeEnv = skipOmpDotenvFiles ? {} : parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = skipOmpDotenvFiles ? {} : parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = skipOmpDotenvFiles ? {} : parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = skipOmpDotenvFiles ? {} : parseEnvFile(path.join(process.cwd(), ".env"));

// Scrub ambient entries that can't be forwarded to a native execve spawn
// (bad names, NUL values) or are macOS malloc toggles we never propagate.
for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}
// Managed mode is valid only for a launch that carries both the launcher-only
// override and a non-empty Coreforge product-version marker. The launch snapshot
// is captured before profile dotenv authority, so dotenv files cannot activate it.
if (Bun.env.OMP_DOTENV_OVERRIDE === "1" && projectEnv.OMP_DOTENV_OVERRIDE === "1") {
	throw new Error(
		`OMP_DOTENV_OVERRIDE=1 is set in both the process environment and ${path.join(process.cwd(), ".env")}. ` +
			"This flag is a launcher-only signal and must not appear in a project .env " +
			"(a managed launch cannot be told apart from a forged one). " +
			"Remove that line from the project .env, or unset the environment variable.",
	);
}
const managedDotenv = coreforgeManagedLaunch;

// Strip any ambient key whose value came from the launch-cwd `.env` (equality
// match, the subtraction `filterChildShellEnv` uses) up front, so the project
// file cannot linger as ambient fallback for a key the agent `.env` leaves
// empty. The flag key is exempt: it is launcher-only (collision already
// refused above), so stripping it could only erase a real launcher signal.
// The default branch below re-applies projectEnv as its normal gap-fill layer,
// so unmanaged precedence is unchanged; managed mode intentionally never
// re-adds it.
for (const key in projectEnv) {
	if (key === "OMP_DOTENV_OVERRIDE") continue;
	if (Bun.env[key] === projectEnv[key] && launchEnvValues?.get(managedEnvName(key)) !== Bun.env[key]) {
		delete Bun.env[key];
	}
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
		managedAgentEnvNames.add(managedEnvName(key));
	}
	applyLauncherCapturedChildPolicy(Bun.env);
} else {
	// Upstream default: ambient wins; files fill gaps, most-specific first.
	for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
		for (const key in file) {
			if (key === "OMP_DOTENV_OVERRIDE") continue; // launcher-only — never file-sourced
			if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
				Bun.env[key] = file[key];
				if (file === projectEnv) projectEnvNamesLoadedByOmp.add(key);
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
 * Read an environment variable by its EXACT, case-sensitive name.
 *
 * `process.env` / `Bun.env` lookups are case-insensitive on Windows (Node backs
 * them with `uv_os_getenv`, Bun with a `CaseInsensitiveASCIIStringArrayHashMap`),
 * so a lowercase literal like `public` silently resolves to a differently-cased
 * system variable — Windows ships `PUBLIC=C:\Users\Public`. Enumerated keys are
 * the only signal that preserves the real casing, so this trusts the lookup only
 * when a key with identical casing is actually present. On POSIX (case-sensitive
 * env) it is equivalent to a direct lookup.
 *
 * Use this instead of `process.env[name] ?? literal` wherever `name` may be a
 * user-supplied literal (e.g. a stored API key) rather than a genuine env-var
 * reference — otherwise the literal gets hijacked by a same-named system var.
 *
 * @param name - Environment variable name to look up.
 * @param env - Environment source; defaults to `process.env`.
 */
export function $envExact(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
	const value = env[name];
	if (value === undefined) return undefined;
	// Enumeration preserves real key casing on Windows, unlike the getter; the
	// value is trusted only when an exact-case entry actually exists.
	for (const key in env) {
		if (key === name) return value;
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

const BUN_TEST_ENTRY_PATTERN = /[._](?:test|spec)\.[cm]?[jt]sx?$/;

/** True when the process is an explicitly marked test child or Bun is running a test entrypoint. */
export function isBunTestRuntime(): boolean {
	if (Bun.env.PI_TEST_RUNTIME === "1") return true;
	const hasTestEnvironment = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	return hasTestEnvironment && BUN_TEST_ENTRY_PATTERN.test(Bun.main);
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
 * SQLite `busy_timeout` for the session-critical databases (agent.db,
 * history.db, stats.db).
 *
 * Interactive hosts tolerate a longer synchronous wait on lock contention
 * (SQLITE_BUSY during WAL recovery/checkpoint — see oh-my-pi#2421): the
 * operator sees a brief freeze and the statement eventually completes.
 * Headless hosts (print/RPC/ACP/eval/SDK) run a protocol on the same thread —
 * a multi-second synchronous busy-wait freezes their event loop and stalls
 * every in-flight frame with no liveness signal, so they use a short timeout
 * and rely on the existing asynchronous open/retry paths to recover from
 * contention instead of blocking.
 */
export function getDbBusyTimeoutMs(): number {
	return isInteractiveHost() ? 5000 : 1000;
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
/** Parse a boolean-ish env value ("1", "yes", "on", …); `def` when unset/empty. */
export function parseFlag(value: string | undefined, def = false): boolean {
	if (!value) return def;
	return TRUTHY[value] === true;
}

export function $flag(name: string, def: boolean = false): boolean {
	return parseFlag($env[name], def);
}
