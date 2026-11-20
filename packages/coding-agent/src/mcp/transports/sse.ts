import * as AIError from "@oh-my-pi/pi-ai/error";
import { logger, postmortem, readSseEvents } from "@oh-my-pi/pi-utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import {
	createMCPHttpStatusError,
	createMCPJsonRpcError,
	MCPTransportError,
	nonRetryableMCPTransportError,
	normalizeMCPTransportError,
} from "../errors";
import { RequestIdAllocator } from "../request-id";
import { routeProgressNotification, withProgressToken } from "../progress";
import { createMCPTimeout, getNeverAbortSignal, resolveMCPTimeoutMs } from "../timeout";
import { type MCPFetchInit, mcpFetch } from "./header-policy";

interface MCPTimeoutOperation {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
	timedOut: () => boolean;
}

interface PendingLegacySseRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	operation: MCPTimeoutOperation;
	postController: AbortController;
	abortHandler?: () => void;
	onProgress?: MCPRequestOptions["onProgress"];
}

/** Identifies a legacy SSE transport whose endpoint handshake timed out. */
export class LegacySseConnectionTimeoutError extends Error {
	constructor(timeoutMs: number) {
		super(`Legacy SSE endpoint timeout after ${timeoutMs}ms`);
		this.name = "LegacySseConnectionTimeoutError";
	}
}

/** Legacy MCP HTTP+SSE transport from protocol revision 2024-11-05. */
export class LegacySseTransport implements MCPTransport {
	#connected = false;
	#endpointUrl: string | null = null;
	#sseConnection: AbortController | null = null;
	#lifecycleController = new AbortController();
	#pending = new Map<string | number, PendingLegacySseRequest>();
	#config: MCPSseServerConfig;
	readonly #requestIds = new RequestIdAllocator();

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(config: MCPSseServerConfig) {
		this.#config = config;
	}

	/** Fetch an endpoint with header precedence and origin policy. */
	#fetch(url: string, init: MCPFetchInit, generated: Record<string, string>): Promise<Response> {
		return mcpFetch(
			url,
			init,
			{ generated, configured: this.#config.headers },
			this.#config.headerPolicy === "origin-locked",
		);
	}

	/**
	 * Combine caller cancellation with transport shutdown for every HTTP
	 * operation, so `close()` ends an in-flight POST as well as the GET stream.
	 * Deadlines remain configured-only: this composes cancellation, never a
	 * timer.
	 */
	#operationSignal(signal?: AbortSignal): AbortSignal {
		return signal ? AbortSignal.any([signal, this.#lifecycleController.signal]) : this.#lifecycleController.signal;
	}

	#assertLocalRequestOwner(options?: MCPRequestOptions): void {
		options?.signal?.throwIfAborted();
		if (options?.mcpOwnerCurrent?.() === false) {
			throw new DOMException("MCP request owner changed", "AbortError");
		}
	}

