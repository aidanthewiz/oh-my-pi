/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint for authenticated Puppeteer clients:
 * - `GET /json/version` → public liveness; returns 503 metadata until the extension connects.
 * - `GET /json` / `/json/list` → token-gated attachable page targets.
 * - `WS /cdp` → token-gated downstream CDP clients; a tab worker adds `?claim=<targetId>` for its tab.
 * - `WS /ext` → token-gated Chrome extension.
 *
 * Binds loopback only. Every endpoint that can inspect or drive browser state
 * requires the machine-local shared secret.
 */
import { macOSFrontApp } from "@oh-my-pi/pi-natives";
import { parseFlag } from "@oh-my-pi/pi-utils";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { RelayBridge, type RelayBridgeExtensionUpdater } from "./bridge";
import {
	defaultRelayExtensionDir,
	installedRelayExtensionVersion,
	unpackedExtensionId,
	writeRelayExtension,
} from "./extension-files";
import { isOlderOmpVersion } from "./protocol";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Nonempty shared secret required by extension and CDP websocket clients. */
	token: string;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	/**
	 * The extension copy this relay keeps current: an older extension Chrome loaded from here is rewritten and
	 * reloaded (default: `omp browser-relay install`'s directory).
	 */
	extensionDir?: string;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

function authorized(url: URL, token: string): boolean {
	return token.length > 0 && url.searchParams.get("token") === token;
}

/**
 * Updates the extension when Chrome loaded it from `dir`: an extension loaded from elsewhere (`install --dir`, a
 * development build) is not this relay's to rewrite, and files a newer omp wrote are left for that omp's relay.
 * Calls run one at a time: Chrome profiles that load the same folder share its files, and a later call finds them
 * already current.
 */
function extensionUpdaterFor(dir: string): RelayBridgeExtensionUpdater {
	let queue: Promise<unknown> = Promise.resolve();
	const update = async (extensionId: string) => {
		if ((await unpackedExtensionId(dir)) !== extensionId) return false;
		if (isOlderOmpVersion(VERSION, await installedRelayExtensionVersion(dir))) return false;
		await writeRelayExtension(dir, VERSION);
		return true;
	};
	return extensionId => {
		const result = queue.then(() => update(extensionId));
		queue = result.catch(() => {});
		return result;
	};
}

/** `chrome-extension://<id>` → `<id>`; anything else → undefined. */
const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;

/** Body of the 503 `/json/version` answer while no extension is connected. */
export interface RelayUnavailableInfo {
	/** Version of the OMP binary serving this relay. */
	ompRelayVersion: string;
	error: string;
	/** An extension completed the hello handshake at least once in this server's lifetime. */
	extensionSeen: boolean;
	/** Milliseconds this server has been listening. */
	uptimeMs: number;
	/** Downstream CDP clients connected to this relay. */
	ompRelayCdpClients: number;
	/** Milliseconds since the last connected extension went away; absent if none has connected yet. */
	disconnectedMs?: number;
}

/** A running relay server. */
export interface RelayServer {
	bridge: RelayBridge;
	port: number;
	stop(): void;
}

interface SocketData {
	role: "cdp" | "ext";
	connId?: number;
	/** The Chrome extension id an `ext` upgrade's `Origin` named. */
	extensionId?: string;
	/** The target a connecting omp tab worker drives (`/cdp?claim=`). */
	claim?: string;
}

type RelayWebSocket = Bun.ServerWebSocket<SocketData>;

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the Coreforge tab group. */
const DEFAULT_GROUP = { title: "coreforge", color: "cyan" } as const;
/** True when `raw` can serve as the authority of a `ws://` URL. */
function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

