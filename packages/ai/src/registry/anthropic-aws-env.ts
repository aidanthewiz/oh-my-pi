import { $env } from "@oh-my-pi/pi-utils";

/**
 * Credential resolution for Claude Platform on AWS (the
 * `aws-external-anthropic.{region}.api.aws` gateway), shared by the availability
 * gate (`anthropic-aws.ts`) and the request transport (`providers/anthropic.ts`)
 * so both read the SAME env every time — a gate that passes must build a request
 * that carries the workspace-id header, and vice versa.
 *
 * Two families of env names reach the same gateway:
 *  - AWS-scoped names — `ANTHROPIC_AWS_WORKSPACE_ID` / `ANTHROPIC_AWS_API_KEY`.
 *    Unambiguous opt-in; always honored.
 *  - Native Anthropic names — `ANTHROPIC_WORKSPACE_ID` / `ANTHROPIC_API_KEY`.
 *    AWS's own onboarding hands these out (alongside `ANTHROPIC_BASE_URL` set to
 *    the gateway), so a machine configured per the AWS docs works out of the box.
 *    These are honored ONLY when `ANTHROPIC_BASE_URL` is the gateway host, so a
 *    plain `api.anthropic.com` key is never misrouted to AWS.
 *
 * The AWS-scoped name always wins when both are present (explicit over inferred).
 */

/**
 * True when `ANTHROPIC_BASE_URL` points at the AWS external-Anthropic gateway.
 * Parsed with `URL` and matched on the FULL hostname (not a substring/suffix) so
 * a look-alike like `aws-external-anthropic.us-east-1.api.aws.evil.com` is rejected.
 */
export function anthropicBaseUrlIsAwsGateway(): boolean {
	const raw = $env.ANTHROPIC_BASE_URL?.trim();
	if (!raw) return false;
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		return false;
	}
	return /^aws-external-anthropic\.[a-z0-9-]+\.api\.aws$/i.test(host);
}

/**
 * Workspace id for the gateway (`anthropic-workspace-id` header). The AWS-scoped
 * name wins; the native name is a fallback only under the gateway base URL.
 * Trimmed; undefined when absent/empty.
 */
export function resolveAnthropicAwsWorkspaceId(): string | undefined {
	const aws = $env.ANTHROPIC_AWS_WORKSPACE_ID?.trim();
	if (aws) return aws;
	if (anthropicBaseUrlIsAwsGateway()) {
		const native = $env.ANTHROPIC_WORKSPACE_ID?.trim();
		if (native) return native;
	}
	return undefined;
}

/**
 * True when the ONLY workspace id available is the native `ANTHROPIC_WORKSPACE_ID`
 * (no AWS-scoped `ANTHROPIC_AWS_WORKSPACE_ID`). The native family is the AWS
 * console's API-key onboarding path, so it authenticates via `ANTHROPIC_API_KEY`
 * (Bearer) only — the SigV4 credential chain is reserved for an explicit
 * AWS-scoped opt-in. Callers use this to refuse a SigV4-only native setup.
 */
export function anthropicAwsWorkspaceIdIsNativeOnly(): boolean {
	if ($env.ANTHROPIC_AWS_WORKSPACE_ID?.trim()) return false;
	return anthropicBaseUrlIsAwsGateway() && !!$env.ANTHROPIC_WORKSPACE_ID?.trim();
}

/**
 * Bearer API key for the gateway, from the SAME family as the workspace id:
 *  - AWS-scoped workspace (`ANTHROPIC_AWS_WORKSPACE_ID`) ⇒ `ANTHROPIC_AWS_API_KEY`.
 *  - Native workspace (`ANTHROPIC_WORKSPACE_ID` under the gateway URL) ⇒
 *    `ANTHROPIC_API_KEY`.
 * The families never cross: a native workspace is never authenticated by the
 * AWS-scoped key, so a native `api.anthropic.com`-style key never signs an AWS
 * request and the AWS-scoped key never rescues a native-only workspace. Trimmed;
 * undefined when the matching key is absent (the AWS-scoped family then tries the
 * SigV4 credential chain; the native family has no SigV4 fallback).
 */
export function resolveAnthropicAwsApiKey(): string | undefined {
	if ($env.ANTHROPIC_AWS_WORKSPACE_ID?.trim()) {
		return $env.ANTHROPIC_AWS_API_KEY?.trim() || undefined;
	}
	if (anthropicBaseUrlIsAwsGateway() && $env.ANTHROPIC_WORKSPACE_ID?.trim()) {
		return $env.ANTHROPIC_API_KEY?.trim() || undefined;
	}
	return undefined;
}
