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
import { ConcatSink, logger, readLines } from "@oh-my-pi/pi-utils";
import { untilAborted } from "@oh-my-pi/pi-utils/abortable";

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
	/** Answers one request; rejected attempts become per-request error replies. */
	route(req: Request): Promise<Response>;
	/** Reported on the ready line. */
	version?: string;
	/** Caller-owned shutdown; aborts input and pending request waits. */
	signal?: AbortSignal;
	/** Active requests, including responses waiting for output completion. Defaults to 4. */
	maxConcurrentRequests?: number;
	/** Maximum streamed response body size in bytes. Defaults to 16 MiB. */
	maxResponseBytes?: number;
}

/** Origin of the `Request`s built from input lines; only the path reaches the routes. */
const STDIO_ORIGIN = "http://stdio";

/** Serves `opts.input` until it ends and every request it carried is answered. */
export async function serveAuthGatewayStdio(opts: AuthGatewayStdioOptions): Promise<void> {
	const maxConcurrentRequests = opts.maxConcurrentRequests ?? 4;
	const maxResponseBytes = opts.maxResponseBytes ?? 16 * 1024 * 1024;
	if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
		throw new RangeError("maxConcurrentRequests must be a positive safe integer");
	}
	validateResponseLimit(maxResponseBytes);
	const controller = new AbortController();
	const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal;
	const inFlight = new Set<Promise<void>>();
	let writeFailed = false;
	let writeFailure: unknown;
	const failWrite = (error: unknown) => {
		if (!writeFailed) {
			writeFailed = true;
			writeFailure = error;
			controller.abort(error);
		}
	};
	const writeLine = async (frame: unknown): Promise<void> => {
		if (writeFailed) return;
		let written: Promise<void>;
		try {
			written = Promise.resolve(opts.write(`${JSON.stringify(frame)}\n`));
		} catch (error) {
			failWrite(error);
			throw error;
		}
		void written.catch(failWrite);
		try {
			await untilAborted(signal, written);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	};
	const decoder = new TextDecoder();
	try {
		await writeLine({ ready: true, version: opts.version });
		for await (const line of readLines(opts.input, signal)) {
			if (signal.aborted) break;
			const text = decoder.decode(line).trim();
			if (!text) continue;
			const request = parseRequest(text, signal);
			if ("error" in request) {
				await writeLine({
					id: request.id,
					status: 400,
					body: { error: { message: request.error, type: "invalid_request_error" } },
				});
				continue;
			}
			const answered = untilAborted(signal, () =>
				opts.route(request.req).then(response => readResponse(response, signal, maxResponseBytes)),
			).then(
				response => writeLine({ id: request.id, ...response }),
				(error: unknown) => {
					const limited = error instanceof AuthGatewayStdioResponseLimitError;
					if (!signal.aborted && !limited) {
						logger.error("auth-gateway stdio request failed", { error: String(error) });
					}
					return writeLine({
						id: request.id,
						status: signal.aborted ? 499 : limited ? 502 : 500,
						body: {
							error: {
								message: signal.aborted ? "request aborted" : limited ? error.message : "internal error",
								type: signal.aborted ? "request_aborted" : limited ? "response_limit_error" : "server_error",
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
					failWrite(error);
				},
			);
			if (inFlight.size >= maxConcurrentRequests) {
				try {
					await untilAborted(signal, () => Promise.race(inFlight));
				} catch (error) {
					if (!signal.aborted) throw error;
					break;
				}
			}
		}
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		if (signal.aborted && !opts.input.locked) {
			void opts.input.cancel(signal.reason).catch(() => {});
		}
		await Promise.allSettled(inFlight);
	}
	if (writeFailed) throw writeFailure;
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

export class AuthGatewayStdioResponseLimitError extends Error {
	constructor(readonly maxBytes: number) {
		super(`Response exceeds the ${maxBytes} byte stdio limit`);
		this.name = "AuthGatewayStdioResponseLimitError";
	}
}

function validateResponseLimit(maxBytes: number): void {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError("maxResponseBytes must be a non-negative safe integer");
	}
}

/** Reads actual streamed bytes, cancelling and releasing the source on failure. */
export async function readAuthGatewayStdioBody(
	response: Response,
	signal?: AbortSignal,
	maxBytes = 16 * 1024 * 1024,
): Promise<Uint8Array> {
	validateResponseLimit(maxBytes);
	if (!response.body) {
		signal?.throwIfAborted();
		return new Uint8Array(0);
	}
	const reader = response.body.getReader();
	const buffer = new ConcatSink();
	let size = 0;
	let cancelled = false;
	const cancel = (reason?: unknown) => {
		if (cancelled) return;
		cancelled = true;
		void reader.cancel(reason).catch(() => {});
	};
	const onAbort = () => cancel(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		for (;;) {
			signal?.throwIfAborted();
			const { done, value } = await untilAborted(signal, () => reader.read());
			signal?.throwIfAborted();
			if (done) {
				return buffer.flush() ?? new Uint8Array(0);
			}
			if (value.byteLength > maxBytes - size) {
				throw new AuthGatewayStdioResponseLimitError(maxBytes);
			}
			size += value.byteLength;
			buffer.append(value);
		}
	} catch (error) {
		const failure = signal?.aborted ? signal.reason : error;
		cancel(failure);
		throw failure;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}

/** A whole response as a line's `status`/`body`/`encoding`. */
async function readResponse(
	response: Response,
	signal: AbortSignal,
	maxBytes: number,
): Promise<Omit<StdioResponse, "id">> {
	const type = response.headers.get("content-type") ?? "";
	const bytes = await readAuthGatewayStdioBody(response, signal, maxBytes);
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
