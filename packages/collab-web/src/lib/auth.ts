import { RetryableRelayAuthorizationError } from "./relay-auth";

const STORAGE_KEY = "coreforce.agent-collab.browser-session";
const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CHALLENGE_TTL_SECONDS = 15 * 60;

interface StoredSession {
	accessToken: string;
	expiresAt: number;
}

interface ChallengeResponse {
	challengeId: string;
	userCode: string;
	expiresIn: number;
}

interface StatusResponse {
	status: "pending" | "approved";
	accessToken?: string;
	expiresIn?: number;
}

export interface RelayAuthorizationProgress {
	userCode: string;
}

async function fetchRelayAuth(input: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	try {
		return await fetch(input, { ...init, signal: requestSignal });
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason instanceof Error ? signal.reason : new Error("Relay authorization aborted");
		}
		if (timeout.aborted || error instanceof TypeError) {
			throw new RetryableRelayAuthorizationError("Relay authorization request failed");
		}
		throw error;
	}
}

function rejectRetryableResponse(response: Response): void {
	if (response.status === 429 || response.status >= 500) {
		throw new RetryableRelayAuthorizationError(`Browser authorization failed: HTTP ${response.status}`);
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
	if (signal.aborted) {
		return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("Relay authorization aborted"));
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error("Relay authorization aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export async function getRelayBrowserToken(
	onProgress: (progress: RelayAuthorizationProgress) => void,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const stored = readStoredSession();
	if (stored) {
		const validation = await fetchRelayAuth(
			"/auth/browser/session",
			{ headers: { Authorization: `Bearer ${stored.accessToken}` } },
			signal,
		);
		rejectRetryableResponse(validation);
		if (validation.status === 204) return stored.accessToken;
		clearRelayBrowserToken();
	}
	const challengeResponse = await fetchRelayAuth(
		"/auth/browser/challenge",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		},
		signal,
	);
	if (challengeResponse.status === 404) return undefined;
	rejectRetryableResponse(challengeResponse);
	if (!challengeResponse.ok) throw new Error(`Browser authorization failed: HTTP ${challengeResponse.status}`);
	const challenge = (await challengeResponse.json()) as Partial<ChallengeResponse>;
	if (
		typeof challenge.challengeId !== "string" ||
		typeof challenge.userCode !== "string" ||
		typeof challenge.expiresIn !== "number" ||
		!Number.isFinite(challenge.expiresIn) ||
		challenge.expiresIn <= 0 ||
		challenge.expiresIn > MAX_CHALLENGE_TTL_SECONDS
	) {
		throw new Error("Relay returned an invalid browser challenge");
	}
	onProgress({ userCode: challenge.userCode });
	const deadline = Date.now() + challenge.expiresIn * 1_000;
	while (Date.now() < deadline) {
		await sleep(POLL_INTERVAL_MS, signal);
		const response = await fetchRelayAuth(
			"/auth/browser/status",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ challengeId: challenge.challengeId }),
			},
			signal,
		);
		if (response.status === 202) continue;
		if (response.status === 410) throw new Error("Browser authorization code expired; connect again for a new code");
		rejectRetryableResponse(response);
		if (!response.ok) throw new Error(`Browser authorization failed: HTTP ${response.status}`);
		const status = (await response.json()) as Partial<StatusResponse>;
		if (
			status.status !== "approved" ||
			typeof status.accessToken !== "string" ||
			typeof status.expiresIn !== "number"
		) {
			throw new Error("Relay returned an invalid browser session");
		}
		storeSession(status.accessToken, status.expiresIn);
		return status.accessToken;
	}
	throw new Error("Browser authorization code expired; connect again for a new code");
}

export function clearRelayBrowserToken(): void {
	try {
		sessionStorage.removeItem(STORAGE_KEY);
	} catch {}
}

function readStoredSession(): StoredSession | null {
	try {
		const raw = sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<StoredSession>;
		if (
			typeof value.accessToken !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(value.accessToken) ||
			typeof value.expiresAt !== "number" ||
			value.expiresAt <= Date.now() + 30_000
		) {
			clearRelayBrowserToken();
			return null;
		}
		return value as StoredSession;
	} catch {
		clearRelayBrowserToken();
		return null;
	}
}

function storeSession(accessToken: string, expiresIn: number): void {
	if (!/^[A-Za-z0-9_-]{43}$/.test(accessToken) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
		throw new Error("Relay returned an invalid browser session");
	}
	try {
		sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, expiresAt: Date.now() + expiresIn * 1_000 }));
	} catch {
		// In-memory use still works when browser storage is unavailable.
	}
}
