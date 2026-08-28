/**
 * Browser relay mode: drive the user's own Chrome tabs through the local CDP
 * relay served by `omp browser-relay` (sibling `server.ts`/`bridge.ts`) plus
 * its companion extension (`packages/browser-relay`, installed via
 * `omp browser-relay install`). The relay impersonates Chrome's CDP discovery
 * endpoint, so beyond kind resolution the entire connected-browser machinery
 * (registry, tab supervisor, tab workers) applies unchanged.
 */
import { parseFlag } from "@oh-my-pi/pi-utils";

/** Browser kind selecting the omp browser relay. */
export interface RelayKind {
	kind: "relay";
	cdpUrl: string;
}

/** Default endpoint of the `omp-browser-relay` CLI. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:9224";

/**
 * Build the authenticated CDP WebSocket endpoint on the configured relay
 * authority. Discovery controls only the expected `/cdp` path; it cannot
 * redirect the machine-local token to another host.
 */
export function resolveRelayWebSocketEndpoint(cdpUrl: string, advertisedUrl: string, token: string): string {
	const advertised = new URL(advertisedUrl, cdpUrl);
	if (
		(advertised.protocol !== "ws:" && advertised.protocol !== "wss:") ||
		advertised.pathname.replace(/\/+$/, "") !== "/cdp"
	) {
		throw new Error("invalid relay CDP websocket endpoint");
	}
	const endpoint = new URL(cdpUrl);
	if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
		throw new Error("relay discovery endpoint must use HTTP or HTTPS");
	}
	endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
	endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/cdp`;
	endpoint.search = "";
	endpoint.hash = "";
	endpoint.searchParams.set("token", token);
	return endpoint.toString();
}

export interface ResolveRelayKindOptions {
	/** `browser.relay` setting; `PI_BROWSER_RELAY=0|1` overrides it. */
	settingEnabled?: boolean;
	/** `browser.relayUrl` setting; falls back to {@link DEFAULT_RELAY_URL}. */
	url?: string;
}

/**
 * Resolve the relay browser kind, or null when relay mode is disabled.
 * Mirrors `resolveCmuxKind`: the setting opts in, the env var is the final
 * override in both directions.
 */
export function resolveRelayKind(
	options?: ResolveRelayKindOptions | null,
	env: Record<string, string | undefined> = process.env,
): RelayKind | null {
	if (!parseFlag(env.PI_BROWSER_RELAY, options?.settingEnabled ?? false)) {
		return null;
	}
	const url = options?.url?.trim() || DEFAULT_RELAY_URL;
	return { kind: "relay", cdpUrl: url.replace(/\/+$/, "") };
}
