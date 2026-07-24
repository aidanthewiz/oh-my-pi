import path from "node:path";
import { ENVELOPE_HEADER_LENGTH, type RelayAuthRequest } from "@oh-my-pi/pi-wire";
import { BrowserAuthorizationStore, type RelayIdentity, type RelayIdentityVerifier } from "./auth";
import { SHARE_ID_RE, type ShareStore, ShareStoreCapacityError, type ShareStoreStats } from "./share-store";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const SHARE_VIEW_RE = /^\/s\/([A-Za-z0-9_-]{10,64})\/?$/;
const SHARE_RAW_RE = /^\/s\/([A-Za-z0-9_-]{10,64})\/raw$/;
const HASHED_ASSET_RE = /^\/[A-Za-z0-9_-]{8,}\.(?:css|js|png|svg|woff2?)$/;
const MAX_TRACKED_UPLOAD_CLIENTS = 10_000;
const AUTH_CHALLENGE_PATH = "/auth/browser/challenge";
const AUTH_STATUS_PATH = "/auth/browser/status";
const AUTH_APPROVE_PATH = "/auth/browser/approve";
const AUTH_SESSION_PATH = "/auth/browser/session";
const AUTHORIZATION_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTH_TIMEOUT_MS = 10_000;

const COLLAB_CSP = [
	"default-src 'self'",
	"base-uri 'none'",
	"connect-src 'self' wss: ws://localhost:* http://localhost:*",
	"font-src 'self'",
	"frame-ancestors 'none'",
	"img-src 'self' data:",
	"object-src 'none'",
	"script-src 'self' 'unsafe-inline'",
	"style-src 'self' 'unsafe-inline'",
].join("; ");

const SHARE_CSP = [
	"default-src 'none'",
	"base-uri 'none'",
	"connect-src 'self' https://api.github.com https://gist.githubusercontent.com",
	"font-src 'self' data:",
	"frame-ancestors 'none'",
	"img-src 'self' data:",
	"object-src 'none'",
	"script-src 'unsafe-inline'",
	"style-src 'unsafe-inline'",
].join("; ");

interface SocketData {
	roomId: string;
	role: "host" | "guest";
	peerId: number;
	registered: boolean;
	authenticating: boolean;
	clientKey: string;
	identity?: RelayIdentity;
	authTimer?: Timer;
}

type RelaySocket = Bun.ServerWebSocket<SocketData>;

interface Room {
	host: RelaySocket;
	guests: Map<number, RelaySocket>;
	nextPeerId: number;
	hostClientKey: string;
	openedAt: number;
	lastActivityAt: number;
}

interface ClientRateWindow {
	startedAt: number;
	count: number;
}

interface RelayMetrics {
	framesFromHosts: number;
	framesFromGuests: number;
	shareUploads: number;
	shareReads: number;
	shareUploadRateLimited: number;
	shareCapacityRejected: number;
	shareStoreErrors: number;
	rejectedConnections: number;
	expiredRooms: number;
	authenticationRejected: number;
	browserChallenges: number;
	browserSessions: number;
}

export interface RelayServerOptions {
	hostname?: string;
	port?: number;
	staticRoot: string;
	shareViewerPath: string;
	shareStore: ShareStore;
	shareMaxBytes?: number;
	maxGuestsPerRoom?: number;
	maxRooms?: number;
	maxHostRoomsPerClient?: number;
	maxShareUploadsPerClient?: number;
	shareUploadWindowMs?: number;
	roomIdleTimeoutMs?: number;
	roomMaxAgeMs?: number;
	trustedProxyHops?: number;
	maxWebSocketPayloadBytes?: number;
	cleanupIntervalMs?: number;
	pingIntervalMs?: number;
	shutdownTimeoutMs?: number;
	log?: (record: Record<string, string | number>) => void;
	identityVerifier?: RelayIdentityVerifier;
	browserAuthorizationStore?: BrowserAuthorizationStore;
	maxBrowserChallengesPerClient?: number;
	browserChallengeWindowMs?: number;
}

