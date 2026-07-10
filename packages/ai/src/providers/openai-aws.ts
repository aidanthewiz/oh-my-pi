/**
 * Transport glue for `openai-aws` — OpenAI models on Amazon Bedrock via the
 * `bedrock-mantle.{region}.api.aws` OpenAI-compatible Responses endpoint.
 *
 * The endpoint speaks the exact OpenAI Responses wire shape, so the regular
 * `openai-responses` streamer is reused unchanged; this module only owns what
 * differs from `api.openai.com`:
 *  - the region-scoped base URL (env region wins over the catalog's baked
 *    us-east-1 segment, mirroring the `anthropic-aws` transport), and
 *  - authentication: an Amazon Bedrock API key as `Authorization: Bearer`
 *    (IAM action `bedrock-mantle:CallWithBearerToken`), or — when the
 *    availability gate resolved `<authenticated>` from the AWS credential
 *    chain — AWS SigV4 request signing with service `bedrock-mantle`.
 */

import { resolveAwsModelProfile } from "../aws-model-auth";
import {
	OPENAI_AWS_SIGV4_SERVICE,
	regionFromOpenAIAwsBaseUrl,
	resolveOpenAIAwsBaseUrl,
} from "../registry/openai-aws-env";
import type { FetchImpl } from "../types";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { signRequest } from "./aws-sigv4";
import { deleteHeaderCaseInsensitive, headerInitToRecord } from "./http-headers";

/** Sentinel the registry returns when SigV4 credentials (not an API key) are present. */
const AUTHENTICATED_API_KEY_SENTINEL = "<authenticated>";

export interface OpenAIAwsRequestSetup {
	baseUrl: string;
	headers: Record<string, string>;
	fetch: FetchImpl | undefined;
}

/**
 * Wrap fetch so each Bedrock-Mantle request is AWS SigV4-signed (service
 * `bedrock-mantle`) via the standard AWS credential provider chain. Used only
 * when no API key is configured. Any client-set `Authorization` is stripped
 * before signing so the SigV4 signature is the sole credential. The signing
 * region must equal the region in the endpoint URL. On 401/403 the cached
 * credentials are invalidated so rotated keys re-resolve without a restart.
 * Secrets are never logged.
 */
export function wrapFetchForOpenAIAwsSigV4(base: FetchImpl, region: string, profile?: string): FetchImpl {
	return async (input, init) => {
		const urlString = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
		const url = new URL(urlString);
		const method = (init?.method ?? (input instanceof Request ? input.method : "POST")).toUpperCase();
		// The Responses streamer posts a JSON string body; also accept the common
		// binary forms and a Request-embedded body so the payload hash always
		// matches the bytes actually sent (a mismatch surfaces as an opaque 403).
		// Remaining BodyInit shapes (streams, FormData) are not used on this path.
		const rawBody = init?.body;
		let bodyText: string;
		if (typeof rawBody === "string") bodyText = rawBody;
		else if (rawBody instanceof Uint8Array) bodyText = new TextDecoder().decode(rawBody);
		else if (rawBody instanceof ArrayBuffer) bodyText = new TextDecoder().decode(rawBody);
		else if (rawBody == null && input instanceof Request && input.body !== null) {
			bodyText = await input.clone().text();
		} else bodyText = "";
		const body = new TextEncoder().encode(bodyText);
		const headers = headerInitToRecord(init?.headers);
		// The SigV4 signature is the only credential; drop competing auth + the
		// host header (signRequest re-derives host from the URL).
		deleteHeaderCaseInsensitive(headers, "authorization");
		deleteHeaderCaseInsensitive(headers, "host");
		const credentials = await resolveAwsCredentials({
			region,
			profile,
			signal: init?.signal ?? undefined,
			fetch: base,
		});
		const signed = await signRequest({
			method,
			host: url.host,
			path: url.pathname,
			query: url.search.replace(/^\?/, ""),
			body,
			region,
			service: OPENAI_AWS_SIGV4_SERVICE,
			credentials,
			headers,
		});
		const response = await base(input, { ...init, headers: { ...headers, ...signed } });
		if (response.status === 401 || response.status === 403) {
			// Stale cached credentials (e.g. rotated session keys) — drop the cache
			// entry so the next attempt re-resolves from scratch.
			invalidateAwsCredentialCache({ profile, region });
		}
		return response;
	};
}

/**
 * Rewrite an `openai-responses` request setup for the Bedrock-Mantle endpoint:
 * region-scoped base URL, and SigV4-signed fetch when the availability gate
 * resolved the AWS credential chain instead of a Bearer API key (in which case
 * the `Authorization: Bearer <authenticated>` sentinel emitted by the shared
 * setup is stripped — the signature becomes the sole credential).
 */
export function applyOpenAIAwsRequestSetup(
	setup: { baseUrl: string | undefined; headers: Record<string, string> },
	apiKey: string,
	baseFetch: FetchImpl | undefined,
): OpenAIAwsRequestSetup {
	const baseUrl = resolveOpenAIAwsBaseUrl(setup.baseUrl);
	const headers = { ...setup.headers };
	if (apiKey !== AUTHENTICATED_API_KEY_SENTINEL) {
		return { baseUrl, headers, fetch: baseFetch };
	}
	deleteHeaderCaseInsensitive(headers, "authorization");
	const region = regionFromOpenAIAwsBaseUrl(baseUrl) ?? "us-east-1";
	const fetchImpl = wrapFetchForOpenAIAwsSigV4(
		baseFetch ?? (globalThis.fetch as FetchImpl),
		region,
		resolveAwsModelProfile(),
	);
	return { baseUrl, headers, fetch: fetchImpl };
}
