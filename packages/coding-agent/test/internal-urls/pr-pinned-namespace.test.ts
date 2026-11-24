import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { fetchPrReviewTarget } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/bundled/review";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { parseRepoRef } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import { parsePrUnifiedDiff, retainPrDiffGeneration } from "@oh-my-pi/pi-coding-agent/tools/gh-pr-diff";
import {
	getCachedGeneration,
	putCached,
	resetForTests,
	resolveGithubCacheAuthKey,
	resolveGitlabCacheAuthKey,
	retainCachedGeneration,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { captureForgeCliEnvironment } from "@oh-my-pi/pi-coding-agent/utils/forge-cli";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { resourceText } from "../helpers/resource-text";

const FIRST = `diff --git a/src/saved-one.ts b/src/saved-one.ts
--- a/src/saved-one.ts
+++ b/src/saved-one.ts
@@ -1 +1 @@
-old-one
+saved-one
`;
const SECOND = `diff --git a/src/saved-two.ts b/src/saved-two.ts
--- a/src/saved-two.ts
+++ b/src/saved-two.ts
@@ -1 +1 @@
-old-two
+saved-two
`;
const DIFF = FIRST + SECOND;
const LIVE =
	SECOND +
	`diff --git a/src/reordered-live.ts b/src/reordered-live.ts
--- a/src/reordered-live.ts
+++ b/src/reordered-live.ts
@@ -1 +1 @@
-old-live
+new-live
` +
	FIRST;
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
const SUFFIXES = ["", "/all", "/1", "/2"] as const;
const settings = Settings.isolated({
	"github.cache.enabled": true,
	"github.cache.softTtlSec": 3600,
	"github.cache.hardTtlSec": 86400,
});
let directory: string;
let cwd: string;
let config: string;
let saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>>;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "pr-pinned-namespace-"));
	cwd = path.join(directory, "~", "literal session");
	config = path.join(cwd, `${path.basename(directory)}-gh config`);
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(config, { recursive: true });
	await fs.writeFile(
		path.join(config, "hosts.yml"),
		"github.com:\n  user: synthetic-a\n  oauth_token: synthetic-file-a\nghe.example.com:\n  user: synthetic-enterprise\n  oauth_token: synthetic-enterprise-token\n",
	);
	saved = {};
	for (const name of ENV_NAMES) {
		saved[name] = process.env[name];
		delete process.env[name];
	}
	process.env.OMP_GITHUB_CACHE_DB = path.join(directory, "cache.db");
	process.env.GH_CONFIG_DIR = path.relative(cwd, config);
	process.env.GLAB_CONFIG_DIR = path.join(directory, "empty-glab-config");
	process.env.GH_HOST = "github.com";
	process.env.GH_TOKEN = "synthetic-env-a";
	resetForTests();
	InternalUrlRouter.resetForTests();
	vi.spyOn(github, "text").mockRejectedValue(new Error("Unexpected GitHub text transport"));
	vi.spyOn(github, "json").mockRejectedValue(new Error("Unexpected GitHub JSON transport"));
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

function auth(repo: string, sessionCwd = cwd): string {
	const key = resolveGithubCacheAuthKey(parseRepoRef(repo).host, captureForgeCliEnvironment(sessionCwd, "gh"));
	expect(key).toBeDefined();
	return key!;
}

function seedLive(repo: string, key: string, rendered: string): void {
	putCached({
		authKey: key,
		repo,
		kind: "pr-diff",
		number: 123,
		includeComments: false,
		rendered,
		payload: { unified: "", files: parsePrUnifiedDiff(rendered).files },
	});
}

async function publish(repo = "owner/repo") {
	const key = auth(repo);
	seedLive(repo, key, DIFF);
	const target = await withActiveSettings(settings, () =>
		fetchPrReviewTarget(cwd, { forge: "github", repo, number: 123, raw: `pr://${repo}/123`, kind: "pr-url" }),
	);
	expect(target.rawDiff).toBe(DIFF);
	expect(target.prDiffQuery).toMatch(/^\?at=\d+$/);
	const generation = Number(target.prDiffQuery!.slice(4));
	expect(getCachedGeneration(repo, "pr-diff", 123, false, generation, key)?.rendered).toBe(DIFF);
	seedLive(repo, key, LIVE);
	return { target, key, generation };
}