	async #assertRequestOwner(options?: MCPRequestOptions): Promise<void> {
		this.#assertLocalRequestOwner(options);
		if (options?.mcpCheckOwner) {
			await options.mcpCheckOwner();
			this.#assertLocalRequestOwner(options);
		}
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#config.url;
	}

	/** `signal` cancels only the wait for the endpoint event; an established stream outlives it. */
	async connect(signal?: AbortSignal): Promise<void> {
		if (this.#connected) return;
		if (this.#sseConnection) return;

		if (this.#lifecycleController.signal.aborted) {
			this.#lifecycleController = new AbortController();
		}
		signal?.throwIfAborted();
		const connection = new AbortController();
		const onAbort = () => connection.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal(connection.signal));
		const endpointReady = Promise.withResolvers<void>();
		this.#sseConnection = connection;

		try {
			const response = await this.#fetch(
				this.#config.url,
				{ method: "GET", signal: operation.signal },
				{ Accept: "text/event-stream" },
			);

			if (!response.ok) {
				const text = await response.text();
				throw createMCPHttpStatusError(response, text, { stage: "connect", retryable: false });
			}
			if (!response.body) {
				throw new Error("Legacy SSE response did not include a body");
			}

			void this.#readSSEStream(response.body, operation, endpointReady).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			});
			await endpointReady.promise;
		} catch (error) {
			operation.clear();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			connection.abort();
			if (operation.isTimeoutAbort(error)) {
				throw new LegacySseConnectionTimeoutError(timeout);
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async #readSSEStream(
		body: ReadableStream<Uint8Array>,
		operation: MCPTimeoutOperation,
		endpointReady: PromiseWithResolvers<void>,
	): Promise<void> {
		const signal = operation.signal ?? getNeverAbortSignal();
		let endpointReceived = false;
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.event === "endpoint") {
					if (!this.#endpointUrl) {
						const endpointUrl = new URL(event.data, this.#config.url);
						const configuredUrl = new URL(this.#config.url);
						if (endpointUrl.origin !== configuredUrl.origin) {
							throw new Error(
								`Legacy SSE endpoint origin mismatch: expected ${configuredUrl.origin}, received ${endpointUrl.origin}`,
							);
						}
						this.#endpointUrl = endpointUrl.href;
						this.#connected = true;
						endpointReceived = true;
						operation.clear();
						endpointReady.resolve();
					}
					continue;
				}
				if (event.data === "" || event.data === "[DONE]") continue;

				let payload: unknown;
				try {
					payload = JSON.parse(event.data) as unknown;
				} catch (error) {
					if (error instanceof SyntaxError) {
						throw new Error(`Legacy SSE message event contained non-JSON data: ${event.data}`);
					}
					throw error;
				}

				const messages = Array.isArray(payload) ? payload : [payload];
				for (const message of messages) {
					if (typeof message !== "object" || message === null) continue;
					this.#dispatchMessage(message as JsonRpcMessage);
				}
			}
			if (!endpointReceived) {
				endpointReady.reject(new Error("Legacy SSE endpoint event not received"));
			}
		} catch (error) {
			if (!endpointReceived) {
				endpointReady.reject(error);
			} else if (error instanceof Error && error.name !== "AbortError") {
				logger.debug("Legacy SSE stream error", { url: this.#config.url, error: error.message });
				this.onError?.(error);
				this.#rejectPending(
					nonRetryableMCPTransportError(
						normalizeMCPTransportError(error, { transport: "http", stage: "receive" }),
					),
				);
			}
		} finally {
			operation.clear();
			if (endpointReceived) {
				this.#rejectPending(
					new MCPTransportError({
						transport: "http",
						stage: "receive",
						failure: "closed",
						message: "Transport closed: legacy SSE stream closed",
						retryable: false,
					}),
				);
			}
		}
	}

	#dispatchMessage(message: JsonRpcMessage): void {
		if ("id" in message && ("result" in message || "error" in message)) {
			const pending = this.#pending.get(message.id);
			if (pending) {
				this.#pending.delete(message.id);
				const response = message as JsonRpcResponse;
				if (response.error) {
					pending.reject(createMCPJsonRpcError("http", response.error));
				} else {
					pending.resolve(response.result);
				}
				return;
			}
		}
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		if ("method" in message && !("id" in message)) {
			routeProgressNotification(message.method, message.params, token => this.#pending.get(token)?.onProgress);
			this.onNotification?.(message.method, message.params);
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		options?.signal?.throwIfAborted();
		await this.#assertRequestOwner(options);
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error("Transport not connected");
		}

		const id = this.#requestIds.next(this.#config.requestIdFormat);
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: options?.onProgress ? withProgressToken(params, id) : (params ?? {}),
		};
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const postController = new AbortController();
		const signal = options?.signal ? AbortSignal.any([options.signal, postController.signal]) : postController.signal;
		const operation = createMCPTimeout(timeout, this.#operationSignal(signal));
		const deferred = Promise.withResolvers<unknown>();
		// Observe the response promise synchronously so a stream-close rejection
		// from `#rejectPending` that lands while `request()` is still awaiting the
		// POST round-trip is never flagged as an unhandled rejection. The real
		// `await deferred.promise` below still receives and propagates the error.
		void deferred.promise.catch(() => undefined);
		const pending: PendingLegacySseRequest = {
			resolve: deferred.resolve,
			reject: deferred.reject,
			operation,
			postController,
			onProgress: options?.onProgress,
		};
		if (operation.signal) {
			pending.abortHandler = () => {
				this.#pending.delete(id);
				operation.clear();
				// Name the source that actually aborted: the caller's reason, the
				// close reason, or — when neither signalled — the configured timer.
				const aborted = options?.signal?.aborted
					? options.signal.reason
					: this.#lifecycleController.signal.aborted
						? this.#lifecycleController.signal.reason
						: undefined;
				deferred.reject(
					aborted instanceof Error ? aborted : new Error(`Legacy SSE response timeout after ${timeout}ms`),
				);
			};
			operation.signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		this.#pending.set(id, pending);

		let postStatus: number | undefined;
		try {
			operation.signal?.throwIfAborted();
			const response = await this.#postJson(body, operation.signal, options);
			postStatus = response.status;
			if (!response.ok) {
				const text = await response.text();
				throw createMCPHttpStatusError(response, text, {
					stage: "receive",
					retryable: response.status === 404,
				});
			}
			await response.body?.cancel();
			const result = await deferred.promise;
			await this.#assertRequestOwner(options);
			return result as T;
		} catch (error) {
			await this.#assertRequestOwner(options);
			this.#pending.delete(id);
			operation.clear();
			if (pending.abortHandler) operation.signal?.removeEventListener("abort", pending.abortHandler);
			if (operation.timedOut()) {
				throw new Error(`Request timeout after ${timeout}ms`);
			}
			if (operation.signal?.aborted) throw operation.signal.reason;
			const normalized = normalizeMCPTransportError(error, {
				transport: "http",
				stage: postStatus === undefined ? "send" : "receive",
			});
			if (
				postStatus === 404 &&
				error instanceof MCPTransportError &&
				error.failure === "http_status" &&
				error.code === 404 &&
				error.retryable
			) {
				throw error;
			}
			// A rejected POST can follow server receipt; only a refused, unreachable, or unresolved connection proves no dispatch.
			if (
				postStatus === undefined &&
				normalized.failure === "connect" &&
				(/^(?:ECONNREFUSED|CONNECTIONREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|FAILEDTOOPENSOCKET)$/i.test(
					String(normalized.code),
				) ||
					/\b(?:ECONNREFUSED|ConnectionRefused|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|FailedToOpenSocket)\b/i.test(
						normalized.message,
					))
			) {
				throw normalized;
			}
			throw nonRetryableMCPTransportError(normalized);
		} finally {
			this.#pending.delete(id);
			operation.clear();
			if (pending.abortHandler) operation.signal?.removeEventListener("abort", pending.abortHandler);
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error("Transport not connected");
		}

		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		try {
			const response = await this.#postJson(
				{
					jsonrpc: "2.0" as const,
					method,
					params: params ?? {},
				},
				operation.signal,
			);
			operation.clear();
			if (!response.ok) {
				const text = await response.text();
				throw createMCPHttpStatusError(response, text, { stage: "receive", retryable: false });
			}
			await response.body?.cancel();
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(`Notify timeout after ${timeout}ms`);
			}
			throw error;
		}
	}

	async #postJson(
		body: JsonRpcRequest | JsonRpcResponse | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> },
		signal?: AbortSignal,
		options?: MCPRequestOptions,
	): Promise<Response> {
		const endpointUrl = this.#endpointUrl;
		if (!endpointUrl) throw new Error("Transport not connected");
		const generated: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		const payload = JSON.stringify(body);
		await this.#assertRequestOwner(options);
		this.#assertLocalRequestOwner(options);
		let response = await this.#fetch(endpointUrl, { method: "POST", body: payload, signal }, generated);
		const status = AIError.status(response);
		if (options?.allowAuthRetry === false || !this.onAuthError || (status !== 401 && status !== 403)) return response;

		let refreshedHeaders: Record<string, string> | null;
		try {
			await this.#assertRequestOwner(options);
			this.#assertLocalRequestOwner(options);
			refreshedHeaders = await this.onAuthError();
			await this.#assertRequestOwner(options);
		} catch (error) {
			await response.body?.cancel();
			throw error;
		}
		if (!refreshedHeaders) return response;
		await response.body?.cancel();
		await this.#assertRequestOwner(options);
		this.#config.headers = refreshedHeaders;
		this.#assertLocalRequestOwner(options);
		response = await this.#fetch(endpointUrl, { method: "POST", body: payload, signal }, generated);
		return response;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, this.#operationSignal());
		try {
			const response = await this.#postJson(
				error ? { jsonrpc: "2.0" as const, id, error } : { jsonrpc: "2.0" as const, id, result: result ?? {} },
				operation.signal,
			);
			operation.clear();
			await response.body?.cancel();
		} catch {
			operation.clear();
		}
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			pending.operation.clear();
			if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
			pending.reject(error);
			pending.postController.abort(error);
		}
	}

	async close(): Promise<void> {
		if (!this.#connected && !this.#sseConnection) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#endpointUrl = null;
		const closeReason = postmortem.markExpectedCleanupError(
			new DOMException("MCP legacy SSE transport closed", "AbortError"),
		);
		// Before rejecting pending entries, so an in-flight POST is cancelled
		// rather than left holding a socket, and each waiter is told the close
		// reason rather than a deadline it never had.
		this.#lifecycleController.abort(closeReason);
		if (this.#sseConnection) {
			this.#sseConnection.abort(closeReason);
			this.#sseConnection = null;
		}
		this.#rejectPending(closeReason);
		if (wasConnected) this.onClose?.();
		this.onClose = undefined;
	}
}

/** Create and connect a legacy HTTP+SSE transport. */
export async function createSseTransport(
	config: MCPSseServerConfig,
	signal?: AbortSignal,
): Promise<LegacySseTransport> {
	const transport = new LegacySseTransport(config);
	await transport.connect(signal);
	return transport;
}
