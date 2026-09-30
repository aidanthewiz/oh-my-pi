// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { $env } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

/** xAI provider ids supported by shared HTTP tool transport resolution. */
export type XAIHttpProvider = "xai-oauth" | "xai";

/** Resolved endpoint and configured headers for an xAI HTTP tool request. */
export interface XAIHttpTransport {
	baseURL: string;
	headers?: Record<string, string>;
}

/**
 * Resolve the HTTP base URL for an xAI tool call.
 *
 * Precedence:
 *   1. `model.baseUrl` from the registry IF the user pinned a per-model
 *      override — i.e. `merged.baseUrl` differs from the seeded/bundled
 *      default for the (provider, id) pair. Mirrors the chat path's per-model
 *      contract (`openai-responses.ts: model.baseUrl`).
 *   2. `ModelRegistry.getProviderBaseUrl(provider)` — provider-level override
 *      (e.g. `providers.xai-oauth.baseUrl` from models.yml). Reached when the
 *      modelId does not appear in the registry under this provider, which
 *      happens for tool-only ids like `grok-imagine-image` that
 *      `applyXAIOAuthCuration` filters out via `XAI_NON_CHAT_PREFIXES`.
 *      Without this leg, a registry-configured proxy is silently bypassed for
 *      image/TTS traffic.
 *   3. `XAI_BASE_URL` env var (legacy global override, preserved).
 *   4. `DEFAULT_BASE_URL = "https://api.x.ai/v1"`.
 *
 * The override gate at step 1 uses `bundled?.baseUrl ?? DEFAULT_BASE_URL` as
 * the canonical default sentinel. For xai (which has bundled entries) this
 * compares against the bundled value; for xai-oauth (no bundled entries —
 * models.json carries no xai-oauth records when the seed is absent, the
 * picker is seeded statically from `xaiOAuthModelManagerOptions` with
 * `baseUrl: DEFAULT_BASE_URL`) the sentinel falls back to DEFAULT_BASE_URL
 * so the env leg remains reachable. Without that fallback, every xai-oauth
 * model id forces `!bundled === true` and short-circuits XAI_BASE_URL
 * silently. Lookup is scoped to (provider, id); matching by id alone would
 * let xai-oauth entries hijack a xai tool call (or vice versa) when the
 * same model id ships under both descriptors.
 */
function resolveXAIBaseURL(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId: string | undefined,
): string {
	if (modelId) {
		const merged = modelRegistry.getAll().find(m => m.id === modelId && m.provider === provider);
		if (merged?.baseUrl) {
			const bundled = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
				m => m.id === modelId,
			);
			const providerDefault = bundled?.baseUrl ?? DEFAULT_BASE_URL;
			if (merged.baseUrl !== providerDefault) {
				return merged.baseUrl.replace(/\/$/, "");
			}
		}
	}
	const providerBaseUrl = modelRegistry.getProviderBaseUrl(provider);
	if (providerBaseUrl) {
		const normalized = providerBaseUrl.replace(/\/$/, "");
		if (normalized !== DEFAULT_BASE_URL) return normalized;
	}
	return ($env.XAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}
/**
 * Resolve an xAI tool endpoint and its provider/model header overrides.
 */
export async function resolveXAIHttpTransport(
	modelRegistry: ModelRegistry,
	provider: XAIHttpProvider,
	modelId?: string,
): Promise<XAIHttpTransport> {
	const model = modelId ? modelRegistry.find(provider, modelId) : undefined;
	return {
		baseURL: resolveXAIBaseURL(modelRegistry, provider, modelId),
		headers: model
			? await modelRegistry.resolveModelHeaders(model)
			: await modelRegistry.getProviderHeaders(provider),
	};
}

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Credential priority:
 *   1. xai-oauth — only when a dedicated xai-oauth source exists.
 *      `authStorage.keys.source("xai-oauth", { env: "none" })` covers stored
 *      OAuth/API keys, runtime keys, and configured keys (including
 *      command-backed models.yml and registered-provider keys).
 *      `XAI_OAUTH_TOKEN` is the dedicated environment source.
 *      `XAI_API_KEY` is not a routing signal here, although an explicitly
 *      selected xai-oauth model may borrow it. An API-key-only setup must
 *      keep the xai provider's base URL and headers for image/TTS tools.
 *   2. xai (plain API key). ModelRegistry resolves its runtime, config,
 *      stored, then environment credential through AuthStorage.keys.get.
 *
 * baseURL: see `resolveXAIBaseURL` above. Resolved AFTER the credential
 * decision so the scoped (provider, id) lookup is unambiguous. `modelId`
 * is optional; probes / tool-availability checks pass `undefined` and fall
 * through to env/default.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 */
export async function resolveXAIHttpCredentials(
	modelRegistry: ModelRegistry,
	modelId?: string,
): Promise<XAICredentials | null> {
	const hasDedicatedXaiOAuth =
		modelRegistry.authStorage.keys.source("xai-oauth", { env: "none" }) !== undefined ||
		Boolean($env.XAI_OAUTH_TOKEN);
	if (hasDedicatedXaiOAuth) {
		const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
		if (oauthKey) {
			const baseURL = resolveXAIBaseURL(modelRegistry, "xai-oauth", modelId);
			return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
		}
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai", modelId);
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}
