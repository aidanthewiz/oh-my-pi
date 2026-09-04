import { createInterface } from "node:readline/promises";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { installCoreforgeAwsRecovery } from "./aws-recovery";
import { ensureManagedCoreforgeAwsSso } from "./aws-sso";
import { CoreforgeIdentityStore, coreforgeIdentityFirstName } from "./coreforge-store";
import type { CoreforgeEntraConfig } from "./entra";
import { CoreforgeEntraIdentity } from "./entra";
import {
	applyCoreforgeIdentityProviderDefaults,
	resolveCoreforgeAwsConfig,
	resolveCoreforgeAwsSsoConstants,
	resolveCoreforgeEntraConfig,
	restoreCoreforgeOperationalAwsEnvironment,
} from "./runtime";

export interface CoreforgeStartupIdentity {
	firstName?: string;
	notices: string[];
}

async function confirmSignIn(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(question)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes";
	} finally {
		rl.close();
	}
}

/**
 * Default sign-in for managed installs. When Entra is enabled AND provisioned
 * (tenant + client IDs present), Microsoft Entra SSO is the SOLE AWS-model auth
 * path: ambient model-auth env vars are cleared so they cannot shadow managed
 * routing, and sign-in is prompted when interactive. When Entra is disabled or
 * unprovisioned, the classic env-credential path is authoritative and untouched.
 * Never throws; a failed/declined sign-in degrades to a notice, not a crash.
 */
export async function ensureCoreforgeIdentityAtStartup(
	settings: Settings,
	options: {
		interactive: boolean;
		createStore?: () => CoreforgeIdentityStore;
		isTty?: () => boolean;
		ensureAwsSso?: typeof ensureManagedCoreforgeAwsSso;
		installAwsRecovery?: typeof installCoreforgeAwsRecovery;
	},
): Promise<CoreforgeStartupIdentity> {
	if (!settings.get("identity.entra.enabled")) {
		restoreCoreforgeOperationalAwsEnvironment(Bun.env);
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
		let profile = store.getProfile();
		// Resolve BEFORE any prompt: enabled-but-unprovisioned (no tenant/client
		// ID yet) must stay fully dormant. A present-but-malformed managed value
		// throws — surface it as a notice instead of crashing (never-throws).
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
			restoreCoreforgeOperationalAwsEnvironment(Bun.env);
			// Entra unprovisioned: the classic env-credential path remains
			// authoritative after restoring the shell-owned AWS selectors.
			return { firstName: coreforgeIdentityFirstName(profile), notices };
		}
		// Entra provisioned: managed identity is the SOLE AWS-model auth path.
		// Attempt sign-in when needed, but every exit below falls through to
		// applyCoreforgeIdentityProviderDefaults so ambient model-auth envs are
		// cleared whether or not sign-in happened ("signed in or not").
		const canPrompt =
			options.interactive &&
			(options.isTty?.() ??
				(process.stdin.isTTY === true &&
					// The prompt reads stdin and writes stderr; stdout may be piped
					// (e.g. `omp | tee`) without making the prompt non-interactive.
					process.stderr.isTTY === true));
		if (!profile) {
			if (!canPrompt) {
				notices.push("Coreforge sign-in required: run `coreforge identity login`.");
			} else {
				process.stderr.write(
					"[coreforge] First run: Coreforge signs you in with your Coreforce Microsoft account.\n",
				);
				if (!(await confirmSignIn("[coreforge] Open Microsoft sign-in now? [Y/n] "))) {
					notices.push("Microsoft sign-in skipped: run `coreforge identity login`.");
				} else {
					try {
						profile = await new CoreforgeEntraIdentity(entraConfig, store).login({
							onProgress: message => process.stderr.write(`[coreforge] ${message}\n`),
						});
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						notices.push(`Microsoft sign-in failed: ${message}. Retry with \`coreforge identity login\`.`);
					}
				}
			}
		}
		// Validate AWS on every interactive launch. A cached SSO session makes this
		// one quiet STS call; an expired session opens `aws sso login` in this same
		// terminal, then retries before model discovery starts. Prompt-capable
		// sessions also install in-place recovery for later expiry; non-interactive
		// callers retain the actionable auth error instead of opening a browser.
		if (profile && canPrompt) {
			try {
				const awsConfig = resolveCoreforgeAwsConfig(settings);
				if (awsConfig) {
					const constants = resolveCoreforgeAwsSsoConstants(settings);
					const ensureAws = options.ensureAwsSso ?? ensureManagedCoreforgeAwsSso;
					const awsIdentity = await ensureAws(awsConfig, constants, message =>
						process.stderr.write(`[coreforge] ${message}\n`),
					);
					profile = store.setAwsIdentity(awsIdentity);
					(options.installAwsRecovery ?? installCoreforgeAwsRecovery)({
						awsConfig: { profile: awsIdentity.profile, region: awsIdentity.region },
						constants,
						ensureAwsSso: options.ensureAwsSso,
						createStore: options.createStore,
					});
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notices.push(`AWS sign-in failed: ${message}. Retry with \`coreforge identity login\`.`);
			}
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
