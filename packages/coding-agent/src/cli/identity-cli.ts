import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { ensureManagedCoreforgeAwsSso } from "../identity/aws-sso";
import type { CoreforgeIdentityProfile } from "../identity/coreforge-store";
import { CoreforgeIdentityStore, coreforgeIdentityFirstName } from "../identity/coreforge-store";
import type { CoreforgeEntraConfig } from "../identity/entra";
import { CoreforgeEntraIdentity } from "../identity/entra";
import {
	resolveCoreforgeAwsConfig,
	resolveCoreforgeAwsSsoConstants,
	resolveCoreforgeEntraConfig,
} from "../identity/runtime";

export const IDENTITY_ACTIONS = ["login", "status", "logout"] as const;
export type IdentityAction = (typeof IDENTITY_ACTIONS)[number];

export interface IdentityCommandArgs {
	action: IdentityAction;
	flags: {
		deviceCode?: boolean;
		json?: boolean;
		quiet?: boolean;
		refresh?: boolean;
		skipAws?: boolean;
	};
}

export interface IdentityCommandDependencies {
	settings?: Settings;
	store?: CoreforgeIdentityStore;
	writeOut?: (text: string) => void;
	writeErr?: (text: string) => void;
	/** Test seam: Entra identity factory. */
	createEntraIdentity?: (
		config: CoreforgeEntraConfig,
		store: CoreforgeIdentityStore,
	) => Pick<CoreforgeEntraIdentity, "login" | "refresh" | "logout">;
	/** Test seam: managed AWS SSO step. */
	ensureAwsSso?: typeof ensureManagedCoreforgeAwsSso;
}

export async function runIdentityCommand(
	command: IdentityCommandArgs,
	deps: IdentityCommandDependencies = {},
): Promise<number> {
	const writeOut = deps.writeOut ?? (text => process.stdout.write(text));
	const writeErr = deps.writeErr ?? (text => process.stderr.write(text));
	const settings = deps.settings ?? (await Settings.init({ cwd: getProjectDir() }));
	const store = deps.store ?? new CoreforgeIdentityStore();
	const ownsStore = deps.store === undefined;
	const createEntra = deps.createEntraIdentity ?? ((config, s) => new CoreforgeEntraIdentity(config, s));
	const ensureAws = deps.ensureAwsSso ?? ensureManagedCoreforgeAwsSso;
	const progress = (message: string) => {
		if (!command.flags.quiet && !command.flags.json) writeErr(`[coreforge] ${message}\n`);
	};
	// Shared AWS leg for login and status --refresh. The caller's Entra result
	// is already persisted; an AWS failure here is captured — never thrown — so
	// the signed-in state stays visible and the exit code degrades separately.
	const runAwsStep = async (): Promise<{ awsProfile?: CoreforgeIdentityProfile; awsError?: string }> => {
		try {
			const awsConfig = resolveCoreforgeAwsConfig(settings);
			if (!awsConfig || command.flags.skipAws) return {};
			return {
				awsProfile: store.setAwsIdentity(
					await ensureAws(awsConfig, resolveCoreforgeAwsSsoConstants(settings), progress),
				),
			};
		} catch (error) {
			return { awsError: error instanceof Error ? error.message : String(error) };
		}
	};
	try {
		if (command.action === "status") {
			let profile = store.getProfile();
			if (!profile || !store.hasTokenCache()) return 1;
			let awsError: string | undefined;
			if (command.flags.refresh) {
				const entraConfig = resolveCoreforgeEntraConfig(settings);
				if (!entraConfig) throw new Error("Coreforge Entra identity is not configured");
				profile = await createEntra(entraConfig, store).refresh();
				const aws = await runAwsStep();
				if (aws.awsProfile) profile = aws.awsProfile;
				awsError = aws.awsError;
			}
			if (command.flags.json) {
				writeOut(`${JSON.stringify(profile, null, 2)}\n`);
			} else if (!command.flags.quiet) {
				writeOut(`Signed in as ${profile.displayName} <${profile.email}>\n`);
				if (profile.aws) writeOut(`AWS: ${profile.aws.profile} (${profile.aws.accountId})\n`);
			}
			if (awsError) {
				if (!command.flags.quiet) writeErr(`[coreforge] AWS refresh failed: ${awsError}\n`);
				return 1;
			}
			return 0;
		}

		if (command.action === "logout") {
			// Clearing credentials is the whole point: a malformed managed config
			// (throwing resolve) or a failing MSAL sign-out must still end with an
			// empty local store, never a stuck signed-in state.
			try {
				const entraConfig = resolveCoreforgeEntraConfig(settings);
				if (entraConfig && store.hasTokenCache()) {
					await createEntra(entraConfig, store).logout();
				} else {
					store.clear();
				}
			} catch (error) {
				store.clear();
				const message = error instanceof Error ? error.message : String(error);
				if (!command.flags.quiet)
					writeErr(`[coreforge] sign-out cleanup: ${message}. Local credentials cleared.\n`);
			}
			if (!command.flags.quiet) writeOut("Signed out of Coreforge.\n");
			return 0;
		}

		const entraConfig = resolveCoreforgeEntraConfig(settings);
		if (!entraConfig) throw new Error("Coreforge Entra identity is not configured");
		progress("Sign in with your Coreforce Microsoft account.");
		let profile = await createEntra(entraConfig, store).login({
			deviceCode: command.flags.deviceCode,
			onProgress: progress,
		});
		const aws = await runAwsStep();
		if (aws.awsProfile) profile = aws.awsProfile;
		if (command.flags.json) {
			writeOut(`${JSON.stringify(profile, null, 2)}\n`);
		} else {
			const firstName = coreforgeIdentityFirstName(profile);
			writeOut(`${firstName ? `Welcome, ${firstName}` : "Welcome"}. Coreforge is ready.\n`);
		}
		if (aws.awsError) {
			if (!command.flags.quiet) writeErr(`[coreforge] AWS sign-in failed: ${aws.awsError}\n`);
			return 1;
		}
		return 0;
	} catch (error) {
		if (!command.flags.quiet) {
			const message = error instanceof Error ? error.message : String(error);
			writeErr(`[coreforge] sign-in error: ${message}\n`);
		}
		return 1;
	} finally {
		if (ownsStore) store.close();
	}
}
