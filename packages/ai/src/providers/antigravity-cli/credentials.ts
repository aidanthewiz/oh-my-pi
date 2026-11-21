/**
 * agy 1.5.9's native consumer credential format (cli/backend/auth token storage).
 * Only host-owned --gemini-dir directories are read/written here. The encrypted
 * omp credential store remains the durable owner of exported OAuth grants.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireFileLock, isEnoent, isFileLockHeld, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils";
import { REMOTE_REFRESH_SENTINEL } from "../../auth/types";
import * as AIError from "../../error";
import type { OAuthCredentials } from "../../registry/oauth/types";
import type { FetchImpl } from "../../types";
import { agyGeminiDir } from "./binary";

const PROVIDER = "antigravity-cli";
// ACP stores credentials under app-data-dir, whose default is the
// antigravity-cli subdirectory of --gemini-dir (not directly in gemini-dir).
const TOKEN_FILE = path.join("antigravity-cli", "antigravity-oauth-token");
const OWNER_PREFIX = ".credential-owner-";
const OWNER_NAME = /^\.credential-owner-[0-9a-f-]{36}$/;
const TEMPORARY_TOKEN_NAME = /^antigravity-oauth-token\.[0-9a-f-]{36}\.tmp$/;
const REQUEST_TIMEOUT_MS = 30_000;
const EXPIRY_SKEW_MS = 60_000;
// These public installed-application credentials match agy's getOauthParams
// consumer branch, not Gemini CLI's different OAuth client.
export const AGY_OAUTH_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = Buffer.from("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=", "base64").toString();

function invalid(message: string): AIError.OAuthError {
	return new AIError.OAuthError(message, { kind: "validation", provider: PROVIDER });
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function json(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw invalid("Antigravity CLI credential data is not valid JSON; sign in again");
	}
}

/** ID-token claims are identity metadata only; never used to authenticate requests. */
function identity(idToken: unknown): Pick<OAuthCredentials, "email" | "accountId"> {
	if (typeof idToken !== "string") return {};
	try {
		const part = idToken.split(".")[1];
		if (!part) return {};
		const claims = record(JSON.parse(Buffer.from(part, "base64url").toString()));
		return {
			email: nonempty(claims?.email) ? claims.email : undefined,
			accountId: nonempty(claims?.sub) ? claims.sub : undefined,
		};
	} catch {
		return {};
	}
}

/** Parse the native consumer grant, not Gemini CLI's oauth_creds.json. */
export function parseAgyStoredCredentials(value: unknown): OAuthCredentials {
	const stored = record(value);
	const token = record(stored?.token);
	if (stored?.auth_method !== "consumer") {
		throw invalid("Antigravity CLI requires a consumer OAuth login; sign in with Google again");
	}
	const expires = typeof token?.expiry === "string" ? Date.parse(token.expiry) : Number.NaN;
	if (!nonempty(token?.access_token) || !Number.isFinite(expires) || expires <= 0) {
		throw invalid("Antigravity CLI did not export a valid access token and expiry; sign in again");
	}
	if (!nonempty(token?.refresh_token) || token.refresh_token === REMOTE_REFRESH_SENTINEL) {
		throw invalid("Antigravity CLI did not export a refreshable grant; sign in again");
	}
	const claims = identity(stored.id_token);
	return {
		access: token.access_token,
		refresh: token.refresh_token,
		expires,
		email: claims.email ?? (nonempty(stored.id_token_email) ? stored.id_token_email : undefined),
		accountId: claims.accountId,
	};
}

/** Read only the isolated directory supplied to the successful login process. */
export async function exportAgyCredentials(geminiDir: string): Promise<OAuthCredentials> {
	let contents: string;
	try {
		const file = path.join(geminiDir, TOKEN_FILE);
		if ((await fs.stat(file)).size > 1024 * 1024) throw new Error();
		contents = await fs.readFile(file, "utf8");
	} catch {
		throw invalid("Antigravity CLI did not write its isolated credential file; sign in again");
	}
	return parseAgyStoredCredentials(json(contents));
}

