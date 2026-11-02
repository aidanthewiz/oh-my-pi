import { describe, expect, it } from "bun:test";
import { Sidebar, type SidebarAction } from "../src/apps/git/sidebar";
import type { ChangedFile, GitViewState, HeadCommit } from "../src/apps/git/state";
import { initTheme } from "../src/theme/theme";

const file = (path: string, area: ChangedFile["area"], additions = 1, deletions = 0): ChangedFile => ({
	path,
	kind: "modified",
	area,
	additions,
	deletions,
});

const head = (files: readonly ChangedFile[]): HeadCommit => ({
	sha: "abcdef0123456789abcdef0123456789abcdef01",
	shortSha: "abcdef0",
	subject: "Tighten the git viewer",
	body: "",
	authorName: "Robin",
	authorEmail: "robin@example.com",
	authorDate: "2026-10-01T10:00:00.000Z",
	parents: ["1111111111111111111111111111111111111111"],
	files,
	filesLoaded: true,
});

const state = (over: Partial<GitViewState> = {}): GitViewState => ({
	cwd: "/repo",
	branch: "main",
	clean: false,
	unstaged: [],
	staged: [],
	headCommit: null,
	...over,
});

describe("git commit-view mutation boundary", () => {
	it.each(["commit", "unstaged", "staged"] as const)(
		"permits file mutations only in a %s change section",
		async area => {
			await initTheme();
			const selected = file("a.ts", area);
			const actions: SidebarAction[] = [];
			let opened = false;
			const sidebar = new Sidebar({
				model: state({
					clean: area === "commit",
					headCommit: area === "commit" ? head([selected]) : null,
					unstaged: area === "unstaged" ? [selected] : [],
					staged: area === "staged" ? [selected] : [],
				}),
				avatars: { get: () => null },
				onSelectFile: () => {},
				onAction: action => actions.push(action),
				onFocusDiff: () => {
					opened = true;
				},
				requestRender: () => {},
			});
			sidebar.viewStyle = "path";
			sidebar.reconcile();
			if (area !== "commit") {
				sidebar.handleInput("\x1b[B");
				if (area === "staged") sidebar.handleInput("\x1b[B");
			}
			expect(sidebar.selectedFile).toBe(selected);
			sidebar.handleInput(" ");
			sidebar.handleInput("\x1b[3~");
			sidebar.handleInput("\r");
			expect(opened).toBe(true);
			expect(actions).toEqual(
				area === "commit"
					? []
					: [
							{
								type: area === "unstaged" ? "stage" : "unstage",
								selection: { files: [selected], label: "a.ts" },
							},
							{ type: "discard", selection: { files: [selected], label: "a.ts" } },
						],
			);
		},
	);
});
