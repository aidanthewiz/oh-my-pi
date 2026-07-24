import type { Settings } from "../config/settings";
import { ensureManagedCoreforgeAwsSso } from "./aws-sso";
import { resolveCoreforgeAwsConfig, resolveCoreforgeAwsSsoConstants } from "./runtime";

const RELAY_TOKEN_DURATION_SECONDS = 300;
const RELAY_TOKEN_ALGORITHM = "RS256";
const RELAY_USER_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface AwsCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface RelayIdentityDependencies {
	findAws?: () => string | undefined;
	run?: (command: string[], interactive: boolean) => Promise<AwsCommandResult>;
	ensureAwsSso?: typeof ensureManagedCoreforgeAwsSso;
	fetch?: typeof fetch;
}

async function runCommand(command: string[], interactive: boolean): Promise<AwsCommandResult> {
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

/** Managed relay audience, absent when upstream/self-hosted omp authentication is disabled. */
export function resolveRelayIdentityAudience(settings: Settings): string | undefined {
	const configured = settings.get("identity.relay.audience")?.trim();
	if (!configured) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(configured);
	} catch {
		throw new Error(`Invalid managed relay audience: ${configured}`);
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("Managed relay audience must be an HTTPS origin");
	}
	const normalized = parsed.origin;
	if (configured.replace(/\/$/, "") !== normalized) {
		throw new Error("Managed relay audience must not contain a path");
	}
	return normalized;
}

/** Reject an authenticated relay URL whose origin could receive a token minted for another service. */
export function assertRelayServiceAudience(serviceUrl: string, audience: string): void {
	let parsed: URL;
	try {
		parsed = new URL(serviceUrl);
	} catch {
		throw new Error(`Invalid relay service URL: ${serviceUrl}`);
	}
	const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol;
	if (protocol !== "https:" || parsed.username || parsed.password) {
		throw new Error("Authenticated relay service URL must use HTTPS or WSS");
	}
	const serviceOrigin = `${protocol}//${parsed.host}`;
	if (serviceOrigin !== audience) {
		throw new Error(`Relay service origin ${serviceOrigin} does not match identity audience ${audience}`);
	}
}

/** Mint a five-minute AWS STS identity proof for the managed relay. */
export async function getCoreforgeRelayIdentityToken(
	settings: Settings,
	onProgress: (message: string) => void = () => {},
	deps: RelayIdentityDependencies = {},
): Promise<string> {
	const audience = resolveRelayIdentityAudience(settings);
	if (!audience) throw new Error("Managed relay identity is not configured");
	const awsConfig = resolveCoreforgeAwsConfig(settings);
	if (!awsConfig) throw new Error("Managed AWS identity is not configured");
	const ensureAws = deps.ensureAwsSso ?? ensureManagedCoreforgeAwsSso;
	const identity = await ensureAws(awsConfig, resolveCoreforgeAwsSsoConstants(settings), onProgress);
	const executable = deps.findAws ? deps.findAws() : Bun.which("aws");
	if (!executable) throw new Error("AWS CLI v2 is required for relay authentication");
	const run = deps.run ?? runCommand;
	const result = await run(
		[
			executable,
			"sts",
			"get-web-identity-token",
			"--profile",
			identity.profile,
			"--region",
			identity.region,
			"--audience",
			audience,
			"--duration-seconds",
			String(RELAY_TOKEN_DURATION_SECONDS),
			"--signing-algorithm",
			RELAY_TOKEN_ALGORITHM,
			"--query",
			"WebIdentityToken",
			"--output",
			"text",
		],
		false,
	);
	if (result.exitCode !== 0) {
		const detail = (result.stderr || result.stdout).trim().slice(-400) || "unknown AWS CLI error";
		throw new Error(`Relay identity token request failed: ${detail}`);
	}
	const token = result.stdout.trim();
	if (!JWT_RE.test(token) || token.length > 16_384) {
		throw new Error("AWS STS returned an invalid relay identity token");
	}
	return token;
}

/** Token callback for native collab/share clients; undefined keeps upstream relays backward-compatible. */
export function createRelayIdentityTokenProvider(
	settings: Settings,
	serviceUrl: string,
	onProgress?: (message: string) => void,
): (() => Promise<string>) | undefined {
	const audience = resolveRelayIdentityAudience(settings);
	if (!audience) return undefined;
	assertRelayServiceAudience(serviceUrl, audience);
	return () => getCoreforgeRelayIdentityToken(settings, onProgress);
}

/** Approve a browser device challenge after authenticating with the managed AWS identity. */
export async function approveRelayBrowser(
	settings: Settings,
	userCode: string,
	onProgress: (message: string) => void = () => {},
	deps: RelayIdentityDependencies = {},
): Promise<void> {
	const code = userCode.trim().toUpperCase();
	if (!RELAY_USER_CODE_RE.test(code)) throw new Error("Relay authorization code must look like ABCD-EFGH");
	const audience = resolveRelayIdentityAudience(settings);
	if (!audience) throw new Error("Managed relay identity is not configured");
	const token = await getCoreforgeRelayIdentityToken(settings, onProgress, deps);
	const request = deps.fetch ?? fetch;
	const response = await request(`${audience}/auth/browser/approve`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ code }),
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).trim().slice(0, 200);
		throw new Error(`Relay browser authorization failed: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
	}
}