/** Decode the existing registry's api-key-format "structured" envelope. */
export function parseAgyApiKey(apiKey: string): OAuthCredentials {
	const value = record(json(apiKey));
	if (
		!nonempty(value?.token) ||
		!nonempty(value?.refreshToken) ||
		typeof value?.expiresAt !== "number" ||
		!Number.isFinite(value.expiresAt) ||
		value.expiresAt <= 0 ||
		value.expiresAt > 8.64e15
	) {
		throw invalid("Antigravity CLI requires exported OAuth credentials; use /login antigravity-cli");
	}
	return {
		access: value.token,
		refresh: value.refreshToken,
		expires: value.expiresAt,
		email: nonempty(value.email) ? value.email : undefined,
		accountId: nonempty(value.accountId) ? value.accountId : undefined,
	};
}

/** Stable account namespace: token rotation never changes conversation ownership. */
export function agyCredentialKey(value: string | Pick<OAuthCredentials, "email" | "accountId">): string {
	const credentials = typeof value === "string" ? parseAgyApiKey(value) : value;
	// Native ACP login retains id_token_email, often without a subject. Prefer
	// that identity so a later refresh adding an ID token cannot move accounts.
	const account = credentials.email
		? `email:${credentials.email.trim().toLowerCase()}`
		: credentials.accountId
			? `sub:${credentials.accountId}`
			: undefined;
	if (!account) throw invalid("Antigravity CLI credentials have no account identity; sign in again");
	return createHash("sha256").update(account).digest("hex");
}

/** Non-secret revision for restarting a host whose cached token source is stale. */
export function agyCredentialVersion(apiKey: string): string {
	const credentials = parseAgyApiKey(apiKey);
	return createHash("sha256")
		.update(JSON.stringify([credentials.access, credentials.refresh, credentials.expires]))
		.digest("hex");
}

/**
 * Apply ONLY to agy's subprocess, never omp or host-executed tools.
 * agy has no file-storage flag. Its native sshDetector checks SSH_TTY for a
 * nonempty value (it does not open the path), selecting file-only storage for
 * the process lifetime. This explicit headless marker prevents both reads and
 * writes of the user's global keychain, including during login and refresh.
 */
export function agyCredentialEnv(): Record<string, string> {
	return { SSH_TTY: "omp-agy-file-auth" };
}

/**
 * Stage one transport generation's grant and retain its account-private file.
 * Release only after startup fails without a child or the child actually exits.
 * Broker refresh sentinels are never sent to Google.
 */
export async function stageAgyCredentials(apiKey: string, geminiDir: string): Promise<() => Promise<void>> {
	const staged = await stageAgyCredentialsWithOwnership(apiKey, geminiDir);
	if ("error" in staged) throw staged.error;
	return staged.release;
}

/** Internal startup result: error types do not establish whether resources were released. */
export async function stageAgyCredentialsWithOwnership(
	apiKey: string,
	geminiDir: string,
): Promise<{ release: () => Promise<void> } | { error: unknown; drained: boolean }> {
	const state = { drained: true };
	try {
		return { release: await stageCredentials(apiKey, geminiDir, state) };
	} catch (error) {
		return { error, drained: state.drained };
	}
}

