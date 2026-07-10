import { hasAwsModelCredentialChain } from "../aws-model-auth";
import {
	anthropicAwsWorkspaceIdIsNativeOnly,
	resolveAnthropicAwsApiKey,
	resolveAnthropicAwsWorkspaceId,
} from "./anthropic-aws-env";
import type { ProviderDefinition } from "./types";

/**
 * Claude Platform on AWS — Anthropic's first-party Messages API served through
 * AWS (`aws-external-anthropic.{region}.api.aws`). Not Amazon Bedrock: Anthropic
 * operates the inference stack; AWS provides auth + Marketplace billing. Same
 * `/v1/{endpoint}` surface and model IDs as `api.anthropic.com`.
 *
 * Dual auth, mirroring the `AnthropicAWS` SDK client:
 *  - `ANTHROPIC_AWS_API_KEY` ⇒ `Authorization: Bearer <key>` (simple path; IAM
 *    authorizes it via the `aws-external-anthropic:CallWithBearerToken` action).
 *  - otherwise the AWS SigV4 credential chain (service `aws-external-anthropic`).
 *
 * SigV4 is reserved for the AWS-scoped opt-in (`ANTHROPIC_AWS_WORKSPACE_ID`). The
 * native family (`ANTHROPIC_WORKSPACE_ID` under the gateway URL) is the AWS
 * console's API-key onboarding path, so it authenticates via `ANTHROPIC_API_KEY`
 * (Bearer) ONLY — a native workspace id with no key does not fall through to the
 * ambient AWS credential chain.
 *
 * Every request also needs a workspace id (`anthropic-workspace-id` header) and a
 * region (base-URL segment). The workspace id has no source other than env
 * (`ANTHROPIC_AWS_WORKSPACE_ID`, or `ANTHROPIC_WORKSPACE_ID` when
 * `ANTHROPIC_BASE_URL` is the gateway host), so it gates availability here;
 * region and SigV4 credentials are resolved by the transport
 * (`buildAnthropicClientOptions`). Name resolution lives in `anthropic-aws-env.ts`.
 */
export const anthropicAwsProvider = {
	id: "anthropic-aws",
	name: "Claude Platform on AWS",
	envKeys: () => {
		// Workspace id is mandatory and env-only — without it the provider can't
		// build a valid request, so don't advertise it as available.
		if (!resolveAnthropicAwsWorkspaceId()) return undefined;
		// API-key path: the value is sent verbatim as an `Authorization: Bearer` token.
		const apiKey = resolveAnthropicAwsApiKey();
		if (apiKey) return apiKey;
		// SigV4 path: only for the AWS-scoped opt-in. A native-only workspace id
		// (ANTHROPIC_WORKSPACE_ID under the gateway) is the console's API-key
		// onboarding path and must NOT be authenticated by an ambient AWS profile
		// with no key — that would advertise availability the API-key user lacks.
		if (anthropicAwsWorkspaceIdIsNativeOnly()) return undefined;
		// Managed Coreforge identity resolves only through its isolated model
		// profile; otherwise use the ordinary AWS credential chain.
		if (hasAwsModelCredentialChain()) {
			return "<authenticated>";
		}
	},
} as const satisfies ProviderDefinition;
