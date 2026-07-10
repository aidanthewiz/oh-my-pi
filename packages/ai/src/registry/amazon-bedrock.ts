import { $env } from "@oh-my-pi/pi-utils";
import { hasAwsModelCredentialChain } from "../aws-model-auth";
import type { ProviderDefinition } from "./types";

export const amazonBedrockProvider = {
	id: "amazon-bedrock",
	name: "Amazon Bedrock",
	// Amazon Bedrock accepts bearer tokens and the model-specific AWS chain.
	envKeys: () => {
		if ($env.AWS_BEARER_TOKEN_BEDROCK || hasAwsModelCredentialChain()) {
			return "<authenticated>";
		}
	},
} as const satisfies ProviderDefinition;