async function stageCredentials(
	apiKey: string,
	geminiDir: string,
	state: { drained: boolean },
): Promise<() => Promise<void>> {
	const credentials = parseAgyApiKey(apiKey);
	agyCredentialKey(apiKey);
	if (credentials.expires <= Date.now()) throw invalid("Antigravity CLI credentials must be refreshed before use");
	const token = {
		access_token: credentials.access,
		token_type: "Bearer",
		refresh_token: credentials.refresh === REMOTE_REFRESH_SENTINEL ? undefined : credentials.refresh,
		expiry: new Date(credentials.expires).toISOString(),
	};
	const file = path.join(geminiDir, TOKEN_FILE);
	const directory = path.dirname(file);
	const owner = path.join(directory, `${OWNER_PREFIX}${randomUUID()}`);
	const temporary = `${file}.${randomUUID()}.tmp`;
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const lock = await acquireFileLock(credentialLock(geminiDir));
	state.drained = false;
	let ownerReleased = true;
	try {
		try {
			await fs.stat(path.join(geminiDir, ".credentials-removed"));
			throw invalid("Antigravity CLI account was removed; sign in again before use");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await fs.chmod(geminiDir, 0o700);
		await fs.chmod(directory, 0o700);
		ownerReleased = false;
		await fs.writeFile(owner, "", { mode: 0o600, flag: "wx" });
		const lease = tryAcquireFileLock(owner);
		if (!lease) {
			await fs.rm(owner, { force: true });
			ownerReleased = true;
			throw invalid("Could not retain the isolated Antigravity CLI account credentials");
		}
		let released: Promise<void> | undefined;
		const release = () =>
			(released ??= withFileLock(credentialLock(geminiDir), async () => {
				lease.release();
				await removeCredentialOwner(owner);
				await removeUnownedCredentials(geminiDir);
			}));
		try {
			await fs.writeFile(
				temporary,
				JSON.stringify({ token, auth_method: "consumer", id_token_email: credentials.email }),
				{ mode: 0o600, flag: "wx" },
			);
			await fs.rename(temporary, file);
			// Check only local bytes; never send an identity-probing inference request.
			const staged = record(json(await fs.readFile(file, "utf8")));
			const stagedToken = record(staged?.token);
			if (
				staged?.auth_method !== "consumer" ||
				stagedToken?.access_token !== token.access_token ||
				stagedToken.refresh_token !== token.refresh_token ||
				stagedToken.expiry !== token.expiry ||
				staged.id_token_email !== credentials.email
			) {
				throw new Error();
			}
			return release;
		} catch (error) {
			lease.release();
			await fs.rm(temporary, { force: true });
			await removeCredentialOwner(owner);
			await removeUnownedCredentials(geminiDir);
			ownerReleased = true;
			throw error;
		}
	} finally {
		lock.release();
		state.drained = ownerReleased;
	}
}

/** Logout completes only after this exact account has no active transport owner. */
export async function removeAgyCredentials(
	credentials: Pick<OAuthCredentials, "email" | "accountId">,
): Promise<(() => void) | undefined> {
	if (!credentials.email && !credentials.accountId) return undefined;
	const geminiDir = path.join(agyGeminiDir(), agyCredentialKey(credentials));
	await fs.mkdir(geminiDir, { recursive: true, mode: 0o700 });
	const lock = await acquireFileLock(credentialLock(geminiDir));
	const removedFile = path.join(geminiDir, ".credentials-removed");
	try {
		if (!(await removeUnownedCredentials(geminiDir))) {
			throw invalid("Antigravity CLI account is still running in another runtime; close it before logging out");
		}
		await fs.writeFile(removedFile, "", { mode: 0o600 });
		return () => lock.release();
	} catch (error) {
		lock.release();
		throw error;
	}
}

/** Only a completed explicit login can reopen a removed account's staging admission. */
export async function readmitAgyCredentials(
	credentials: Pick<OAuthCredentials, "email" | "accountId">,
	isCurrent: () => boolean,
): Promise<void> {
	if (!credentials.email && !credentials.accountId) {
		if (!isCurrent()) throw invalid("Antigravity CLI login is no longer the stored account; sign in again");
		return;
	}
	const directory = path.join(agyGeminiDir(), agyCredentialKey(credentials));
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	await withFileLock(credentialLock(directory), async () => {
		if (!isCurrent()) throw invalid("Antigravity CLI login is no longer the stored account; sign in again");
		await fs.rm(path.join(directory, ".credentials-removed"), { force: true });
	});
}

function credentialLock(geminiDir: string): string {
	return path.join(geminiDir, ".credential-ownership");
}

async function removeCredentialOwner(owner: string): Promise<void> {
	await fs.rm(owner, { force: true });
	await fs.rm(`${owner}.lock`, { force: true });
}

/** The account lock serializes staging, owner registration and last-owner deletion across processes. */
async function removeUnownedCredentials(geminiDir: string): Promise<boolean> {
	const directory = path.join(geminiDir, path.dirname(TOKEN_FILE));
	let names: string[];
	try {
		names = await fs.readdir(directory);
	} catch (error) {
		if (isEnoent(error)) return true;
		throw error;
	}
	for (const name of names) {
		if (!OWNER_NAME.test(name)) continue;
		const owner = path.join(directory, name);
		if (isFileLockHeld(owner)) return false;
		await removeCredentialOwner(owner);
	}
	await fs.rm(path.join(geminiDir, TOKEN_FILE), { force: true });
	await Promise.all(
		names
			.filter(name => TEMPORARY_TOKEN_NAME.test(name))
			.map(name => fs.rm(path.join(directory, name), { force: true })),
	);
	return true;
}

/** Bounded, secret-safe refresh; only known OAuth error codes reach callers. */
export async function refreshAgyCredentials(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	if (!nonempty(credentials.refresh) || credentials.refresh === REMOTE_REFRESH_SENTINEL) {
		throw invalid("Antigravity CLI refresh must be performed by the credential owner");
	}
	if (signal?.aborted) throw new AIError.LoginCancelledError("Antigravity CLI credential refresh cancelled");
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	let body: Record<string, unknown> | undefined;
	try {
		response = await fetchImpl("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: AGY_OAUTH_CLIENT_ID,
				client_secret: CLIENT_SECRET,
				grant_type: "refresh_token",
				refresh_token: credentials.refresh,
			}),
			signal: requestSignal,
		});
		try {
			body = record(await response.json());
		} catch {
			// Preserve HTTP status for revocation/rate-limit classification even
			// when a proxy or the provider sends a non-JSON failure body.
			if (response.ok) throw new Error();
		}
		if (requestSignal.aborted) throw new Error();
	} catch {
		if (signal?.aborted) throw new AIError.LoginCancelledError("Antigravity CLI credential refresh cancelled");
		throw new AIError.OAuthError(
			timeout.aborted ? "Antigravity CLI credential refresh timed out" : "Antigravity CLI credential refresh failed",
			{ kind: timeout.aborted ? "timeout" : "token-refresh", provider: PROVIDER },
		);
	}
	if (!response.ok) {
		const code = body?.error;
		// Only authentication-status responses can revoke a grant. Transient
		// proxy/rate-limit responses may carry stale OAuth-shaped error bodies.
		const safeCode =
			(response.status === 400 || response.status === 401) &&
			(code === "invalid_grant" || code === "invalid_client" || code === "unauthorized_client")
				? code
				: undefined;
		throw new AIError.OAuthError(
			`Antigravity CLI credential refresh failed: HTTP ${response.status}${safeCode ? ` ${safeCode}` : ""}`,
			{ kind: "token-refresh", provider: PROVIDER, status: response.status },
		);
	}
	if (
		!nonempty(body?.access_token) ||
		typeof body?.expires_in !== "number" ||
		!Number.isFinite(body.expires_in) ||
		body.expires_in <= 0 ||
		body.expires_in > 365 * 24 * 60 * 60 ||
		(body.refresh_token !== undefined &&
			(!nonempty(body.refresh_token) || body.refresh_token === REMOTE_REFRESH_SENTINEL))
	) {
		throw invalid("Antigravity CLI credential refresh returned an invalid token response");
	}
	const nextIdentity = identity(body.id_token);
	if (credentials.accountId && nextIdentity.accountId && credentials.accountId !== nextIdentity.accountId) {
		throw invalid("Antigravity CLI credential refresh changed account identity");
	}
	return {
		...credentials,
		access: body.access_token,
		refresh: nonempty(body.refresh_token) ? body.refresh_token : credentials.refresh,
		expires: Date.now() + body.expires_in * 1000 - Math.min(EXPIRY_SKEW_MS, body.expires_in * 100),
		email: nextIdentity.email ?? credentials.email,
		accountId: nextIdentity.accountId ?? credentials.accountId,
	};
}
