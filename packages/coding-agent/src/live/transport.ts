import { type AuthStorage, type OAuthAccess, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { LiveWebRtcPeer } from "@oh-my-pi/pi-natives";
import { toError } from "@oh-my-pi/pi-utils";
import { generateCodexAttestation } from "./attestation";
import {
	buildLiveSessionPayload,
	type LiveClientMessage,
	LIVE_MODEL,
	type LiveServerEvent,
	parseLiveServerEvent,
} from "./protocol";

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

interface LiveSignalingResult {
	answer: string;
	callId: string;
	access: OAuthAccess;
	attestation: string | undefined;
}

class LiveSignalingError extends Error {
	status: number;
	errorMessage: string;

	constructor(status: number, message: string) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
		this.errorMessage = message;
	}
}

/** Callbacks emitted by the live WebRTC transport. */
export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

/** Configuration required to establish a Codex live call. */
export interface LiveTransportOptions {
	authStorage: AuthStorage;
	sessionId: string;
	instructions: string;
	voice: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
	/** Rechecks the owning session, live-model policy and cost admission at each use. */
	assertCurrent?: () => void;
	/**
	 * SDP offer from a caller-owned WebRTC peer (one Opus audio track plus an `oai-events`
	 * data channel). When set, no native peer is created: the caller's peer carries the audio,
	 * {@link CodexLiveTransport.sdpAnswer} holds the answer to apply to it, and this transport
	 * keeps only the sideband.
	 */
	sdpOffer?: string;
}

/** Extracts the server-assigned `rtc_*` call ID from a signaling Location header. */
export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find(segment => LIVE_CALL_ID_PATTERN.test(segment));
}

/** Builds the Frameless Bidi sideband WebSocket URL for an accepted Codex call. */
export function buildLiveSidebandUrl(callId: string): string {
	const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
	url.protocol = "wss:";
	return url.toString();
}

