import {
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	MANAGED_AWS_MODEL_AUTH_MODE,
} from "@oh-my-pi/pi-ai";
import type { Settings } from "../config/settings";
import type { CoreforgeAwsSsoConstants } from "./aws-profile";
import type { CoreforgeAwsConfig } from "./aws-sso";
import { validateCoreforgeAwsConfig } from "./aws-sso";
import { loadCoreforgeIdentityProfile } from "./coreforge-store";
import type { CoreforgeEntraConfig } from "./entra";
import { validateCoreforgeEntraConfig } from "./entra";

interface EnvironmentLike {
	[key: string]: string | undefined;
}

export interface CoreforgeClaudeConfig {
	workspaceId: string;
	baseUrl: string;
	inferenceGeo?: string;
}

export interface AppliedCoreforgeDefaults {
	/** Entra is enabled AND provisioned (tenant + client IDs present). */
	entraProvisioned: boolean;
	/** A signed-in product identity exists in the store. */
	identityAvailable: boolean;
	/** Managed env keys force-set from the signed-in identity. */
	appliedKeys: string[];
	/** Ambient model-auth env keys removed so they cannot shadow Entra routing. */
	clearedKeys: string[];
	/** The reserved inference profile was removed from operational AWS_PROFILE. */
	removedManagedAwsProfile: boolean;
	/** Message when a managed value was malformed (bad baseUrl/geo); surfaced by startup. */
	configError?: string;
}

function hasValue(value: string | undefined): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function isAnthropicAwsGateway(value: string | undefined): boolean {
	if (!value) return false;
	try {
		return /^aws-external-anthropic\.[a-z0-9-]+\.api\.aws$/i.test(new URL(value).hostname);
	} catch {
		return false;
	}
}

/**
 * Resolves the managed Entra client configuration, or undefined while identity
 * is off OR not yet provisioned (no tenant/client ID). Only a present-but-
 * malformed value throws: a managed overlay may ship `enabled: true` ahead of
 * the IT-issued IDs, and that pre-provisioning state must stay fully dormant —
 * no startup prompt, no error.
 */
export function resolveCoreforgeEntraConfig(settings: Settings): CoreforgeEntraConfig | undefined {
	if (!settings.get("identity.entra.enabled")) return undefined;
	const tenantId = settings.get("identity.entra.tenantId")?.trim();
	const clientId = settings.get("identity.entra.clientId")?.trim();
	if (!tenantId || !clientId) return undefined;
	return validateCoreforgeEntraConfig({
		tenantId,
		clientId,
		authorityHost: settings.get("identity.entra.authorityHost") ?? "",
	});
}

export function resolveCoreforgeAwsConfig(settings: Settings): CoreforgeAwsConfig | undefined {
	const profile = settings.get("identity.aws.profile");
	if (!profile) return undefined;
	return validateCoreforgeAwsConfig({ profile, region: settings.get("identity.aws.region") ?? "" });
}

/**
 * Managed IAM Identity Center constants, or undefined until the org overlay
 * carries all of them. With these present the startup flow can adopt an
 * existing matching `~/.aws/config` profile (any name) or seed the managed
 * one — without them the managed profile must pre-exist on the machine.
 */
export function resolveCoreforgeAwsSsoConstants(settings: Settings): CoreforgeAwsSsoConstants | undefined {
	const aws = resolveCoreforgeAwsConfig(settings);
	if (!aws) return undefined;
	const ssoStartUrl = settings.get("identity.aws.ssoStartUrl")?.trim();
	const ssoRegion = settings.get("identity.aws.ssoRegion")?.trim();
	const ssoAccountId = settings.get("identity.aws.ssoAccountId")?.trim();
	const ssoRoleName = settings.get("identity.aws.ssoRoleName")?.trim();
	if (!ssoStartUrl || !ssoRegion || !ssoAccountId || !ssoRoleName) return undefined;
	return { ...aws, ssoStartUrl, ssoRegion, ssoAccountId, ssoRoleName };
}

export function resolveCoreforgeClaudeConfig(settings: Settings): CoreforgeClaudeConfig | undefined {
	const workspaceId = settings.get("identity.claude.workspaceId")?.trim();
	if (!workspaceId) return undefined;
	const baseUrl = settings.get("identity.claude.baseUrl")?.trim() ?? "";
	if (!isAnthropicAwsGateway(baseUrl)) throw new Error(`Invalid managed Claude Platform on AWS URL: ${baseUrl}`);
	const inferenceGeo = settings.get("identity.claude.inferenceGeo")?.trim().toLowerCase();
	if (inferenceGeo && inferenceGeo !== "us" && inferenceGeo !== "global") {
		throw new Error(`Invalid managed Claude inference geography: ${inferenceGeo}`);
	}
	return { workspaceId, baseUrl, inferenceGeo: inferenceGeo || undefined };
}

/**
 * Provider-specific model credentials that must not shadow managed Entra
 * routing. Standard AWS credential-chain variables are deliberately excluded:
 * they belong to the employee's operational AWS CLI, SDKs, and MCP servers.
 * Managed model authentication uses the OMP_MODEL_AWS_* namespace instead.
 */
const MODEL_AUTH_ENV_VARS: readonly string[] = [
	"OPENAI_API_KEY",
	"OPENAI_AWS_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_WORKSPACE_ID",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_AWS_INFERENCE_GEO",
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
];

const OPERATIONAL_AWS_ENV_VARS = ["AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_PROFILE", "AWS_DEFAULT_REGION"] as const;

/**
 * Restore AWS selectors captured by the Coreforge launcher before managed
 * `.env` loading. Returns the pre-restore profile for managed-profile cleanup.
 */
