/**
 * `mr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache, router, and default-project singletons. `gitlab.json` / `gitlab.text`
 * are spied per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import {
	fetchMrDiffFresh,
	getOrFetchMrDiff,
	resetDefaultGitlabProjectMemoForTests,
} from "@oh-my-pi/pi-coding-agent/tools/glab-mr";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { getOrFetchIssue } from "@oh-my-pi/pi-coding-agent/tools/gh-view";
import { gitlab } from "@oh-my-pi/pi-coding-agent/utils/gitlab";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const diffText = `diff --git a/src/one.ts b/src/one.ts
--- a/src/one.ts
+++ b/src/one.ts
@@ -1 +1 @@
-one
+uno
diff --git a/src/two.ts b/src/two.ts
--- a/src/two.ts
+++ b/src/two.ts
@@ -1 +1 @@
-two
+dos
`;
const secondSection = diffText.slice(diffText.indexOf("diff --git a/src/two.ts"));

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
	"GITLAB_HOST",
	"GITLAB_URI",
	"GL_HOST",
	"GLAB_CONFIG_DIR",
	"PATH",
	"ANTHROPIC_API_KEY",
	"FORGE_TEST_ALIAS",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_HOST",
	"GH_CONFIG_DIR",
	"GH_REPO",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
let tempDir: string;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mr-protocol-"));
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	process.env.GITLAB_TOKEN = "test-token";
	process.env.GITLAB_HOST = "gitlab.example.com";
	// Empty dir: no glab config.yml hosts unless a test writes one.
	process.env.GLAB_CONFIG_DIR = tempDir;
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	resetDefaultGitlabProjectMemoForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	resetDefaultGitlabProjectMemoForTests();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

describe("mr:// diff family", () => {
	it("lists changed files of a nested-group project with per-file mr:// links", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.example.com/acme/platform/api/7/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/1");
		expect(resource.content).toContain("mr://gitlab.example.com/acme/platform/api/7/diff/2");
		const args = textSpy.mock.calls[0]![1] as string[];
		expect(args.slice(0, 5)).toEqual(["mr", "diff", "7", "-R", "https://gitlab.example.com/acme/platform/api"]);
	});

	it("slices one file, returns the full diff, and rejects an out-of-range index", async () => {
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const slice = await router.resolve("mr://gitlab.com/g/p/7/diff/2");
		expect(slice.content).toBe(secondSection);
		const all = await router.resolve("mr://gitlab.com/g/p/7/diff/all");
		expect(all.content).toBe(diffText);
		await expect(router.resolve("mr://gitlab.com/g/p/7/diff/3")).rejects.toThrow(/MR has 2 files/);
	});

	it("serves a repeat read from the cache without re-running glab", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		const first = await router.resolve("mr://gitlab.com/g/p/7/diff/1");
		const second = await router.resolve("mr://gitlab.com/g/p/7/diff/1");

		expect(first.notes?.[0]).toBe("Fetched live");
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("uses the CLI chooser on a private projection without repository-local GitLab configuration", async () => {
		await fs.mkdir(path.join(tempDir, ".git", "objects"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(
			path.join(tempDir, ".git", "config"),
			'[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://gitlab.example.com/acme/platform/api.git\n',
		);
		await fs.mkdir(path.join(tempDir, ".git", "glab-cli"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".git", "glab-cli", "config.yml"), "api_host: attacker.example\n");
		vi.spyOn(gitlab, "json").mockImplementation(async <T>(projectedCwd: string): Promise<T> => {
			expect(projectedCwd).not.toBe(tempDir);
			expect(await Bun.file(path.join(projectedCwd, ".git", "glab-cli", "config.yml")).exists()).toBe(false);
			const config = await fs.readFile(path.join(projectedCwd, ".git", "config"), "utf8");
			expect(config).toContain("https://gitlab.example.com/acme/platform/api.git");
			expect(config).not.toContain("attacker.example");
			return { web_url: "https://gitlab.example.com/acme/platform/api" } as T;
		});
		vi.spyOn(gitlab, "text").mockResolvedValue(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://7/diff", { cwd: tempDir });

		expect(resource.content).toContain("# Merge Request Diff: gitlab.example.com/acme/platform/api!7 (2 files)");
	});

	it("rejects URLs without a diff suffix, a group/project pair, or a plain host", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		const router = InternalUrlRouter.instance();

		await expect(router.resolve("mr://gitlab.com/g/p/7")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com/g/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://gitlab.com@evil.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		await expect(router.resolve("mr://evil%1B%5D8%3B%3B.example/g/p/7/diff")).rejects.toThrow(/Invalid mr:\/\/ URL/);
		expect(textSpy).not.toHaveBeenCalled();
	});

	it("retries without --raw when the instance has no raw diff endpoint", async () => {
		const textSpy = vi
			.spyOn(gitlab, "text")
			.mockRejectedValueOnce(new Error("could not obtain raw diff: 404 Not Found"))
			.mockResolvedValueOnce(diffText);

		const resource = await InternalUrlRouter.instance().resolve("mr://gitlab.com/g/p/7/diff");

		expect(resource.content).toContain("(2 files)");
		expect(textSpy).toHaveBeenCalledTimes(2);
		expect(textSpy.mock.calls[0]![1]).toContain("--raw");
		expect(textSpy.mock.calls[1]![1]).not.toContain("--raw");
	});

	it("fails with an upgrade hint instead of parsing an old glab's header-less diff", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockRejectedValue(new Error("unknown flag: --raw"));

		await expect(InternalUrlRouter.instance().resolve("mr://gitlab.com/g/p/7/diff")).rejects.toThrow(
			/too old for `glab mr diff --raw`/,
		);
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("keeps env tokens away from hosts the user has not configured", async () => {
		const textSpy = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		await fs.mkdir(path.join(tempDir, ".git", "objects"), { recursive: true });
		await fs.mkdir(path.join(tempDir, ".git", "refs", "heads"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".git", "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(
			path.join(tempDir, ".git", "config"),
			'[core]\nrepositoryformatversion = 0\nbare = false\n[remote "origin"]\nurl = https://git.own.example/team/app.git\n',
		);
		const router = InternalUrlRouter.instance();
		const context = { cwd: tempDir };

		await expect(router.resolve("mr://attacker.example/a/b/1/diff", context)).rejects.toThrow(
			/Refusing to send GitLab token environment variables to attacker\.example/,
		);
		expect(textSpy).not.toHaveBeenCalled();

		await expect(router.resolve("mr://git.own.example/team/app/1/diff", context)).rejects.toThrow(
			/Refusing to send GitLab token/,
		);
		await expect(router.resolve("mr://1/diff", context)).rejects.toThrow("Refusing to send GitLab token");
		expect(textSpy).not.toHaveBeenCalled();

		await Bun.write(path.join(tempDir, "config.yml"), "hosts:\n    git.corp.example:\n        token: stored\n");
		const configured = await router.resolve("mr://git.corp.example/a/b/1/diff", context);
		expect(configured.content).toContain("(2 files)");

		delete process.env.GITLAB_TOKEN;
		const withoutEnvToken = await router.resolve("mr://other.example/a/b/1/diff", context);
		expect(withoutEnvToken.content).toContain("(2 files)");
	});

	it("guards direct raw fetches before starting a token-bearing command", async () => {
		const text = vi.spyOn(gitlab, "text").mockResolvedValue(diffText);
		await expect(fetchMrDiffFresh(tempDir, "attacker.example/group/project", 1, undefined)).rejects.toThrow(
			"Refusing to send GitLab token",
		);
		expect(text).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"pins each real CLI launch and cache row to its private call-start environment",
		async () => {
			const bin = path.join(tempDir, "bin");
			await fs.mkdir(bin);
			await fs.writeFile(
				path.join(bin, "glab"),
				`#!${process.execPath}\nimport * as fs from "node:fs";\nconst identity = { token: process.env.GITLAB_TOKEN, provider: process.env.ANTHROPIC_API_KEY ?? "absent", alias: process.env.FORGE_TEST_ALIAS ?? "absent", cwd: process.cwd(), hasLocal: fs.existsSync(".git/glab-cli/config.yml") };\nprocess.stdout.write("diff --git a/id.txt b/id.txt\\n--- a/id.txt\\n+++ b/id.txt\\n@@ -1 +1 @@\\n-old\\n+" + JSON.stringify(identity) + "\\n");\n`,
				{ mode: 0o700 },
			);
			process.env.PATH = `${bin}${path.delimiter}${savedEnv.PATH ?? ""}`;
			process.env.ANTHROPIC_API_KEY = "synthetic-private-model-key";
			process.env.FORGE_TEST_ALIAS = "synthetic-private-model-key";
			process.env.GITLAB_TOKEN = "first-call-token";
			const options = { cwd: tempDir, project: "gitlab.example.com/group/project", iid: 1 };
			const firstCall = getOrFetchMrDiff(options);
			process.env.GITLAB_TOKEN = "second-call-token";
			const first = await firstCall;
			expect(first.rendered).toContain('"token":"first-call-token"');
			expect(first.rendered).toContain('"provider":"absent","alias":"absent"');
			expect(first.rendered).not.toContain("synthetic-private-model-key");
			const identity = JSON.parse(
				first.rendered
					.split("\n")
					.find(line => line.startsWith("+{"))!
					.slice(1),
			);
			expect(identity.hasLocal).toBe(false);
			expect(identity.cwd).not.toBe(tempDir);
			await expect(fs.stat(identity.cwd)).rejects.toMatchObject({ code: "ENOENT" });
			const second = await getOrFetchMrDiff(options);
			expect(second.rendered).toContain('"token":"second-call-token"');
			expect(second.status).not.toBe("fresh");
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps GitHub discovery, fetch and cache identity on the initiating credential",
		async () => {
			const bin = path.join(tempDir, "bin");
			await fs.mkdir(bin);
			await fs.writeFile(
				path.join(bin, "gh"),
				`#!${process.execPath}\nif (process.argv[2] === "repo") process.stdout.write("https://github.com/group/project\\n"); else process.stdout.write(JSON.stringify({number:7,title:"Identity",state:"OPEN",author:{login:"synthetic"},body:JSON.stringify({token:process.env.GH_TOKEN,provider:process.env.ANTHROPIC_API_KEY ?? "absent",alias:process.env.FORGE_TEST_ALIAS ?? "absent"}),url:"https://github.com/group/project/issues/7",labels:[],comments:[]}));\n`,
				{ mode: 0o700 },
			);
			process.env.PATH = `${bin}${path.delimiter}${savedEnv.PATH ?? ""}`;
			process.env.GH_CONFIG_DIR = tempDir;
			process.env.GH_TOKEN = "first-github-token";
			process.env.ANTHROPIC_API_KEY = "synthetic-private-model-key";
			process.env.FORGE_TEST_ALIAS = "synthetic-private-model-key";
			const pending = getOrFetchIssue({ cwd: tempDir, issue: "7" });
			process.env.GH_TOKEN = "second-github-token";
			const first = await pending;
			expect(first.rendered).toContain('"token":"first-github-token"');
			expect(first.rendered).toContain('"provider":"absent","alias":"absent"');
			const second = await getOrFetchIssue({ cwd: tempDir, issue: "7" });
			expect(second.rendered).toContain('"token":"second-github-token"');
			expect(second.status).not.toBe("fresh");
			delete process.env.GH_TOKEN;
			process.env.GH_ENTERPRISE_TOKEN = "synthetic-enterprise-token";
			await expect(
				getOrFetchIssue({ cwd: tempDir, repo: "attacker.example/group/project", issue: "7" }),
			).rejects.toThrow("Refusing to send GitHub enterprise token");
		},
	);
});