export interface RelayServer {
	url: string;
	stop(): Promise<void>;
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
	const staticRoot = path.resolve(options.staticRoot);
	const shareViewerPath = path.resolve(options.shareViewerPath);
	const shareMaxBytes = options.shareMaxBytes ?? 1_000_000;
	const maxGuestsPerRoom = options.maxGuestsPerRoom ?? 32;
	const maxRooms = options.maxRooms ?? 1_000;
	const maxHostRoomsPerClient = options.maxHostRoomsPerClient ?? 25;
	const maxShareUploadsPerClient = options.maxShareUploadsPerClient ?? 20;
	const shareUploadWindowMs = options.shareUploadWindowMs ?? 60 * 60 * 1_000;
	const roomIdleTimeoutMs = options.roomIdleTimeoutMs ?? 60 * 60 * 1_000;
	const roomMaxAgeMs = options.roomMaxAgeMs ?? 24 * 60 * 60 * 1_000;
	const trustedProxyHops = options.trustedProxyHops ?? 0;
	const maxWebSocketPayloadBytes = options.maxWebSocketPayloadBytes ?? 8 * 1024 * 1024;
	const cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1_000;
	const pingIntervalMs = options.pingIntervalMs ?? 30_000;
	const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 1_000;
	const identityVerifier = options.identityVerifier;
	const browserAuthorizationStore = options.browserAuthorizationStore ?? new BrowserAuthorizationStore();
	const maxBrowserChallengesPerClient = options.maxBrowserChallengesPerClient ?? 20;
	const browserChallengeWindowMs = options.browserChallengeWindowMs ?? 5 * 60 * 1_000;
	const log = options.log ?? (record => console.log(JSON.stringify(record)));
	const rooms = new Map<string, Room>();
	const sockets = new Set<RelaySocket>();
	const hostRoomsByClient = new Map<string, number>();
	const shareUploadWindows = new Map<string, ClientRateWindow>();
	const browserChallengeWindows = new Map<string, ClientRateWindow>();
	const metrics: RelayMetrics = {
		framesFromHosts: 0,
		framesFromGuests: 0,
		shareUploads: 0,
		shareReads: 0,
		shareUploadRateLimited: 0,
		shareCapacityRejected: 0,
		shareStoreErrors: 0,
		rejectedConnections: 0,
		expiredRooms: 0,
		authenticationRejected: 0,
		browserChallenges: 0,
		browserSessions: 0,
	};

	await options.shareStore.cleanup();

	const closeRoom = (roomId: string, room: Room, reason: string, closeHost: boolean): void => {
		if (rooms.get(roomId) !== room) return;
		rooms.delete(roomId);
		const remaining = (hostRoomsByClient.get(room.hostClientKey) ?? 1) - 1;
		if (remaining > 0) hostRoomsByClient.set(room.hostClientKey, remaining);
		else hostRoomsByClient.delete(room.hostClientKey);
		const closure = JSON.stringify({ t: "room-closed" });
		for (const guest of room.guests.values()) {
			guest.send(closure);
			guest.close(4001, reason);
		}
		room.guests.clear();
		if (closeHost) room.host.close(4001, reason);
		log({ event: "room_closed", reason, rooms: rooms.size });
	};

	const authenticateAwsToken = async (token: string): Promise<RelayIdentity> => {
		if (!identityVerifier) throw new Error("relay identity verification is disabled");
		return identityVerifier.verify(token);
	};

	const authenticateToken = async (token: string): Promise<RelayIdentity> => {
		if (OPAQUE_TOKEN_RE.test(token)) {
			const identity = browserAuthorizationStore.verifySession(token);
			if (identity) return identity;
		}
		return authenticateAwsToken(token);
	};