function liveSessionHeaders(
	access: OAuthAccess,
	sessionId: string,
	realtimeSessionId: string,
	attestation: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${access.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
		"x-session-id": realtimeSessionId,
		[OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		[OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
		[OPENAI_HEADERS.THREAD_ID]: sessionId,
	};
	const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	if (attestation) headers["x-oai-attestation"] = attestation;
	return headers;
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/g, " ");
	if (!normalized) return statusText || "empty response body";
	if (normalized.length <= MAX_ERROR_BODY_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new DOMException("Live connection aborted", "AbortError");
}

/** WebRTC transport for a Codex Frameless Bidi live session, with a native or caller-owned media peer. */
export class CodexLiveTransport {
	readonly #options: LiveTransportOptions;
	#peer: LiveWebRtcPeer | undefined;
	#sdpAnswer: string | undefined;
	readonly #realtimeSessionId = crypto.randomUUID();
	#sideband: Bun.WebSocket | undefined;
	#state: Lifecycle = "idle";
	#connectPromise: Promise<void> | undefined;
	#closePromise: Promise<void> | undefined;
	#sendTail: Promise<void> = Promise.resolve();
	#muted = false;
	#unexpectedFailureReported = false;
	readonly #abortListener: () => void;
	readonly #credentials: AuthStorage["credentials"];
	readonly #sourceIdentity: string | undefined;
	#credentialGeneration: number;
	#acceptedAccess: OAuthAccess | undefined;

	constructor(options: LiveTransportOptions) {
		this.#options = options;
		this.#credentials = options.authStorage.credentials;
		this.#credentialGeneration = this.#credentials.generation;
		this.#sourceIdentity = options.authStorage.sourceIdentity;
		this.#abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) options.signal?.addEventListener("abort", this.#abortListener, { once: true });
	}

	#assertOwnerCurrent(): void {
		this.#options.signal?.throwIfAborted();
		const auth = this.#options.authStorage;
		if (
			auth.isClosed ||
			auth.credentials !== this.#credentials ||
			auth.sourceIdentity !== this.#sourceIdentity ||
			this.#state === "closing" ||
			this.#state === "closed"
		)
			throw new Error("Live transport owner changed");
		this.#options.assertCurrent?.();
	}

	#assertAccess(access: OAuthAccess): void {
		const auth = this.#options.authStorage;
		const row = this.#credentials.list(LIVE_PROVIDER).find(row => row.id === access.credentialId);
		const account = auth.oauth.accounts(LIVE_PROVIDER, this.#options.sessionId).find(account => account.active);
		if (
			access.credentialId === undefined ||
			!auth.sessions.permits(LIVE_PROVIDER, this.#options.sessionId, access.credentialId) ||
			account?.credentialId !== access.credentialId ||
			!row ||
			row.credential.type !== "oauth" ||
			row.credential.access !== access.accessToken ||
			row.credential.accountId !== access.accountId ||
			row.credential.orgId !== access.orgId ||
			row.credential.projectId !== access.projectId
		)
			throw new Error("Live OAuth account changed");
	}

	#assertCurrent(): void {
		this.#assertOwnerCurrent();
		if (this.#credentials.generation !== this.#credentialGeneration)
			throw new Error("Live credential generation changed");
		if (this.#acceptedAccess) this.#assertAccess(this.#acceptedAccess);
	}

	#acceptAccess(access: OAuthAccess): void {
		this.#assertOwnerCurrent();
		this.#assertAccess(access);
		this.#credentialGeneration = this.#credentials.generation;
	}

	#current(): boolean {
		try {
			this.#assertCurrent();
			return true;
		} catch (error) {
			this.#reportFailure(error instanceof Error ? error.message : String(error));
			void this.close();
			return false;
		}
	}

	/** SDP answer for the caller's peer once a {@link LiveTransportOptions.sdpOffer} call has been signaled. */
	get sdpAnswer(): string | undefined {
		return this.#sdpAnswer;
	}

	/** Establish the media peer, perform Codex signaling, and wait for the data channel or sideband. */
	connect(): Promise<void> {
		if (this.#state === "connected") return Promise.resolve();
		if (this.#connectPromise) return this.#connectPromise;
		if (this.#state === "closing" || this.#state === "closed")
			return Promise.reject(new Error("Live transport is closed"));
		if (this.#options.signal?.aborted) return Promise.reject(abortReason(this.#options.signal));
		this.#state = "connecting";
		const operation = this.#connect().catch(async error => {
			await this.close();
			throw error;
		});
		this.#connectPromise = operation;
		return operation;
	}

	async #connect(): Promise<void> {
		this.#assertCurrent();
		let offer = this.#options.sdpOffer;
		let peer: LiveWebRtcPeer | undefined;
		if (offer === undefined) {
			peer = this.#createPeer();
			this.#peer = peer;
			offer = await peer.createOffer();
			this.#assertCurrent();
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		const signaling = await this.#signal(offer);
		this.#assertCurrent();
		this.#acceptedAccess = signaling.access;
		if (peer) {
			await peer.acceptAnswer(signaling.answer);
			this.#assertCurrent();
			peer.setMuted(this.#muted);
			await peer.waitForOpen();
			this.#assertCurrent();
		} else {
			this.#sdpAnswer = signaling.answer;
		}
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		await this.#connectSideband(signaling.callId, signaling.access, signaling.attestation);
		if (this.#state !== "connecting") throw abortReason(this.#options.signal);
		this.#assertCurrent();
		this.#state = "connected";
	}

	#createPeer(): LiveWebRtcPeer {
		return new LiveWebRtcPeer(
			(error, payload) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleServerEvent(payload);
				}
			},
			(error, level) => {
				if (error) {
					this.#reportFailure(error.message);
				} else {
					this.#handleOutputLevel(level);
				}
			},
			(error, message) => this.#reportFailure(error?.message ?? message),
		);
	}

	async #signal(offer: string): Promise<LiveSignalingResult> {
		const attestation = await generateCodexAttestation();
		this.#assertCurrent();
		const result = await withOAuthAccess(
			{
				oauth: {
					access: async (...args: Parameters<AuthStorage["oauth"]["access"]>) => {
						this.#assertCurrent();
						const access = await this.#options.authStorage.oauth.access(args[0], args[1], {
							...args[2],
							baseUrl: CODEX_BASE_URL,
							modelId: LIVE_MODEL,
						});
						this.#assertOwnerCurrent();
						if (access) this.#acceptAccess(access);
						return access;
					},
				},
				limits: {
					rotate: async (...args: Parameters<AuthStorage["limits"]["rotate"]>) => {
						this.#assertCurrent();
						const result = await this.#options.authStorage.limits.rotate(args[0], args[1], {
							...args[2],
							modelId: LIVE_MODEL,
						});
						this.#assertOwnerCurrent();
						this.#credentialGeneration = this.#credentials.generation;
						return result;
					},
				},
			},
			LIVE_PROVIDER,
			access => this.#signalWithAccess(offer, access, attestation),
			{
				sessionId: this.#options.sessionId,
				signal: this.#options.signal,
				missingAccessMessage: "No Codex OAuth credential is available for a live call.",
			},
		);
		this.#assertCurrent();
		return result;
	}

	async #signalWithAccess(
		offer: string,
		access: OAuthAccess,
		attestation: string | undefined,
	): Promise<LiveSignalingResult> {
		this.#acceptAccess(access);
		const headers = new Headers({
			...liveSessionHeaders(access, this.#options.sessionId, this.#realtimeSessionId, attestation),
			Accept: "*/*",
			"Content-Type": "application/json",
		});
		const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);
		this.#options.signal?.throwIfAborted();
		const response = await fetchImpl(SIGNALING_URL, {
			method: "POST",
			headers,
			body: JSON.stringify({
				sdp: offer,
				session: buildLiveSessionPayload(this.#options.instructions, this.#options.voice),
			}),
			signal: this.#options.signal,
		});
		this.#assertCurrent();
		this.#assertAccess(access);
		const responseBody = await response.text();
		this.#assertCurrent();
		this.#assertAccess(access);
		if (!response.ok) {
			const detail = boundedErrorBody(responseBody, response.statusText);
			throw new LiveSignalingError(response.status, `Codex live signaling failed (${response.status}): ${detail}`);
		}
		const answer = responseBody;
		if (!answer.trim())
			throw new LiveSignalingError(response.status, "Codex live signaling returned an empty SDP answer");
		const callId = parseLiveCallId(response.headers.get("location"));
		if (!callId) {
			throw new LiveSignalingError(response.status, "Codex live signaling returned no valid call ID");
		}
		return { answer, callId, access, attestation };
	}

	async #connectSideband(callId: string, access: OAuthAccess, attestation: string | undefined): Promise<void> {
		let failure = new Error("Codex live sideband connection failed");
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt++) {
			this.#assertCurrent();
			try {
				await this.#openSideband(callId, access, attestation);
				this.#assertCurrent();
				return;
			} catch (cause) {
				failure = toError(cause);
				this.#assertCurrent();
				if (this.#options.signal?.aborted) throw abortReason(this.#options.signal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
				this.#assertCurrent();
			}
		}
		throw failure;
	}

	async #openSideband(callId: string, access: OAuthAccess, attestation: string | undefined): Promise<void> {
		this.#assertCurrent();
		if (access.credentialId === undefined) throw new Error("Live OAuth credential has no stored identity");
		const refreshed = await this.#options.authStorage.oauth.access(LIVE_PROVIDER, this.#options.sessionId, {
			signal: this.#options.signal,
			baseUrl: CODEX_BASE_URL,
			modelId: LIVE_MODEL,
		});
		this.#assertOwnerCurrent();
		if (
			!refreshed ||
			refreshed.credentialId !== access.credentialId ||
			refreshed.accountId !== access.accountId ||
			refreshed.orgId !== access.orgId ||
			refreshed.projectId !== access.projectId
		)
			throw new Error("Live OAuth account changed");
		this.#acceptAccess(refreshed);
		this.#acceptedAccess = refreshed;
		const url = buildLiveSidebandUrl(callId);
		const options = {
			headers: liveSessionHeaders(refreshed, this.#options.sessionId, this.#realtimeSessionId, attestation),
			proxy: getProxyForUrl(LIVE_PROVIDER, new URL(url)),
		} satisfies Bun.WebSocketOptions;
		const socket: Bun.WebSocket = Reflect.construct(WebSocket, [url, options]);
		socket.binaryType = "nodebuffer";
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let opened = false;
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		const cleanup = (): void => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			this.#options.signal?.removeEventListener("abort", onAbort);
		};
		const rejectConnect = (error: Error): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = (): void => {
			socket.close(1000, "aborted");
			rejectConnect(abortReason(this.#options.signal));
		};
		socket.onopen = () => {
			if (settled) {
				socket.close(1000, "stale");
				return;
			}
			if (!this.#current()) {
				socket.close(1000, "stale owner");
				rejectConnect(new Error("Live transport owner changed"));
				return;
			}
			opened = true;
			settled = true;
			cleanup();
			this.#sideband = socket;
			resolve();
		};
		socket.onmessage = event => {
			if (typeof event.data !== "string") {
				this.#reportFailure("Codex live sideband returned an unexpected binary frame.");
				return;
			}
			this.#handleSidebandEvent(event.data);
		};
		socket.onerror = event => {
			const detail = event instanceof ErrorEvent && event.message ? `: ${event.message}` : "";
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband connection failed${detail}`));
				socket.close(1011, "connection failed");
				return;
			}
			this.#reportFailure(`Codex live sideband failed${detail}`);
		};
		socket.onclose = event => {
			if (!opened) {
				rejectConnect(new Error(`Codex live sideband closed before connecting (${event.code})`));
				return;
			}
			if (this.#sideband !== socket) return;
			this.#sideband = undefined;
			if (this.#state === "connecting" || this.#state === "connected") {
				const detail = event.reason ? `: ${event.reason}` : "";
				this.#reportFailure(`Codex live sideband closed (${event.code})${detail}`);
			}
		};
		if (this.#options.signal?.aborted) {
			onAbort();
		} else {
			this.#options.signal?.addEventListener("abort", onAbort, { once: true });
			timeout = setTimeout(() => {
				socket.close(1000, "connect timeout");
				rejectConnect(new Error("Codex live sideband connection timed out"));
			}, SIDEBAND_CONNECT_TIMEOUT_MS);
			timeout.unref?.();
		}
		await promise;
		this.#assertCurrent();
	}

	#handleSidebandEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		if (!this.#current()) return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleServerEvent(payload: string): void {
		if (this.#state === "closing" || this.#state === "closed") return;
		if (!this.#current()) return;
		const event = parseLiveServerEvent(payload);
		if (!event || (this.#sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
		try {
			this.#options.callbacks.onEvent(event);
		} catch {}
	}

	#handleOutputLevel(level: number): void {
		if (this.#state !== "connected" || !Number.isFinite(level)) return;
		if (!this.#current()) return;
		try {
			this.#options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {}
	}

	#reportFailure(message: string): void {
		if ((this.#state !== "connecting" && this.#state !== "connected") || this.#unexpectedFailureReported) {
			return;
		}
		this.#unexpectedFailureReported = true;
		try {
			this.#options.callbacks.onEvent({ type: "error", message });
		} catch {}
	}

	/** Serialize one Frameless Bidi control message onto the call's sideband WebSocket. */
	send(message: LiveClientMessage): Promise<void> {
		const operation = this.#sendTail.then(() => {
			if (this.#state !== "connected") throw new Error("Live transport is not connected");
			if (message.type !== "session.close") this.#assertCurrent();
			const sideband = this.#sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error("Codex live sideband is not connected");
			}
			sideband.send(JSON.stringify(message));
		});
		this.#sendTail = operation.catch(() => {});
		return operation;
	}

	/** Queue 16 kHz mono Float32 PCM for native Opus transmission. */
	pushAudio(samples: Float32Array): void {
		if (this.#state !== "connected" || this.#muted || samples.length === 0) return;
		this.#assertCurrent();
		this.#peer?.pushAudio(samples);
	}

	/** Enable or disable the native audio source and discard partial input when muted. */
	async setMuted(muted: boolean): Promise<void> {
		this.#assertCurrent();
		this.#muted = muted;
		if (this.#state === "connected") this.#peer?.setMuted(muted);
	}

	/** Stop sideband signaling and the native WebRTC media peer. Safe to call repeatedly. */
	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#state = "closing";
		const operation = this.#close();
		this.#closePromise = operation;
		return operation;
	}

	async #close(): Promise<void> {
		this.#options.signal?.removeEventListener("abort", this.#abortListener);
		const sideband = this.#sideband;
		const peer = this.#peer;
		this.#sideband = undefined;
		this.#peer = undefined;
		if (sideband && (sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)) {
			sideband.close(1000, "done");
		}
		if (peer) {
			try {
				await peer.close();
			} catch {}
		}
		this.#state = "closed";
	}
}
