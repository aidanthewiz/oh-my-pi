import { hasAwsModelCredentialChain } from "../aws-model-auth";
import { resolveOpenAIAwsApiKey } from "./openai-aws-env";
import type { ProviderDefinition } from "./types";

/**
 * OpenAI on AWS — OpenAI models served by Amazon Bedrock through the
 * `bedrock-mantle.{region}.api.aws` endpoint (the OpenAI-compatible Responses
 * API surface powered by AWS's Mantle inference engine). Same request/response
 * wire shape as `api.openai.com/v1/responses`; model ids carry the `openai.`
 * namespace (`openai.gpt-5.6-sol`).
 *
 * Dual auth, mirroring the AWS docs and our `anthropic-aws` sibling:
 *  - `OPENAI_AWS_API_KEY` (or the AWS-documented `AWS_BEARER_TOKEN_BEDROCK`)
 *    ⇒ `Authorization: Bearer <key>` (IAM: `bedrock-mantle:CallWithBearerToken`).
 *  - otherwise the AWS SigV4 credential chain (service `bedrock-mantle`),
 *    resolved by the transport per request.
 *
 * Never reads `OPENAI_API_KEY`: that key belongs to the first-party `openai`
 * provider and would be rejected by the Mantle endpoint anyway — keeping the
 * families separate means a plain OpenAI key never advertises AWS availability.
 */
export const openaiAwsProvider = {
	id: "openai-aws",
	name: "OpenAI on AWS",
	envKeys: () => {
		const apiKey = resolveOpenAIAwsApiKey();
		if (apiKey) return apiKey;
		// Managed Coreforge identity resolves only through its isolated model
		// profile; otherwise use the ordinary AWS credential chain.
		if (hasAwsModelCredentialChain()) {
			return "<authenticated>";
		}
	},
} as const satisfies ProviderDefinition;
