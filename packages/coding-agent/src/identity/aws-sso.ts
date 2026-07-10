import { AWS_PROFILE_PATTERN, AWS_REGION_PATTERN, CONTROL_CHARACTER_PATTERN } from "./aws-patterns";
import {
	type CoreforgeAwsSsoConstants,
	type ResolvedAwsProfile,
	resolveOrSeedCoreforgeAwsProfile,
} from "./aws-profile";
import type { CoreforgeAwsIdentity } from "./coreforge-store";

export interface CoreforgeAwsConfig {
	profile: string;
	region: string;
}

interface AwsCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface CoreforgeAwsDependencies {
	findAws?: () => string | undefined;
	run?: (command: string[], interactive: boolean) => Promise<AwsCommandResult>;
	now?: () => number;
	resolveProfile?: (constants: CoreforgeAwsSsoConstants) => ResolvedAwsProfile;
}

async function runAwsCommand(command: string[], interactive: boolean): Promise<AwsCommandResult> {
	const child = Bun.spawn(command, {
		stdin: interactive ? "inherit" : "ignore",
		stdout: interactive ? "inherit" : "pipe",
		stderr: interactive ? "inherit" : "pipe",
	});
	const exitCode = await child.exited;
	return {
		exitCode,
		stdout: interactive ? "" : await new Response(child.stdout).text(),
		stderr: interactive ? "" : await new Response(child.stderr).text(),
	};
}

/** Strict check for MANAGED values (org settings); adopted names are exempt. */
export function validateCoreforgeAwsConfig(config: CoreforgeAwsConfig): CoreforgeAwsConfig {
	const profile = config.profile.trim();
	const region = config.region.trim();
	if (!AWS_PROFILE_PATTERN.test(profile)) throw new Error(`Invalid managed AWS profile: ${profile || "<empty>"}`);
	if (!AWS_REGION_PATTERN.test(region)) throw new Error(`Invalid managed AWS region: ${region || "<empty>"}`);
	return { profile, region };
}

/**
 * Argv-safety check before spawning the AWS CLI. Adoption accepts any
 * existing `~/.aws/config` profile name (content-keyed), so this only blocks
 * shapes that change the COMMAND: a leading `-` (flag injection) or control
 * characters. The profile is always a discrete `Bun.spawn` argv element —
 * never a shell string — so spaces and punctuation are safe.
 */
function validateAwsSpawnConfig(config: CoreforgeAwsConfig): CoreforgeAwsConfig {
	const profile = config.profile.trim();
	const region = config.region.trim();
	if (!profile || profile.startsWith("-") || CONTROL_CHARACTER_PATTERN.test(profile)) {
		throw new Error(`Unsafe AWS profile name: ${profile || "<empty>"}`);
	}
	if (!AWS_REGION_PATTERN.test(region)) throw new Error(`Invalid managed AWS region: ${region || "<empty>"}`);
	return { profile, region };
}

export async function ensureCoreforgeAwsSso(
	config: CoreforgeAwsConfig,
	onProgress: (message: string) => void = () => {},
	deps: CoreforgeAwsDependencies = {},
): Promise<CoreforgeAwsIdentity> {
	const normalized = validateAwsSpawnConfig(config);
	const executable = deps.findAws ? deps.findAws() : Bun.which("aws");
	if (!executable) throw new Error("AWS CLI v2 is required for Coreforge AWS sign-in");
	const run = deps.run ?? runAwsCommand;
	const identityCommand = [
		executable,
		"sts",
		"get-caller-identity",
		"--profile",
		normalized.profile,
		"--region",
		normalized.region,
		"--output",
		"json",
	];
	let result = await run(identityCommand, false);
	if (result.exitCode !== 0) {
		onProgress(`Opening AWS IAM Identity Center sign-in for profile ${normalized.profile}...`);
		const login = await run([executable, "sso", "login", "--profile", normalized.profile], true);
		if (login.exitCode !== 0) {
			throw new Error(`AWS SSO sign-in failed for profile ${normalized.profile}`);
		}
		result = await run(identityCommand, false);
	}
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(-400) || "unknown AWS CLI error";
		throw new Error(`AWS identity validation failed for profile ${normalized.profile}: ${detail}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (error) {
		throw new Error("AWS STS returned invalid identity JSON", { cause: error });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("AWS STS returned an invalid identity response");
	}
	const identity = parsed as { Account?: unknown; Arn?: unknown; UserId?: unknown };
	if (typeof identity.Account !== "string" || typeof identity.Arn !== "string") {
		throw new Error("AWS STS identity response is missing Account or Arn");
	}
	return {
		profile: normalized.profile,
		region: normalized.region,
		accountId: identity.Account,
		roleArn: identity.Arn,
		userId: typeof identity.UserId === "string" ? identity.UserId : undefined,
		validatedAt: (deps.now ?? Date.now)(),
	};
}

/**
 * Resolve/adopt the managed Identity Center profile before invoking AWS CLI,
 * then reject any profile whose live STS identity points at another account.
 * Both startup and the explicit `identity login` command use this path.
 */
export async function ensureManagedCoreforgeAwsSso(
	config: CoreforgeAwsConfig,
	constants: CoreforgeAwsSsoConstants | undefined,
	onProgress: (message: string) => void = () => {},
	deps: CoreforgeAwsDependencies = {},
): Promise<CoreforgeAwsIdentity> {
	let loginConfig = config;
	if (constants) {
		const resolved = (deps.resolveProfile ?? resolveOrSeedCoreforgeAwsProfile)(constants);
		if (resolved.source !== "existing-managed") {
			onProgress(
				`AWS profile '${resolved.profile}' (${resolved.source}) targets the managed Identity Center account.`,
			);
		}
		loginConfig = { ...config, profile: resolved.profile };
	}
	const identity = await ensureCoreforgeAwsSso(loginConfig, onProgress, deps);
	if (constants && identity.accountId !== constants.ssoAccountId) {
		throw new Error(
			`AWS profile '${loginConfig.profile}' resolves to account ${identity.accountId}, ` +
				`expected the managed account ${constants.ssoAccountId}`,
		);
	}
	return identity;
}
