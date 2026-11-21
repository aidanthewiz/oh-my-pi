/**
 * `omp auth-gateway stdio`: the gateway's routes as JSON lines on stdin and
 * stdout (`serveAuthGatewayStdio`), for a parent process that wants omp's
 * inference without an HTTP listener or a bearer token.
 *
 * Unlike `serve` it runs on this omp's own credentials (the broker when one is
 * configured, else the local store), models (`models.yml` and extension
 * providers included) and settings. Request model IDs are omp selectors, as
 * `--model` takes them ({@link selectorCandidates}). Streaming replies complete
 * within the byte limit before acceptance; model failures use the next
 * permitted candidate. Serving ends when stdin does.
 */
import { Console } from "node:console";
import * as fs from "node:fs";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import {
	AuthGatewayStdioResponseLimitError,
	type AuthGatewayRouter,
	createAuthGatewayRouter,
	readAuthGatewayStdioBody,
	serveAuthGatewayStdio,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { isTransientStatus } from "@oh-my-pi/pi-ai/error";
import { classifyGatewayError, type GatewayErrorClassification } from "@oh-my-pi/pi-ai/error/gateway";
import { getProjectDir, isRecord, logger, postmortem, readSseEvents, VERSION } from "@oh-my-pi/pi-utils";
import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import { ModelRegistry } from "../config/model-registry";
import {
	disabledProviderIds,
	filterModelsByConfiguredScope,
	formatModelStringWithRouting,
	normalizeModelPatternList,
	resolveCliModel,
} from "../config/model-resolver";
import { Settings } from "../config/settings";
import { claimRpcInput } from "../modes/rpc/rpc-input";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";

/** Names the caller in the gateway's logs. */
const STDIO_PEER = "stdio";

function gatewayModels(
	settings: Settings,
	registry: Pick<ModelRegistry, "getAvailable">,
	kind: ModelKind | "all" = "all",
): Model<Api>[] {
	const disabled = disabledProviderIds(settings);
	return filterModelsByConfiguredScope(registry.getAvailable(kind), settings).filter(
		model => !disabled.has(model.provider),
	);
}

/** Model kind each non-chat route serves; other paths are chat routes. */
const ROUTE_KINDS: Record<string, ModelKind> = {
	"/v1/systemone": "judge",
	"/alpha/decisions": "judge",
	"/v1/images/generations": "image",
	"/v1/images": "image",
	"/v1/images/edits": "image",
	"/v1/audio/speech": "tts",
	"/v1/audio/transcriptions": "stt",
	"/v1/embeddings": "embedding",
	"/v1/rerank": "rerank",
	"/v1/videos": "video",
};

/**
 * Catalog kinds the gateway has a route for. Other kinds (tiny, search) have no
 * wire, so `/v1/models` never advertises them.
 */
export const GATEWAY_MODEL_KINDS: readonly ModelKind[] = ["chat", ...new Set(Object.values(ROUTE_KINDS))];

/**
 * The models a request naming `selector` may run on, in order: the model
 * `--model` would pick among models of `kind` (the first entry of a comma
 * list that resolves), then that model's configured `retry.fallbackChains`
 * (its role's chain when the entry named a role; never the role's built-in
 * priority list). Empty when no entry resolves.
 */
export function selectorCandidates(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable"> & Partial<Pick<ModelRegistry, "hasProvider">>,
	kind: ModelKind = "chat",
): Model<Api>[] {
	const available = gatewayModels(settings, registry, kind);
	const scoped = {
		getAll: () => registry.getAll(kind),
		getAvailable: () => available,
		hasProvider: registry.hasProvider?.bind(registry),
	};
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model, configuredRole } = resolveCliModel({ cliModel: pattern, modelRegistry: scoped, settings });
		if (!model) continue;
		const chain = expandOnlineTinyModelFallbacks(model, settings, available, configuredRole);
		const seen = new Set<string>();
		return [model, ...chain].filter(candidate => {
			const key = formatModelStringWithRouting(candidate);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}
	return [];
}

async function streamFailure(
	bytes: Uint8Array,
	pathname: string,
	signal: AbortSignal,
): Promise<GatewayErrorClassification | undefined> {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	for await (const event of readSseEvents(stream, signal)) {
		if (!event.data || event.data === "[DONE]") continue;
		let data: unknown;
		try {
			data = JSON.parse(event.data);
		} catch {
			continue;
		}
		if (!isRecord(data)) continue;
		let error: unknown;
		if (pathname === "/v1/pi/stream" && event.event === null && data.type === "error") {
			const nativeError = isRecord(data.error) ? data.error : undefined;
			const message =
				typeof nativeError?.errorMessage === "string"
					? nativeError.errorMessage
					: typeof data.errorMessage === "string"
						? data.errorMessage
						: "Upstream request failed";
			if (data.reason === "aborted" || nativeError?.stopReason === "aborted") {
				return { status: 499, type: "request_aborted", message };
			}
			return classifyGatewayError(
				typeof nativeError?.errorClassificationMessage === "string"
					? nativeError.errorClassificationMessage
					: message,
			);
		}
		if (pathname === "/v1/chat/completions" && event.event === null) {
			error = data.error;
		} else if (pathname === "/v1/messages" && event.event === "error" && data.type === "error") {
			error = data.error;
		} else if (
			pathname === "/v1/responses" &&
			event.event === "response.failed" &&
			data.type === "response.failed" &&
			isRecord(data.response)
		) {
			error = data.response.error;
		}
		if (isRecord(error) && typeof error.message === "string") {
			return classifyGatewayError(error.message);
		}
	}
	signal.throwIfAborted();
	return undefined;
}

/** Selector dispatch over one router, with request-local model resolution. */
export function createAuthGatewayStdioRouter(
	storage: AuthStorage,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): { route(req: Request): Promise<Response>; close(): Promise<void> } {
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: id =>
			gatewayModels(settings, registry, "video").find(model => `${model.provider}/${model.id}` === id),
		listModels: () => GATEWAY_MODEL_KINDS.flatMap(kind => gatewayModels(settings, registry, kind)),
	});
	const route = async (req: Request): Promise<Response> => {
		if (!router.isModelRequest(req)) return router.route(req, STDIO_PEER);
		// Unparseable bodies pass through for the route to reject in its own wire format.
		const body: unknown = req.body
			? await req
					.clone()
					.json()
					.catch(() => undefined)
			: undefined;
		if (!isRecord(body)) return router.route(req, STDIO_PEER);
		const pathname = new URL(req.url).pathname;
		const native = pathname === "/v1/pi/stream";
		const selector =
			native && typeof body.modelId === "string" && body.modelId.length > 0
				? body.modelId
				: typeof body.model === "string"
					? body.model
					: native && isRecord(body.model) && typeof body.model.id === "string"
						? body.model.id
						: undefined;
		if (selector === undefined || (native && selector.length === 0)) return router.route(req, STDIO_PEER);
		const kind = ROUTE_KINDS[pathname] ?? "chat";
		const candidates = selectorCandidates(selector, settings, registry, kind);
		let response = Response.json(
			{ error: { message: `No available model matches "${selector}"`, type: "invalid_request_error" } },
			{ status: 404 },
		);
		for (const [index, model] of candidates.entries()) {
			const key = formatModelStringWithRouting(model);
			req.signal.throwIfAborted();
			const attempt = new Request(req.url, {
				method: req.method,
				headers: req.headers,
				body: JSON.stringify(native ? { ...body, modelId: key } : { ...body, model: key }),
				signal: req.signal,
			});
			response = await router.route(attempt, STDIO_PEER, undefined, id => (id === key ? model : undefined));
			let failureStatus = response.status >= 400 ? response.status : undefined;
			let invalidStreamRequest = false;
			if (response.ok && response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "text/event-stream") {
				try {
					const bytes = await readAuthGatewayStdioBody(response, req.signal);
					const failure = await streamFailure(bytes, pathname, req.signal);
					failureStatus = failure?.status;
					invalidStreamRequest = failure?.type === "invalid_request_error" && !isTransientStatus(failure.status);
					response = new Response(bytes, response);
				} catch (error) {
					req.signal.throwIfAborted();
					if (error instanceof AuthGatewayStdioResponseLimitError) throw error;
					const classified = classifyGatewayError(error);
					failureStatus = classified.status;
					invalidStreamRequest =
						classified.type === "invalid_request_error" && !isTransientStatus(classified.status);
					response = Response.json(
						{ error: { message: classified.message, type: classified.type } },
						{ status: classified.status },
					);
				}
			}
			if (req.signal.aborted) {
				await response.body?.cancel(req.signal.reason);
				req.signal.throwIfAborted();
			}
			// Request failures and caller cancellation cannot improve on another model.
			if (
				failureStatus === undefined ||
				failureStatus <= 400 ||
				invalidStreamRequest ||
				failureStatus === 499 ||
				index === candidates.length - 1
			) {
				return response;
			}
			logger.warn("auth-gateway stdio attempt failed", { selector, model: key, status: failureStatus });
			await response.body?.cancel();
		}
		return response;
	};
	return { route, close: () => router.close() };
}

