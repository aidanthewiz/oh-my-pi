import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import * as scrapers from "@oh-my-pi/pi-coding-agent/web/scrapers/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createSession(testDir: string): ToolSession {
	const sessionFile = path.join(testDir, "session.jsonl");
	const artifactsDir = sessionFile.slice(0, -6);
	let nextArtifactId = 0;
	return {
		cwd: testDir,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => "*",
		allocateOutputArtifact: async () => {
			const id = String(nextArtifactId++);
			return { id, path: path.join(artifactsDir, `${id}.log`) };
		},
		settings: Settings.isolated({
			"fetch.enabled": true,
			"grep.contextBefore": 0,
			"grep.contextAfter": 0,
			"astGrep.enabled": true,
			"astEdit.enabled": true,
			"tools.commands": false,
		}),
	};
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(entry => entry.type === "text")
		.map(entry => entry.text ?? "")
		.join("\n");
}

function stubLoadPage(body: string, contentType: string) {
	return vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
		ok: true,
		status: 200,
		finalUrl: requestedUrl,
		contentType,
		content: body,
	}));
}

function serveTextTargets(responses: Readonly<Record<string, string>>, requests: string[]) {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const target = url.pathname + url.search;
			requests.push(target);
			const body = responses[target];
			return new Response(body ?? "Unexpected request target", {
				status: body === undefined ? 404 : 200,
				headers: { "Content-Type": "text/plain" },
			});
		},
	});
}

