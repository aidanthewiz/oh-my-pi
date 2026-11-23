import { type Api, type AuthStorage, type Model, withAuth } from "@oh-my-pi/pi-ai";
import { applySessionHeader } from "@oh-my-pi/pi-ai/providers/inference-headers";
import { asRecord } from "@oh-my-pi/pi-utils";
import {
	type SearchCitation,
	SearchProviderError,
	type SearchResponse,
	type SearchSource,
	type SearchUsage,
} from "../types";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { searchReasoningEffort, withHardTimeout } from "./utils";

const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 100;

function getSearchQuery(params: SearchParams): { query: string; sites: string[] } {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	return {
		query: parsed.hasDirectives ? formatQuery(parsed, GOOGLE_QUERY_SYNTAX) : params.query,
		sites: parsed.sites,
	};
}

function acceptsNamedToolChoice(model: Model<Api>): boolean {
	const compat = model.compat;
	return !(compat && "supportsNamedToolChoice" in compat && compat.supportsNamedToolChoice === false);
}

function buildRequestBody(params: SearchParams): Record<string, unknown> {
	const { query, sites } = getSearchQuery(params);
	const tool: Record<string, unknown> = { type: "web_search" };
	if (sites.length > 0) {
		const allowedDomains = [...new Set(sites.map(site => site.split("/", 1)[0]).filter(Boolean))];
		if (allowedDomains.length > 0) tool.filters = { allowed_domains: allowedDomains };
	}

	const body: Record<string, unknown> = {
		model: params.model.requestModelId ?? params.model.id,
		instructions: params.systemPrompt,
		input: query,
		tools: [tool],
		tool_choice: acceptsNamedToolChoice(params.model) ? { type: "web_search" } : "required",
		include: ["web_search_call.action.sources"],
		store: false,
	};
	// Effort follows the web role's level; `mode` is the catalog pro alias. The
	// fields are independent, and undefined members drop out of the JSON body.
	const effort = searchReasoningEffort(params.model, params.thinkingLevel);
	const mode = params.model.reasoningMode;
	if (effort !== undefined || mode) body.reasoning = { effort, mode };
	if (params.maxOutputTokens !== undefined) body.max_output_tokens = params.maxOutputTokens;
	return body;
}