/** Start the relay server on 127.0.0.1. Throws if the port is taken. */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const token = opts.token.trim();
	if (token === "") throw new Error("Browser relay token must be nonempty");
	const log = opts.log ?? (() => {});
	const group =
		opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const updateExtension = extensionUpdaterFor(opts.extensionDir ?? defaultRelayExtensionDir());
	const bridge = new RelayBridge({ log, group, updateExtension });
	const sockets = new Set<RelayWebSocket>();
	const startedAt = Date.now();
	// Only macOS can hand the front app back; elsewhere the relay never reads it.
	if (process.platform === "darwin" && parseFlag(process.env.PI_BROWSER_RELAY_KEEP_FRONT, true)) {
		bridge.keepFrontAppWith(macOSFrontApp);
	}

	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: opts.port,
		fetch(req, srv): Response | undefined {
			const fallback = `127.0.0.1:${opts.port}`;
			const rawHost = req.headers.get("host")?.trim();
			const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
			const requestUrl =
				rawHost && rawHost !== host && req.url.startsWith(`http://${rawHost}`)
					? req.url.slice(`http://${rawHost}`.length)
					: req.url;
			const url = new URL(requestUrl, `http://${fallback}`);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (path === "/cdp") {
				// Browsers set Origin on websocket upgrades; native CDP clients
				// don't. Reject any Origin so a web page can't drive the relay.
				if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
				if (!authorized(url, token)) return new Response("Unauthorized", { status: 401 });
				const data: SocketData = { role: "cdp", claim: url.searchParams.get("claim") ?? undefined };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (path === "/ext") {
				const origin = req.headers.get("origin");
				if (origin && !origin.startsWith("chrome-extension://")) {
					return new Response("Forbidden", { status: 403 });
				}
				if (!authorized(url, token)) return new Response("Unauthorized", { status: 401 });
				const data: SocketData = { role: "ext", extensionId: origin?.match(EXTENSION_ORIGIN)?.[1] };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (path === "/json/version") {
				if (!bridge.ready) {
					const disconnectedMs = bridge.extensionGoneForMs;
					const info: RelayUnavailableInfo = {
						ompRelayVersion: VERSION,
						error: "relay extension is not connected",
						extensionSeen: bridge.extensionSeen,
						uptimeMs: Date.now() - startedAt,
						ompRelayCdpClients: bridge.cdpClientCount,
						...(disconnectedMs === null ? {} : { disconnectedMs }),
					};
					return Response.json(info, { status: 503 });
				}
				return Response.json(bridge.versionInfo(`ws://${host}/cdp`));
			}
			if (path === "/json" || path === "/json/list") {
				if (!authorized(url, token)) return new Response("Unauthorized", { status: 401 });
				return Response.json(bridge.listTargets());
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: MAX_PAYLOAD_BYTES,
			// Disabled: Bun caps idleTimeout at 255s, and the keepalive pings
			// below already detect dead peers via the websocket close path.
			idleTimeout: 0,
			open(ws: RelayWebSocket): void {
				sockets.add(ws);
				if (ws.data.role === "ext") {
					bridge.extConnected(ws, ws.data.extensionId);
				} else {
					ws.data.connId = bridge.cdpConnected(ws, ws.data.claim);
				}
			},
			message(ws: RelayWebSocket, message: string | Buffer): void {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				if (ws.data.role === "ext") {
					bridge.extMessage(ws, text);
				} else if (ws.data.connId !== undefined) {
					bridge.cdpMessage(ws.data.connId, text);
				}
			},
			close(ws: RelayWebSocket): void {
				sockets.delete(ws);
				if (ws.data.role === "ext") {
					bridge.extClosed(ws);
				} else if (ws.data.connId !== undefined) {
					bridge.cdpClosed(ws.data.connId);
				}
			},
		},
	});

	// Puppeteer connections go silent while the agent is idle; protocol-level
	// pings count as activity and keep them under the idle timeout.
	const keepalive = setInterval(() => {
		for (const ws of sockets) ws.ping();
	}, WS_KEEPALIVE_MS);
	keepalive.unref();

	log("relay listening", { port: opts.port });
	return {
		bridge,
		port: opts.port,
		stop() {
			clearInterval(keepalive);
			server.stop(true);
		},
	};
}
