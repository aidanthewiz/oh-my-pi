import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "@oh-my-pi/pi-coding-agent/capability";
import type { CapabilityResult } from "@oh-my-pi/pi-coding-agent/capability/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetActiveSkillsForTests, setActiveSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import {
	type InternalResource,
	type InternalUrl,
	InternalUrlRouter,
	LocalProtocolHandler,
	type ProtocolHandler,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as sshFileTransfer from "@oh-my-pi/pi-coding-agent/ssh/file-transfer";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { formatOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { AstGrepTool } from "../../src/tools/ast-grep";
import { GlobTool } from "../../src/tools/glob";
import { GrepTool } from "../../src/tools/grep";

import { cfgCompactionExperimentalContextManagement } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgReadSummarizeEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text ?? "")
		.join("\n");
}

function virtualDocName(url: InternalUrl): string {
	const host = url.rawHost || url.hostname;
	const pathname = url.rawPathname ?? url.pathname;
	return host ? (pathname && pathname !== "/" ? host + pathname : host) : "";
}

function registerVirtualDocs(docs: ReadonlyMap<string, string>): void {
	const handler: ProtocolHandler = {
		scheme: "virtual",
		spec: { backing: "virtual", selectors: "lines", immutable: true },
		async resolve(url: InternalUrl): Promise<InternalResource> {
			const name = virtualDocName(url);
			if (!name) {
				const content = Array.from(docs.keys())
					.map(key => `- virtual://${key}`)
					.join("\n");
				return {
					url: url.href,
					content,
					contentType: "text/plain",
					size: Buffer.byteLength(content, "utf-8"),
				};
			}
			const content = docs.get(name);
			if (content === undefined) {
				throw new Error(`Virtual doc not found: ${name}`);
			}
			return {
				url: url.href,
				content,
				contentType: "text/plain",
				size: Buffer.byteLength(content, "utf-8"),
			};
		},
	};
	InternalUrlRouter.instance().register(handler);
}

