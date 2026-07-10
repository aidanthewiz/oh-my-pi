import { $env } from "@oh-my-pi/pi-utils";

export const AWS_MODEL_AUTH_MODE_ENV = "OMP_MODEL_AWS_AUTH_MODE";
export const AWS_MODEL_PROFILE_ENV = "OMP_MODEL_AWS_PROFILE";
export const AWS_MODEL_REGION_ENV = "OMP_MODEL_AWS_REGION";
export const MANAGED_AWS_MODEL_AUTH_MODE = "managed";

type EnvironmentLike = Record<string, string | undefined>;

export function isManagedAwsModelAuth(env: EnvironmentLike = $env): boolean {
	return env[AWS_MODEL_AUTH_MODE_ENV] === MANAGED_AWS_MODEL_AUTH_MODE;
}

export function resolveAwsModelProfile(env: EnvironmentLike = $env): string | undefined {
	const value = isManagedAwsModelAuth(env) ? env[AWS_MODEL_PROFILE_ENV] : env.AWS_PROFILE;
	return value?.trim() || undefined;
}

export function resolveAwsModelRegion(env: EnvironmentLike = $env): string | undefined {
	const value = isManagedAwsModelAuth(env) ? env[AWS_MODEL_REGION_ENV] : env.AWS_REGION || env.AWS_DEFAULT_REGION;
	return value?.trim() || undefined;
}

export function allowAmbientAwsModelCredentials(env: EnvironmentLike = $env): boolean {
	return !isManagedAwsModelAuth(env);
}

export function hasAwsModelCredentialChain(env: EnvironmentLike = $env): boolean {
	if (isManagedAwsModelAuth(env)) return resolveAwsModelProfile(env) !== undefined;
	const hasEcsCredentials = !!env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || !!env.AWS_CONTAINER_CREDENTIALS_FULL_URI;
	const hasWebIdentity = !!env.AWS_WEB_IDENTITY_TOKEN_FILE && !!env.AWS_ROLE_ARN;
	return !!(
		env.AWS_PROFILE ||
		(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ||
		hasEcsCredentials ||
		hasWebIdentity
	);
}
