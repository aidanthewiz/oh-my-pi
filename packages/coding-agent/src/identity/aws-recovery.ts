import {
	type AwsCredentialRecoveryRequest,
	setAwsCredentialRecoveryHandler,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { logger } from "@oh-my-pi/pi-utils";
import type { CoreforgeAwsSsoConstants } from "./aws-profile";
import { type CoreforgeAwsConfig, type CoreforgeAwsDependencies, ensureManagedCoreforgeAwsSso } from "./aws-sso";
import { CoreforgeIdentityStore } from "./coreforge-store";

/** Deadline before graceful termination of a mid-session AWS sign-in begins. */
const RECOVERY_TIMEOUT_MS = 180_000;
const RECOVERY_TERMINATION_GRACE_MS = 5_000;

export interface CoreforgeAwsRecoveryOptions {
	awsConfig: CoreforgeAwsConfig;
	constants?: CoreforgeAwsSsoConstants;
	/** Progress sink; defaults to the debug log (TUI-safe, unlike stderr). */
	onProgress?: (message: string) => void;
	ensureAwsSso?: typeof ensureManagedCoreforgeAwsSso;
	createStore?: () => CoreforgeIdentityStore;
	setHandler?: typeof setAwsCredentialRecoveryHandler;
	awsDependencies?: CoreforgeAwsDependencies;
	recoveryTimeoutMs?: number;
	terminationGraceMs?: number;
}

/**
 * Spawn the AWS CLI without inheriting the terminal: a mid-session sign-in must
 * not take stdin from the TUI, and its output is forwarded through the caller's
 * progress sink instead of being written straight to the screen. Bounded by
 * {@link RECOVERY_TIMEOUT_MS}.
 */
function backgroundAwsRunner(
	onProgress: (message: string) => void,
	timeoutMs = RECOVERY_TIMEOUT_MS,
	terminationGraceMs = RECOVERY_TERMINATION_GRACE_MS,
): NonNullable<CoreforgeAwsDependencies["run"]> {
	return async (command, interactive) => {
		const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const stdoutPromise = new Response(child.stdout).text().catch(() => "");
		const stderrPromise = new Response(child.stderr).text().catch(() => "");
		let timeout: NodeJS.Timeout | undefined;
		let forceKill: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				child.kill("SIGTERM");
				forceKill = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`AWS authentication command timed out after ${timeoutMs + terminationGraceMs}ms`));
				}, terminationGraceMs);
			}, timeoutMs);
		});
		try {
			const exitCode = await Promise.race([child.exited, deadline]);
			const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
			const output = `${stdout}${stderr}`.trim();
			if (interactive && output) onProgress(output);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(timeout);
			clearTimeout(forceKill);
		}
	};
}

/**
 * Install the mid-session AWS re-authentication handler consulted by the model
 * providers when credential resolution hits an expired or missing SSO session.
 * Without it, an expiry mid-conversation is only repaired by restarting the
 * agent, because managed SSO is otherwise validated at startup only.
 */
export function installCoreforgeAwsRecovery(options: CoreforgeAwsRecoveryOptions): void {
	const onProgress = options.onProgress ?? (message => logger.info(`[coreforge] ${message}`));
	const ensureAwsSso = options.ensureAwsSso ?? ensureManagedCoreforgeAwsSso;
	const setHandler = options.setHandler ?? setAwsCredentialRecoveryHandler;
	setHandler(async (request: AwsCredentialRecoveryRequest): Promise<boolean> => {
		if (request.profile !== options.awsConfig.profile) {
			logger.warn("Ignoring AWS recovery request for unmanaged profile", {
				requestedProfile: request.profile,
				managedProfile: options.awsConfig.profile,
			});
			return false;
		}
		logger.warn("AWS session expired mid-session; re-authenticating", {
			profile: request.profile,
			kind: request.kind,
		});
		onProgress(`AWS session ${request.kind === "sso-token-expired" ? "expired" : "missing"}; signing in again...`);
		const identity = await ensureAwsSso(
			{ profile: request.profile, region: request.region },
			options.constants,
			onProgress,
			{
				run: backgroundAwsRunner(onProgress, options.recoveryTimeoutMs, options.terminationGraceMs),
				...options.awsDependencies,
			},
		);
		// Persist so the next startup sees the refreshed validation; a store
		// failure must not fail the recovery the conversation is waiting on.
		try {
			const store = options.createStore ? options.createStore() : new CoreforgeIdentityStore();
			try {
				store.setAwsIdentity(identity);
			} finally {
				store.close();
			}
		} catch (error) {
			logger.warn("Could not persist refreshed AWS identity", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		onProgress(`AWS sign-in refreshed for profile ${identity.profile}.`);
		return true;
	});
}
