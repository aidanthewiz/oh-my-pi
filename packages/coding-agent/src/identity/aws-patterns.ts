/**
 * Shared validation patterns for managed AWS identity constants. Kept in one
 * place so the profile/region/control-char rules can never drift between the
 * profile seeder (aws-profile.ts) and the SSO orchestrator (aws-sso.ts).
 */

/** AWS profile name: the safe subset accepted in `~/.aws/config` section names. */
export const AWS_PROFILE_PATTERN = /^[A-Za-z0-9._-]+$/;

/** AWS region, incl. GovCloud (`us-gov-west-1`). */
export const AWS_REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

/** Control characters that must never reach an AWS CLI argv or config write. */
export const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