	const registerSocket = (ws: RelaySocket): void => {
		if (ws.data.registered) return;
		const { roomId, role, clientKey, identity } = ws.data;
		const principalKey = identity?.userId ?? clientKey;
		if (role === "host") {
			if (rooms.has(roomId)) {
				metrics.rejectedConnections++;
				ws.close(4009, "a host is already connected for this room");
				return;
			}
			if (rooms.size >= maxRooms) {
				metrics.rejectedConnections++;
				ws.close(4029, "relay room capacity reached");
				return;
			}
			const clientRoomCount = hostRoomsByClient.get(principalKey) ?? 0;
			if (clientRoomCount >= maxHostRoomsPerClient) {
				metrics.rejectedConnections++;
				ws.close(4029, "client room capacity reached");
				return;
			}
			const now = Date.now();
			ws.data.registered = true;
			rooms.set(roomId, {
				host: ws,
				guests: new Map(),
				nextPeerId: 1,
				hostClientKey: principalKey,
				openedAt: now,
				lastActivityAt: now,
			});
			hostRoomsByClient.set(principalKey, clientRoomCount + 1);
			log({ event: "room_opened", rooms: rooms.size });
		} else {
			const room = rooms.get(roomId);
			if (!room) {
				metrics.rejectedConnections++;
				ws.close(4004, "no such room");
				return;
			}
			if (room.guests.size >= maxGuestsPerRoom) {
				metrics.rejectedConnections++;
				ws.close(4029, "room is full");
				return;
			}
			const peerId = room.nextPeerId++;
			ws.data.peerId = peerId;
			ws.data.registered = true;
			room.guests.set(peerId, ws);
			room.host.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
			room.lastActivityAt = Date.now();
		}
		if (ws.data.authTimer) {
			clearTimeout(ws.data.authTimer);
			ws.data.authTimer = undefined;
		}
		if (identityVerifier) ws.send(JSON.stringify({ t: "auth-ok" }));
	};

