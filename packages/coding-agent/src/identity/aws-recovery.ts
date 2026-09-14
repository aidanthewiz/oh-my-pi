import * as os from "node:os";
import {
	type AwsCredentialRecoveryRequest,
	setAwsCredentialRecoveryHandler,
} from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { logger, ptree } from "@oh-my-pi/pi-utils";
import type { CoreforgeAwsSsoConstants } from "./aws-profile";
import { type CoreforgeAwsConfig, type CoreforgeAwsDependencies, ensureManagedCoreforgeAwsSso } from "./aws-sso";
import { CoreforgeIdentityStore } from "./coreforge-store";

/** Deadline before graceful termination of a mid-session AWS sign-in begins. */
const RECOVERY_TIMEOUT_MS = 180_000;
const RECOVERY_TERMINATION_GRACE_MS = 5_000;

export interface CoreforgeAwsRecoveryOptions {
	awsConfig: CoreforgeAwsConfig;
	constants?: CoreforgeAwsSsoConstants;
	/** A caller without an interactive surface must never trigger browser SSO. */
	canPrompt?: boolean;
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
 * Spawn a managed-profile AWS command with an explicit, credential-free
 * environment. It must not inherit operational AWS selectors or credentials.
 */
function backgroundAwsRunner(
	onProgress: (message: string) => void,
	timeoutMs = RECOVERY_TIMEOUT_MS,
	terminationGraceMs = RECOVERY_TERMINATION_GRACE_MS,
): NonNullable<CoreforgeAwsDependencies["run"]> {
	const env = Object.fromEntries(
		["HOME", "PATH", "SystemRoot", "TMPDIR", "USERPROFILE"]
			.map(key => [key, Bun.env[key]] as const)
			.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
	);
	return async (command, interactive) => {
		using child = ptree.spawn(command, {
			cwd: os.homedir(),
			env,
			detached: true,
			subreaper: true,
			timeout: timeoutMs + terminationGraceMs,
		});
		const timeout = setTimeout(() => {
			child.kill(new ptree.TimeoutError(timeoutMs, child.peekStderr()), terminationGraceMs);
		}, timeoutMs);
		try {
			const result = await child.wait({
				allowNonZero: true,
				maxOutputBytes: 1024 * 1024,
				onStdout: interactive ? onProgress : undefined,
			});
			if (interactive && result.stderr) onProgress(result.stderr);
			if (result.exitCode === null)
				throw result.exitError ?? new Error("AWS command terminated without an exit code");
			return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
		} finally {
			clearTimeout(timeout);
		}
	};
}

/**
 * Install the managed-model credential recovery handler. Managed SSO is
 * verified only when a managed consumer needs credentials.
 */
export function installCoreforgeAwsRecovery(options: CoreforgeAwsRecoveryOptions): void {
	const onProgress = options.onProgress ?? (message => logger.info(`[coreforge] ${message}`));
	const ensureAwsSso = options.ensureAwsSso ?? ensureManagedCoreforgeAwsSso;
	const setHandler = options.setHandler ?? setAwsCredentialRecoveryHandler;
	let failed = false;
	let inFlight: Promise<boolean> | undefined;
	setHandler(async (request: AwsCredentialRecoveryRequest): Promise<boolean> => {
		if (request.profile !== options.awsConfig.profile) {
			logger.warn("Ignoring AWS recovery request for unmanaged profile", {
				requestedProfile: request.profile,
				managedProfile: options.awsConfig.profile,
			});
			return false;
		}
		if (options.canPrompt === false || failed) return false;
		if (inFlight) return await inFlight;

		inFlight = (async () => {
			logger.warn("AWS session expired mid-session; re-authenticating", {
				profile: request.profile,
				kind: request.kind,
			});
			onProgress(`AWS session ${request.kind === "sso-token-expired" ? "expired" : "missing"}; signing in again...`);
			try {
				const identity = await ensureAwsSso(
					{ profile: request.profile, region: request.region },
					options.constants,
					onProgress,
					{
						run: backgroundAwsRunner(onProgress, options.recoveryTimeoutMs, options.terminationGraceMs),
						...options.awsDependencies,
					},
				);
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
			} catch (error) {
				failed = true;
				logger.warn("AWS SSO recovery failed", {
					profile: request.profile,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			} finally {
				inFlight = undefined;
			}
		})();
		return await inFlight;
	});
}
