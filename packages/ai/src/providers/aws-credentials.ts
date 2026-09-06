/**
 * AWS credential resolution for the Bedrock provider.
 *
 * Chain (first hit wins):
 *  1. Static credentials from the environment outside managed model auth
 *     (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` [+ `AWS_SESSION_TOKEN`]).
 *  2. Web identity (`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`) outside managed model auth.
 *  3. Profile in `~/.aws/credentials` and `~/.aws/config`:
 *      - static keys, SSO (including AWS CLI token refresh), `credential_process`, or
 *        `role_arn` role chaining (`source_profile`, `web_identity_token_file`, `credential_source`).
 *  4. ECS/container credentials from `AWS_CONTAINER_CREDENTIALS_*` outside managed model auth.
 *  5. EC2 IMDSv2 when metadata is enabled outside managed model auth.
 *
 * Resolved credentials are cached process-wide per profile and refreshed
 * 60 s before `Expiration` to absorb clock skew.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { allowAmbientAwsModelCredentials } from "../aws-model-auth";
import * as AIError from "../error";
import type { FetchImpl } from "../types";
import { raceWithSignal } from "../utils/abort";
import {
	type AwsIniFile,
	parseAwsIni,
	resolveAwsProfile,
	resolveAwsRegion,
	shouldLoadAwsSharedConfig,
} from "../utils/aws-profile";
import { isLocalOrMetadataHost } from "../utils/proxy";
import { type AwsCredentials, signRequest } from "./aws-sigv4";

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

function requireDynamicCredentialExpiration(
	value: string | undefined,
	source: string,
	kind: AIError.AwsCredentialsErrorKind,
): number {
	const expiresAt = value ? Date.parse(value) : Number.NaN;
	if (Number.isFinite(expiresAt)) return expiresAt;
	throw new AIError.AwsCredentialsError(`${source} response has a missing or invalid Expiration.`, kind);
}

/** Credential-process expiry is optional; missing/malformed values disable caching. */
function dynamicCredentialExpiration(value: string | undefined): number {
	if (!value) return Date.now();
	const expiresAt = Date.parse(value);
	return Number.isFinite(expiresAt) ? expiresAt : Date.now();
}

interface CacheEntry {
	creds: ResolvedCredentials;
	expiresAt: number;
}

const cache: Map<string, CacheEntry> = new Map();
const inflight: Map<string, Promise<ResolvedCredentials>> = new Map();

function credentialCacheKey(profile: string, region: string, loadSharedConfig: boolean): string {
	return `${profile}\x00${region}\x00${loadSharedConfig ? "config" : "credentials"}`;
}