function responsesEndpoint(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/responses`;
}

function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
	try {
		const url = new URL(baseUrl);
		return (
			url.protocol === "https:" &&
			url.hostname === "api.openai.com" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			url.pathname.replace(/\/+$/, "") === "/v1"
		);
	} catch {
		return false;
	}
}

function httpError(status: number): SearchProviderError {
	const messages: Record<number, string> = {
		400: "OpenAI Responses API rejected the request (400)",
		401: "OpenAI API key was rejected (401)",
		402: "OpenAI API billing limit reached (402)",
		403: "OpenAI API request forbidden (403)",
		429: "OpenAI API rate limit reached (429)",
	};
	const base = messages[status] ?? `OpenAI Responses API request failed (${status})`;
	return new SearchProviderError("openai", base, status);
}

function readResponse(payload: unknown, modelId: string, resultLimit: number): SearchResponse {
	const response = asRecord(payload);
	if (!response) {
		throw new SearchProviderError("openai", "OpenAI Responses API returned an invalid response", 502);
	}

	const output = Array.isArray(response.output) ? response.output.map(asRecord).filter(record => record !== null) : [];
	const searchCalls = output.filter(item => item.type === "web_search_call" && item.status !== "failed");
	if (searchCalls.length === 0) {
		throw new SearchProviderError(
			"openai",
			"OpenAI returned a completion without running web search (no web_search_call); refusing to treat a non-search answer as a search result",
			502,
		);
	}

	const sources: SearchSource[] = [];
	const citations: SearchCitation[] = [];
	const sourceIndexes = new Map<string, number>();
	const citationIndexes = new Map<string, number>();
	const addSource = (urlValue: unknown, titleValue?: unknown, citedTextValue?: string, isCitation = false): void => {
		if (typeof urlValue !== "string") return;
		const url = urlValue.trim();
		if (!url) return;
		const title = typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : url;
		const citedText = citedTextValue?.trim() || undefined;
		const sourceIndex = sourceIndexes.get(url);
		if (sourceIndex === undefined) {
			sourceIndexes.set(url, sources.length);
			sources.push({ title, url, ...(citedText ? { snippet: citedText } : {}) });
		} else {
			const source = sources[sourceIndex];
			if (source.title === url && title !== url) source.title = title;
			if (citedText && !source.snippet) source.snippet = citedText;
		}

		if (!isCitation) return;
		const citationIndex = citationIndexes.get(url);
		if (citationIndex === undefined) {
			citationIndexes.set(url, citations.length);
			citations.push({ title, url, ...(citedText ? { citedText } : {}) });
		} else {
			const citation = citations[citationIndex];
			if (citation.title === url && title !== url) citation.title = title;
			if (citedText && !citation.citedText) citation.citedText = citedText;
		}
	};

	const searchQueries: string[] = [];
	const consultedSources: Array<{ url: unknown; title: unknown }> = [];
	for (const item of searchCalls) {
		const action = asRecord(item.action);
		if (!action) continue;
		if (typeof action.query === "string" && action.query.trim()) searchQueries.push(action.query.trim());
		if (!Array.isArray(action.sources)) continue;
		for (const rawSource of action.sources) {
			const source = asRecord(rawSource);
			if (source) consultedSources.push({ url: source.url, title: source.title });
		}
	}

	const answerParts: string[] = [];
	for (const item of output) {
		if (item.type !== "message" || !Array.isArray(item.content)) continue;
		for (const rawPart of item.content) {
			const part = asRecord(rawPart);
			if (!part) continue;
			const text = typeof part.text === "string" ? part.text : "";
			if (part.type === "output_text" && text.trim()) answerParts.push(text.trim());
			const annotations = Array.isArray(part.annotations) ? part.annotations : [];
			for (const rawAnnotation of annotations) {
				const annotation = asRecord(rawAnnotation);
				if (!annotation || annotation.type !== "url_citation") continue;
				const start = annotation.start_index;
				const end = annotation.end_index;
				const citedText =
					typeof start === "number" && typeof end === "number" && start >= 0 && end > start
						? text.slice(start, end)
						: undefined;
				addSource(annotation.url, annotation.title, citedText, true);
			}
		}
		if (Array.isArray(item.annotations)) {
			for (const rawAnnotation of item.annotations) {
				const annotation = asRecord(rawAnnotation);
				if (annotation?.type !== "url_citation") continue;
				addSource(annotation.url, annotation.title, undefined, true);
			}
		}
	}

	for (const source of consultedSources) addSource(source.url, source.title);

	const answer =
		answerParts.length > 0
			? answerParts.join("\n\n")
			: typeof response.output_text === "string"
				? response.output_text.trim() || undefined
				: undefined;
	if (!answer && sources.length === 0) {
		throw new SearchProviderError("openai", "OpenAI web search returned no answer or sources", 502);
	}

	// Annotated answer URLs are collected first, so the hard cap keeps them ahead of merely consulted sources.
	const limitedSources = sources.slice(0, resultLimit);
	const limitedCitations = citations.slice(0, resultLimit);
	const usageRecord = asRecord(response.usage);
	const usage: SearchUsage = {};
	if (typeof usageRecord?.input_tokens === "number") usage.inputTokens = usageRecord.input_tokens;
	if (typeof usageRecord?.output_tokens === "number") usage.outputTokens = usageRecord.output_tokens;
	if (typeof usageRecord?.total_tokens === "number") usage.totalTokens = usageRecord.total_tokens;
	const searchRequests = searchCalls.filter(item => asRecord(item.action)?.type === "search").length;
	if (searchRequests > 0) usage.searchRequests = searchRequests;

	return {
		provider: "openai",
		answer,
		sources: limitedSources,
		citations: limitedCitations.length > 0 ? limitedCitations : undefined,
		searchQueries: searchQueries.length > 0 ? [...new Set(searchQueries)] : undefined,
		usage: Object.keys(usage).length > 0 ? usage : undefined,
		model: typeof response.model === "string" ? response.model : modelId,
		requestId: typeof response.id === "string" ? response.id : undefined,
		authMode: "api_key",
	};
}

/** Execute API-billed web search through the selected OpenAI Responses model. */
export async function searchOpenAIResponses(params: SearchParams): Promise<SearchResponse> {
	const credentialOrigin = params.modelRegistry.authStorage.keys.source(params.model.provider);
	if (credentialOrigin?.kind === "oauth") {
		throw new SearchProviderError(
			"openai",
			`OpenAI API web search requires API-key credentials; OAuth credentials for "${params.model.provider}" are not supported.`,
		);
	}
	if (!isOfficialOpenAIEndpoint(params.model.baseUrl) && credentialOrigin?.kind === "env") {
		throw new SearchProviderError(
			"openai",
			"Refusing to send the OpenAI environment API key to a custom Responses endpoint. Configure an endpoint-specific API key.",
		);
	}
	const resultLimit = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const body = buildRequestBody(params);
	const keyOrResolver = params.modelRegistry.resolver(params.model, params.sessionId);
	return withAuth(
		keyOrResolver,
		async apiKey => {
			const configuredHeaders = await params.modelRegistry.resolveModelHeaders(params.model, params.signal);
			const headers = new Headers(configuredHeaders);
			headers.set("Authorization", `Bearer ${apiKey}`);
			headers.set("Content-Type", "application/json");
			applySessionHeader(headers, params.model.compat, params.sessionId);
			const response = await (params.fetch ?? fetch)(responsesEndpoint(params.model.baseUrl), {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: withHardTimeout(params.signal, params.timeoutMs),
			});
			if (!response.ok) throw httpError(response.status);
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				throw new SearchProviderError("openai", "OpenAI Responses API returned invalid JSON", 502);
			}
			return readResponse(payload, params.model.id, resultLimit);
		},
		{
			signal: params.signal,
			missingKeyMessage: `OpenAI API credentials not found for selected provider "${params.model.provider}".`,
		},
	);
}

/** Search provider for OpenAI's API-billed Responses web_search tool. */
export class OpenAIProvider extends SearchProvider {
	readonly id = "openai";
	readonly label = "OpenAI API";

	isAvailable(authStorage: AuthStorage, model?: Model<Api>): boolean {
		const credentialSource = authStorage.keys.source(model?.provider ?? "openai");
		return (
			credentialSource !== undefined &&
			credentialSource.kind !== "oauth" &&
			(credentialSource.kind !== "env" || model === undefined || isOfficialOpenAIEndpoint(model.baseUrl))
		);
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchOpenAIResponses(params);
	}
}
