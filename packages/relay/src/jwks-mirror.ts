const port = integerEnv("PORT", 8081, 1, 65_535);
const refreshSeconds = integerEnv("JWKS_REFRESH_SECONDS", 60 * 60, 60, 24 * 60 * 60);
const upstream = validateUpstream(process.env.JWKS_UPSTREAM_URL ?? "");

let cached: string | null = null;
let refreshedAt = 0;
let refreshing: Promise<void> | null = null;

async function refresh(): Promise<void> {
	if (refreshing) return refreshing;
	refreshing = (async () => {
		const response = await fetch(upstream, { redirect: "error", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`upstream JWKS returned HTTP ${response.status}`);
		const contentLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > 64 * 1024) throw new Error("upstream JWKS is too large");
		const text = await response.text();
		if (text.length > 64 * 1024) throw new Error("upstream JWKS is too large");
		const value = JSON.parse(text) as { keys?: unknown };
		if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 20) {
			throw new Error("upstream JWKS is invalid");
		}
		cached = JSON.stringify(value);
		refreshedAt = Date.now();
	})().finally(() => {
		refreshing = null;
	});
	return refreshing;
}

await refresh();

const server = Bun.serve({
	hostname: process.env.HOST ?? "0.0.0.0",
	port,
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "GET" && request.method !== "HEAD")
			return new Response("method not allowed", { status: 405 });
		if (url.pathname === "/healthz") {
			return new Response(cached ? "ok" : "unavailable", { status: cached ? 200 : 503 });
		}
		if (url.pathname !== "/jwks") return new Response("not found", { status: 404 });
		if (Date.now() - refreshedAt >= refreshSeconds * 1_000) {
			try {
				await refresh();
			} catch (error) {
				console.error(JSON.stringify({ event: "jwks_refresh_failed", error: String(error) }));
			}
		}
		if (!cached) return new Response("JWKS unavailable", { status: 503 });
		return new Response(request.method === "HEAD" ? null : cached, {
			headers: {
				"Cache-Control": "public, max-age=3600",
				"Content-Type": "application/json; charset=utf-8",
				"X-Content-Type-Options": "nosniff",
			},
		});
	},
});

const timer = setInterval(() => {
	void refresh().catch(error => {
		console.error(JSON.stringify({ event: "jwks_refresh_failed", error: String(error) }));
	});
}, refreshSeconds * 1_000);
timer.unref();

const shutdown = (): void => {
	clearInterval(timer);
	void server.stop(true);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
console.log(JSON.stringify({ event: "jwks_mirror_started", port: server.port }));

function validateUpstream(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("JWKS_UPSTREAM_URL must be a valid URL");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		!url.hostname.endsWith(".tokens.sts.global.api.aws") ||
		url.pathname !== "/.well-known/jwks.json" ||
		url.search ||
		url.hash
	) {
		throw new Error("JWKS_UPSTREAM_URL must be an AWS STS identity-token JWKS endpoint");
	}
	return url.href;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
	}
	return value;
}