export async function resolveAwsCredentials(opts: CredentialResolveOptions = {}): Promise<ResolvedCredentials> {
	const allowAmbientCredentials = allowAmbientAwsModelCredentials();
	const profile = resolveAwsProfile(opts.profile);
	const region = resolveAwsRegion(opts.region, opts.profile);
	const loadSharedConfig = shouldLoadAwsSharedConfig(opts.profile);
	const cacheKey = `${credentialCacheKey(profile, region, loadSharedConfig)}\x00${allowAmbientCredentials ? "ambient" : "managed"}`;

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
			const creds = await resolveFreshWithRecovery(
				profile,
				region,
				cacheKey,
				allowAmbientCredentials,
				loadSharedConfig,
				fetchImpl,
			);
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
	loadSharedConfig: boolean,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials> {
	try {
		const creds = await resolveFresh(
			profile,
			region,
			allowAmbientCredentials,
			loadSharedConfig,
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
				loadSharedConfig,
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
	loadSharedConfig: boolean,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = globalThis.fetch as FetchImpl,
): Promise<ResolvedCredentials> {
	// Standard AWS environment credentials belong to operational tools when
	// managed model authentication is active.
	if (allowAmbientCredentials) {
		const envCreds = readEnvCredentials();
		if (envCreds) return envCreds;
	}

	// 2. Web identity is an ambient operational source.
	if (allowAmbientCredentials) {
		const webIdentityCreds = await readWebIdentityCredentials(region, signal, fetchImpl);
		if (webIdentityCreds) return webIdentityCreds;
	}

	// 3. Profile (static, SSO, or credential_process).
	const profileCreds = await readProfileCredentials(
		profile,
		region,
		allowAmbientCredentials,
		loadSharedConfig,
		signal,
		fetchImpl,
	);
	if (profileCreds) return profileCreds;

	// 4. ECS/container credentials are ambient operational sources.
	if (allowAmbientCredentials) {
		const containerCreds = await readContainerCredentials(signal, fetchImpl);
		if (containerCreds) return containerCreds;
	}

	// 5. EC2 task/instance identity is another ambient operational source.
	if (allowAmbientCredentials && $env.AWS_EC2_METADATA_DISABLED?.toLowerCase() !== "true") {
		const imdsCreds = await readImdsCredentials(signal, fetchImpl);
		if (imdsCreds) return imdsCreds;
	}

	throw new AIError.AwsCredentialsError(
		allowAmbientCredentials
			? `Unable to resolve AWS credentials. Configure static environment keys, web identity, profile '${profile}', ECS credentials, or an EC2 instance role.`
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

async function readIniFile(p: string): Promise<AwsIniFile | undefined> {
	try {
		const text = await fs.promises.readFile(p, "utf8");
		return parseAwsIni(text);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

// ---------- Profile / SSO / role chaining ----------

/** Shared-config view and resolution context threaded through role-chain recursion. */
interface ProfileResolveContext {
	credentialsIni: AwsIniFile | undefined;
	configIni: AwsIniFile | undefined;
	allowAmbientCredentials: boolean;
	region: string;
	signal: AbortSignal | undefined;
	fetchImpl: FetchImpl;
}

async function readProfileCredentials(
	profile: string,
	region: string,
	allowAmbientCredentials: boolean,
	loadSharedConfig: boolean,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	const home = process.platform === "win32" ? $env.USERPROFILE || os.homedir() : $env.HOME || os.homedir();
	const defaultCredentialsPath = path.join(home, ".aws", "credentials");
	const defaultConfigPath = path.join(home, ".aws", "config");
	const credentialsPath = (allowAmbientCredentials && $env.AWS_SHARED_CREDENTIALS_FILE) || defaultCredentialsPath;
	const configPath = (allowAmbientCredentials && $env.AWS_CONFIG_FILE) || defaultConfigPath;

	const credentialsIni = await readIniFile(credentialsPath);
	const configIni = loadSharedConfig ? await readIniFile(configPath) : undefined;

	return resolveProfileChain(
		profile,
		{ credentialsIni, configIni, region, allowAmbientCredentials, signal, fetchImpl },
		new Set(),
	);
}

/**
 * Resolve one profile, following `role_arn` chains. A `role_arn` profile derives
 * base credentials from `source_profile` (recursive), `web_identity_token_file`,
 * or `credential_source`, then exchanges them via STS. Non-role profiles resolve
 * directly from static keys, SSO, or `credential_process`. `seen` guards against
 * `source_profile` cycles.
 */
async function resolveProfileChain(
	profile: string,
	ctx: ProfileResolveContext,
	seen: Set<string>,
): Promise<ResolvedCredentials | undefined> {
	if (seen.has(profile)) {
		throw new AIError.AwsCredentialsError(`AWS profile role chain contains a cycle at '${profile}'.`, "profile");
	}
	seen.add(profile);

	// Static credentials live in ~/.aws/credentials; SSO/role config lives in
	// ~/.aws/config under `[profile foo]`. Merge into a single view.
	const merged: Record<string, string> = {
		...(ctx.configIni?.[profile] ?? {}),
		...(ctx.credentialsIni?.[profile] ?? {}),
	};
	if (Object.keys(merged).length === 0) return undefined;

	if (merged.role_arn) return assumeRoleFromProfile(profile, merged, ctx, seen);

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
			const refreshed = await readSsoCredentialsViaAwsCli(profile, ctx.allowAmbientCredentials, ctx.signal);
			if (refreshed) return refreshed;
		}
		return readSsoCredentials(merged, ctx.configIni, ctx.region, ctx.signal, ctx.fetchImpl);
	}

	if (merged.credential_process) {
		return readCredentialProcess(profile, merged.credential_process, ctx.allowAmbientCredentials, ctx.signal);
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

/**
 * Resolve base credentials for a `role_arn` profile and exchange them for the
 * target role. `web_identity_token_file` is a self-contained
 * AssumeRoleWithWebIdentity; otherwise the base comes from `source_profile`
 * (recursive) or `credential_source`, followed by an STS `AssumeRole`.
 */
async function assumeRoleFromProfile(
	profile: string,
	merged: Record<string, string>,
	ctx: ProfileResolveContext,
	seen: Set<string>,
): Promise<ResolvedCredentials> {
	const roleArn = merged.role_arn;
	const region = ctx.region;

	if (merged.web_identity_token_file) {
		return assumeRoleWithWebIdentity(
			{ roleArn, tokenFile: merged.web_identity_token_file, sessionName: merged.role_session_name },
			region,
			ctx.signal,
			ctx.fetchImpl,
		);
	}

	if (merged.mfa_serial) {
		throw new AIError.AwsCredentialsError(
			`AWS profile '${profile}' requires MFA (mfa_serial), which is not supported for non-interactive credential resolution.`,
			"profile",
		);
	}

	let base: ResolvedCredentials | undefined;
	if (merged.source_profile) {
		base = await resolveProfileChain(merged.source_profile, ctx, seen);
		if (!base) {
			throw new AIError.AwsCredentialsError(
				`AWS profile '${profile}' references source_profile '${merged.source_profile}', which has no usable credentials.`,
				"profile",
			);
		}
	} else if (merged.credential_source) {
		if (!ctx.allowAmbientCredentials) {
			throw new AIError.AwsCredentialsError(
				`AWS profile '${profile}' uses credential_source '${merged.credential_source}', which is unavailable under managed model authentication.`,
				"profile",
			);
		}
		base = await resolveCredentialSource(merged.credential_source, region, ctx.signal, ctx.fetchImpl);
		if (!base) {
			throw new AIError.AwsCredentialsError(
				`AWS profile '${profile}' credential_source '${merged.credential_source}' produced no credentials.`,
				"profile",
			);
		}
	} else {
		throw new AIError.AwsCredentialsError(
			`AWS profile '${profile}' sets role_arn without source_profile, credential_source, or web_identity_token_file.`,
			"profile",
		);
	}

	return stsAssumeRole(
		base,
		roleArn,
		region,
		{
			sessionName: merged.role_session_name,
			durationSeconds: merged.duration_seconds,
			externalId: merged.external_id,
		},
		ctx.signal,
		ctx.fetchImpl,
	);
}

/** Resolve the base credentials named by a profile `credential_source` directive. */
async function resolveCredentialSource(
	source: string,
	_region: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	switch (source) {
		case "Environment":
			return readEnvCredentials();
		case "Ec2InstanceMetadata":
			return $env.AWS_EC2_METADATA_DISABLED?.toLowerCase() === "true"
				? undefined
				: readImdsCredentials(signal, fetchImpl);
		case "EcsContainer":
			return readContainerCredentials(signal, fetchImpl);
		default:
			throw new AIError.AwsCredentialsError(`Unsupported AWS credential_source '${source}'.`, "profile");
	}
}

/**
 * Exchange base credentials for a target role via STS `AssumeRole`. The request
 * is SigV4-signed with the base credentials.
 */
async function stsAssumeRole(
	base: ResolvedCredentials,
	roleArn: string,
	region: string,
	opts: { sessionName?: string; durationSeconds?: string; externalId?: string },
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials> {
	const body = new URLSearchParams({
		Action: "AssumeRole",
		Version: "2011-06-15",
		RoleArn: roleArn,
		RoleSessionName: opts.sessionName || `omp-${process.pid}`,
	});
	if (opts.durationSeconds) body.set("DurationSeconds", opts.durationSeconds);
	if (opts.externalId) body.set("ExternalId", opts.externalId);
	const payload = new TextEncoder().encode(body.toString());
	const endpoint = new URL(stsEndpoint(region));
	const contentType = "application/x-www-form-urlencoded";
	const signed = await signRequest({
		method: "POST",
		host: endpoint.host,
		path: endpoint.pathname,
		body: payload,
		region,
		service: "sts",
		credentials: base,
		headers: { "content-type": contentType },
	});
	const response = await fetchImpl(endpoint, {
		method: "POST",
		headers: { ...signed, "content-type": contentType },
		body: payload,
		signal,
	});
	const xml = await response.text();
	if (!response.ok) {
		throw new AIError.AwsCredentialsError(
			`AWS AssumeRole failed: ${response.status} ${xmlTag(xml, "Message") ?? xml.slice(0, 200)}`,
			"assume-role",
		);
	}
	return parseStsCredentials(xml, "AWS AssumeRole", "assume-role");
}
interface SsoCachedToken {
	accessToken?: string;
	expiresAt?: string;
	startUrl?: string;
	region?: string;
}

async function readSsoCredentials(
	profileCfg: Record<string, string>,
	configIni: AwsIniFile | undefined,
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
	if (parsed.SessionToken) {
		out.sessionToken = parsed.SessionToken;
		out.expiresAt = dynamicCredentialExpiration(parsed.Expiration);
	} else if (parsed.Expiration) {
		out.expiresAt = dynamicCredentialExpiration(parsed.Expiration);
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

// ---------- Web identity ----------

function xmlTag(xml: string, tag: string): string | undefined {
	const value = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
	if (!value) return undefined;
	return value
		.replaceAll("&amp;", "&")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'");
}

function stsEndpoint(region: string): string {
	const dnsSuffix = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
	return `https://sts.${region}.${dnsSuffix}/`;
}

/** Parse `<Credentials>` from an STS AssumeRole/WithWebIdentity XML response. */
function parseStsCredentials(xml: string, source: string, kind: AIError.AwsCredentialsErrorKind): ResolvedCredentials {
	const accessKeyId = xmlTag(xml, "AccessKeyId");
	const secretAccessKey = xmlTag(xml, "SecretAccessKey");
	const sessionToken = xmlTag(xml, "SessionToken");
	if (!accessKeyId || !secretAccessKey || !sessionToken) {
		throw new AIError.AwsCredentialsError(`${source} response is missing credentials.`, kind);
	}
	const expiresAt = requireDynamicCredentialExpiration(xmlTag(xml, "Expiration"), source, kind);
	return { accessKeyId, secretAccessKey, sessionToken, expiresAt };
}

async function readWebIdentityCredentials(
	region: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	const tokenFile = $env.AWS_WEB_IDENTITY_TOKEN_FILE;
	const roleArn = $env.AWS_ROLE_ARN;
	if (!tokenFile || !roleArn) return undefined;
	return assumeRoleWithWebIdentity(
		{ roleArn, tokenFile, sessionName: $env.AWS_ROLE_SESSION_NAME },
		region,
		signal,
		fetchImpl,
	);
}

/**
 * Exchange a web-identity token file for role credentials via STS
 * `AssumeRoleWithWebIdentity`. Used by the env chain (`AWS_WEB_IDENTITY_TOKEN_FILE`)
 * and by `role_arn` + `web_identity_token_file` profiles.
 */
async function assumeRoleWithWebIdentity(
	params: { roleArn: string; tokenFile: string; sessionName?: string },
	region: string,
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials> {
	let token: string;
	try {
		token = (await Bun.file(params.tokenFile).text()).trim();
	} catch (err) {
		throw new AIError.AwsCredentialsError(
			`Unable to read AWS web identity token file: ${String(err)}`,
			"web-identity",
			{
				cause: err,
			},
		);
	}
	if (!token) {
		throw new AIError.AwsCredentialsError("AWS web identity token file is empty.", "web-identity");
	}
	const body = new URLSearchParams({
		Action: "AssumeRoleWithWebIdentity",
		Version: "2011-06-15",
		RoleArn: params.roleArn,
		RoleSessionName: params.sessionName || `omp-${process.pid}`,
		WebIdentityToken: token,
	});
	const response = await fetchImpl(stsEndpoint(region), {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: body.toString(),
		signal,
	});
	const xml = await response.text();
	if (!response.ok) {
		throw new AIError.AwsCredentialsError(
			`AWS AssumeRoleWithWebIdentity failed: ${response.status} ${xmlTag(xml, "Message") ?? xml.slice(0, 200)}`,
			"web-identity",
		);
	}
	return parseStsCredentials(xml, "AWS web identity", "web-identity");
}

// ---------- ECS/container credentials ----------

interface ContainerCredentialResponse {
	AccessKeyId?: string;
	SecretAccessKey?: string;
	Token?: string;
	Expiration?: string;
}

const ECS_TASK_CREDENTIALS_BASE_URL = new URL("http://169.254.170.2/");

async function readContainerCredentials(
	signal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	const relativeUri = $env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
	const fullUri = $env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	if (!relativeUri && !fullUri) return undefined;
	let endpoint: URL;
	if (relativeUri) {
		if (!relativeUri.startsWith("/") || relativeUri.startsWith("//")) {
			throw new AIError.AwsCredentialsError(
				"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI must be a single-host absolute path.",
				"container",
			);
		}
		endpoint = new URL(relativeUri.slice(1), ECS_TASK_CREDENTIALS_BASE_URL);
	} else {
		try {
			endpoint = new URL(fullUri as string);
		} catch (err) {
			throw new AIError.AwsCredentialsError(
				`AWS_CONTAINER_CREDENTIALS_FULL_URI is invalid: ${String(err)}`,
				"container",
				{ cause: err },
			);
		}
		if (endpoint.protocol !== "https:" && !isLocalOrMetadataHost(endpoint.hostname)) {
			throw new AIError.AwsCredentialsError(
				"AWS_CONTAINER_CREDENTIALS_FULL_URI must use HTTPS or a local metadata host.",
				"container",
			);
		}
	}
	let authorization = $env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
	const authorizationTokenFile = $env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE;
	if (!authorization && authorizationTokenFile) {
		try {
			authorization = (await Bun.file(authorizationTokenFile).text()).trim();
		} catch (err) {
			throw new AIError.AwsCredentialsError(
				`Unable to read AWS container authorization token file: ${String(err)}`,
				"container",
				{ cause: err },
			);
		}
	}
	const response = await fetchImpl(endpoint, {
		headers: authorization ? { authorization } : undefined,
		signal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new AIError.AwsCredentialsError(
			`AWS container credential endpoint failed: ${response.status} ${body.slice(0, 200)}`,
			"container",
		);
	}
	const body = (await response.json()) as ContainerCredentialResponse;
	if (!body.AccessKeyId || !body.SecretAccessKey || !body.Token) {
		throw new AIError.AwsCredentialsError(
			"AWS container credential response is missing AccessKeyId/SecretAccessKey/Token.",
			"container",
		);
	}
	return {
		accessKeyId: body.AccessKeyId,
		secretAccessKey: body.SecretAccessKey,
		sessionToken: body.Token,
		expiresAt: requireDynamicCredentialExpiration(body.Expiration, "AWS container credential", "container"),
	};
}

// ---------- IMDSv2 ----------

const IMDS_IPV4_BASE_URL = "http://169.254.169.254/";
const IMDS_IPV6_BASE_URL = "http://[fd00:ec2::254]/";
const IMDS_TIMEOUT_MS = 1000;

function imdsRequestSignal(parentSignal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(IMDS_TIMEOUT_MS);
	return parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
}

function imdsBaseUrl(): URL {
	const mode = $env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE?.toLowerCase();
	const fallback = mode === "ipv6" ? IMDS_IPV6_BASE_URL : IMDS_IPV4_BASE_URL;
	const endpoint = new URL($env.AWS_EC2_METADATA_SERVICE_ENDPOINT || fallback);
	if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
	return endpoint;
}

async function readImdsCredentials(
	parentSignal: AbortSignal | undefined,
	fetchImpl: FetchImpl,
): Promise<ResolvedCredentials | undefined> {
	try {
		const endpoint = imdsBaseUrl();
		const tokenRes = await fetchImpl(new URL("latest/api/token", endpoint), {
			method: "PUT",
			headers: { "x-aws-ec2-metadata-token-ttl-seconds": "21600" },
			signal: imdsRequestSignal(parentSignal),
		});
		if (!tokenRes.ok) return undefined;
		const token = await tokenRes.text();

		const roleRes = await fetchImpl(new URL("latest/meta-data/iam/security-credentials/", endpoint), {
			headers: { "x-aws-ec2-metadata-token": token },
			signal: imdsRequestSignal(parentSignal),
		});
		if (!roleRes.ok) return undefined;
		const role = (await roleRes.text()).trim();
		if (!role) return undefined;

		const credsRes = await fetchImpl(
			new URL(`latest/meta-data/iam/security-credentials/${encodeURIComponent(role)}`, endpoint),
			{
				headers: { "x-aws-ec2-metadata-token": token },
				signal: imdsRequestSignal(parentSignal),
			},
		);
		if (!credsRes.ok) return undefined;
		const body = (await credsRes.json()) as {
			AccessKeyId?: string;
			SecretAccessKey?: string;
			Token?: string;
			Expiration?: string;
		};
		if (!body.AccessKeyId || !body.SecretAccessKey || !body.Token || !body.Expiration) return undefined;
		const expiresAt = Date.parse(body.Expiration);
		if (!Number.isFinite(expiresAt)) return undefined;
		return {
			accessKeyId: body.AccessKeyId,
			secretAccessKey: body.SecretAccessKey,
			sessionToken: body.Token,
			expiresAt,
		};
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
	const profile = resolveAwsProfile(opts.profile);
	const region = resolveAwsRegion(opts.region, opts.profile);
	const loadSharedConfig = shouldLoadAwsSharedConfig(opts.profile);
	cache.delete(
		`${credentialCacheKey(profile, region, loadSharedConfig)}\x00${allowAmbientCredentials ? "ambient" : "managed"}`,
	);
}
