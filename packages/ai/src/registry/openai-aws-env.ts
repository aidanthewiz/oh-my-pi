import { $env } from "@oh-my-pi/pi-utils";
import { resolveAwsModelRegion } from "../aws-model-auth";

/**
 * Credential/endpoint resolution for OpenAI models on Amazon Bedrock served
 * through the `bedrock-mantle.{region}.api.aws` endpoint (AWS's OpenAI-
 * compatible Responses API surface, powered by the Mantle inference engine).
 * Shared by the availability gate (`openai-aws.ts`) and the request transport
 * (`providers/openai-shared.ts` / `openai-responses.ts`) so both read the SAME
 * env every time — a gate that passes must build a request the transport can
 * authenticate, and vice versa.
 *
 * Auth is dual, mirroring the AWS docs (and our `anthropic-aws` sibling):
 *  - `OPENAI_AWS_API_KEY` — an Amazon Bedrock API key sent as
 *    `Authorization: Bearer <key>` (IAM authorizes it via the
 *    `bedrock-mantle:CallWithBearerToken` action).
 *  - otherwise the AWS SigV4 credential chain (service `bedrock-mantle`).
 *
 * The catalog bakes a us-east-1 base URL; `resolveOpenAIAwsBaseUrl` rewrites
 * the region segment from the active model-auth region at request time so the
 * endpoint host and SigV4 signing region always agree.
 */

/** SigV4 service name for the Bedrock-Mantle endpoint. */
export const OPENAI_AWS_SIGV4_SERVICE = "bedrock-mantle";
export const OPENAI_AWS_DEFAULT_REGION = "us-east-1";

/**
 * OpenAI frontier models (`openai.gpt-5.x`) are served on the `openai/v1`
 * path prefix — distinct from the bare `/v1` used by the open-weight models.
 * See the per-model AWS cards ("available on the openai/v1/responses path").
 */
export const OPENAI_AWS_FRONTIER_PATH_PREFIX = "/openai/v1";

/** Extract the region segment from a `bedrock-mantle.{region}.api.aws` URL. */
export function regionFromOpenAIAwsBaseUrl(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	return /bedrock-mantle\.([^./]+)\.api\.aws/i.exec(baseUrl)?.[1];
}

/**
 * True when a URL points at the Bedrock-Mantle endpoint. Parsed with `URL` and
 * matched on the FULL hostname (not a substring/suffix) so a look-alike such as
 * `bedrock-mantle.us-east-1.api.aws.evil.com` is rejected.
 */
export function openaiBaseUrlIsAwsMantle(baseUrl: string | undefined): boolean {
	const raw = baseUrl?.trim();
	if (!raw) return false;
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		return false;
	}
	return /^bedrock-mantle\.[a-z0-9-]+\.api\.aws$/i.test(host);
}

/**
 * Bearer API key for the Mantle endpoint. `OPENAI_AWS_API_KEY` is the
 * unambiguous opt-in; `AWS_BEARER_TOKEN_BEDROCK` (the name AWS's own docs and
 * Codex-on-Bedrock onboarding export) is honored as a fallback so a machine
 * configured per the AWS docs works out of the box. Trimmed; undefined when
 * absent (the transport then uses the SigV4 credential chain).
 */
export function resolveOpenAIAwsApiKey(): string | undefined {
	return $env.OPENAI_AWS_API_KEY?.trim() || $env.AWS_BEARER_TOKEN_BEDROCK?.trim() || undefined;
}

/**
 * Region for the endpoint URL and SigV4 signature. The active model-auth
 * region wins, followed by the catalog base URL's segment.
 */
export function resolveOpenAIAwsRegion(catalogBaseUrl?: string): string | undefined {
	return resolveAwsModelRegion() ?? regionFromOpenAIAwsBaseUrl(catalogBaseUrl);
}

/**
 * Resolve the request base URL for an `openai-aws` model: the env region wins
 * over the catalog's baked us-east-1 segment; the catalog path prefix
 * (`/openai/v1` for frontier ids, `/v1` for open-weight ids) is preserved.
 */
export function resolveOpenAIAwsBaseUrl(catalogBaseUrl: string | undefined): string {
	const region = resolveOpenAIAwsRegion(catalogBaseUrl) ?? OPENAI_AWS_DEFAULT_REGION;
	let path = OPENAI_AWS_FRONTIER_PATH_PREFIX;
	if (catalogBaseUrl) {
		try {
			path = new URL(catalogBaseUrl).pathname.replace(/\/+$/, "") || "/v1";
		} catch {
			// Malformed catalog URL — keep the frontier default.
		}
	}
	return `https://bedrock-mantle.${region}.api.aws${path}`;
}
