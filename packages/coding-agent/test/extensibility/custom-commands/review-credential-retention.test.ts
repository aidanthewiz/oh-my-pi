import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fetchPrReviewTarget } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as gh from "@oh-my-pi/pi-coding-agent/tools/gh";
import { parsePrUnifiedDiff } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-diff";
import {
	getCached,
	getCachedGeneration,
	putCached,
	resetForTests,
	resolveGithubCacheAuthKey,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FIRST_FILE_DIFF = `diff --git a/src/account-a.ts b/src/account-a.ts
--- a/src/account-a.ts
+++ b/src/account-a.ts
@@ -1 +1 @@
-old
+synthetic-account-a
`;
const DIFF = `${FIRST_FILE_DIFF}diff --git a/src/second.ts b/src/second.ts
--- a/src/second.ts
+++ b/src/second.ts
@@ -1 +1 @@
-before
+after
`;
const ENV_NAMES = [
	"OMP_GITHUB_CACHE_DB",
	"GH_CONFIG_DIR",
	"GLAB_CONFIG_DIR",
	"GH_HOST",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
] as const;
const REF = { forge: "github", repo: "owner/repo", number: 123, raw: "pr://owner/repo/123", kind: "pr-url" } as const;
let directory: string;
let saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-credential-retention-"));
	saved = {};
	for (const name of ENV_NAMES) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.OMP_GITHUB_CACHE_DB = path.join(directory, "cache.db");
	process.env.GH_CONFIG_DIR = path.join(directory, "empty-gh-config");
	process.env.GLAB_CONFIG_DIR = path.join(directory, "empty-glab-config");
	process.env.GH_HOST = "github.com";
	resetForTests();
	InternalUrlRouter.resetForTests();
	spyOn(github, "json").mockRejectedValue(new Error("Unexpected GitHub JSON transport"));
});

