import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import {
	CF_ENGINE_RELEASE_REPO,
	CF_PRODUCT_RELEASE_REPO,
	fetchCfAsset,
	fetchCfLatestProductRelease,
	fetchCfLatestRelease,
	resolveCfToken,
} from "@oh-my-pi/pi-coding-agent/cli/cf-channel";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

/**
 * resolveCfToken caches its result per process, so this file gets exactly one
 * observable resolution. Priming both env keys before the first call pins the
 * outcome (no `gh auth token` shell-out, no network) and doubles as the
 * priority test: OMP_UPDATE_GITHUB_TOKEN must win over GITHUB_TOKEN.
 */
const CF_TOKEN = "cf-test-token";
const TOKEN_KEYS = ["OMP_UPDATE_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof TOKEN_KEYS)[number], string | undefined>> = {};
const savedProductChannel = process.env.OMP_CF_UPDATE_CHANNEL;

beforeAll(() => {
	for (const key of TOKEN_KEYS) savedEnv[key] = process.env[key];
	process.env.OMP_UPDATE_GITHUB_TOKEN = CF_TOKEN;
	process.env.GITHUB_TOKEN = "lower-priority-token";
	delete process.env.OMP_CF_UPDATE_CHANNEL;
	delete process.env.GH_TOKEN;
});

afterAll(() => {
	for (const key of TOKEN_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (savedProductChannel === undefined) delete process.env.OMP_CF_UPDATE_CHANNEL;
	else process.env.OMP_CF_UPDATE_CHANNEL = savedProductChannel;
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.OMP_CF_UPDATE_CHANNEL;
});

function mockFetch(handler: (input: FetchInput, init?: FetchInit) => Response | Promise<Response>): void {
	const fetchMock: typeof globalThis.fetch = Object.assign(
		async (input: FetchInput, init?: FetchInit) => handler(input, init),
		{ preconnect: globalThis.fetch.preconnect },
	);
	vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
}

function releasePayload(overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		tag_name: "v16.3.11.2",
		assets: [
			{ name: "omp-darwin-arm64", url: "https://api.github.com/repos/x/y/releases/assets/1", size: 123 },
			{ name: "omp-linux-x64", url: "https://api.github.com/repos/x/y/releases/assets/2", size: 456 },
		],
		...overrides,
	};
}

describe("resolveCfToken", () => {
	it("resolves OMP_UPDATE_GITHUB_TOKEN ahead of GITHUB_TOKEN and caches it", async () => {
		expect(await resolveCfToken()).toBe(CF_TOKEN);
		// Cached: removing the env var no longer changes the answer.
		delete process.env.OMP_UPDATE_GITHUB_TOKEN;
		expect(await resolveCfToken()).toBe(CF_TOKEN);
		process.env.OMP_UPDATE_GITHUB_TOKEN = CF_TOKEN;
	});
});

describe("fetchCfLatestRelease", () => {
	it("requests the mirror's latest release with auth headers and maps the payload", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestSignal: AbortSignal | null | undefined;
		mockFetch((input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestSignal = init?.signal;
			return Response.json(releasePayload());
		});

		const controller = new AbortController();
		const release = await fetchCfLatestRelease(controller.signal);

		expect(requestUrl).toBe(`https://api.github.com/repos/${CF_ENGINE_RELEASE_REPO}/releases/latest`);
		expect(requestHeaders?.get("Authorization")).toBe(`Bearer ${CF_TOKEN}`);
		expect(requestHeaders?.get("Accept")).toBe("application/vnd.github+json");
		expect(requestSignal).toBe(controller.signal);
		expect(release.tag).toBe("v16.3.11.2");
		expect(release.version).toBe("16.3.11.2");
		expect(release.assets).toEqual([
			{ name: "omp-darwin-arm64", url: "https://api.github.com/repos/x/y/releases/assets/1", size: 123 },
			{ name: "omp-linux-x64", url: "https://api.github.com/repos/x/y/releases/assets/2", size: 456 },
		]);
	});

	it("requests the independently versioned Coreforge product release", async () => {
		let requestUrl: string | undefined;
		mockFetch(input => {
			requestUrl = String(input);
			return Response.json(releasePayload({ tag_name: "v1.4.0", assets: [] }));
		});

		const release = await fetchCfLatestProductRelease();

		expect(requestUrl).toBe(`https://api.github.com/repos/${CF_PRODUCT_RELEASE_REPO}/releases/latest`);
		expect(release).toEqual({ tag: "v1.4.0", version: "1.4.0", assets: [] });
	});

	it("includes prereleases only for an explicit beta channel", async () => {
		process.env.OMP_CF_UPDATE_CHANNEL = "beta";
		const requestUrls: string[] = [];
		mockFetch(input => {
			const requestUrl = String(input);
			requestUrls.push(requestUrl);
			if (requestUrl.endsWith("/releases/latest")) {
				return Response.json(releasePayload({ tag_name: "v1.4.0", assets: [] }));
			}
			return Response.json([
				releasePayload({ tag_name: "v1.5.0-beta.2", assets: [], draft: false, prerelease: true }),
				releasePayload({ tag_name: "v1.5.0-beta.10", assets: [], draft: false, prerelease: true }),
				releasePayload({ tag_name: "v2.0.0-beta.1", assets: [], draft: true, prerelease: true }),
				releasePayload({ tag_name: "v9.0.0", assets: [], draft: false, prerelease: false }),
			]);
		});

		const release = await fetchCfLatestProductRelease();

		expect(requestUrls).toEqual([
			`https://api.github.com/repos/${CF_PRODUCT_RELEASE_REPO}/releases/latest`,
			`https://api.github.com/repos/${CF_PRODUCT_RELEASE_REPO}/releases?per_page=100`,
		]);
		expect(release).toEqual({ tag: "v1.5.0-beta.10", version: "1.5.0-beta.10", assets: [] });
	});

	it("keeps the stable release when it outranks the latest beta", async () => {
		process.env.OMP_CF_UPDATE_CHANNEL = "beta";
		mockFetch(input => {
			if (String(input).endsWith("/releases/latest")) {
				return Response.json(releasePayload({ tag_name: "v1.5.0", assets: [] }));
			}
			return Response.json([
				releasePayload({ tag_name: "v1.5.0-beta.99", assets: [], draft: false, prerelease: true }),
			]);
		});

		expect(await fetchCfLatestProductRelease()).toEqual({ tag: "v1.5.0", version: "1.5.0", assets: [] });
	});

	it("keeps the stable release when the optional beta lookup fails", async () => {
		process.env.OMP_CF_UPDATE_CHANNEL = "beta";
		mockFetch(input => {
			if (String(input).endsWith("/releases/latest")) {
				return Response.json(releasePayload({ tag_name: "v1.5.0", assets: [] }));
			}
			return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
		});

		expect(await fetchCfLatestProductRelease()).toEqual({ tag: "v1.5.0", version: "1.5.0", assets: [] });
	});

	it("keeps a tag without a v prefix as-is", async () => {
		mockFetch(() => Response.json(releasePayload({ tag_name: "16.3.11" })));

		const release = await fetchCfLatestRelease();

		expect(release.tag).toBe("16.3.11");
		expect(release.version).toBe("16.3.11");
	});

	it("throws on a non-ok response with the status", async () => {
		mockFetch(() => new Response("nope", { status: 404, statusText: "Not Found" }));

		await expect(fetchCfLatestRelease()).rejects.toThrow("release lookup failed: 404 Not Found");
	});

	it("throws on a payload missing tag_name", async () => {
		const payload = releasePayload();
		delete payload.tag_name;
		mockFetch(() => Response.json(payload));

		await expect(fetchCfLatestRelease()).rejects.toThrow("unexpected payload shape");
	});

	it("throws when assets is not an array", async () => {
		mockFetch(() => Response.json(releasePayload({ assets: "not-an-array" })));

		await expect(fetchCfLatestRelease()).rejects.toThrow("unexpected payload shape");
	});

	it("throws on a non-object payload", async () => {
		mockFetch(() => Response.json(null));

		await expect(fetchCfLatestRelease()).rejects.toThrow("unexpected payload shape");
	});

	it("throws and counts malformed asset entries instead of dropping them", async () => {
		mockFetch(() =>
			Response.json(
				releasePayload({
					assets: [
						{ name: "omp-darwin-arm64", url: "https://api.github.com/x", size: 123 },
						{ name: "omp-linux-x64", url: "https://api.github.com/y", size: "456" },
						{ name: "omp-windows-x64" },
					],
				}),
			),
		);

		await expect(fetchCfLatestRelease()).rejects.toThrow("release lookup returned 2 malformed asset entries");
	});
});

