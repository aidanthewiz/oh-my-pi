import { type AwsBedrockProviderOptions, resolveAwsBearerToken } from "../registry/aws";
import type { FetchImpl, Model } from "../types";
import { resolveAwsRegion } from "../utils/aws-profile";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";
import type { OpenAIResponsesOptions } from "./openai-responses";
import { NO_AUTH_SENTINEL } from "./openai-shared";

export type BedrockMantleProviderOptions = AwsBedrockProviderOptions;

export interface BedrockMantleOptions extends OpenAIResponsesOptions {
	providerOptions?: BedrockMantleProviderOptions;
}

const AWS_REGION_RE = /^[a-z0-9-]+$/;

function resolveBedrockMantleUrl(
	input: string | URL | Request,
	region: string,
	pathKind: "base" | "request" = "request",
): URL {
	if (!AWS_REGION_RE.test(region)) {
		throw new Error(`Invalid AWS region for Bedrock Mantle: ${region}`);
	}
	const expectedHost = `bedrock-mantle.${region}.api.aws`;
	const raw = input instanceof Request ? input.url : input.toString();
	const url = new URL(raw.replaceAll("{region}", region));
	const validPath =
		pathKind === "base" ? url.pathname === "/v1" : url.pathname === "/v1" || url.pathname.startsWith("/v1/");
	if (
		url.protocol !== "https:" ||
		url.hostname !== expectedHost ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		!validPath
	) {
		throw new Error(`Bedrock Mantle endpoint must use https://${expectedHost}/v1`);
	}
	return url;
}

async function requestBody(input: string | URL | Request, init?: RequestInit): Promise<Uint8Array> {
	if (init?.body !== undefined && init.body !== null) {
		if (typeof init.body === "string") return new TextEncoder().encode(init.body);
		if (init.body instanceof Uint8Array) return init.body;
		if (init.body instanceof ArrayBuffer) return new Uint8Array(init.body);
		throw new TypeError(`Cannot SigV4-sign ${init.body.constructor?.name ?? typeof init.body} request body`);
	}
	if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
	return new Uint8Array();
}

function createSignedFetch(options: BedrockMantleOptions, region: string): FetchImpl {
	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const signedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = resolveBedrockMantleUrl(input, region);
		const method = init?.method ?? (input instanceof Request ? input.method : "POST");
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.delete("authorization");
		const contentType = headers.get("content-type");
		const body = await requestBody(input, init);
		const credentials = await resolveAwsCredentials({
			profile: options.providerOptions?.profile,
			region,
			signal: options.signal,
			fetch: baseFetch,
		});
		const signed = await signRequest({
			method,
			host: url.host,
			path: url.pathname,
			query: url.search.slice(1),
			body,
			region,
			service: "bedrock-mantle",
			credentials,
			...(contentType ? { headers: { "content-type": contentType } } : {}),
		});
		for (const [name, value] of Object.entries(signed)) {
			if (value !== undefined && name !== "host") headers.set(name, value);
		}
		const response = await baseFetch(
			url,
			method === "GET" || method === "HEAD" ? { ...init, method, headers } : { ...init, method, headers, body },
		);
		if (response.status === 401 || response.status === 403) {
			invalidateAwsCredentialCache({ profile: options.providerOptions?.profile, region });
		}
		return response;
	};
	return Object.assign(signedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

function resolveBearerToken(options: BedrockMantleOptions): string | undefined {
	const apiKey = options.apiKey === NO_AUTH_SENTINEL ? undefined : options.apiKey;
	return resolveAwsBearerToken(apiKey, options.providerOptions?.bearerToken);
}

export function createBedrockMantleAuthenticatedFetch(options: BedrockMantleOptions = {}): FetchImpl {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const bearerToken = resolveBearerToken(options);
	if (!bearerToken) return createSignedFetch(options, region);

	const baseFetch = options.fetch ?? (globalThis.fetch as FetchImpl);
	const authenticatedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = resolveBedrockMantleUrl(input, region);
		const headers = new Headers(input instanceof Request ? input.headers : undefined);
		for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
		headers.set("authorization", `Bearer ${bearerToken}`);
		const resolvedInput = input instanceof Request ? new Request(url.href, input) : url;
		return baseFetch(resolvedInput, { ...init, headers });
	};
	return Object.assign(authenticatedFetch, baseFetch.preconnect ? { preconnect: baseFetch.preconnect } : {});
}

export interface PreparedBedrockMantleRequest {
	model: Model<"openai-responses">;
	options: OpenAIResponsesOptions;
}

export function prepareBedrockMantleRequest(
	model: Model<"openai-responses">,
	options: BedrockMantleOptions,
): PreparedBedrockMantleRequest {
	const region = resolveAwsRegion(options.providerOptions?.region, options.providerOptions?.profile);
	const resolvedModel = { ...model, baseUrl: resolveBedrockMantleUrl(model.baseUrl, region, "base").toString() };
	const bearerToken = resolveBearerToken(options);
	if (bearerToken) {
		return { model: resolvedModel, options: { ...options, apiKey: bearerToken } };
	}
	return {
		model: resolvedModel,
		options: {
			...options,
			apiKey: NO_AUTH_SENTINEL,
			fetch: createBedrockMantleAuthenticatedFetch(options),
		},
	};
}
