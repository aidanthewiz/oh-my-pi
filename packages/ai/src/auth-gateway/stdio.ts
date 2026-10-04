/**
 * The auth-gateway's routes over JSON lines, for a parent process that owns
 * the gateway as its child: one request per input line, one response per
 * output line.
 *
 * ```text
 * → {"id": 1, "path": "/v1/chat/completions", "body": {"model": "…", "messages": […]}}
 * ← {"id": 1, "status": 200, "body": {"choices": […]}}
 * ```
 *
 * The first output line is `{"ready": true, "version": "…"}`. `method`
 * defaults to `POST` when a request carries a `body` and to `GET` otherwise.
 * Requests run concurrently and answer in completion order, matched by `id`
 * (a string or number). A JSON response body is embedded as JSON, a text one
 * (a `stream: true` reply's SSE) as a string, anything else (audio, video) as
 * base64 with `"encoding": "base64"`. A line that is not a request answers
 * status 400 with the `id` it carried, if any. Serving ends once input ends
 * and every request has been answered.
 */
import { logger, readLines, untilAborted } from "@oh-my-pi/pi-utils";

/** Request ids are opaque to the transport: echoed back as received. */
type StdioId = string | number;

/** One response line. */
interface StdioResponse {
	id: StdioId | null;
	status: number;
	body: unknown;
	encoding?: "base64";
}

export interface AuthGatewayStdioOptions {
	/** Request lines. */
	input: ReadableStream<Uint8Array>;
	/** Writes one response line, newline included. */
	write(line: string): void | Promise<void>;
	/** Answers one request; never rejects (the gateway router's `route`, or a wrapper around it). */
	route(req: Request): Promise<Response>;
	/** Reported on the ready line. */
	version?: string;
	/** Caller-owned shutdown; aborts input and pending request waits. */
	signal?: AbortSignal;
}

/** Origin of the `Request`s built from input lines; only the path reaches the routes. */
const STDIO_ORIGIN = "http://stdio";

/** Serves `opts.input` until it ends and every request it carried is answered. */
export async function serveAuthGatewayStdio(opts: AuthGatewayStdioOptions): Promise<void> {
	const send = (response: StdioResponse): void | Promise<void> => opts.write(`${JSON.stringify(response)}\n`);
	await opts.write(`${JSON.stringify({ ready: true, version: opts.version })}\n`);
	const controller = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
	const inFlight = new Set<Promise<void>>();
	let writeFailure: unknown;
	const decoder = new TextDecoder();
	try {
		for await (const line of readLines(opts.input, signal)) {
			const text = decoder.decode(line).trim();
			if (!text) continue;
			const request = parseRequest(text, signal);
			if ("error" in request) {
				await send({
					id: request.id,
					status: 400,
					body: { error: { message: request.error, type: "invalid_request_error" } },
				});
				continue;
			}
			const answered = untilAborted(signal, () => opts.route(request.req).then(readResponse)).then(
				response => send({ id: request.id, ...response }),
				(error: unknown) => {
					if (!signal.aborted) logger.error("auth-gateway stdio request failed", { error: String(error) });
					return send({
						id: request.id,
						status: signal.aborted ? 499 : 500,
						body: {
							error: {
								message: signal.aborted ? "request aborted" : "internal error",
								type: signal.aborted ? "request_aborted" : "server_error",
							},
						},
					});
				},
			);
			inFlight.add(answered);
			void answered.then(
				() => inFlight.delete(answered),
				error => {
					inFlight.delete(answered);
					writeFailure ??= error;
					controller.abort(error);
				},
			);
		}
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		await Promise.allSettled(inFlight);
	}
	if (writeFailure !== undefined) throw writeFailure;
}

/** A request line as a `Request`, or why it isn't one (with its `id` when it had a usable one). */
function parseRequest(
	text: string,
	signal: AbortSignal,
): { id: StdioId; req: Request } | { id: StdioId | null; error: string } {
	let frame: unknown;
	try {
		frame = JSON.parse(text);
	} catch (error) {
		return { id: null, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
		return { id: null, error: "A request is a JSON object" };
	}
	const { id, method, path, body } = frame as Record<string, unknown>;
	if (typeof id !== "string" && typeof id !== "number") {
		return { id: null, error: "`id` must be a string or a number" };
	}
	if (typeof path !== "string" || !path.startsWith("/")) {
		return { id, error: "`path` must be an absolute path such as /v1/chat/completions" };
	}
	if (method !== undefined && typeof method !== "string") {
		return { id, error: "`method` must be a string" };
	}
	const init: RequestInit =
		body === undefined
			? { method: method ?? "GET" }
			: { method: method ?? "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
	try {
		return { id, req: new Request(`${STDIO_ORIGIN}${path}`, { ...init, signal }) };
	} catch (error) {
		return { id, error: error instanceof Error ? error.message : String(error) };
	}
}

/** A whole response as a line's `status`/`body`/`encoding`. */
async function readResponse(response: Response): Promise<Omit<StdioResponse, "id">> {
	const type = response.headers.get("content-type") ?? "";
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0) return { status: response.status, body: null };
	if (type.includes("json")) {
		const text = new TextDecoder().decode(bytes);
		try {
			return { status: response.status, body: JSON.parse(text) };
		} catch {
			return { status: response.status, body: text };
		}
	}
	if (type.startsWith("text/")) return { status: response.status, body: new TextDecoder().decode(bytes) };
	return { status: response.status, body: bytes.toBase64(), encoding: "base64" };
}