afterEach(async () => {
	resetForTests();
	InternalUrlRouter.resetForTests();
	vi.restoreAllMocks();
	for (const name of ENV_NAMES) {
		const value = saved[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	await removeWithRetries(directory);
});

async function waitForAdmission(admitted: Promise<void>, pending: Promise<unknown>): Promise<void> {
	await Promise.race([
		admitted,
		pending.then(() => {
			throw new Error("Review publisher completed before the fixture gate");
		}),
	]);
}

describe("review snapshot credential ownership", () => {
	it.each(["miss", "fresh"] as const)(
		"retains an A snapshot only under A after rotation on a %s lookup",
		async source => {
			process.env.GH_TOKEN = "synthetic-review-account-a";
			const authA = resolveGithubCacheAuthKey()!;
			expect(authA).toBeDefined();
			const settings = Settings.isolated({
				"github.cache.enabled": true,
				"github.cache.softTtlSec": 3600,
				"github.cache.hardTtlSec": 86400,
			});
			const admitted = Promise.withResolvers<void>();
			const response = Promise.withResolvers<string>();
			const publish = Promise.withResolvers<void>();
			const transport = spyOn(github, "text").mockImplementation(() => {
				if (source === "fresh") throw new Error("Fresh snapshot must not fetch GitHub");
				admitted.resolve();
				return response.promise;
			});
			if (source === "fresh") {
				putCached({
					authKey: authA,
					repo: REF.repo,
					kind: "pr-diff",
					number: REF.number,
					includeComments: false,
					rendered: DIFF,
					payload: { unified: "", files: parsePrUnifiedDiff(DIFF).files },
				});
				const lookupPrDiff = gh.getOrFetchPrDiff;
				spyOn(gh, "getOrFetchPrDiff").mockImplementation(async options => {
					const lookup = await lookupPrDiff(options);
					expect(lookup.status).toBe("fresh");
					admitted.resolve();
					await publish.promise;
					return lookup;
				});
			}
			const pending = withActiveSettings(settings, () => fetchPrReviewTarget(directory, REF));
			try {
				await waitForAdmission(admitted.promise, pending);
				process.env.GH_TOKEN = "synthetic-review-account-b";
				const authB = resolveGithubCacheAuthKey()!;
				expect(authB).toBeDefined();
				expect(authB).not.toBe(authA);
				response.resolve(DIFF);
				publish.resolve();
				const target = await pending;
				expect(target.rawDiff).toBe(DIFF);
				expect(target.prDiffQuery).toMatch(/^\?at=\d+$/);
				const generation = Number(target.prDiffQuery!.slice(4));
				const router = InternalUrlRouter.instance();
				for (const suffix of ["", "/all", "/1"]) {
					await expect(
						router.resolve(`${target.prDiffUrl}${suffix}${target.prDiffQuery}`, { settings }),
					).rejects.toThrow();
				}
				expect(getCachedGeneration(REF.repo, "pr-diff", REF.number, false, generation, authB)).toBeNull();
				expect(getCached(REF.repo, "pr-diff", REF.number, false, authB)).toBeNull();
				expect(getCachedGeneration(REF.repo, "pr-diff", REF.number, false, generation, authA)?.rendered).toBe(DIFF);
				expect(getCached(REF.repo, "pr-diff", REF.number, false, authA)?.rendered).toBe(DIFF);
				process.env.GH_TOKEN = "synthetic-review-account-a";
				const all = await router.resolve(`${target.prDiffUrl}/all${target.prDiffQuery}`, { settings });
				expect(all.content).toBe(DIFF);
				const first = await router.resolve(`${target.prDiffUrl}/1${target.prDiffQuery}`, { settings });
				expect(first.content).toBe(FIRST_FILE_DIFF);
				expect(transport.mock.calls.length).toBe(source === "miss" ? 1 : 0);
			} finally {
				admitted.resolve();
				response.resolve(DIFF);
				publish.resolve();
				await pending.catch(() => undefined);
			}
		},
	);

	it.each(["unchanged", "removed", "initially-missing", "disabled"] as const)(
		"preserves the %s identity/cache boundary",
		async scenario => {
			if (scenario !== "initially-missing") process.env.GH_TOKEN = "synthetic-review-account-a";
			const initialAuth = resolveGithubCacheAuthKey();
			expect(initialAuth === undefined).toBe(scenario === "initially-missing");
			const settings = Settings.isolated({ "github.cache.enabled": scenario !== "disabled" });
			const admitted = Promise.withResolvers<void>();
			const response = Promise.withResolvers<string>();
			const transport = spyOn(github, "text").mockImplementation(() => {
				admitted.resolve();
				return response.promise;
			});
			const pending = withActiveSettings(settings, () => fetchPrReviewTarget(directory, REF));
			try {
				await waitForAdmission(admitted.promise, pending);
				if (scenario === "removed") delete process.env.GH_TOKEN;
				if (scenario === "initially-missing") process.env.GH_TOKEN = "synthetic-review-account-b";
				response.resolve(DIFF);
				const target = await pending;
				expect(target.rawDiff).toBe(DIFF);
				const router = InternalUrlRouter.instance();
				if (scenario === "disabled" || scenario === "initially-missing") {
					expect(target.prDiffQuery).toBe("");
					expect(getCached(REF.repo, "pr-diff", REF.number, false, resolveGithubCacheAuthKey())).toBeNull();
				} else {
					expect(target.prDiffQuery).toMatch(/^\?at=\d+$/);
					const generation = Number(target.prDiffQuery!.slice(4));
					expect(
						getCachedGeneration(REF.repo, "pr-diff", REF.number, false, generation, initialAuth)?.rendered,
					).toBe(DIFF);
					if (scenario === "removed") {
						await expect(
							router.resolve(`${target.prDiffUrl}/all${target.prDiffQuery}`, { settings }),
						).rejects.toThrow();
						process.env.GH_TOKEN = "synthetic-review-account-a";
					}
					const result = await router.resolve(`${target.prDiffUrl}/all${target.prDiffQuery}`, { settings });
					expect(result.content).toBe(DIFF);
				}
				expect(transport.mock.calls.length).toBe(1);
			} finally {
				admitted.resolve();
				response.resolve(DIFF);
				await pending.catch(() => undefined);
			}
		},
	);
});
