/**
 * HTTP + WebSocket server for the browser relay.
 *
 * Impersonates Chrome's CDP discovery endpoint for authenticated Puppeteer clients:
 * - `GET /json/version` → public liveness and an uncredentialed WebSocket path.
 * - `GET /json` / `/json/list` → token-gated attachable page targets.
 * - `WS /cdp` → token-gated downstream CDP clients.
 * - `WS /ext` → token-gated Chrome extension.
 *
 * Binds loopback only. Every endpoint that can inspect or drive browser state
 * requires the machine-local shared secret.
 */
import { RelayBridge } from "./bridge";

/** Options for {@link startRelayServer}. */
export interface RelayServerOptions {
	port: number;
	/** Nonempty shared secret required by extension and CDP websocket clients. */
	token: string;
	/** Group tabs the agent actively drives under one per-window Chrome tab group (default on); `false` disables. */
	group?: boolean | { title: string; color: string };
	log?: (message: string, data?: Record<string, unknown>) => void;
}

function authorized(url: URL, token: string): boolean {
	return token.length > 0 && url.searchParams.get("token") === token;
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
}

type RelayWebSocket = Bun.ServerWebSocket<SocketData>;

const WS_KEEPALIVE_MS = 30_000;
/** Screenshots travel base64-encoded through both websocket legs. */
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/** Default appearance of the Coreforge tab group. */
const DEFAULT_GROUP = { title: "coreforge", color: "cyan" } as const;

/** Start the relay server on 127.0.0.1. Throws if the port is taken. */
export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const token = opts.token.trim();
	if (token === "") throw new Error("Browser relay token must be nonempty");
	const log = opts.log ?? (() => {});
	const group =
		opts.group === false ? null : opts.group === true || opts.group === undefined ? DEFAULT_GROUP : opts.group;
	const bridge = new RelayBridge({ log, group });
	const sockets = new Set<RelayWebSocket>();

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (path === "/cdp") {
				// Browsers set Origin on websocket upgrades; native CDP clients
				// don't. Reject any Origin so a web page can't drive the relay.
				if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
				if (!authorized(url, token)) return new Response("Unauthorized", { status: 401 });
				const data: SocketData = { role: "cdp" };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (path === "/ext") {
				const origin = req.headers.get("origin");
				if (origin && !origin.startsWith("chrome-extension://")) {
					return new Response("Forbidden", { status: 403 });
				}
				if (!authorized(url, token)) return new Response("Unauthorized", { status: 401 });
				const data: SocketData = { role: "ext" };
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("websocket upgrade required", { status: 426 });
			}
			if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
			if (path === "/json/version") {
				if (!bridge.ready) {
					return Response.json({ error: "relay extension is not connected" }, { status: 503 });
				}
				return Response.json(bridge.versionInfo(`ws://127.0.0.1:${opts.port}/cdp`));
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
					bridge.extConnected(ws);
				} else {
					ws.data.connId = bridge.cdpConnected(ws);
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
