import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import type { GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { cfgDisabledProviders, cfgEnabledModels } from "./model-settings";
import type { Settings } from "./settings";

/**
 * Login admission uses the consuming session's current policy. Omitted settings
 * mean an unmanaged SDK host; logout never uses this gate.
 */
export function isOAuthLoginProviderAllowed(provider: OAuthProviderInfo, settings?: Settings): boolean {
	if (settings === undefined) return true;
	const credentialTarget = provider.storeCredentialsAs ?? provider.id;
	const disabled = cfgDisabledProviders.get(settings);
	if (disabled.includes(provider.id) || disabled.includes(credentialTarget)) return false;
	const patterns = cfgEnabledModels.get(settings);
	if (patterns.length === 0 || patterns.some(pattern => pattern.indexOf("/") <= 0)) return true;
	if (
		patterns.some(pattern => {
			const prefix = pattern.slice(0, pattern.indexOf("/"));
			return prefix === provider.id || prefix === credentialTarget;
		})
	) {
		return true;
	}
	return getBundledModels(credentialTarget as GeneratedProvider).length === 0;
}

export function assertOAuthLoginProviderAllowed(provider: OAuthProviderInfo, settings?: Settings): void {
	if (!isOAuthLoginProviderAllowed(provider, settings)) {
		throw new Error(`Provider '${provider.id}' is excluded by the current login policy.`);
	}
}

/** Login lists and direct login actions share one policy; logout lists remain unfiltered. */
export function filterOAuthLoginProviders(providers: OAuthProviderInfo[], settings?: Settings): OAuthProviderInfo[] {
	return providers.filter(provider => isOAuthLoginProviderAllowed(provider, settings));
}