describe("search tools with external URL paths", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-url-paths-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(testDir);
	});

	it("searches both HTTP targets without splitting semicolons inside the first query", async () => {
		const requests: string[] = [];
		const server = serveTextTargets(
			{
				"/a?x=1;y=2": "needle complete query\n",
				"/b": "needle second target\n",
			},
			requests,
		);
		try {
			const base = server.url.origin;
			const result = await new GrepTool(createSession(testDir)).execute("query-url-list", {
				pattern: "needle",
				path: `${base}/a?x=1;y=2;${base}/b`,
			});
			expect(requests.slice().sort()).toEqual(["/a?x=1;y=2", "/b"]);
			expect(resultText(result)).toContain("needle complete query");
			expect(resultText(result)).toContain("needle second target");
			expect(result.details?.matchCount).toBe(2);
			expect(resultText(result)).not.toContain("missing");
		} finally {
			await server.stop(true);
		}
	});

	it("searches a scalar HTTP URL with intact path and query semicolons", async () => {
		const requests: string[] = [];
		const server = serveTextTargets({ "/scalar;v=1?x=1;y=2": "needle scalar target\n" }, requests);
		try {
			const result = await new GrepTool(createSession(testDir)).execute("scalar-query-url", {
				pattern: "needle",
				path: `${server.url.origin}/scalar;v=1?x=1;y=2`,
			});
			expect(requests).toEqual(["/scalar;v=1?x=1;y=2"]);
			expect(resultText(result)).toContain("needle scalar target");
			expect(result.details?.matchCount).toBe(1);
		} finally {
			await server.stop(true);
		}
	});

	it("keeps nested question marks inside URL query data after a local target", async () => {
		await Bun.write(path.join(testDir, "local.txt"), "needle local\n");
		const requests: string[] = [];
		const server = serveTextTargets(
			{ "/nested?x=1;y=2?z=3": "needle nested query\n", "/other": "needle other target\n" },
			requests,
		);
		try {
			const base = server.url.origin;
			const result = await new GrepTool(createSession(testDir)).execute("local-nested-query", {
				pattern: "needle",
				path: `local.txt;${base}/nested?x=1;y=2?z=3;${base}/other`,
			});
			expect(requests.slice().sort()).toEqual(["/nested?x=1;y=2?z=3", "/other"]);
			expect(resultText(result)).toContain("needle local");
			expect(resultText(result)).toContain("needle nested query");
			expect(resultText(result)).toContain("needle other target");
			expect(result.details?.matchCount).toBe(3);
		} finally {
			await server.stop(true);
		}
	});

	it("searches a query URL and a literal semicolon filename with selectors in either order", async () => {
		await Bun.write(path.join(testDir, "semi;colon.txt"), "needle excluded local\nneedle selected local\n");
		const requests: string[] = [];
		const server = serveTextTargets(
			{ "/mixed?x=1;y=2": "needle selected remote\nneedle excluded remote\n" },
			requests,
		);
		try {
			const remote = `${server.url.origin}/mixed?x=1;y=2:1-1`;
			const local = "semi;colon.txt:2-2";
			const tool = new GrepTool(createSession(testDir));
			for (const input of [`${remote};${local}`, `${local};${remote}`]) {
				const result = await tool.execute("mixed-query-url", { pattern: "needle", path: input });
				expect(resultText(result)).toContain("needle selected remote");
				expect(resultText(result)).toContain("needle selected local");
				expect(resultText(result)).not.toContain("needle excluded");
				expect(result.details?.matchCount).toBe(2);
			}
			expect(requests).toEqual(["/mixed?x=1;y=2", "/mixed?x=1;y=2"]);
		} finally {
			await server.stop(true);
		}
	});

	it("reads URL lists with intact query semicolons and compound range selectors", async () => {
		const requests: string[] = [];
		const server = serveTextTargets(
			{
				"/read?x=1;y=2": "excluded first\nselected first\nexcluded last\n",
				"/other": "selected second start\nexcluded middle\nselected second end\n",
			},
			requests,
		);
		try {
			const base = server.url.origin;
			const tool = new ReadTool(createSession(testDir));
			const first = resultText(await tool.execute("read-query-whole", { path: `${base}/read?x=1;y=2:raw` }));
			const second = resultText(await tool.execute("read-other-whole", { path: `${base}/other:raw` }));
			const firstLine = first.split("\n").findIndex(line => line === "selected first") + 1;
			const secondLines = second
				.split("\n")
				.flatMap((line, index) => (line.startsWith("selected second") ? [index + 1] : []));
			const result = await tool.execute("read-query-url-list", {
				path: `${base}/read?x=1;y=2:raw:${firstLine}-${firstLine};${base}/other:${secondLines.join(",")}:raw`,
			});
			expect(requests).toEqual(["/read?x=1;y=2", "/other", "/read?x=1;y=2", "/other"]);
			expect(resultText(result)).toContain("selected first");
			expect(resultText(result)).toContain("selected second start");
			expect(resultText(result)).toContain("selected second end");
			expect(resultText(result)).not.toContain("excluded");
			expect(resultText(result)).not.toContain("Could not read");
		} finally {
			await server.stop(true);
		}
	});

	it("search fetches a URL and greps the rendered text", async () => {
		stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url", {
			pattern: "remote needle",
			path: "https://example.com/notes.txt",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("Cannot search external URL");
	});

	it("refetches the same URL before each search", async () => {
		let body = "first needle\n";
		const loadPage = vi.spyOn(scrapers, "loadPage").mockImplementation(async requestedUrl => ({
			ok: true,
			status: 200,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			content: body,
		}));
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const first = await tool!.execute("search-url-first", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});
		body = "second needle\n";
		const second = await tool!.execute("search-url-second", {
			pattern: "first|second",
			path: "https://example.com/live.txt",
		});

		expect(resultText(first)).toContain("first needle");
		expect(resultText(second)).toContain("second needle");
		expect(resultText(second)).not.toContain("first needle");
		expect(loadPage).toHaveBeenCalledTimes(2);
	});

	it("search applies URL line-range selectors after materialization", async () => {
		stubLoadPage("outside before\nremote needle\noutside after\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-range", {
			pattern: "outside|remote needle",
			path: "https://example.com/notes.txt:2-2",
		});

		const text = resultText(result);
		expect(text).toContain("remote needle");
		expect(text).not.toContain("outside before");
		expect(text).not.toContain("outside after");
	});

	it("ast_edit rejects external URLs instead of staging read-cache files", async () => {
		stubLoadPage("legacyWrap(x, value)\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("ast-edit-url", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: ["https://example.com/snippet.ts"],
			}),
		).rejects.toThrow("Cannot rewrite external URL");
	});

	it("ast_grep materializes URL content with the source extension", async () => {
		stubLoadPage("export function remoteNeedle() {\n\treturn 1;\n}\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "ast_grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("ast-grep-url", {
			pat: "remoteNeedle",
			path: "https://example.com/snippet.ts",
		});

		const text = resultText(result);
		expect(text).toContain("remoteNeedle");
		expect(text).not.toContain("Parse issues");
	});

	it("search materializes a scheme-less www. scope like its canonical spelling", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-www", {
			pattern: "remote needle",
			path: "www.example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://www.example.com/notes.txt", expect.anything());
	});

	it("search repairs a collapsed https:/ scheme before materializing", async () => {
		const loadPage = stubLoadPage("alpha\nremote needle\nomega\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-url-collapsed", {
			pattern: "remote needle",
			path: "https:/example.com/notes.txt",
		});

		expect(resultText(result)).toContain("remote needle");
		expect(loadPage).toHaveBeenCalledWith("https://example.com/notes.txt", expect.anything());
	});

	it("search prefers an existing local directory named like a www. host", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "www.example.com"), { recursive: true });
		await fs.writeFile(path.join(testDir, "www.example.com", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-dir", {
			pattern: "local needle",
			path: "www.example.com",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search leaves plain relative paths untouched by URL materialization", async () => {
		const loadPage = stubLoadPage("remote body\n", "text/plain");
		await fs.mkdir(path.join(testDir, "src"), { recursive: true });
		await fs.writeFile(path.join(testDir, "src", "notes.txt"), "local needle\n");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		const result = await tool!.execute("search-local-rel", {
			pattern: "local needle",
			path: "src/notes.txt",
		});

		expect(resultText(result)).toContain("local needle");
		expect(loadPage).not.toHaveBeenCalled();
	});

	it("search rejects unsupported URL schemes explicitly", async () => {
		stubLoadPage("remote body\n", "text/plain");
		const tools = await createTools(createSession(testDir));
		const tool = tools.find(entry => entry.name === "grep");
		expect(tool).toBeDefined();

		await expect(
			tool!.execute("search-url-ftp", {
				pattern: "needle",
				path: "ftp://example.com/notes.txt",
			}),
		).rejects.toThrow("Cannot search external URL");
	});
});