	const server = Bun.serve<SocketData>({
		hostname: options.hostname ?? "0.0.0.0",
		port: options.port ?? 8080,
		maxRequestBodySize: shareMaxBytes,
		async fetch(request, bunServer): Promise<Response | undefined> {
			const url = new URL(request.url);
			const clientKey = resolveClientKey(request, bunServer, trustedProxyHops);
			const roomMatch = ROOM_PATH_RE.exec(url.pathname);
			if (roomMatch) {
				const role = url.searchParams.get("role");
				if (role !== "host" && role !== "guest") return textResponse("role must be host or guest", 400);
				const upgraded = bunServer.upgrade(request, {
					data: {
						roomId: roomMatch[1]!,
						role,
						peerId: 0,
						registered: false,
						authenticating: false,
						clientKey,
					},
				});
				return upgraded ? undefined : textResponse("websocket upgrade required", 426);
			}

			if (request.method === "GET" && url.pathname === "/healthz") return textResponse("ok", 200);
			if (request.method === "GET" && url.pathname === "/metrics") {
				let guests = 0;
				for (const room of rooms.values()) guests += room.guests.size;
				const storeStats = await options.shareStore.stats();
				return new Response(renderMetrics(rooms.size, guests, metrics, storeStats), {
					headers: responseHeaders("text/plain; version=0.0.4; charset=utf-8", "no-store"),
				});
			}

			if (identityVerifier && request.method === "GET" && url.pathname === AUTH_SESSION_PATH) {
				const token = bearerToken(request);
				if (!token) return unauthorizedResponse();
				try {
					await authenticateToken(token);
					return new Response(null, { status: 204, headers: responseHeaders("text/plain", "no-store") });
				} catch {
					metrics.authenticationRejected++;
					return unauthorizedResponse();
				}
			}

			if (identityVerifier && request.method === "POST" && url.pathname === AUTH_CHALLENGE_PATH) {
				if (!isJsonRequest(request)) return textResponse("content-type must be application/json", 415);
				const retryAfterSeconds = consumeRateWindow(
					browserChallengeWindows,
					clientKey,
					maxBrowserChallengesPerClient,
					browserChallengeWindowMs,
					Date.now(),
				);
				if (retryAfterSeconds !== null) return rateLimitResponse(retryAfterSeconds, "browser authorization");
				try {
					await request.json();
					const challenge = browserAuthorizationStore.create();
					metrics.browserChallenges++;
					return jsonResponse(challenge, 201);
				} catch (error) {
					if (error instanceof SyntaxError) return textResponse("invalid JSON body", 400);
					return textResponse("browser authorization capacity reached", 503);
				}
			}

			if (identityVerifier && request.method === "POST" && url.pathname === AUTH_STATUS_PATH) {
				if (!isJsonRequest(request)) return textResponse("content-type must be application/json", 415);
				const body = await readJsonBody(request);
				if (!body || typeof body.challengeId !== "string" || !OPAQUE_TOKEN_RE.test(body.challengeId)) {
					return textResponse("invalid browser challenge", 400);
				}
				const status = browserAuthorizationStore.exchange(body.challengeId);
				if (status.status === "pending") return jsonResponse(status, 202);
				if (status.status === "expired") return textResponse("browser challenge expired", 410);
				metrics.browserSessions++;
				return jsonResponse(status, 200);
			}

			if (identityVerifier && request.method === "POST" && url.pathname === AUTH_APPROVE_PATH) {
				if (!isJsonRequest(request)) return textResponse("content-type must be application/json", 415);
				const token = bearerToken(request);
				if (!token) return unauthorizedResponse();
				let identity: RelayIdentity;
				try {
					identity = await authenticateAwsToken(token);
				} catch {
					metrics.authenticationRejected++;
					return unauthorizedResponse();
				}
				const body = await readJsonBody(request);
				const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
				if (!AUTHORIZATION_CODE_RE.test(code)) return textResponse("invalid browser authorization code", 400);
				const result = browserAuthorizationStore.approve(code, identity);
				if (result === "not-found") return textResponse("browser challenge not found", 404);
				if (result === "expired") return textResponse("browser challenge expired", 410);
				return new Response(null, { status: 204, headers: responseHeaders("text/plain", "no-store") });
			}

			let requestIdentity: RelayIdentity | undefined;
			if (identityVerifier && request.method === "POST" && url.pathname === "/s") {
				const token = bearerToken(request);
				if (!token) return unauthorizedResponse();
				try {
					requestIdentity = await authenticateAwsToken(token);
				} catch {
					metrics.authenticationRejected++;
					return unauthorizedResponse();
				}
			}

			if (request.method === "POST" && url.pathname === "/s") {
				const uploadClientKey = requestIdentity?.userId ?? clientKey;
				if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/octet-stream") {
					return textResponse("content-type must be application/octet-stream", 415);
				}
				const declaredLength = Number(request.headers.get("content-length"));
				if (Number.isFinite(declaredLength) && declaredLength > shareMaxBytes) {
					return textResponse("share exceeds the upload limit", 413);
				}
				const retryAfterSeconds = consumeRateWindow(
					shareUploadWindows,
					uploadClientKey,
					maxShareUploadsPerClient,
					shareUploadWindowMs,
					Date.now(),
				);
				if (retryAfterSeconds !== null) {
					metrics.shareUploadRateLimited++;
					return rateLimitResponse(retryAfterSeconds);
				}
				let data: Uint8Array;
				try {
					data = new Uint8Array(await request.arrayBuffer());
				} catch {
					return textResponse("share exceeds the upload limit", 413);
				}
				if (data.byteLength <= 28) return textResponse("sealed share is truncated", 400);
				if (data.byteLength > shareMaxBytes) return textResponse("share exceeds the upload limit", 413);
				try {
					const id = await options.shareStore.put(data);
					metrics.shareUploads++;
					log({ event: "share_uploaded", bytes: data.byteLength });
					return new Response(JSON.stringify({ id }), {
						status: 201,
						headers: responseHeaders("application/json; charset=utf-8", "no-store"),
					});
				} catch (error) {
					if (error instanceof ShareStoreCapacityError) {
						metrics.shareCapacityRejected++;
						return textResponse(error.message, 507);
					}
					metrics.shareStoreErrors++;
					log({ event: "share_store_write_failed", error: String(error) });
					return textResponse("share store unavailable", 503);
				}
			}

			const rawMatch = SHARE_RAW_RE.exec(url.pathname);
			if ((request.method === "GET" || request.method === "HEAD") && rawMatch) {
				if (identityVerifier) {
					const token = bearerToken(request);
					if (!token) return unauthorizedResponse();
					try {
						await authenticateToken(token);
					} catch {
						metrics.authenticationRejected++;
						return unauthorizedResponse();
					}
				}
				const id = rawMatch[1]!;
				if (!SHARE_ID_RE.test(id)) return textResponse("not found", 404);
				let blob: Blob | null;
				try {
					blob = await options.shareStore.get(id);
				} catch (error) {
					metrics.shareStoreErrors++;
					log({ event: "share_store_read_failed", error: String(error) });
					return textResponse("share store unavailable", 503);
				}
				if (!blob) return textResponse("share not found or expired", 404);
				metrics.shareReads++;
				return new Response(request.method === "HEAD" ? null : blob, {
					headers: {
						...responseHeaders("application/octet-stream", "private, no-store"),
						"Content-Length": String(blob.size),
					},
				});
			}

			if ((request.method === "GET" || request.method === "HEAD") && SHARE_VIEW_RE.test(url.pathname)) {
				return fileResponse(shareViewerPath, request.method === "HEAD", "no-store", SHARE_CSP);
			}

			if (request.method === "GET" || request.method === "HEAD") {
				const decodedPath = decodePathname(url.pathname);
				if (decodedPath !== null) {
					const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
					const candidate = path.resolve(staticRoot, relativePath);
					const relative = path.relative(staticRoot, candidate);
					if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
						const cache = HASHED_ASSET_RE.test(decodedPath) ? "public, max-age=31536000, immutable" : "no-cache";
						const response = await fileResponse(candidate, request.method === "HEAD", cache, COLLAB_CSP);
						if (response.status !== 404) return response;
					}
				}
			}

			return textResponse("not found", 404);
		},
		websocket: {
			maxPayloadLength: maxWebSocketPayloadBytes,
			backpressureLimit: maxWebSocketPayloadBytes * 2,
			closeOnBackpressureLimit: true,
			open(ws): void {
				sockets.add(ws);
				if (!identityVerifier) {
					registerSocket(ws);
					return;
				}
				ws.data.authTimer = setTimeout(() => {
					if (!ws.data.registered) {
						metrics.authenticationRejected++;
						ws.close(4401, "authentication required");
					}
				}, AUTH_TIMEOUT_MS);
			},
			async message(ws, message): Promise<void> {
				if (!ws.data.registered) {
					if (
						!identityVerifier ||
						typeof message !== "string" ||
						message.length > 20_000 ||
						ws.data.authenticating
					) {
						metrics.authenticationRejected++;
						ws.close(4401, "authentication required");
						return;
					}
					let auth: RelayAuthRequest;
					try {
						auth = JSON.parse(message) as RelayAuthRequest;
					} catch {
						metrics.authenticationRejected++;
						ws.close(4401, "authentication required");
						return;
					}
					if (auth.t !== "auth" || typeof auth.token !== "string" || auth.token.length === 0) {
						metrics.authenticationRejected++;
						ws.close(4401, "authentication required");
						return;
					}
					ws.data.authenticating = true;
					try {
						const identity = await authenticateToken(auth.token);
						if (!sockets.has(ws)) return;
						ws.data.identity = identity;
						registerSocket(ws);
					} catch {
						metrics.authenticationRejected++;
						log({ event: "authentication_rejected" });
						ws.close(4401, "authentication failed");
					} finally {
						ws.data.authenticating = false;
					}
					return;
				}
				if (typeof message === "string") return;
				const room = rooms.get(ws.data.roomId);
				if (!room || message.byteLength < ENVELOPE_HEADER_LENGTH) return;
				room.lastActivityAt = Date.now();
				const view = new DataView(message.buffer, message.byteOffset, ENVELOPE_HEADER_LENGTH);
				if (ws.data.role === "host") {
					metrics.framesFromHosts++;
					const peerId = view.getUint32(0, false);
					if (peerId === 0) {
						for (const guest of room.guests.values()) guest.send(message);
					} else {
						room.guests.get(peerId)?.send(message);
					}
					return;
				}
				metrics.framesFromGuests++;
				view.setUint32(0, ws.data.peerId, false);
				room.host.send(message);
			},
			close(ws): void {
				sockets.delete(ws);
				if (ws.data.authTimer) {
					clearTimeout(ws.data.authTimer);
					ws.data.authTimer = undefined;
				}
				if (!ws.data.registered) return;
				const room = rooms.get(ws.data.roomId);
				if (!room) return;
				if (ws.data.role === "host") {
					if (room.host !== ws) return;
					closeRoom(ws.data.roomId, room, "room closed", false);
					return;
				}
				if (room.guests.delete(ws.data.peerId)) {
					room.lastActivityAt = Date.now();
					room.host.send(JSON.stringify({ t: "peer-left", peer: ws.data.peerId }));
				}
			},
		},
	});

	const pingTimer = setInterval(() => {
		const now = Date.now();
		for (const [roomId, room] of rooms) {
			const idle = now - room.lastActivityAt >= roomIdleTimeoutMs;
			const overAge = now - room.openedAt >= roomMaxAgeMs;
			if (idle || overAge) {
				metrics.expiredRooms++;
				closeRoom(roomId, room, idle ? "room idle timeout" : "room maximum age reached", true);
			}
		}
		for (const socket of sockets) socket.ping();
	}, pingIntervalMs);
	pingTimer.unref();
	const cleanupTimer = setInterval(() => {
		pruneRateWindows(shareUploadWindows, shareUploadWindowMs, Date.now());
		pruneRateWindows(browserChallengeWindows, browserChallengeWindowMs, Date.now());
		browserAuthorizationStore.cleanup();
		void options.shareStore
			.cleanup()
			.then(deleted => {
				if (deleted > 0) log({ event: "shares_expired", count: deleted });
			})
			.catch(error => {
				metrics.shareStoreErrors++;
				log({ event: "share_cleanup_failed", error: String(error) });
			});
	}, cleanupIntervalMs);
	cleanupTimer.unref();

	const boundPort = server.port;
	if (boundPort === undefined) throw new Error("relay did not bind a TCP port");
	log({ event: "relay_started", port: boundPort });
	return {
		url: `http://${server.hostname === "0.0.0.0" ? "127.0.0.1" : server.hostname}:${boundPort}`,
		async stop(): Promise<void> {
			clearInterval(pingTimer);
			clearInterval(cleanupTimer);
			for (const socket of sockets) socket.close(1001, "relay shutting down");
			sockets.clear();
			rooms.clear();
			hostRoomsByClient.clear();
			shareUploadWindows.clear();
			browserChallengeWindows.clear();
			const stopping = server.stop(true);
			if (shutdownTimeoutMs > 0) await Promise.race([stopping, Bun.sleep(shutdownTimeoutMs)]);
			else void stopping;
		},
	};
}

