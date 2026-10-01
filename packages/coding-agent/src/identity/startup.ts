import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { installCoreforgeAwsRecovery } from "./aws-recovery";
import { CoreforgeIdentityStore, coreforgeIdentityFirstName } from "./coreforge-store";
import type { CoreforgeEntraConfig } from "./entra";
import {
	applyCoreforgeIdentityProviderDefaults,
	protectCoreforgeOperationalAwsChildEnvironment,
	resolveCoreforgeAwsConfig,
	resolveCoreforgeAwsSsoConstants,
	resolveCoreforgeEntraConfig,
} from "./runtime";

export interface CoreforgeStartupIdentity {
	firstName?: string;
	notices: string[];
}

/**
 * Apply managed identity defaults without opening an interactive browser flow.
 * Explicit identity login and managed consumers own sign-in and AWS proof.
 */
export async function ensureCoreforgeIdentityAtStartup(
	settings: Settings,
	options: {
		interactive: boolean;
		createStore?: () => CoreforgeIdentityStore;
		isTty?: () => boolean;
		installAwsRecovery?: typeof installCoreforgeAwsRecovery;
	},
): Promise<CoreforgeStartupIdentity> {
	if (!settings.get("identity.entra.enabled")) {
		protectCoreforgeOperationalAwsChildEnvironment();
		return { notices: [] };
	}
	const notices: string[] = [];
	// The store constructor touches the filesystem (mkdir + SQLite open) and
	// can throw (EACCES, ENOSPC, corrupt DB). Never-throws contract: degrade
	// to signed-out with a notice instead of crashing startup.
	const openStore = (): CoreforgeIdentityStore | undefined => {
		try {
			return (options.createStore ?? (() => new CoreforgeIdentityStore()))();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notices.push(`Coreforge identity store unavailable: ${message}. Continuing signed out.`);
			return undefined;
		}
	};
	const store = openStore();
	if (!store) {
		// Store inaccessible (EACCES/ENOSPC/corrupt): no signed-in identity is
		// readable, but if Entra is provisioned the ambient model-auth envs must
		// STILL be cleared — they must never authenticate AWS models. Use a
		// no-op identity loader so the clear does not re-hit the broken store;
		// applyDefaults self-gates on raw-ID provisioning, so this is a no-op
		// when Entra is unprovisioned.
		try {
			applyCoreforgeIdentityProviderDefaults(settings, Bun.env, () => undefined);
		} catch {
			// never throws with a no-op loader + raw-ID gate; ignore defensively
		}
		return { notices };
	}
	try {
		const profile = store.getProfile();
		let entraConfig: CoreforgeEntraConfig | undefined;
		try {
			entraConfig = resolveCoreforgeEntraConfig(settings);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notices.push(`Coreforge managed identity settings are invalid: ${message}`);
			// IDs are present (provisioning intent) but malformed — can't sign in,
			// but ambient model-auth envs must STILL be cleared so they can't
			// authenticate AWS models. applyDefaults derives provisioning from raw
			// ID presence, so it clears here even though the config won't validate.
			try {
				const applied = applyCoreforgeIdentityProviderDefaults(settings, Bun.env, () => store.getProfile());
				// A second, distinct misconfiguration (e.g. bad Claude baseUrl) must
				// also surface — don't let the Entra error mask it.
				if (applied.configError && applied.configError !== message) {
					notices.push(`Coreforge managed identity settings are invalid: ${applied.configError}`);
				}
			} catch {
				// never throws in practice (raw-ID gate + swallowed resolve); ignore
			}
			return { firstName: coreforgeIdentityFirstName(profile), notices };
		}
		if (!entraConfig) {
			protectCoreforgeOperationalAwsChildEnvironment();
			return { firstName: coreforgeIdentityFirstName(profile), notices };
		}
		// Entra provisioned: managed identity is the SOLE AWS-model auth path.
		// Every exit below falls through to applyCoreforgeIdentityProviderDefaults
		// so ambient model-auth envs are cleared whether signed in or not.
		const canPrompt =
			options.interactive &&
			(options.isTty?.() ??
				(process.stdin.isTTY === true &&
					// The prompt reads stdin and writes stderr; stdout may be piped
					// (e.g. `omp | tee`) without making the prompt non-interactive.
					process.stderr.isTTY === true));
		if (!profile) {
			notices.push("Coreforge sign-in required: run `coreforge identity login`.");
		}
		// Managed AWS proof is intentionally lazy. Relay, collaboration, sharing,
		// and managed-model consumers validate STS at their own security boundary,
		// so an unavailable AWS SSO session never delays the interactive prompt.
		try {
			const awsConfig = profile?.aws
				? { profile: profile.aws.profile, region: profile.aws.region }
				: resolveCoreforgeAwsConfig(settings);
			if (awsConfig) {
				(options.installAwsRecovery ?? installCoreforgeAwsRecovery)({
					awsConfig,
					canPrompt,
					constants: resolveCoreforgeAwsSsoConstants(settings),
					createStore: options.createStore,
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notices.push(`Coreforge managed identity settings are invalid: ${message}`);
		}
		// Provisioned precedence: clear ambient model-auth envs (so they can't
		// authenticate AWS models) and inject managed values when signed in.
		// Runs after the sign-in attempt resolved, so a transient failure never
		// strips env before a retry.
		try {
			const applied = applyCoreforgeIdentityProviderDefaults(settings, Bun.env, () => store.getProfile());
			logger.debug("Coreforge identity defaults applied", {
				appliedKeys: applied.appliedKeys,
				clearedKeys: applied.clearedKeys,
				removedManagedAwsProfile: applied.removedManagedAwsProfile,
			});
			// The cleared keys remain in the debug record for diagnostics without
			// interrupting managed startup with an actionable notice.
			if (applied.removedManagedAwsProfile && !applied.configError) {
				notices.push(
					"Coreforge isolated its managed inference profile from operational AWS tools; local AWS settings remain authoritative.",
				);
			}
			// A malformed managed value (bad Claude baseUrl/geo) cleared auth but
			// injected nothing — surface why so it is not a silent auth failure.
			if (applied.configError) {
				notices.push(`Coreforge managed identity settings are invalid: ${applied.configError}`);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notices.push(`Coreforge managed identity settings are invalid: ${message}`);
		}
		return { firstName: coreforgeIdentityFirstName(profile), notices };
	} finally {
		store.close();
	}
}
