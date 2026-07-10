/**
 * AWS credential resolution for the Bedrock provider.
 *
 * Chain (first hit wins):
 *  1. Static credentials from the environment outside managed model auth
 *     (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` [+ `AWS_SESSION_TOKEN`]).
 *  2. Profile in `~/.aws/credentials` (and `~/.aws/config` for SSO):
 *      - static `aws_access_key_id` / `aws_secret_access_key` / `aws_session_token`
 *      - modern `sso-session` profiles through the AWS CLI credential exporter,
 *        which silently refreshes the cached access token before returning
 *        short-lived role credentials.
 *      - `credential_process` — an external command emitting the AWS SDK
 *        `Version: 1` JSON envelope on stdout. Used by `aws-vault`, `granted`,
 *        in-house brokers, etc.
 *  3. EC2 IMDSv2 (only when `AWS_EC2_METADATA_DISABLED` is unset / falsey and
 *     `169.254.169.254` is reachable within a 1 s timeout).
 *
 * Resolved credentials are cached process-wide per profile and refreshed
 * 60 s before `Expiration` to absorb clock skew.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { allowAmbientAwsModelCredentials, resolveAwsModelProfile, resolveAwsModelRegion } from "../aws-model-auth";
import * as AIError from "../error";
import type { FetchImpl } from "../types";
import { raceWithSignal } from "../utils/abort";
import type { AwsCredentials } from "./aws-sigv4";

export interface ResolvedCredentials extends AwsCredentials {
	/** Absolute expiration timestamp in ms. `undefined` for non-expiring static creds. */
	expiresAt?: number;
}