export function restoreCoreforgeOperationalAwsEnvironment(env: EnvironmentLike = Bun.env): string | undefined {
	const profileBeforeRestore = env.AWS_PROFILE?.trim() || undefined;
	for (const key of OPERATIONAL_AWS_ENV_VARS) {
		const stateKey = `OMP_OPERATIONAL_${key}_SET`;
		const valueKey = `OMP_OPERATIONAL_${key}`;
		if (env[stateKey] === "1" && hasValue(env[valueKey])) env[key] = env[valueKey];
		else if (env[stateKey] === "0") delete env[key];
		delete env[stateKey];
		delete env[valueKey];
	}
	return profileBeforeRestore;
}

/**
 * Managed model-auth precedence for the coreforge product identity.
 *
 * - Entra disabled/unprovisioned: no-op — ambient env credentials remain the
 *   authoritative model-auth path.
 * - Entra enabled+provisioned: managed identity is the ONLY AWS-model auth
 *   path. Provider-specific model credentials are cleared, while operational
 *   AWS credentials remain available to tools. The model profile and region
 *   are injected through OMP_MODEL_AWS_* variables that AWS tooling ignores.
 *
 * Callers MUST invoke this only after the sign-in attempt has resolved (the
 * store already reflects a completed/declined/failed login), so a transient
 * sign-in failure never strips the env before a retry.
 */
export function applyCoreforgeIdentityProviderDefaults(
	settings: Settings,
	env: EnvironmentLike = Bun.env,
	loadIdentity: typeof loadCoreforgeIdentityProfile = loadCoreforgeIdentityProfile,
): AppliedCoreforgeDefaults {
	const profileBeforeOperationalRestore = restoreCoreforgeOperationalAwsEnvironment(env);
	// Provisioning = raw tenant+client ID presence, NOT the validating resolve:
	// IDs present-but-malformed is still provisioning INTENT, and must trigger
	// the clear (a bad UUID must not let ambient envs authenticate AWS models).
	// resolveCoreforgeEntraConfig would throw on malformed IDs; reading the raw
	// settings never does.
	const entraProvisioned =
		settings.get("identity.entra.enabled") === true &&
		hasValue(settings.get("identity.entra.tenantId")) &&
		hasValue(settings.get("identity.entra.clientId"));
	if (!entraProvisioned) {
		return {
			entraProvisioned: false,
			identityAvailable: false,
			appliedKeys: [],
			clearedKeys: [],
			removedManagedAwsProfile: false,
		};
	}
	const identity = loadIdentity();
	const identityAvailable = identity !== undefined;
	// Resolve every managed value BEFORE mutating env, so the clear+inject below
	// is one synchronous, non-throwing sequence — no window where a provider
	// (e.g. the SigV4 signer reading AWS_REGION) sees a cleared-but-not-yet-
	// reinjected value. A malformed managed value (e.g. bad claude baseUrl)
	// throws here: we capture the message (returned as configError for startup
	// to surface) but STILL run the clear below — provisioned Entra must never
	// leave ambient model-auth vars live, even on a misconfigured overlay. With
	// no managed values to inject, the clear removes the whole family and the
	// user is left signed-out-of-AWS-models (correct: envs must not authenticate
	// them).
	let managed: Record<string, string | undefined> = {
		[AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE,
	};
	let reservedModelProfile = identity?.aws?.profile ?? settings.get("identity.aws.profile")?.trim();
	let configError: string | undefined;
	if (identityAvailable) {
		try {
			const aws = resolveCoreforgeAwsConfig(settings);
			const claude = resolveCoreforgeClaudeConfig(settings);
			if (aws && claude) {
				const modelProfile = identity?.aws?.profile ?? aws.profile;
				reservedModelProfile = modelProfile;
				managed = {
					[AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE,
					[AWS_MODEL_PROFILE_ENV]: modelProfile,
					[AWS_MODEL_REGION_ENV]: aws.region,
					ANTHROPIC_AWS_WORKSPACE_ID: claude.workspaceId,
					ANTHROPIC_BASE_URL: claude.baseUrl,
					ANTHROPIC_AWS_INFERENCE_GEO: claude.inferenceGeo,
				};
			}
		} catch (error) {
			// Retain managed mode so ambient operational AWS credentials cannot
			// become a model-auth fallback while the identity config is invalid.
			managed = { [AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE };
			configError = error instanceof Error ? error.message : String(error);
		}
	}
	const clearedKeys: string[] = [];
	const hadManagedAwsProfile =
		reservedModelProfile !== undefined && profileBeforeOperationalRestore === reservedModelProfile;
	// Clear provider model-auth vars, then force-set the isolated managed values.
	for (const key of MODEL_AUTH_ENV_VARS) {
		if (hasValue(env[key]) && managed[key] === undefined) {
			delete env[key];
			clearedKeys.push(key);
		}
	}
	const appliedKeys: string[] = [];
	for (const [key, value] of Object.entries(managed)) {
		if (!value) continue;
		env[key] = value;
		appliedKeys.push(key);
	}
	const removedManagedAwsProfile =
		hadManagedAwsProfile || (reservedModelProfile !== undefined && env.AWS_PROFILE?.trim() === reservedModelProfile);
	if (reservedModelProfile !== undefined && env.AWS_PROFILE?.trim() === reservedModelProfile) {
		delete env.AWS_PROFILE;
	}
	return {
		entraProvisioned: true,
		identityAvailable,
		appliedKeys,
		clearedKeys,
		removedManagedAwsProfile,
		configError,
	};
}
