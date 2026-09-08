import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { $env, $pickenv } from "@oh-my-pi/pi-utils";
import { isFoundryEnabled } from "../utils/foundry";
import {
	anthropicBaseUrlIsAwsGateway,
	isAnthropicAwsGatewayUrl,
	resolveAnthropicAwsProviderCredential,
} from "./anthropic-aws-env";
import type { ProviderTransport } from "./build";
import type { ProviderCredentialContext } from "./types";

function anthropicRequestEnvironmentOwnsCredential(context: ProviderCredentialContext): boolean {
	const foundryBaseUrl = isFoundryEnabled() ? $env.FOUNDRY_BASE_URL?.trim() : undefined;
	if (foundryBaseUrl) return isAnthropicAwsGatewayUrl(foundryBaseUrl);
	const configuredBaseUrl = context.baseUrl?.trim();
	if (configuredBaseUrl && !isOfficialAnthropicApiUrl(configuredBaseUrl)) return false;
	return anthropicBaseUrlIsAwsGateway();
}

export function resolveAnthropicEnvironmentCredential(context?: ProviderCredentialContext): string | undefined {
	if (anthropicRequestEnvironmentOwnsCredential(context ?? {})) {
		return resolveAnthropicAwsProviderCredential();
	}
	const foundryEnabled = isFoundryEnabled();
	const foundryBaseUrl = foundryEnabled ? $env.FOUNDRY_BASE_URL?.trim() : undefined;
	if (foundryBaseUrl) {
		return $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
	}
	const configuredBaseUrl = context?.baseUrl?.trim();
	if (configuredBaseUrl && !isOfficialAnthropicApiUrl(configuredBaseUrl)) {
		return $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
	}
	if (anthropicBaseUrlIsAwsGateway()) return resolveAnthropicAwsProviderCredential();
	if (foundryEnabled) {
		return $pickenv("ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
	}
	return $pickenv("ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY");
}

export const anthropicTransport = {
	requestEnvironmentOwnsCredential: anthropicRequestEnvironmentOwnsCredential,
	envKeysForRequest: resolveAnthropicEnvironmentCredential,
} as const satisfies ProviderTransport;