async function fileResponse(filePath: string, head: boolean, cacheControl: string, csp: string): Promise<Response> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) return textResponse("not found", 404);
	return new Response(head ? null : file, {
		headers: {
			...responseHeaders(file.type || "application/octet-stream", cacheControl),
			"Content-Length": String(file.size),
			"Content-Security-Policy": csp,
		},
	});
}

function responseHeaders(contentType: string, cacheControl: string): Record<string, string> {
	return {
		"Cache-Control": cacheControl,
		"Content-Type": contentType,
		"Cross-Origin-Opener-Policy": "same-origin",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options": "DENY",
	};
}

function textResponse(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: responseHeaders("text/plain; charset=utf-8", "no-store"),
	});
}

function jsonResponse(value: unknown, status: number): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: responseHeaders("application/json; charset=utf-8", "no-store"),
	});
}

function unauthorizedResponse(): Response {
	return new Response("authentication required", {
		status: 401,
		headers: {
			...responseHeaders("text/plain; charset=utf-8", "no-store"),
			"WWW-Authenticate": "Bearer",
		},
	});
}

function bearerToken(request: Request): string | null {
	const value = request.headers.get("authorization");
	if (!value?.startsWith("Bearer ")) return null;
	const token = value.slice("Bearer ".length).trim();
	return token && token.length <= 16_384 ? token : null;
}