export interface CredentialResolveOptions {
	/** Named profile from AWS config; ignored when managed model authentication is active. */
	profile?: string;
	/** Falls back to the active model-auth region and finally `us-east-1`. */
	region?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

const REFRESH_SKEW_MS = 60_000;
/**
 * TTL for file-sourced credentials that carry a session token but no expiry.
 * Tools like aws-vault/saml2aws rewrite ~/.aws/credentials with short-lived STS
 * session keys; caching them forever serves stale creds after rotation.
 */
const FILE_SESSION_CREDS_TTL_MS = 5 * 60_000;
/**
 * Bound for the detached (signal-free) shared resolution: a hung
 * credential_process/SSO/IMDS fetch must not pin the inflight slot forever.
 */
const SHARED_RESOLVE_TIMEOUT_MS = 30_000;
/**
 * Minimum spacing between {@link AwsCredentialRecoveryHandler} invocations for
 * one profile/region after a recovery attempt failed to produce working
 * credentials. Without it, every request of a long-lived session would spawn
 * another sign-in attempt.
 */
const RECOVERY_COOLDOWN_MS = 60_000;

const MANAGED_MODEL_CHILD_CLEARED_ENV_VARS = [
	"AWS_PROFILE",
	"AWS_DEFAULT_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_ROLE_ARN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
] as const;

/** Resolution failures a fresh interactive sign-in can plausibly repair. */
const RECOVERABLE_RECOVERY_KINDS: Partial<Record<AIError.AwsCredentialsErrorKind, true>> = {
	"sso-token-missing": true,
	"sso-token-expired": true,
};

export interface AwsCredentialRecoveryRequest {
	profile: string;
	region: string;
	kind: AIError.AwsCredentialsErrorKind;
	error: AIError.AwsCredentialsError;
}

/**
 * Re-authentication callback for expired/missing SSO sessions. Returns whether
 * a fresh session was established; resolution is retried exactly once when it
 * returns `true`.
 */
export type AwsCredentialRecoveryHandler = (request: AwsCredentialRecoveryRequest) => Promise<boolean> | boolean;

let recoveryHandler: AwsCredentialRecoveryHandler | undefined;
const recoveryCooldown: Map<string, number> = new Map();

/**
 * Install the process-wide re-authentication callback consulted when credential
 * resolution fails on an expired/missing SSO session. Pass `undefined` to
 * remove it. Without a handler, resolution keeps its previous behavior: the
 * typed {@link AIError.AwsCredentialsError} propagates to the caller.
 */
export function setAwsCredentialRecoveryHandler(handler: AwsCredentialRecoveryHandler | undefined): void {
	recoveryHandler = handler;
	recoveryCooldown.clear();
}

interface CacheEntry {
	creds: ResolvedCredentials;
	expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();
const inflight: Map<string, Promise<ResolvedCredentials>> = new Map();

export async function resolveAwsCredentials(opts: CredentialResolveOptions = {}): Promise<ResolvedCredentials> {
	const allowAmbientCredentials = allowAmbientAwsModelCredentials();
	const profile = allowAmbientCredentials
		? opts.profile || resolveAwsModelProfile() || "default"
		: resolveAwsModelProfile() || "default";
	const region = allowAmbientCredentials
		? opts.region || resolveAwsModelRegion() || "us-east-1"
		: resolveAwsModelRegion() || "us-east-1";
	const cacheKey = `${profile}\x00${region}\x00${allowAmbientCredentials ? "ambient" : "managed"}`;

	const hit = cache.get(cacheKey);
	if (hit && hit.expiresAt - REFRESH_SKEW_MS > Date.now()) return hit.creds;

	// Single-flight: N concurrent cold calls must not each spawn credential_process/SSO/IMDS fetches.
	// The shared resolution is deliberately detached from any caller's signal — aborting one
	// request must not fail every waiter — and bounded by its own timeout instead; each caller
	// races its own signal against the shared promise.
	const existing = inflight.get(cacheKey);
	if (existing) return raceWithSignal(existing, opts.signal);

	const fetchImpl = opts.fetch ?? (globalThis.fetch as FetchImpl);
	const promise = (async () => {
		try {
			const creds = await resolveFreshWithRecovery(profile, region, cacheKey, allowAmbientCredentials, fetchImpl);
			cache.set(cacheKey, { creds, expiresAt: creds.expiresAt ?? Number.POSITIVE_INFINITY });
			return creds;
		} finally {
			inflight.delete(cacheKey);
		}
	})();
	inflight.set(cacheKey, promise);
	return raceWithSignal(promise, opts.signal);
}

/**
 * One resolution pass, plus at most one re-authentication and re-resolve when
 * the failure is an expired/missing SSO session and a recovery handler is
 * installed. Bounded by construction: a single handler invocation and a single
 * retry per resolution, with {@link RECOVERY_COOLDOWN_MS} spacing while
 * recovery keeps failing. Runs inside the single-flight slot, so concurrent
 * requests of one conversation share the same sign-in instead of racing.
 */
async function resolveFreshWithRecovery(
	profile: string,
	region: string,
	cacheKey: string,
	allowAmbientCredentials: boolean,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials> {
	try {
		const creds = await resolveFresh(
			profile,
			region,
			allowAmbientCredentials,
			AbortSignal.timeout(SHARED_RESOLVE_TIMEOUT_MS),
			fetchImpl,
		);
		recoveryCooldown.delete(cacheKey);
		return creds;
	} catch (error) {
		if (!(await runCredentialRecovery(profile, region, cacheKey, error))) throw error;
		try {
			const creds = await resolveFresh(
				profile,
				region,
				allowAmbientCredentials,
				AbortSignal.timeout(SHARED_RESOLVE_TIMEOUT_MS),
				fetchImpl,
			);
			recoveryCooldown.delete(cacheKey);
			return creds;
		} catch (retryError) {
			if (
				!(retryError instanceof AIError.AwsCredentialsError) ||
				RECOVERABLE_RECOVERY_KINDS[retryError.kind] !== true
			) {
				recoveryCooldown.delete(cacheKey);
			}
			throw retryError;
		}
	}
}

/** Whether the installed handler ran and reported a fresh session. */
async function runCredentialRecovery(
	profile: string,
	region: string,
	cacheKey: string,
	error: unknown,
): Promise<boolean> {
	const handler = recoveryHandler;
	if (!handler) return false;
	if (!(error instanceof AIError.AwsCredentialsError)) return false;
	if (RECOVERABLE_RECOVERY_KINDS[error.kind] !== true) return false;
	const lastAttempt = recoveryCooldown.get(cacheKey);
	if (lastAttempt !== undefined && Date.now() - lastAttempt < RECOVERY_COOLDOWN_MS) return false;
	recoveryCooldown.set(cacheKey, Date.now());
	try {
		return await handler({ profile, region, kind: error.kind, error });
	} catch (recoveryError) {
		logger.warn("AWS credential recovery handler failed", {
			profile,
			kind: error.kind,
			error: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
		});
		return false;
	}
}

async function resolveFresh(
	profile: string,
	region: string,
	allowAmbientCredentials: boolean,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = globalThis.fetch as FetchImpl,
): Promise<ResolvedCredentials> {
	// Standard AWS environment credentials belong to operational tools when
	// managed model authentication is active.
	if (allowAmbientCredentials) {
		const envCreds = readEnvCredentials();
		if (envCreds) return envCreds;
	}

	// 2. Profile (static or SSO).
	const profileCreds = await readProfileCredentials(profile, region, allowAmbientCredentials, signal, fetchImpl);
	if (profileCreds) return profileCreds;

	// EC2 task/instance identity is another ambient operational source.
	if (allowAmbientCredentials && $env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true") {
		const imdsCreds = await readImdsCredentials(signal, fetchImpl);
		if (imdsCreds) return imdsCreds;
	}

	throw new AIError.AwsCredentialsError(
		allowAmbientCredentials
			? `Unable to resolve AWS credentials. Set AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY, or configure profile '${profile}' in ~/.aws/credentials (or ~/.aws/config for SSO).`
			: `Unable to resolve managed AWS model profile '${profile}' from ~/.aws/config.`,
		"resolution",
	);
}

function readEnvCredentials(): ResolvedCredentials | undefined {
	const ak = $env.AWS_ACCESS_KEY_ID;
	const sk = $env.AWS_SECRET_ACCESS_KEY;
	if (!ak || !sk) return undefined;
	const token = $env.AWS_SESSION_TOKEN;
	return token
		? { accessKeyId: ak, secretAccessKey: sk, sessionToken: token }
		: { accessKeyId: ak, secretAccessKey: sk };
}

// ---------- INI parsing ----------

/** Map of section name -> map of key -> value. Section names are stripped of
 * any leading `profile ` (so `~/.aws/config` aligns with `~/.aws/credentials`). */
type IniFile = Record<string, Record<string, string>>;

function parseIni(text: string): IniFile {
	const out: IniFile = {};
	let current: Record<string, string> | null = null;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			let name = line.slice(1, -1).trim();
			if (name.startsWith("profile ")) name = name.slice(8).trim();
			if (name.startsWith("sso-session ")) name = `sso-session:${name.slice(12).trim()}`;
			let section = out[name];
			if (!section) {
				section = {};
				out[name] = section;
			}
			current = section;
			continue;
		}
		if (!current) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

async function readIniFile(p: string): Promise<IniFile | undefined> {
	try {
		const text = await fs.promises.readFile(p, "utf8");
		return parseIni(text);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

// ---------- Profile / SSO ----------

async function readProfileCredentials(
	profile: string,
	region: string,
	allowAmbientCredentials: boolean,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	const home = process.platform === "win32" ? $env.USERPROFILE || os.homedir() : $env.HOME || os.homedir();
	const defaultCredentialsPath = path.join(home, ".aws", "credentials");
	const defaultConfigPath = path.join(home, ".aws", "config");
	const credentialsPath = (allowAmbientCredentials && $env.AWS_SHARED_CREDENTIALS_FILE) || defaultCredentialsPath;
	const configPath = (allowAmbientCredentials && $env.AWS_CONFIG_FILE) || defaultConfigPath;

	const credentialsIni = await readIniFile(credentialsPath);
	const configIni = await readIniFile(configPath);

	// Static credentials live in ~/.aws/credentials; SSO config lives in
	// ~/.aws/config under `[profile foo]`. Merge into a single view.
	const merged: Record<string, string> = { ...(configIni?.[profile] ?? {}), ...(credentialsIni?.[profile] ?? {}) };
	if (Object.keys(merged).length === 0) return undefined;

	if (merged.aws_access_key_id && merged.aws_secret_access_key) {
		const out: ResolvedCredentials = {
			accessKeyId: merged.aws_access_key_id,
			secretAccessKey: merged.aws_secret_access_key,
		};
		if (merged.aws_session_token) {
			out.sessionToken = merged.aws_session_token;
			// Session-token creds in the credentials file are short-lived STS keys that
			// external tools rotate in place; cap the cache so rotations are picked up.
			out.expiresAt = Date.now() + FILE_SESSION_CREDS_TTL_MS;
		}
		return out;
	}

	if (merged.sso_account_id && merged.sso_role_name) {
		// Modern sso-session profiles carry a refresh token. Delegate these to the
		// AWS CLI so its supported token provider renews the hourly access token;
		// our direct cache exchange below intentionally remains as the no-CLI and
		// legacy-profile fallback.
		if (merged.sso_session) {
			const refreshed = await readSsoCredentialsViaAwsCli(profile, allowAmbientCredentials, signal);
			if (refreshed) return refreshed;
		}
		return readSsoCredentials(merged, configIni, region, signal, fetchImpl);
	}

	if (merged.credential_process) {
		return readCredentialProcess(profile, merged.credential_process, allowAmbientCredentials, signal);
	}

	return undefined;
}

/**
 * Resolve a modern SSO profile through the AWS CLI token provider. Unlike a
 * direct read of ~/.aws/sso/cache, `export-credentials` uses the refresh token
 * stored by `aws sso login`, so one browser sign-in survives the access token's
 * hourly rotation. The caller falls back to the direct resolver when the CLI is
 * unavailable (legacy OMP installs and non-CLI environments).
 */
function classifyAwsCliSsoFailure(message: string): AIError.AwsCredentialsErrorKind {
	if (/error loading sso token|sso token[\s\S]*(?:not found|does not exist)/i.test(message)) {
		return "sso-token-missing";
	}
	if (/(?:sso (?:token|session)|token)[\s\S]*(?:expired|invalid|refresh failed)/i.test(message)) {
		return "sso-token-expired";
	}
	return "sso-role";
}

async function readSsoCredentialsViaAwsCli(
	profile: string,
	allowAmbientCredentials: boolean,
	signal: AbortSignal | undefined,
): Promise<ResolvedCredentials | undefined> {
	const executable = Bun.which("aws", { PATH: $env.PATH });
	if (!executable) return undefined;
	try {
		return await runCredentialCommand(
			profile,
			[executable, "configure", "export-credentials", "--profile", profile, "--format", "process"],
			allowAmbientCredentials,
			signal,
			"AWS CLI SSO credential export",
			"sso-role",
		);
	} catch (error) {
		if (!(error instanceof AIError.AwsCredentialsError) || error.kind !== "sso-role") throw error;
		const kind = classifyAwsCliSsoFailure(error.message);
		if (kind === error.kind) throw error;
		throw new AIError.AwsCredentialsError(error.message, kind, { cause: error });
	}
}

interface SsoCachedToken {
	accessToken?: string;
	expiresAt?: string;
	startUrl?: string;
	region?: string;
}

async function readSsoCredentials(
	profileCfg: Record<string, string>,
	configIni: IniFile | undefined,
	defaultRegion: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	// Two SSO profile shapes:
	//   - legacy: `sso_start_url` + `sso_region` directly on the profile
	//   - sso-session: `sso_session = my-session` references a `[sso-session my-session]` block
	let startUrl = profileCfg.sso_start_url;
	let ssoRegion = profileCfg.sso_region;
	const sessionName = profileCfg.sso_session;
	if (sessionName && configIni) {
		const session = configIni[`sso-session:${sessionName}`];
		if (session) {
			startUrl = startUrl || session.sso_start_url;
			ssoRegion = ssoRegion || session.sso_region;
		}
	}
	if (!startUrl || !ssoRegion) return undefined;

	const token = await loadSsoCachedToken(startUrl, sessionName);
	if (!token?.accessToken) {
		throw new AIError.AwsCredentialsError(
			`AWS SSO token for ${startUrl} not found in ~/.aws/sso/cache. Run 'aws sso login' first.`,
			"sso-token-missing",
		);
	}
	const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.POSITIVE_INFINITY;
	if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
		throw new AIError.AwsCredentialsError(
			`AWS SSO token for ${startUrl} has expired. Run 'aws sso login' to refresh.`,
			"sso-token-expired",
		);
	}

	const url =
		`https://portal.sso.${ssoRegion}.amazonaws.com/federation/credentials` +
		`?account_id=${encodeURIComponent(profileCfg.sso_account_id)}` +
		`&role_name=${encodeURIComponent(profileCfg.sso_role_name)}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: { "x-amz-sso_bearer_token": token.accessToken },
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new AIError.AwsCredentialsError(
			`AWS SSO GetRoleCredentials failed: ${response.status} ${body.slice(0, 200)}`,
			"sso-role",
		);
	}
	const json = (await response.json()) as {
		roleCredentials?: { accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number };
	};
	const role = json.roleCredentials;
	if (!role)
		throw new AIError.AwsCredentialsError(
			"AWS SSO GetRoleCredentials: missing roleCredentials in response",
			"sso-role",
		);

	// region is honored at the caller; we only consume defaultRegion to keep the
	// param wired for symmetry with other resolution paths.
	void defaultRegion;

	return {
		accessKeyId: role.accessKeyId,
		secretAccessKey: role.secretAccessKey,
		sessionToken: role.sessionToken,
		expiresAt: role.expiration,
	};
}

async function loadSsoCachedToken(
	startUrl: string,
	sessionName: string | undefined,
): Promise<SsoCachedToken | undefined> {
	const home = process.platform === "win32" ? $env.USERPROFILE || os.homedir() : $env.HOME || os.homedir();
	const cacheDir = path.join(home, ".aws", "sso", "cache");
	let entries: string[];
	try {
		entries = await fs.promises.readdir(cacheDir);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	// Prefer the deterministic hash for legacy `sso_start_url` profiles or the
	// session name for the newer `sso-session` shape; otherwise scan.
	const candidates: string[] = [];
	const hash = await sha1Hex(sessionName || startUrl);
	candidates.push(`${hash}.json`);
	for (const entry of entries) {
		if (entry.endsWith(".json") && !candidates.includes(entry)) candidates.push(entry);
	}
	for (const file of candidates) {
		if (!entries.includes(file)) continue;
		try {
			const text = await fs.promises.readFile(path.join(cacheDir, file), "utf8");
			const parsed = JSON.parse(text) as SsoCachedToken;
			if (parsed.startUrl === startUrl || (sessionName && file === `${hash}.json`)) {
				return parsed;
			}
		} catch (err) {
			logger.debug("aws-credentials: failed to read SSO cache", { file, err: String(err) });
		}
	}
	return undefined;
}

async function sha1Hex(input: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
	const bytes = new Uint8Array(digest);
	let out = "";
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
	return out;
}

// ---------- credential_process ----------

/** JSON envelope emitted by an external credential process. Matches the
 * AWS CLI / SDK contract documented at
 * https://docs.aws.amazon.com/sdkref/latest/guide/feature-process-credentials.html */
interface CredentialProcessEnvelope {
	Version?: number;
	AccessKeyId?: string;
	SecretAccessKey?: string;
	SessionToken?: string;
	Expiration?: string;
}

async function readCredentialProcess(
	profile: string,
	command: string,
	allowAmbientCredentials: boolean,
	signal: AbortSignal | undefined,
): Promise<ResolvedCredentials> {
	return runCredentialCommand(
		profile,
		buildCredentialProcessArgv(profile, command),
		allowAmbientCredentials,
		signal,
		"AWS credential_process",
		"credential-process",
	);
}

async function runCredentialCommand(
	profile: string,
	argv: string[],
	allowAmbientCredentials: boolean,
	signal: AbortSignal | undefined,
	source: string,
	kind: AIError.AwsCredentialsErrorKind,
): Promise<ResolvedCredentials> {
	const environment = allowAmbientCredentials ? undefined : { ...Bun.env };
	if (environment) {
		for (const key of MANAGED_MODEL_CHILD_CLEARED_ENV_VARS) delete environment[key];
	}
	const child = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		windowsHide: true,
		signal,
		...(environment ? { env: environment } : {}),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) {
		const tail = stderr.trim().slice(-512) || stdout.trim().slice(-512) || "(no output)";
		throw new AIError.AwsCredentialsError(`${source} for profile '${profile}' exited ${exitCode}: ${tail}`, kind);
	}

	let parsed: CredentialProcessEnvelope;
	try {
		parsed = JSON.parse(stdout) as CredentialProcessEnvelope;
	} catch (err) {
		throw new AIError.AwsCredentialsError(
			`${source} for profile '${profile}' did not emit valid JSON: ${String(err)}`,
			kind,
			{ cause: err },
		);
	}
	if (parsed.Version !== 1) {
		throw new AIError.AwsCredentialsError(
			`${source} for profile '${profile}' returned unsupported Version ${parsed.Version ?? "<missing>"}; expected 1.`,
			kind,
		);
	}
	if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
		throw new AIError.AwsCredentialsError(
			`${source} for profile '${profile}' returned envelope without AccessKeyId/SecretAccessKey.`,
			kind,
		);
	}

	const out: ResolvedCredentials = {
		accessKeyId: parsed.AccessKeyId,
		secretAccessKey: parsed.SecretAccessKey,
	};
	if (parsed.SessionToken) out.sessionToken = parsed.SessionToken;
	if (parsed.Expiration) {
		const exp = Date.parse(parsed.Expiration);
		if (!Number.isNaN(exp)) out.expiresAt = exp;
	}
	return out;
}

/** Resolve the argv for `Bun.spawn`. On Windows we route `.cmd`/`.bat` helpers
 * through `cmd.exe /c` because direct execution refuses batch files (mirrors
 * Node's `execFile` policy and avoids surprise no-ops). */
function buildCredentialProcessArgv(profile: string, command: string): string[] {
	const tokens = tokenizeCredentialProcessCommand(command);
	if (tokens.length === 0) {
		throw new AIError.AwsCredentialsError(
			`AWS credential_process for profile '${profile}' is empty.`,
			"credential-process",
		);
	}
	if (process.platform === "win32" && isBatchScript(tokens[0])) {
		return ["cmd.exe", "/d", "/s", "/c", command];
	}
	return tokens;
}

function isBatchScript(executable: string): boolean {
	const lower = executable.toLowerCase();
	return lower.endsWith(".cmd") || lower.endsWith(".bat");
}

/** POSIX-shell-style tokenizer used by the AWS CLI for `credential_process`.
 *
 * Outside quotes a backslash escapes the next character. Inside single quotes
 * everything is literal (no escapes, cannot contain `'`). Inside double quotes
 * a backslash only escapes `$`, `` ` ``, `"`, and `\` — every other backslash
 * is preserved verbatim, which is what makes Windows paths like
 * `"C:\Program Files\tool\auth.exe"` survive tokenization. */
export function tokenizeCredentialProcessCommand(cmd: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let hasToken = false;
	let mode: "normal" | "single" | "double" = "normal";
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (mode === "normal") {
			if (ch === "'") {
				mode = "single";
				hasToken = true;
				continue;
			}
			if (ch === '"') {
				mode = "double";
				hasToken = true;
				continue;
			}
			if (ch === "\\" && i + 1 < cmd.length) {
				current += cmd[++i];
				hasToken = true;
				continue;
			}
			if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
				if (hasToken) {
					tokens.push(current);
					current = "";
					hasToken = false;
				}
				continue;
			}
			current += ch;
			hasToken = true;
			continue;
		}
		if (mode === "single") {
			if (ch === "'") {
				mode = "normal";
				continue;
			}
			current += ch;
			continue;
		}
		// double-quote
		if (ch === '"') {
			mode = "normal";
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) {
			const next = cmd[i + 1];
			if (next === "$" || next === "`" || next === '"' || next === "\\") {
				current += next;
				i++;
				continue;
			}
			// Preserve literal backslash for Windows paths.
			current += ch;
			continue;
		}
		current += ch;
	}
	if (mode !== "normal") {
		throw new AIError.AwsCredentialsError(
			"AWS credential_process command has an unterminated quote.",
			"credential-process",
		);
	}
	if (hasToken) tokens.push(current);
	return tokens;
}

// ---------- IMDSv2 ----------

const IMDS_HOST = "169.254.169.254";
const IMDS_TIMEOUT_MS = 1000;

async function readImdsCredentials(
	parentSignal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	const timeout = AbortSignal.timeout(IMDS_TIMEOUT_MS);
	const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
	try {
		const tokenRes = await fetchImpl(`http://${IMDS_HOST}/latest/api/token`, {
			method: "PUT",
			headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
			signal,
		});
		if (!tokenRes.ok) return undefined;
		const token = await tokenRes.text();

		const roleRes = await fetchImpl(`http://${IMDS_HOST}/latest/meta-data/iam/security-credentials/`, {
			headers: { "x-aws-ec2-metadata-token": token },
			signal,
		});
		if (!roleRes.ok) return undefined;
		const role = (await roleRes.text()).trim();
		if (!role) return undefined;

		const credsRes = await fetchImpl(
			`http://${IMDS_HOST}/latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`,
			{
				headers: { "x-aws-ec2-metadata-token": token },
				signal,
			},
		);
		if (!credsRes.ok) return undefined;
		const body = (await credsRes.json()) as {
			AccessKeyId?: string;
			SecretAccessKey?: string;
			Token?: string;
			Expiration?: string;
		};
		if (!body.AccessKeyId || !body.SecretAccessKey) return undefined;
		const out: ResolvedCredentials = {
			accessKeyId: body.AccessKeyId,
			secretAccessKey: body.SecretAccessKey,
		};
		if (body.Token) out.sessionToken = body.Token;
		if (body.Expiration) out.expiresAt = Date.parse(body.Expiration);
		return out;
	} catch {
		return undefined;
	}
}

/** Test/diagnostic helper — drops cached credentials and recovery back-off state. */
export function clearAwsCredentialCache(): void {
	cache.clear();
	recoveryCooldown.clear();
}

/**
 * Drop the cache entry for one profile/region. Called by the Bedrock provider on
 * 401/403 responses so stale credentials are re-resolved instead of served until restart.
 */
export function invalidateAwsCredentialCache(opts: { profile?: string; region?: string } = {}): void {
	const allowAmbientCredentials = allowAmbientAwsModelCredentials();
	const profile = opts.profile || resolveAwsModelProfile() || "default";
	const region = opts.region || resolveAwsModelRegion() || "us-east-1";
	cache.delete(`${profile}\x00${region}\x00${allowAmbientCredentials ? "ambient" : "managed"}`);
}