/** Serves the gateway on stdin/stdout until stdin ends, then exits. */
export async function runAuthGatewayStdio(): Promise<void> {
	const input = claimRpcInput();
	const protocolStdout = process.stdout;
	Object.defineProperty(process, "stdout", { value: process.stderr, configurable: true });
	globalThis.console = Object.assign(new Console({ stdout: process.stderr, stderr: process.stderr }), {
		write(...data: (string | ArrayBufferView | ArrayBuffer)[]): number {
			let written = 0;
			for (const item of data) {
				written +=
					typeof item === "string"
						? fs.writeSync(process.stderr.fd, item)
						: fs.writeSync(
								process.stderr.fd,
								ArrayBuffer.isView(item)
									? new Uint8Array(item.buffer, item.byteOffset, item.byteLength)
									: new Uint8Array(item),
							);
			}
			return written;
		},
	});
	const controller = new AbortController();
	let storage: AuthStorage | undefined;
	let router: Pick<AuthGatewayRouter, "close"> | undefined;
	const unregister = postmortem.register("auth-gateway-stdio", async () => {
		controller.abort();
		await router?.close();
		await storage?.close();
	});
	try {
		const cwd = getProjectDir();
		const settings = await Settings.init({ cwd });
		storage = await discoverAuthStorage(undefined, { settings });
		const registry = new ModelRegistry(storage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		const stdioRouter = createAuthGatewayStdioRouter(storage, settings, registry);
		router = stdioRouter;
		await serveAuthGatewayStdio({
			input,
			write: line => {
				const flushed = Promise.withResolvers<void>();
				protocolStdout.write(line, error => (error ? flushed.reject(error) : flushed.resolve()));
				return flushed.promise;
			},
			route: req => stdioRouter.route(req),
			version: VERSION,
			signal: controller.signal,
		});
	} finally {
		controller.abort();
		await router?.close();
		await storage?.close();
		await input.cancel().catch(() => {});
		unregister();
	}
	await postmortem.quit(0);
}