function isJsonRequest(request: Request): boolean {
	return request.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body: unknown = await request.json();
		return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function rateLimitResponse(retryAfterSeconds: number, operation = "share upload"): Response {
	return new Response(`${operation} rate limit exceeded`, {
		status: 429,
		headers: {
			...responseHeaders("text/plain; charset=utf-8", "no-store"),
			"Retry-After": String(retryAfterSeconds),
		},
	});
}

function resolveClientKey(request: Request, server: Bun.Server<SocketData>, trustedProxyHops: number): string {
	const forwarded = request.headers.get("x-forwarded-for");
	if (trustedProxyHops > 0 && forwarded) {
		const chain = forwarded.split(",");
		const index = chain.length - trustedProxyHops;
		const address = index >= 0 ? chain[index]?.trim() : undefined;
		if (address) return address.slice(0, 128);
	}
	return server.requestIP(request)?.address ?? "unknown";
}

function consumeRateWindow(
	windows: Map<string, ClientRateWindow>,
	clientKey: string,
	limit: number,
	windowMs: number,
	now: number,
): number | null {
	let window = windows.get(clientKey);
	if (window && now - window.startedAt >= windowMs) {
		windows.delete(clientKey);
		window = undefined;
	}
	if (!window) {
		if (windows.size >= MAX_TRACKED_UPLOAD_CLIENTS) {
			pruneRateWindows(windows, windowMs, now);
			if (windows.size >= MAX_TRACKED_UPLOAD_CLIENTS) return Math.max(1, Math.ceil(windowMs / 1_000));
		}
		windows.set(clientKey, { startedAt: now, count: 1 });
		return null;
	}
	if (window.count >= limit) {
		return Math.max(1, Math.ceil((window.startedAt + windowMs - now) / 1_000));
	}
	window.count++;
	return null;
}

function pruneRateWindows(windows: Map<string, ClientRateWindow>, windowMs: number, now: number): void {
	for (const [clientKey, window] of windows) {
		if (now - window.startedAt >= windowMs) windows.delete(clientKey);
	}
}

function decodePathname(pathname: string): string | null {
	try {
		const decoded = decodeURIComponent(pathname);
		return decoded.includes("\0") || decoded.includes("\\") ? null : decoded;
	} catch {
		return null;
	}
}

function renderMetrics(rooms: number, guests: number, metrics: RelayMetrics, store: ShareStoreStats): string {
	return [
		"# TYPE omp_relay_active_rooms gauge",
		`omp_relay_active_rooms ${rooms}`,
		"# TYPE omp_relay_active_guests gauge",
		`omp_relay_active_guests ${guests}`,
		"# TYPE omp_relay_frames_total counter",
		`omp_relay_frames_total{direction="host"} ${metrics.framesFromHosts}`,
		`omp_relay_frames_total{direction="guest"} ${metrics.framesFromGuests}`,
		"# TYPE omp_relay_share_uploads_total counter",
		`omp_relay_share_uploads_total ${metrics.shareUploads}`,
		"# TYPE omp_relay_share_reads_total counter",
		`omp_relay_share_reads_total ${metrics.shareReads}`,
		"# TYPE omp_relay_share_upload_rate_limited_total counter",
		`omp_relay_share_upload_rate_limited_total ${metrics.shareUploadRateLimited}`,
		"# TYPE omp_relay_share_capacity_rejected_total counter",
		`omp_relay_share_capacity_rejected_total ${metrics.shareCapacityRejected}`,
		"# TYPE omp_relay_share_store_errors_total counter",
		`omp_relay_share_store_errors_total ${metrics.shareStoreErrors}`,
		"# TYPE omp_relay_rejected_connections_total counter",
		`omp_relay_rejected_connections_total ${metrics.rejectedConnections}`,
		"# TYPE omp_relay_expired_rooms_total counter",
		`omp_relay_expired_rooms_total ${metrics.expiredRooms}`,
		"# TYPE omp_relay_authentication_rejected_total counter",
		`omp_relay_authentication_rejected_total ${metrics.authenticationRejected}`,
		"# TYPE omp_relay_browser_challenges_total counter",
		`omp_relay_browser_challenges_total ${metrics.browserChallenges}`,
		"# TYPE omp_relay_browser_sessions_total counter",
		`omp_relay_browser_sessions_total ${metrics.browserSessions}`,
		"# TYPE omp_relay_share_store_bytes gauge",
		`omp_relay_share_store_bytes ${store.bytes}`,
		"# TYPE omp_relay_share_store_capacity_bytes gauge",
		`omp_relay_share_store_capacity_bytes ${store.capacityBytes}`,
		"",
	].join("\n");
}
