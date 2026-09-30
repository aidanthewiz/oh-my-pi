/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "./registry";
import type { AuthAccountPolicies } from "@oh-my-pi/pi-ai/auth-storage";

/** Display metadata for one model tag. */
export interface ModelTagDef {
	name: string;
	color?: string;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

/** Model tags keyed by tag id (`modelTags`). */
export type ModelTagsSettings = Record<string, ModelTagDef>;

const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_STRING_RECORD: Record<string, string> = {};
const DEFAULT_CYCLE_ORDER: string[] = ["smol", "default", "slow"];
const EMPTY_MODEL_TAGS_RECORD: ModelTagsSettings = {};
const EMPTY_AUTH_ACCOUNT_POLICIES: AuthAccountPolicies = [];

// Auth broker — credentials proxied through a remote `omp auth-broker serve`
// host. Hidden from the UI; populate via env vars or hand-edited config.yml. Env takes
// precedence so per-machine overrides remain trivial. The connection itself is resolved by
// `@oh-my-pi/pi-ai/auth-broker/discover` from env + global config.yml only (project layers
// never redirect credentials); these definitions own validation, CLI, and `cfg://` display.
export const cfgAuthBrokerUrl = register({
	id: "auth.broker.url",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_URL",
});

export const cfgAuthBrokerToken = register({
	id: "auth.broker.token",
	type: "string",
	default: undefined,
	env: "OMP_AUTH_BROKER_TOKEN",
	credential: true,
});

export const cfgAuthAccountPolicies = register({
	id: "auth.accountPolicies",
	type: "array",
	default: EMPTY_AUTH_ACCOUNT_POLICIES,
});

export const cfgEnabledModels = register({
	id: "enabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});
export const cfgDisabledModels = register({
	id: "disabledModels",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "models" },
});

export const cfgEnabledProviders = register({
	id: "enabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgDisabledProviders = register({
	id: "disabledProviders",
	type: "array",
	default: EMPTY_STRING_ARRAY,
	pathScoped: { valuesKey: "providers" },
});

export const cfgModelRoleStorage = register({
	id: "modelRoleStorage",
	type: "enum",
	values: ["global", "project"] as const,
	default: "global",
	ui: {
		tab: "model",
		group: "Prompt",
		label: "Model Role Storage",
		description: "Where model selector role assignments are saved",
		options: [
			{
				value: "global",
				label: "Global",
				description: "Save role models in the active profile config (current behavior)",
			},
			{
				value: "project",
				label: "Per-project",
				description: "Save project role models in .omp/config.yml; missing project roles use global defaults",
			},
		],
	},
});

export const cfgModelRoles = register({ id: "modelRoles", type: "record", default: EMPTY_STRING_RECORD });

export const cfgModelTags = register({ id: "modelTags", type: "record", default: EMPTY_MODEL_TAGS_RECORD });

export const cfgModelProviderOrder = register({ id: "modelProviderOrder", type: "array", default: EMPTY_STRING_ARRAY });

export const cfgCycleOrder = register({ id: "cycleOrder", type: "array", default: DEFAULT_CYCLE_ORDER });

// Managed product identity is configured by the read-only managed layer. Credentials and
// profile attributes live in agent.db; these declarations contain only non-secret selectors.
export const cfgIdentityEntraEnabled = register({ id: "identity.entra.enabled", type: "boolean", default: false });
export const cfgIdentityEntraTenantId = register({ id: "identity.entra.tenantId", type: "string", default: undefined });
export const cfgIdentityEntraClientId = register({ id: "identity.entra.clientId", type: "string", default: undefined });
export const cfgIdentityEntraAuthorityHost = register({
	id: "identity.entra.authorityHost",
	type: "string",
	default: "login.microsoftonline.com",
});
export const cfgIdentityAwsProfile = register({ id: "identity.aws.profile", type: "string", default: undefined });
export const cfgIdentityAwsRegion = register({ id: "identity.aws.region", type: "string", default: "us-east-1" });
export const cfgIdentityAwsSsoStartUrl = register({
	id: "identity.aws.ssoStartUrl",
	type: "string",
	default: undefined,
});
export const cfgIdentityAwsSsoRegion = register({ id: "identity.aws.ssoRegion", type: "string", default: undefined });
export const cfgIdentityAwsSsoAccountId = register({
	id: "identity.aws.ssoAccountId",
	type: "string",
	default: undefined,
});
export const cfgIdentityAwsSsoRoleName = register({
	id: "identity.aws.ssoRoleName",
	type: "string",
	default: undefined,
});
export const cfgIdentityRelayAudience = register({
	id: "identity.relay.audience",
	type: "string",
	default: undefined,
});
export const cfgIdentityClaudeWorkspaceId = register({
	id: "identity.claude.workspaceId",
	type: "string",
	default: undefined,
});
export const cfgIdentityClaudeBaseUrl = register({
	id: "identity.claude.baseUrl",
	type: "string",
	default: "https://aws-external-anthropic.us-east-1.api.aws",
});
export const cfgIdentityClaudeInferenceGeo = register({
	id: "identity.claude.inferenceGeo",
	type: "string",
	default: undefined,
});
