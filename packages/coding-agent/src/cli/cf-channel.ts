/**
 * Coreforge release channel.
 *
 * Coreforge startup checks read independent Coreforge product releases, while
 * direct engine self-update reads this private fork's releases instead of
 * npm/GitHub upstream. Engine versions carry a fourth segment (`16.3.11.2` =
 * upstream 16.3.11 + coreforge patch roll 2).
 *
 * Private-repo release assets cannot be fetched via browser_download_url with
 * a bare token; they must go through the asset API endpoint with
 * `Accept: application/octet-stream`. Token resolution order:
 * OMP_UPDATE_GITHUB_TOKEN, GITHUB_TOKEN, GH_TOKEN, then `gh auth token`.
 */
import { $ } from "bun";
import { compareCfProductVersions, isCfProductVersion } from "./cf-version";

export const CF_ENGINE_RELEASE_REPO = "Coreforce-CAD/oh-my-pi";
export const CF_PRODUCT_RELEASE_REPO = "Coreforce-CAD/coreforge";

export interface CfReleaseAsset {
	name: string;
	/** Asset API URL (`…/releases/assets/<id>`) - the auth-compatible download endpoint. */
	url: string;
	size: number;
	/** GitHub-provided content digest, when available for the uploaded asset. */
	digest?: string | null;
}

type CfFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CfFetchOptions {
	fetchImpl?: CfFetch;
	/** undefined resolves the normal token chain; null forces the unauthenticated path. */
	tokenOverride?: string | null;
}

function isCfReleaseAsset(value: unknown): value is CfReleaseAsset {
	return (
		!!value &&
		typeof value === "object" &&
		"name" in value &&
		typeof value.name === "string" &&
		"url" in value &&
		typeof value.url === "string" &&
		"size" in value &&
		typeof value.size === "number" &&
		(!("digest" in value) || value.digest === null || typeof value.digest === "string")
	);
}

export interface CfRelease {
	tag: string;
	/** Tag with the leading `v` stripped, e.g. "16.3.11.2". */
	version: string;
	assets: CfReleaseAsset[];
}

let cachedToken: string | null | undefined;

/** Resolve a GitHub token able to read the private mirror. Cached per process. */
export async function resolveCfToken(): Promise<string | undefined> {
	if (cachedToken !== undefined) return cachedToken ?? undefined;
	for (const key of ["OMP_UPDATE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"]) {
		const value = process.env[key]?.trim();
		if (value) {
			cachedToken = value;
			return value;
		}
	}
	try {
		const result = await $`gh auth token`.quiet().nothrow();
		const token = result.exitCode === 0 ? result.text().trim() : "";
		cachedToken = token || null;
		return token || undefined;
	} catch {
		cachedToken = null;
		return undefined;
	}
}

function apiHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
}

function parseCfRelease(data: unknown): CfRelease {
	if (
		!data ||
		typeof data !== "object" ||
		!("tag_name" in data) ||
		typeof data.tag_name !== "string" ||
		!("assets" in data) ||
		!Array.isArray(data.assets)
	) {
		throw new Error("release lookup returned an unexpected payload shape");
	}
	const assets = data.assets.filter(isCfReleaseAsset);
	if (assets.length !== data.assets.length) {
		throw new Error(`release lookup returned ${data.assets.length - assets.length} malformed asset entries`);
	}
	return {
		tag: data.tag_name,
		version: data.tag_name.replace(/^v/, ""),
		assets,
	};
}

/**
 * Fetch the latest release from a private Coreforce repository.
 * Throws when no token is available or the API call fails - callers on the
 * interactive path surface the error; the startup check swallows it.
 */
async function fetchLatestRelease(
	repo: string,
	signal?: AbortSignal,
	options: CfFetchOptions = {},
): Promise<CfRelease> {
	const token =
		options.tokenOverride === undefined ? await resolveCfToken() : options.tokenOverride?.trim() || undefined;
	if (!token) {
		throw new Error("no GitHub token for the coreforge update channel (set GITHUB_TOKEN or run `gh auth login`)");
	}
	const response = await (options.fetchImpl ?? fetch)(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: apiHeaders(token),
		signal,
	});
	if (!response.ok) {
		throw new Error(`release lookup failed: ${response.status} ${response.statusText}`);
	}
	return parseCfRelease(await response.json());
}
async function fetchLatestBetaProductRelease(signal?: AbortSignal): Promise<CfRelease | undefined> {
	const token = await resolveCfToken();
	if (!token) {
		throw new Error("no GitHub token for the coreforge update channel (set GITHUB_TOKEN or run `gh auth login`)");
	}
	const response = await fetch(`https://api.github.com/repos/${CF_PRODUCT_RELEASE_REPO}/releases?per_page=100`, {
		headers: apiHeaders(token),
		signal,
	});
	if (!response.ok) {
		throw new Error(`release lookup failed: ${response.status} ${response.statusText}`);
	}
	const data: unknown = await response.json();
	if (!Array.isArray(data)) {
		throw new Error("release lookup returned an unexpected payload shape");
	}
	const candidates = data
		.filter(
			(release): release is Record<string, unknown> =>
				!!release &&
				typeof release === "object" &&
				release.draft === false &&
				release.prerelease === true &&
				typeof release.tag_name === "string" &&
				release.tag_name.includes("-beta.") &&
				isCfProductVersion(release.tag_name.replace(/^v/, "")),
		)
		.map(parseCfRelease);
	return candidates.toSorted((a, b) => compareCfProductVersions(b.version, a.version))[0];
}

/** Fetch the latest product release allowed by the launcher's update channel. */
export async function fetchCfLatestProductRelease(signal?: AbortSignal): Promise<CfRelease> {
	const stable = await fetchLatestRelease(CF_PRODUCT_RELEASE_REPO, signal);
	if (process.env.OMP_CF_UPDATE_CHANNEL?.trim().toLowerCase() !== "beta") return stable;
	try {
		const beta = await fetchLatestBetaProductRelease(signal);
		return beta && compareCfProductVersions(beta.version, stable.version) > 0 ? beta : stable;
	} catch (error) {
		if (signal?.aborted) throw error;
		return stable;
	}
}
/** Fetch the latest fork engine release used by the binary updater. */
export function fetchCfLatestRelease(signal?: AbortSignal, options?: CfFetchOptions): Promise<CfRelease> {
	return fetchLatestRelease(CF_ENGINE_RELEASE_REPO, signal, options);
}

/**
 * Open a download stream for a private release asset via the asset API.
 */
export async function fetchCfAsset(
	asset: CfReleaseAsset,
	signal?: AbortSignal,
	options: CfFetchOptions = {},
): Promise<Response> {
	const token =
		options.tokenOverride === undefined ? await resolveCfToken() : options.tokenOverride?.trim() || undefined;
	if (!token) throw new Error("no GitHub token for the coreforge update channel");
	const response = await (options.fetchImpl ?? fetch)(asset.url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" },
		redirect: "follow",
		signal,
	});
	if (!response.ok || !response.body) {
		throw new Error(`asset download failed: ${response.status} ${response.statusText}`);
	}
	return response;
}
