/**
 * `omp auth-gateway stdio`: the gateway's routes as JSON lines on stdin and
 * stdout (`serveAuthGatewayStdio`), for a parent process that wants omp's
 * inference without an HTTP listener or a bearer token.
 *
 * Unlike `serve` it runs on this omp's own credentials (the broker when one is
 * configured, else the local store), models (`models.yml` and extension
 * providers included) and settings. A request's `model` is an omp model
 * selector, as `--model` takes it ({@link selectorCandidates}); an attempt
 * that fails before its reply starts moves on to the next candidate. Serving
 * ends when stdin does.
 */
import { Console } from "node:console";
import { writeSync } from "node:fs";
import type { Api, AuthStorage, Model } from "@oh-my-pi/pi-ai";
import { type AuthGatewayRouter, createAuthGatewayRouter, serveAuthGatewayStdio } from "@oh-my-pi/pi-ai/auth-gateway";
import { getProjectDir, isRecord, logger, postmortem, VERSION } from "@oh-my-pi/pi-utils";
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
import { collectOnlineTinyCandidates, expandOnlineTinyModelFallbacks } from "../tiny/online-candidates";

/** Names the caller in the gateway's logs. */
const STDIO_PEER = "stdio";

function gatewayModels(settings: Settings, registry: Pick<ModelRegistry, "getAvailable">): Model<Api>[] {
	const disabled = disabledProviderIds(settings);
	return filterModelsByConfiguredScope(registry.getAvailable("all"), settings).filter(
		model => !disabled.has(model.provider),
	);
}

/**
 * The models a request naming `selector` may run on, in order: the model
 * `--model` would pick (the first entry of a comma list that resolves), then
 * that model's `retry.fallbackChains` (its role's chain when the entry named a
 * role). Empty when no entry resolves.
 */
export function selectorCandidates(
	selector: string,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): Model<Api>[] {
	const available = gatewayModels(settings, registry);
	const scopedRegistry = { getAll: () => registry.getAll("all"), getAvailable: () => available };
	for (const pattern of normalizeModelPatternList(selector)) {
		const { model, configuredRole } = resolveCliModel({ cliModel: pattern, modelRegistry: scopedRegistry, settings });
		if (!model) continue;
		const chain = configuredRole
			? collectOnlineTinyCandidates([configuredRole], settings, available).map(candidate => candidate.model)
			: expandOnlineTinyModelFallbacks(model, settings, available);
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

/** Selector dispatch over one router, with request-local model resolution. */
export function createAuthGatewayStdioRouter(
	storage: AuthStorage,
	settings: Settings,
	registry: Pick<ModelRegistry, "getAll" | "getAvailable">,
): { route(req: Request): Promise<Response>; close(): void } {
	const router = createAuthGatewayRouter({
		storage,
		resolveModel: id => gatewayModels(settings, registry).find(model => `${model.provider}/${model.id}` === id),
		listModels: () => gatewayModels(settings, registry),
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
		if (!isRecord(body) || typeof body.model !== "string") return router.route(req, STDIO_PEER);
		const selector = body.model;
		const candidates = selectorCandidates(selector, settings, registry);
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
				body: JSON.stringify({ ...body, model: key }),
				signal: req.signal,
			});
			response = await router.route(attempt, STDIO_PEER, id => (id === key ? model : undefined));
			// 400 is the request's own fault and 499 its caller's: another model would fare no better.
			if (response.status <= 400 || response.status === 499 || index === candidates.length - 1) return response;
			logger.warn("auth-gateway stdio attempt failed", { selector, model: key, status: response.status });
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
						? writeSync(process.stderr.fd, item)
						: writeSync(
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
	const unregister = postmortem.register("auth-gateway-stdio", () => {
		controller.abort();
		router?.close();
		storage?.close();
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
			write: line =>
				new Promise<void>((resolve, reject) => {
					protocolStdout.write(line, error => (error ? reject(error) : resolve()));
				}),
			route: req => stdioRouter.route(req),
			version: VERSION,
			signal: controller.signal,
		});
	} finally {
		controller.abort();
		router?.close();
		storage?.close();
		await input.cancel().catch(() => {});
		unregister();
	}
	await postmortem.quit(0);
}