describe("fetchCfAsset", () => {
	const asset = { name: "omp-darwin-arm64", url: "https://api.github.com/repos/x/y/releases/assets/1", size: 123 };

	it("downloads via the asset API URL with octet-stream accept", async () => {
		let requestUrl: string | undefined;
		let requestHeaders: Headers | undefined;
		let requestRedirect: RequestInit["redirect"];
		mockFetch((input, init) => {
			requestUrl = String(input);
			requestHeaders = new Headers(init?.headers);
			requestRedirect = init?.redirect;
			return new Response("binary-bytes");
		});

		const response = await fetchCfAsset(asset);

		expect(requestUrl).toBe(asset.url);
		expect(requestHeaders?.get("Authorization")).toBe(`Bearer ${CF_TOKEN}`);
		expect(requestHeaders?.get("Accept")).toBe("application/octet-stream");
		expect(requestRedirect).toBe("follow");
		expect(await response.text()).toBe("binary-bytes");
	});

	it("throws on a non-ok response", async () => {
		mockFetch(() => new Response("denied", { status: 403, statusText: "Forbidden" }));

		await expect(fetchCfAsset(asset)).rejects.toThrow("asset download failed: 403 Forbidden");
	});

	it("throws on an ok response without a body", async () => {
		mockFetch(() => new Response(null, { status: 200 }));

		await expect(fetchCfAsset(asset)).rejects.toThrow("asset download failed: 200");
	});
});
