import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai/oauth/types";
import type { GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { settings } from "./settings";

/**
 * Login-list gate for managed installs: when `enabledModels` is configured,
 * a model provider whose models can never be selected has no reason to offer
 * OAuth sign-in — a stored credential would be dead weight on a provider the
 * org never audited. Non-model providers (search, local runtimes: no bundled
 * catalog entry) stay.
 *
 * LOGIN-ONLY by contract: callers apply this to login lists exclusively.
 * Logout paths (`OAuthSelectorComponent` logout mode, `/logout`) enumerate
 * stored credentials unfiltered, so a provider signed in before the allowlist
 * narrowed always remains sign-out-able (covered in oauth-selector.test.ts).
 *
 * Provider eligibility is derived from the `provider/` prefixes of the
 * allowlist patterns. A pattern without a provider prefix cannot be attributed
 * to a provider, so the gate turns itself off rather than guess.
 */
export function filterOAuthLoginProviders(providers: OAuthProviderInfo[]): OAuthProviderInfo[] {
	let patterns: readonly string[];
	try {
		patterns = settings.get("enabledModels") ?? [];
	} catch {
		return providers; // before Settings.init(): unmanaged context
	}
	if (patterns.length === 0) return providers;

	const allowedProviders = new Set<string>();
	for (const pattern of patterns) {
		const slash = pattern.indexOf("/");
		if (slash <= 0) return providers; // bare-id pattern: provider unknowable, gate off
		allowedProviders.add(pattern.slice(0, slash));
	}

	return providers.filter(provider => {
		const credentialTarget = provider.storeCredentialsAs ?? provider.id;
		if (allowedProviders.has(credentialTarget) || allowedProviders.has(provider.id)) return true;
		// No bundled models -> not a model provider (search key, local runtime).
		return getBundledModels(credentialTarget as GeneratedProvider).length === 0;
	});
}