function expectSaved(content: string, suffix: string, base: string, query: string): void {
	if (suffix === "/all") expect(content).toBe(DIFF);
	else if (suffix === "/1") expect(content).toBe(FIRST);
	else if (suffix === "/2") expect(content).toBe(SECOND);
	else {
		expect(content).toContain("1. src/saved-one.ts");
		expect(content).toContain("2. src/saved-two.ts");
		expect(content).toContain(`${base}/1${query}`);
		expect(content).toContain(`${base}/2${query}`);
		expect(content).not.toContain("src/reordered-live.ts");
	}
}

describe("pinned PR credential namespace", () => {
	it.each([
		["relative", "qualified"],
		["absolute", "qualified"],
		["relative", "short"],
		["absolute", "short"],
		["relative", "enterprise"],
		["absolute", "enterprise"],
	] as const)("reads the review's exact saved files with %s config and %s URL", async (configForm, shape) => {
		if (configForm === "absolute") process.env.GH_CONFIG_DIR = config;
		const repo = shape === "enterprise" ? "ghe.example.com/owner/repo" : "owner/repo";
		const { target } = await publish(repo);
		if (shape === "short")
			vi.spyOn(github, "text").mockImplementation(async (_cwd, args) => {
				if (args[0] === "repo" && args[1] === "view") return "https://github.com/owner/repo";
				throw new Error("Pinned reads must not fetch a diff");
			});
		const base = shape === "short" ? "pr://123/diff" : target.prDiffUrl!;
		const router = InternalUrlRouter.instance();
		for (const suffix of SUFFIXES) {
			const resource = await router.resolve(`${base}${suffix}${target.prDiffQuery}`, { cwd, settings });
			expectSaved(resourceText(resource), suffix, target.prDiffUrl!, target.prDiffQuery!);
		}
	});

	it("does not read the ambient relative-path namespace instead of the captured config", async () => {
		const { target, generation, key } = await publish();
		const ambient = resolveGithubCacheAuthKey()!;
		expect(ambient).toBeDefined();
		expect(ambient).not.toBe(key);
		expect(
			retainPrDiffGeneration({
				repo: "owner/repo",
				number: 123,
				fetchedAt: generation,
				rendered: LIVE,
				files: parsePrUnifiedDiff(LIVE).files,
				cacheAuthKey: ambient,
			}),
		).toBe(generation);
		for (const suffix of SUFFIXES) {
			const result = await InternalUrlRouter.instance().resolve(
				`${target.prDiffUrl}${suffix}${target.prDiffQuery}`,
				{ cwd, settings },
			);
			expectSaved(resourceText(result), suffix, target.prDiffUrl!, target.prDiffQuery!);
		}
	});

	it.each(SUFFIXES.map(suffix => [suffix] as const))(
		"keeps the initiating namespace across short-form suspension for %s",
		async suffix => {
			process.env.GH_CONFIG_DIR = config;
			const { target, generation } = await publish();
			const admitted = Promise.withResolvers<void>();
			const response = Promise.withResolvers<string>();
			vi.spyOn(github, "text").mockImplementation((_cwd, args) => {
				if (args[0] !== "repo" || args[1] !== "view") throw new Error("Unexpected diff fetch");
				admitted.resolve();
				return response.promise;
			});
			const pending = InternalUrlRouter.instance().resolve(`pr://123/diff${suffix}${target.prDiffQuery}`, {
				cwd,
				settings,
			});
			const observed = pending.then(
				value => ({ value }),
				error => ({ error }),
			);
			try {
				await Promise.race([
					admitted.promise,
					pending.then(() => {
						throw new Error("Resolution completed before admission");
					}),
				]);
				process.env.GH_TOKEN = "synthetic-env-b";
				process.env.GH_CONFIG_DIR = path.join(directory, "account-b-config");
				const keyB = auth("owner/repo");
				expect(
					retainPrDiffGeneration({
						repo: "owner/repo",
						number: 123,
						fetchedAt: generation,
						rendered: LIVE,
						files: parsePrUnifiedDiff(LIVE).files,
						cacheAuthKey: keyB,
					}),
				).toBe(generation);
				response.resolve("https://github.com/owner/repo");
				const result = await pending;
				expectSaved(resourceText(result), suffix, target.prDiffUrl!, target.prDiffQuery!);
				const later = await InternalUrlRouter.instance().resolve(`${target.prDiffUrl}/all${target.prDiffQuery}`, {
					cwd,
					settings,
				});
				expect(later.content).toBe(LIVE);
			} finally {
				response.resolve("https://github.com/owner/repo");
				await observed;
			}
		},
	);

	it.each([
		"disabled",
		"expired",
		"missing-generation",
		"missing-identity",
		"account-rotated",
		"source-rotated",
		"other-cwd",
	] as const)("preserves the %s unavailable boundary", async scenario => {
		process.env.GH_CONFIG_DIR = config;
		const { target, generation, key } = await publish();
		let readSettings = settings;
		let readCwd = cwd;
		let query = target.prDiffQuery!;
		if (scenario === "disabled") readSettings = Settings.isolated({ "github.cache.enabled": false });
		if (scenario === "expired") {
			readSettings = Settings.isolated({ "github.cache.enabled": true, "github.cache.hardTtlSec": 10 });
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 20_000);
		}
		if (scenario === "missing-generation") query = `?at=${generation + 1000}`;
		if (scenario === "missing-identity") {
			delete process.env.GH_TOKEN;
			await fs.unlink(path.join(config, "hosts.yml"));
		}
		if (scenario === "account-rotated") process.env.GH_TOKEN = "synthetic-env-b";
		if (scenario === "source-rotated")
			await fs.writeFile(
				path.join(config, "hosts.yml"),
				"github.com:\n  user: synthetic-b\n  oauth_token: synthetic-file-b\n",
			);
		if (scenario === "other-cwd") {
			process.env.GH_CONFIG_DIR = path.relative(cwd, config);
			readCwd = path.join(directory, "other", "literal session");
			await fs.mkdir(readCwd, { recursive: true });
		}
		for (const suffix of SUFFIXES)
			await expect(
				InternalUrlRouter.instance().resolve(`${target.prDiffUrl}${suffix}${query}`, {
					cwd: readCwd,
					settings: readSettings,
				}),
			).rejects.toThrow(/not available/);
		const retained = getCachedGeneration("owner/repo", "pr-diff", 123, false, generation, key);
		if (scenario === "expired") expect(retained).toBeNull();
		else expect(retained?.rendered).toBe(DIFF);
		if (scenario === "account-rotated" || scenario === "source-rotated") {
			const republished = await publish();
			expect(republished.key).not.toBe(key);
			const result = await InternalUrlRouter.instance().resolve(
				`${republished.target.prDiffUrl}/1${republished.target.prDiffQuery}`,
				{ cwd, settings },
			);
			expect(result.content).toBe(FIRST);
		}
	});

	it("does not fall back to default or GitLab retention namespaces", async () => {
		process.env.GH_CONFIG_DIR = config;
		const generation = Date.now();
		process.env.GITLAB_TOKEN = "synthetic-gitlab-token";
		const gitlabKey = resolveGitlabCacheAuthKey("gitlab.example.com", captureForgeCliEnvironment(cwd, "glab"))!;
		expect(gitlabKey).toBeDefined();
		for (const key of ["default", gitlabKey])
			expect(
				retainCachedGeneration({
					authKey: key,
					repo: "owner/repo",
					kind: "pr-diff",
					number: 123,
					includeComments: false,
					fetchedAt: generation,
					rendered: LIVE,
					payload: { unified: "", files: parsePrUnifiedDiff(LIVE).files },
				}),
			).toBe(generation);
		seedLive("owner/repo", auth("owner/repo"), DIFF);
		for (const suffix of SUFFIXES)
			await expect(
				InternalUrlRouter.instance().resolve(`pr://owner/repo/123/diff${suffix}?at=${generation}`, {
					cwd,
					settings,
				}),
			).rejects.toThrow(/not available/);
	});

	it("ordinary unpinned diff reads still use the current live row", async () => {
		seedLive("owner/repo", auth("owner/repo"), DIFF);
		const router = InternalUrlRouter.instance();
		expect((await router.resolve("pr://owner/repo/123/diff/all", { cwd, settings })).content).toBe(DIFF);
		expect((await router.resolve("pr://owner/repo/123/diff/1", { cwd, settings })).content).toBe(FIRST);
		seedLive("owner/repo", auth("owner/repo"), LIVE);
		expect((await router.resolve("pr://owner/repo/123/diff/all", { cwd, settings })).content).toBe(LIVE);
	});
});