describe("GrepTool internal URL resolution", () => {
	let tmpDir: string;
	let artifactsDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "grep-test-"));
		artifactsDir = path.join(tmpDir, "artifacts");
		await fs.mkdir(artifactsDir);

		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();

		// Register a synthetic main session so artifact:// can derive
		// `artifactsDir` from its sessionFile (sessionFile.slice(0,-6)).
		AgentRegistry.global().register({
			id: "test-main",
			displayName: "test",
			kind: "main",
			session: null,
			sessionFile: `${artifactsDir}.jsonl`,
		});
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
		AgentRegistry.resetGlobalForTests();
		LocalProtocolHandler.resetOverrideForTests();
		InternalUrlRouter.resetForTests();
		resetActiveSkillsForTests();
		vi.restoreAllMocks();
	});

	function createSession(overrides: Partial<ToolSession> = {}): ToolSession {
		return {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 }),
			...overrides,
		};
	}

	async function registerSkillDirectory(): Promise<string> {
		const skillDir = path.join(tmpDir, "skills", "demo");
		await fs.mkdir(path.join(skillDir, "references", "docs"), { recursive: true });
		await Bun.write(path.join(skillDir, "SKILL.md"), "# Demo\n");
		await Bun.write(path.join(skillDir, "references", "index.md"), "install needle\n");
		await Bun.write(path.join(skillDir, "references", "docs", "guide.md"), "deep needle\n");
		setActiveSkills([
			{
				name: "demo",
				description: "demo skill",
				filePath: path.join(skillDir, "SKILL.md"),
				baseDir: skillDir,
				source: "test",
			},
		]);
		return skillDir;
	}

	it("lists skill:// directory subpaths through the read tool", async () => {
		const skillDir = await registerSkillDirectory();
		const session = createSession();
		const tool = new ReadTool(session);

		const result = await tool.execute("test-call", { path: "skill://demo/references" });

		const text = getResultText(result);
		expect(text).toContain("index.md");
		expect(text).toContain("docs/");
		expect(result.details?.resolvedPath).toBe(path.join(skillDir, "references"));
	});

	it("resolves skill:// through session skills when active skill globals are empty", async () => {
		const skillDir = await registerSkillDirectory();
		resetActiveSkillsForTests();
		const session = createSession({
			skills: [
				{
					name: "demo",
					description: "demo skill",
					filePath: path.join(skillDir, "SKILL.md"),
					baseDir: skillDir,
					source: "test",
				},
			],
		});
		const tool = new ReadTool(session);

		const result = await tool.execute("test-call", { path: "skill://demo" });

		expect(getResultText(result)).toContain("# Demo");
		expect(result.details?.resolvedPath).toBe(path.join(skillDir, "SKILL.md"));
	});
	it("walks skill:// directory subpaths for search and find", async () => {
		await registerSkillDirectory();
		const session = createSession({ hasEditTool: true });
		const searchTool = new GrepTool(session);
		const findTool = new GlobTool(session);

		const searchResult = await searchTool.execute("test-search", {
			pattern: "deep needle",
			path: "skill://demo/references",
		});
		const findResult = await findTool.execute("test-find", {
			path: "skill://demo/references",
		});

		const searchText = getResultText(searchResult);
		expect(searchText).toContain("deep needle");
		expect(searchText).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(getResultText(findResult)).toContain("guide.md");
	});

	it("walks bare skill:// roots for search and find", async () => {
		await registerSkillDirectory();
		const session = createSession({ hasEditTool: true });
		const searchTool = new GrepTool(session);
		const findTool = new GlobTool(session);

		const searchResult = await searchTool.execute("test-search", {
			pattern: "deep needle",
			path: "skill://demo",
		});
		const findResult = await findTool.execute("test-find", {
			path: "skill://demo",
		});

		expect(getResultText(searchResult)).toContain("deep needle");
		expect(getResultText(findResult)).toContain("guide.md");
	});

	it("greps the caller-bound full current branch without materializing a session file", async () => {
		const settings = Settings.isolated({ "grep.contextBefore": 0, "grep.contextAfter": 0 });
		cfgCompactionExperimentalContextManagement.set(settings, true);
		const branch = [
			{
				type: "message",
				id: "compacted-source",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "searchable pre-compaction needle", timestamp: 1 },
			},
		] as unknown as SessionEntry[];
		const manager = {
			getBranch: () => branch,
			getSessionId: () => "grep-current-session",
		} as unknown as NonNullable<ToolSession["sessionManager"]>;
		const tool = new GrepTool(
			createSession({
				settings,
				getSessionId: () => "grep-current-session",
				sessionManager: manager,
			}),
		);

		const result = await tool.execute("current-history-search", {
			pattern: "pre-compaction needle",
			path: "history://current/full",
		});

		expect(getResultText(result)).toContain("searchable pre-compaction needle");
	});

	it("greps artifact:// with regex pattern", async () => {
		const content = "ERROR: connection refused\nWARN: timeout\nERROR: disk full\nINFO: ok\n";
		await Bun.write(path.join(artifactsDir, "3.python.log"), content);

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "ERROR.*",
			path: "artifact://3",
		});

		const text = getResultText(result);
		expect(text).toContain("connection refused");
		expect(text).toContain("disk full");
		expect(text).not.toContain("timeout");
		expect(text).not.toContain("INFO");
	});

	it("searches each artifact in a semicolon-delimited internal URL list", async () => {
		await Bun.write(path.join(artifactsDir, "31.bash.log"), "needle first artifact\n");
		await Bun.write(path.join(artifactsDir, "32.bash.log"), "needle second artifact\n");
		await Bun.write(path.join(artifactsDir, "33.bash.log"), "needle unrelated artifact\n");

		const result = await new GrepTool(createSession()).execute("artifact-list", {
			pattern: "needle",
			path: "artifact://31;artifact://32",
		});

		const text = getResultText(result);
		expect(text).toContain("needle first artifact");
		expect(text).toContain("needle second artifact");
		expect(text).not.toContain("needle unrelated artifact");
		expect(result.details?.files?.slice().sort()).toEqual(["artifact://31", "artifact://32"]);
		expect(result.details?.matchCount).toBe(2);
	});

	it("searches each agent output in a semicolon-delimited internal URL list", async () => {
		await Bun.write(path.join(artifactsDir, "Alpha.md"), "needle alpha output\n");
		await Bun.write(path.join(artifactsDir, "Beta.md"), "needle beta output\n");
		await Bun.write(path.join(artifactsDir, "Other.md"), "needle unrelated output\n");

		const result = await new GrepTool(createSession()).execute("agent-list", {
			pattern: "needle",
			path: "agent://Alpha;agent://Beta",
		});

		const text = getResultText(result);
		expect(text).toContain("needle alpha output");
		expect(text).toContain("needle beta output");
		expect(text).not.toContain("needle unrelated output");
		expect(result.details?.files?.slice().sort()).toEqual(["agent://Alpha", "agent://Beta"]);
		expect(result.details?.matchCount).toBe(2);
	});

	it("preserves each registered resource's ranges and compound selectors in URL lists", async () => {
		registerVirtualDocs(
			new Map([
				["first.md", "needle excluded first\nneedle selected first\nneedle excluded last\n"],
				["second.md", "needle selected second start\nneedle excluded middle\nneedle selected second end\n"],
			]),
		);

		const result = await new GrepTool(createSession()).execute("virtual-range-list", {
			pattern: "needle",
			path: "virtual://first.md:2-2:raw;virtual://second.md:raw:1,3",
		});

		const text = getResultText(result);
		expect(text).toContain("needle selected first");
		expect(text).toContain("needle selected second start");
		expect(text).toContain("needle selected second end");
		expect(text).not.toContain("needle excluded");
		expect(result.details?.files?.slice().sort()).toEqual(["virtual://first.md", "virtual://second.md"]);
		expect(result.details?.matchCount).toBe(3);
	});

	it("searches semicolon-bearing internal URL paths before the next URL boundary", async () => {
		registerVirtualDocs(
			new Map([
				["first;v=1.md", "needle excluded first\nneedle selected semicolon path\n"],
				["second.md", "needle selected second\nneedle excluded second\n"],
			]),
		);
		const result = await new GrepTool(createSession()).execute("virtual-semicolon-list", {
			pattern: "needle",
			path: "virtual://first;v=1.md:2-2;virtual://second.md:1-1",
		});
		expect(getResultText(result)).toContain("needle selected semicolon path");
		expect(getResultText(result)).toContain("needle selected second");
		expect(getResultText(result)).not.toContain("needle excluded");
		expect(result.details?.files?.slice().sort()).toEqual(["virtual://first;v=1.md", "virtual://second.md"]);
		expect(result.details?.matchCount).toBe(2);
	});

	it("searches mixed internal URL and literal path lists in either order", async () => {
		registerVirtualDocs(new Map([["doc.md", "needle excluded virtual\nneedle selected virtual\n"]]));
		await Bun.write(path.join(tmpDir, "mixed.txt"), "needle selected local\nneedle excluded local\n");
		await Bun.write(path.join(tmpDir, "other.txt"), "needle unrelated local\n");
		const tool = new GrepTool(createSession());

		for (const entry of ["virtual://doc.md:2-2;mixed.txt:1-1", "mixed.txt:1-1;virtual://doc.md:2-2"]) {
			const result = await tool.execute("mixed-url-list", { pattern: "needle", path: entry });
			const text = getResultText(result);
			expect(text).toContain("needle selected virtual");
			expect(text).toContain("needle selected local");
			expect(text).not.toContain("needle excluded");
			expect(text).not.toContain("needle unrelated");
			expect(result.details?.matchCount).toBe(2);
		}
	});

	it("keeps non-list semicolons in internal URL paths and queries intact", async () => {
		await Bun.write(
			path.join(artifactsDir, "Fields.md"),
			JSON.stringify({ "a;b": "needle selected field\n", other: "needle excluded field\n" }),
		);
		const tool = new GrepTool(createSession());

		for (const entry of ["agent://Fields/a;b", 'agent://Fields?q=.["a;b"]']) {
			const result = await tool.execute("semicolon-resource", { pattern: "needle", path: entry });
			const text = getResultText(result);
			expect(text).toContain("needle selected field");
			expect(text).not.toContain("needle excluded field");
			expect(result.details?.matchCount).toBe(1);
		}
	});

	it("keeps literal semicolon filenames ahead of list and selector interpretations", async () => {
		await Bun.write(path.join(tmpDir, "a;b:1-2"), "first line\nsecond line\nneedle literal third line\n");
		await Bun.write(path.join(tmpDir, "a"), "needle split first\n");
		await Bun.write(path.join(tmpDir, "b"), "needle split second\n");

		const result = await new GrepTool(createSession()).execute("literal-semicolon", {
			pattern: "needle",
			path: "a;b:1-2",
		});

		const text = getResultText(result);
		expect(text).toContain("needle literal third line");
		expect(text).not.toContain("needle split");
		expect(result.details?.files).toEqual(["a;b:1-2"]);
		expect(result.details?.matchCount).toBe(1);
	});

	it("searches a mixed internal URL and local path semicolon list", async () => {
		await Bun.write(path.join(artifactsDir, "1.python.log"), "artifact needle\n");
		await Bun.write(path.join(tmpDir, "notes.txt"), "local needle\n");

		const text = getResultText(
			await new GrepTool(createSession()).execute("mixed-url-local", {
				pattern: "needle",
				path: "artifact://1;notes.txt",
			}),
		);

		// Both targets are searched — the list is not one artifact URI.
		expect(text).toContain("artifact://1");
		expect(text).toContain("artifact needle");
		expect(text).toContain("notes.txt");
		expect(text).toContain("local needle");
		expect(text).not.toContain("artifact://1;notes.txt");
	});

	it("globs a mixed internal URL and local path semicolon list", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "PLAN.md"), "# Plan\n");
		await Bun.write(path.join(tmpDir, "notes.txt"), "local\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const text = getResultText(
			await new GlobTool(createSession()).execute("glob-mixed-url-local", {
				path: "local://PLAN.md;notes.txt",
			}),
		);

		expect(text).toContain("PLAN.md");
		expect(text).toContain("notes.txt");
		expect(text).not.toContain("local://PLAN.md;notes.txt");
	});

	it("keeps a single internal URL with a semicolon in its path whole", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "report;"), "semicolon needle\n");
		await Bun.write(path.join(localRoot, "report"), "plain needle\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const text = getResultText(
			await new GrepTool(createSession()).execute("semicolon", { pattern: "needle", path: "local://report;" }),
		);
		expect(text).toContain("semicolon needle");
		expect(text).not.toContain("plain needle");

		registerVirtualDocs(
			new Map([
				["report;version:abc", "opaque needle\n"],
				["report", "plain needle\n"],
			]),
		);
		const opaqueTailResult = await new GrepTool(createSession()).execute("semicolon-opaque-tail", {
			pattern: "needle",
			path: "virtual://report;version:abc",
		});
		const opaqueTailText = getResultText(opaqueTailResult);
		expect(opaqueTailText).toContain("opaque needle");
		expect(opaqueTailText).not.toContain("plain needle");
		expect(opaqueTailResult.details?.files).toEqual(["virtual://report;version:abc"]);
		expect(opaqueTailResult.details?.missingPaths ?? []).toEqual([]);
	});

	it("keeps opaque URI tails while splitting later local and URL targets with selectors", async () => {
		registerVirtualDocs(
			new Map([
				["report;revision:xyz", "needle excluded opaque\nneedle selected opaque\n"],
				["second.md", "needle selected second start\nneedle excluded second\nneedle selected second end\n"],
			]),
		);
		await Bun.write(path.join(tmpDir, "notes.txt"), "needle selected local\nneedle excluded local\n");

		const result = await new GrepTool(createSession()).execute("opaque-tail-list", {
			pattern: "needle",
			path: "virtual://report;revision:xyz:2-2;notes.txt:1-1;virtual://second.md:raw:1,3",
		});

		const text = getResultText(result);
		expect(text).toContain("needle selected opaque");
		expect(text).toContain("needle selected local");
		expect(text).toContain("needle selected second start");
		expect(text).toContain("needle selected second end");
		expect(text).not.toContain("needle excluded");
		expect(result.details?.files?.slice().sort()).toEqual([
			"notes.txt",
			"virtual://report;revision:xyz",
			"virtual://second.md",
		]);
		expect(result.details?.matchCount).toBe(4);
		expect(result.details?.missingPaths ?? []).toEqual([]);
	});

	it("preserves opaque URI identity in quoted JSON path lists with escaped URL separators", async () => {
		registerVirtualDocs(
			new Map([
				["report;revision:xyz", "needle excluded opaque\nneedle selected opaque\n"],
				["second.md", "needle selected second\nneedle excluded second\n"],
			]),
		);

		const result = await new GrepTool(createSession()).execute("opaque-json-list", {
			pattern: "needle",
			path: String.raw`["virtual:\/\/report;revision:xyz:raw:2-2","virtual:\/\/second.md:1-1"]`,
		});

		const text = getResultText(result);
		expect(text).toContain("needle selected opaque");
		expect(text).toContain("needle selected second");
		expect(text).not.toContain("needle excluded");
		expect(result.details?.files?.slice().sort()).toEqual(["virtual://report;revision:xyz", "virtual://second.md"]);
		expect(result.details?.matchCount).toBe(2);
		expect(result.details?.missingPaths ?? []).toEqual([]);
	});

	it("keeps opaque URI tails and collapsed HTTP targets as separate search paths", async () => {
		registerVirtualDocs(
			new Map([
				["report;version:abc", "needle exact opaque resource\n"],
				["report", "needle wrong opaque prefix\n"],
			]),
		);
		const externalContents: Readonly<Record<string, string>> = {
			"https://a.example/doc": "needle first external resource\n",
			"https://b.example/doc": "needle second external resource\n",
		};
		vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: externalContents[requestedUrl] ?? "unexpected external target\n",
		}));
		const session = createSession({
			getArtifactsDir: () => artifactsDir,
			settings: Settings.isolated({
				"fetch.enabled": true,
				"grep.contextBefore": 0,
				"grep.contextAfter": 0,
			}),
		});

		const result = await new GrepTool(session).execute("opaque-collapsed-http-list", {
			pattern: "needle",
			path: "virtual://report;version:abc;https://a.example/doc;https:/b.example/doc",
		});

		const text = getResultText(result);
		expect(text).toContain("needle exact opaque resource");
		expect(text).toContain("needle first external resource");
		expect(text).toContain("needle second external resource");
		expect(text).not.toContain("needle wrong opaque prefix");
		expect(result.details?.files).toContain("virtual://report;version:abc");
		expect(result.details?.fileCount).toBe(3);
		expect(result.details?.matchCount).toBe(3);
		expect(result.details?.missingPaths ?? []).toEqual([]);
	});

	it("searches virtual internal URL content without a backing file", async () => {
		registerVirtualDocs(new Map([["doc.md", "alpha line\nneedle in virtual content\ngamma line\n"]]));

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "virtual://doc.md",
		});

		const text = getResultText(result);
		expect(text).toContain("needle in virtual content");
		expect(result.details?.files).toEqual(["virtual://doc.md"]);
	});

	it("applies line ranges when searching virtual internal URL content", async () => {
		registerVirtualDocs(new Map([["doc.md", "needle outside range\nmiddle line\nneedle inside range\n"]]));

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "virtual://doc.md:3-3",
		});

		const text = getResultText(result);
		expect(text).toContain("needle inside range");
		expect(text).not.toContain("needle outside range");
	});

	it("keeps in-range virtual matches that fall after the result cap (ranged probe)", async () => {
		// >INTERNAL_TOTAL_CAP (2000) matching lines precede the selected range; the
		// native probe must not stop at the cap before range filtering.
		const content = `${Array.from({ length: 2100 }, (_, i) => `needle ${i + 1}`).join("\n")}\n`;
		registerVirtualDocs(new Map([["big.md", content]]));
		const tool = new GrepTool(createSession());
		const result = await tool.execute("ranged-cap", { pattern: "needle", path: "virtual://big.md:2090-2100" });
		expect(getResultText(result)).toContain("needle 2095");
	});

	it("truncates a multibyte virtual match by UTF-8 bytes and labels the notice bytes", async () => {
		// Regression for #10888: virtual-resource matches must truncate in the
		// same unit as on-disk matches (bytes), and the notice must say so.
		// "needle " + "é"*300 is 307 chars but 607 bytes; a char cap of 512 would
		// leave it whole, the byte cap trims it.
		const line = `needle ${"é".repeat(300)}`;
		registerVirtualDocs(new Map([["mb.md", `${line}\n`]]));
		const result = await new GrepTool(createSession()).execute("mb-virtual", {
			pattern: "needle",
			path: "virtual://mb.md",
		});
		const text = getResultText(result);
		expect((text.match(/é/g) ?? []).length).toBeLessThan(300);
		expect(result.details?.meta?.limits?.columnTruncated).toEqual({ maxColumn: 512, unit: "bytes" });
		expect(formatOutputNotice(result.details?.meta)).toContain("Some lines truncated to 512 bytes");
	});

	it("shows a match far into a long line instead of only the line's start", async () => {
		const line = `${"a".repeat(12_000)}deadline [s120]${"b".repeat(2_400)}`;
		registerVirtualDocs(new Map([["long.md", `${line}\n`]]));
		const result = await new GrepTool(createSession()).execute("long-line", {
			pattern: "deadline \\[s120\\]",
			path: "virtual://long.md",
		});
		const text = getResultText(result);
		expect(text).toMatch(/\.\.\.a+deadline \[s120\]b+\.\.\. \[col 12001\]/);
		expect(result.details?.meta?.limits?.columnTruncated).toEqual({ maxColumn: 512, unit: "bytes" });
	});

	it("windows a long line around a cross-line look-ahead match", async () => {
		registerVirtualDocs(new Map([["ahead.md", `${"a".repeat(12_000)}needle\nend\n`]]));
		const result = await new GrepTool(createSession()).execute("long-line-ahead", {
			pattern: "needle(?=\\nend)",
			path: "virtual://ahead.md",
		});
		expect(getResultText(result)).toMatch(/\.\.\.a+needle \[col 12001\]/);
	});

	it("rejects a malformed selector on a selector-capable internal URL instead of widening the search", async () => {
		const session = createSession();
		const tool = new GrepTool(session);
		await expect(tool.execute("bad-sel", { pattern: "needle", path: "artifact://5:-10" })).rejects.toThrow(
			/invalid selector/i,
		);
		await expect(tool.execute("bad-mixed", { pattern: "needle", path: "artifact://5:1-1:-10" })).rejects.toThrow(
			/invalid selector/i,
		);
		// Multi-range colon compounds are rejected by read's parseSel; search must match.
		await expect(tool.execute("bad-multi", { pattern: "needle", path: "artifact://5:1-1:1-2" })).rejects.toThrow(
			/invalid selector/i,
		);
		// A `conflicts` display chunk is not valid in a range compound (only `raw` is).
		await expect(
			tool.execute("bad-conflicts", { pattern: "needle", path: "artifact://5:conflicts:1-1" }),
		).rejects.toThrow(/invalid selector/i);
	});

	it("makes read reject the same malformed internal-URL selector compounds search does", async () => {
		const session = createSession();
		const read = new ReadTool(session);
		// read.ts rejects a peeled internal-URL selector whose parseSel kind is "none"
		// before resolving the resource, so artifact 5 need not exist. (`:-10` alone is
		// a valid read tail; search rejects it because it cannot filter by tail.)
		await expect(read.execute("read-bad-neg", { path: "artifact://5:-10-3" })).rejects.toThrow(/invalid selector/i);
		await expect(read.execute("read-bad-multi", { path: "artifact://5:1-1:1-2" })).rejects.toThrow(
			/invalid selector/i,
		);
		await expect(read.execute("read-bad-conflicts", { path: "artifact://5:conflicts:1-1" })).rejects.toThrow(
			/invalid selector/i,
		);
	});

	it("expands omp:// root to grep embedded documentation files", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "Grep file contents with a regex across files",
			path: "omp://",
		});

		const text = getResultText(result);
		expect(text).toContain("# omp://tools/grep.md");
		expect(text).toContain("Grep file contents with a regex across files");
	});

	it("walks an omp:// docs subdirectory and names hits by URL without edit anchors", async () => {
		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "Read files, directories, archives",
			path: "omp://tools",
		});

		const text = getResultText(result);
		expect(result.details?.files).toContain("omp://tools/read.md");
		expect(text).toContain("Read files, directories, archives");
		expect(text).not.toMatch(/omp:\/\/tools\/read\.md#[0-9A-F]{4}/);
	});

	it("globs omp:// docs by URL pattern", async () => {
		const text = getResultText(await new GlobTool(createSession()).execute("glob-omp", { path: "omp://tools/*.md" }));

		expect(text).toContain("omp://tools/read.md");
		expect(text).toContain("omp://tools/grep.md");
	});

	it("suppresses hashline anchors when searching immutable artifact:// sources", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "9.bash.log"), content);

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "artifact://9",
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// No hashline section headers or numbered editable lines for immutable sources.
		expect(text).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(text).not.toMatch(/^\*?\s*\d+:/m);
	});

	it("resolves local:// URLs before file-name lookup", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "PLAN.md"), "# Plan\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession();
		const tool = new GlobTool(session);

		const result = await tool.execute("test-call", {
			path: "local://PLAN.md",
		});

		const text = getResultText(result);
		expect(text).toContain("PLAN.md");
	});

	it("walks local:// directory subpaths for read and find", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(path.join(localRoot, "notes"), { recursive: true });
		await Bun.write(path.join(localRoot, "notes", "PLAN.md"), "# Plan\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		const readResult = await new ReadTool(session).execute("test-read", { path: "local://notes" });
		const findResult = await new GlobTool(session).execute("test-find", {
			path: "local://notes",
		});
		const dirResource = await InternalUrlRouter.instance().resolve("local://notes");

		const readText = getResultText(readResult);
		expect(readText).toContain("PLAN.md");
		// Directory listings must stay immutable so hashline edit anchors never key on a directory path.
		expect(readText).not.toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(dirResource.immutable).toBe(true);
		expect(getResultText(findResult)).toContain("PLAN.md");
	});

	it("keeps hashline anchors when searching mutable local:// sources", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "plan.md"), "alpha line\nbeta needle line\ngamma line\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "local://plan.md",
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Mutable local:// sources keep a hashline section header plus numbered match lines.
		expect(text).toMatch(/^\[[^#\r\n]+#[0-9A-F]{4}\]$/m);
		expect(text).toMatch(/^\*\d+:.*needle/m);
	});

	it("accepts the single-slash local:/ spelling in find and search like read", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(path.join(localRoot, "notes"), { recursive: true });
		await Bun.write(path.join(localRoot, "notes", "plan.md"), "beta needle line\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });
		const session = createSession();

		const findResult = await new GlobTool(session).execute("find-single-slash", { path: "local:/notes" });
		const searchResult = await new GrepTool(session).execute("search-single-slash", {
			pattern: "needle",
			path: "local:/notes/plan.md",
		});

		expect(getResultText(findResult)).toContain("plan.md");
		expect(getResultText(searchResult)).toContain("beta needle line");
	});

	it("honors a line selector on the single-slash local:/ spelling in search", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "notes.md"), "first needle\nsecond needle\nthird needle\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const text = getResultText(
			await new GrepTool(createSession()).execute("search-alias-selector", {
				pattern: "needle",
				path: "local:/notes.md:2-2",
			}),
		);

		expect(text).toContain("second needle");
		expect(text).not.toContain("first needle");
		expect(text).not.toContain("third needle");
	});

	it("names the unknown artifact id and the available ones when find cannot locate it", async () => {
		await Bun.write(path.join(artifactsDir, "4.bash.log"), "log\n");

		await expect(
			new GlobTool(createSession()).execute("find-missing-artifact", { path: "artifact://9" }),
		).rejects.toThrow("Artifact 9 not found. Available: 4");
	});

	it("reports a glob in a skill:// name through the nameless skill root's error", async () => {
		await registerSkillDirectory();

		for (const tool of [new GlobTool(createSession()), new GrepTool(createSession())]) {
			await expect(tool.execute("id-glob", { pattern: "needle", path: "skill://*/SKILL.md" })).rejects.toThrow(
				"skill:// URL requires a skill name",
			);
		}
	});

	it("greps a local:// directory, naming hits by URL with anchors on the backing file", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(path.join(localRoot, "notes"), { recursive: true });
		await Bun.write(path.join(localRoot, "notes", "a b.md"), "alpha\nbeta needle\n");
		await Bun.write(path.join(localRoot, "notes", "c.txt"), "no match\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const result = await new GrepTool(createSession({ hasEditTool: true })).execute("local-dir", {
			pattern: "needle",
			path: "local://notes",
		});

		const text = getResultText(result);
		// Raw entry names come back percent-encoded, exactly as `read` accepts them.
		expect(result.details?.files).toEqual(["local://notes/a%20b.md"]);
		expect(text).toMatch(/local:\/\/notes\/a%20b\.md#[0-9A-F]{4}/);
		expect(text).toMatch(/^\*\d+:.*beta needle/m);
	});

	it("searches a local:// directory listed beside a `!glob` exclusion", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(path.join(localRoot, "notes"), { recursive: true });
		await Bun.write(path.join(localRoot, "notes", "a.md"), "kept needle\n");
		await Bun.write(path.join(localRoot, "notes", "a.test.md"), "excluded needle\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const result = await new GrepTool(createSession()).execute("local-exclude", {
			pattern: "needle",
			path: "local://notes;!*.test.md",
		});
		expect(result.details?.files).toEqual(["local://notes/a.md"]);
	});

	it("runs ast_grep over a local:// file", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "util.ts"), "export function greet() {\n\treturn 1;\n}\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const result = await new AstGrepTool(createSession()).execute("ast-local", {
			pat: "function $NAME() { $$$BODY }",
			path: "local://util.ts",
		});

		expect(result.details?.files).toEqual(["local://util.ts"]);
		expect(getResultText(result)).toContain("function greet()");
	});

	it("expands a glob in the first local:// segment for find and search", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		await Bun.write(path.join(localRoot, "draft-plan.md"), "gamma needle\n");
		await Bun.write(path.join(localRoot, "notes.txt"), "gamma needle\n");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });
		const session = createSession();

		const findText = getResultText(await new GlobTool(session).execute("find-root-glob", { path: "local://*.md" }));
		const searchText = getResultText(
			await new GrepTool(session).execute("search-root-glob", { pattern: "needle", path: "local://*.md" }),
		);

		expect(findText).toContain("draft-plan.md");
		expect(findText).not.toContain("notes.txt");
		expect(searchText).toContain("draft-plan.md");
		expect(searchText).not.toContain("notes.txt");
	});

	it("read local://<name>:<sel> honors URL selector even when a sibling literal `<name>:<sel>` file exists (issue #4618)", async () => {
		const localRoot = path.join(artifactsDir, "local");
		await fs.mkdir(localRoot, { recursive: true });
		// Base file targeted by `local://notes.md`; selector should slice this one.
		await Bun.write(
			path.join(localRoot, "notes.md"),
			`${Array.from({ length: 10 }, (_, i) => `url-target line ${i + 1}`).join("\n")}\n`,
		);
		// Sibling literal `notes.md:1-2` under the same local root — must NOT
		// shadow the URL selector semantics of `local://notes.md:1-2`.
		await Bun.write(path.join(localRoot, "notes.md:1-2"), "sibling literal shadow\n");

		LocalProtocolHandler.setOverride({ getArtifactsDir: () => artifactsDir, getSessionId: () => "session" });

		const session = createSession({ hasEditTool: true });
		cfgReadSummarizeEnabled.set(session.settings, false);
		const result = await new ReadTool(session).execute("test-read-local-url-selector", {
			path: "local://notes.md:1-2",
		});

		const text = getResultText(result);
		// The base file was targeted (URL selector semantics preserved), not the
		// sibling literal. Content check is enough — the read tool's context
		// expansion around the requested range is unrelated to the shadow bug.
		expect(text).toContain("url-target line 1");
		expect(text).toContain("url-target line 2");
		expect(text).not.toContain("sibling literal shadow");
	});

	it("keeps hashlines on mutable files when mixed with immutable artifact:// inputs", async () => {
		const content = "alpha line\nbeta needle line\ngamma line\n";
		await Bun.write(path.join(artifactsDir, "11.bash.log"), content);
		await Bun.write(path.join(tmpDir, "mixed.txt"), "mixed needle line\n");

		const session = createSession({ hasEditTool: true });
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: JSON.stringify(["artifact://11", "mixed.txt"]),
		});

		const text = getResultText(result);
		expect(text).toContain("needle");
		// Mutable mixed.txt keeps hashlines somewhere in the output.
		expect(text).toMatch(/^# mixed\.txt#[0-9A-F]{4}/m);
		expect(text).toMatch(/^\*\d+:.*mixed needle/m);
	});

	it("throws on nonexistent artifact ID", async () => {
		const session = createSession();
		const tool = new GrepTool(session);

		expect(tool.execute("test-call", { pattern: "foo", path: "artifact://999" })).rejects.toThrow(
			"Artifact 999 not found",
		);
	});

	it("emits forward-only, deduplicated context lines for adjacent virtual matches", async () => {
		registerVirtualDocs(new Map([["doc.md", "l1\nneedle a\nl3\nneedle b\nl5\nl6\nl7\nl8\n"]]));

		const session = createSession({
			settings: Settings.isolated({ "grep.contextBefore": 1, "grep.contextAfter": 3 }),
		});
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: "virtual://doc.md",
		});

		const text = getResultText(result);
		const lineNumbers = text
			.split("\n")
			.map(line => /^[* ](\d+)\|/.exec(line)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number);
		expect(lineNumbers.length).toBeGreaterThan(0);
		for (let i = 1; i < lineNumbers.length; i++) {
			expect(lineNumbers[i]).toBeGreaterThan(lineNumbers[i - 1]);
		}
		// Context between the two matches appears exactly once.
		expect(lineNumbers.filter(n => n === 3)).toHaveLength(1);
	});

	it("matches an RE2 inline-flag pattern on a virtual resource (native dialect, not JS RegExp)", async () => {
		registerVirtualDocs(new Map([["doc.md", "needle here\n"]]));
		const tool = new GrepTool(createSession());
		const result = await tool.execute("re2-virtual", { pattern: "(?i)NEEDLE", path: "virtual://doc.md" });
		expect(getResultText(result)).toContain("needle");
	});

	it("applies an RE2 inline-flag pattern across mixed local and virtual scopes", async () => {
		await Bun.write(path.join(tmpDir, "local.txt"), "needle local\n");
		registerVirtualDocs(new Map([["doc.md", "needle virtual\n"]]));
		const tool = new GrepTool(createSession());
		const result = await tool.execute("re2-mixed", {
			pattern: "(?i)NEEDLE",
			path: `${path.join(tmpDir, "local.txt")}; virtual://doc.md`,
		});
		const text = getResultText(result);
		expect(text).toContain("local");
		expect(text).toContain("virtual");
	});

	it("reports 'No more results' instead of 'No matches found' when skip is past the end", async () => {
		await Bun.write(path.join(tmpDir, "a.txt"), "needle in a\n");
		await Bun.write(path.join(tmpDir, "b.txt"), "needle in b\n");

		const session = createSession();
		const tool = new GrepTool(session);

		const result = await tool.execute("test-call", {
			pattern: "needle",
			path: ".",
			skip: 5,
		});

		const text = getResultText(result);
		expect(text).toContain("No more results");
		expect(text).toContain("2 files total");
		expect(text).not.toContain("No matches found");
	});

	it("refuses to search a directory listing that has no backing local path", async () => {
		// A directory resource with no sourcePath (e.g. a remote ssh:// listing) must
		// not be grepped — its listing text is not the directory's contents.
		InternalUrlRouter.instance().register({
			scheme: "dirstub",
			spec: { backing: "virtual", selectors: "none", immutable: true },
			async resolve(url: InternalUrl): Promise<InternalResource> {
				return { url: url.href, content: "sub/\nfile.txt", contentType: "text/plain", isDirectory: true };
			},
		});
		const tool = new GrepTool(createSession());
		// Unix natives surface the real errno text; elsewhere the provider message rides along.
		await expect(tool.execute("dir-search", { pattern: "x", path: "dirstub://host/dir" })).rejects.toThrow(
			/dirstub:\/\/host\/dir(: Operation not supported| lists only through the read tool)/,
		);
	});

	it("rejects an ssh:// directory in search without draining a remote listing", async () => {
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
		vi.spyOn(sshFileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(sshFileTransfer, "statRemotePath").mockResolvedValue("directory");
		// Unreadable directories still fail; their rendered listing text must
		// never become a successful searchable document.
		const listSpy = vi.spyOn(sshFileTransfer, "listRemoteDir").mockRejectedValue(new Error("Permission denied"));
		const tool = new GrepTool(createSession());
		await expect(tool.execute("ssh-dir-search", { pattern: "x", path: "ssh://h/etc" })).rejects.toThrow(
			/Permission denied|Input\/output error/i,
		);
		expect(listSpy).toHaveBeenCalledTimes(1);
	});

	it("searches an IPv6 ssh:// file instead of rejecting the brackets as a glob", async () => {
		vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<unknown>);
		vi.spyOn(sshFileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(sshFileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("needle here\n"),
			truncated: false,
		});
		const tool = new GrepTool(createSession());
		const result = await tool.execute("ssh-ipv6", { pattern: "needle", path: "ssh://[::1]/etc/hosts" });
		expect(getResultText(result)).toContain("needle");
	});
});
