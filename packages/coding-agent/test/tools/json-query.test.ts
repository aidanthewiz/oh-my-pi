import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Shell } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { Settings } from "../../src/config/settings";
import { resolveLocalUrlToPath } from "../../src/internal-urls";
import { ReadTool } from "../../src/tools/read";
import { ToolAbortError } from "../../src/tools/tool-errors";

type ToolTextResult = {
	content: Array<{ type: string; text?: string }>;
};

type SessionLike = ConstructorParameters<typeof ReadTool>[0];

function getText(result: ToolTextResult): string {
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text ?? "")
		.join("\n");
}

function createSession(cwd: string, overrides: Partial<SessionLike> = {}): SessionLike {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	} as SessionLike;
}

describe("JSON query in read tool", () => {
	let tempDir: string;
	let jsonFile: string;
	let jsonlFile: string;
	let numbersFile: string;
	let mixedFile: string;
	let failingLineFile: string;
	let session: SessionLike;
	let readTool: ReadTool;

	beforeAll(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-json-test-"));
		jsonFile = path.join(tempDir, "data.json");
		jsonlFile = path.join(tempDir, "events.jsonl");
		numbersFile = path.join(tempDir, "numbers.json");
		mixedFile = path.join(tempDir, "mixed.json");
		failingLineFile = path.join(tempDir, "failing.jsonl");

		const testData = {
			name: "my-project",
			version: "1.2.3",
			active: true,
			items: [
				{ id: 1, name: "item-one", active: true },
				{ id: 2, name: "item-two", active: false },
				{ id: 3, name: "item-three", active: true },
			],
			metadata: {
				tags: ["alpha", "beta", "gamma"],
				nested: { deep: "secret-value" },
			},
		};

		const testLines = [
			JSON.stringify({ timestamp: "2026-10-01", status: "ok", user: "alice" }),
			JSON.stringify({ timestamp: "2026-10-02", status: "error", user: "bob" }),
			JSON.stringify({ timestamp: "2026-10-03", status: "ok", user: "charlie" }),
		];

		await fs.writeFile(jsonFile, JSON.stringify(testData, null, 2), "utf-8");
		await fs.writeFile(jsonlFile, testLines.join("\n") + "\n", "utf-8");
		// Literals JS numbers cannot hold; jq prints them verbatim.
		await fs.writeFile(numbersFile, '{"ids":[12345678901234567890,1.0,3]}', "utf-8");
		// `.name` fails on the third element.
		await fs.writeFile(mixedFile, '[{"name":"a"},{"name":"b"},3]', "utf-8");
		// `.n + 1` fails on the second line only.
		await fs.writeFile(failingLineFile, '{"n":1}\n{"n":"x"}\n{"n":3}\n', "utf-8");

		session = createSession(tempDir);
		readTool = new ReadTool(session);
	});

	afterAll(async () => {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	});

	it("cancels after query output begins without waiting for its execution timeout", async () => {
		const controller = new AbortController();
		const originalRun = Shell.prototype.run;
		const run = spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			return originalRun.call(this, options, (error, chunk) => {
				onChunk?.(error, chunk);
				if (chunk?.includes("query-started")) controller.abort();
			});
		});
		try {
			const outcome = await readTool
				.execute(
					"cancel-query",
					{ path: `${jsonFile}?q="query-started", (reduce range(0;1000000000) as $i (0; . + $i))` },
					controller.signal,
				)
				.then(
					result => result,
					error => error,
				);
			expect(outcome).toBeInstanceOf(ToolAbortError);
		} finally {
			controller.abort();
			run.mockRestore();
		}
	}, 5_000);

	it("keeps caller credentials and value aliases out of env and $ENV while retaining safe settings", async () => {
		const values: Record<string, string> = {
			COREFORGE_JSON_QUERY_TEST_API_KEY: "synthetic-json-query-credential",
			COREFORGE_JSON_QUERY_TEST_ALIAS: "synthetic-json-query-credential",
			"COREFORGE_JSON_QUERY_TEST_ALIAS.VALUE": "synthetic-json-query-credential",
			COREFORGE_JSON_QUERY_TEST_FLAG: "safe-json-setting",
		};
		const previous = Object.keys(values).map(key => ({ key, process: process.env[key], bun: Bun.env[key] }));
		try {
			for (const [key, value] of Object.entries(values)) {
				process.env[key] = value;
				Bun.env[key] = value;
			}
			const query =
				'{secret: env.COREFORGE_JSON_QUERY_TEST_API_KEY, inherited: $ENV.COREFORGE_JSON_QUERY_TEST_API_KEY, alias: env.COREFORGE_JSON_QUERY_TEST_ALIAS, unusual: env["COREFORGE_JSON_QUERY_TEST_ALIAS.VALUE"], safe: env.COREFORGE_JSON_QUERY_TEST_FLAG}';
			const result = await readTool.execute("credential-boundary", { path: `${jsonFile}?q=${query}` });
			expect(JSON.parse(getText(result))).toEqual({
				secret: null,
				inherited: null,
				alias: null,
				unusual: null,
				safe: "safe-json-setting",
			});
		} finally {
			for (const entry of previous) {
				if (entry.process === undefined) delete process.env[entry.key];
				else process.env[entry.key] = entry.process;
				if (entry.bun === undefined) delete Bun.env[entry.key];
				else Bun.env[entry.key] = entry.bun;
			}
		}
	});

	it.skipIf(process.platform === "win32")(
		"keeps query execution on bundled builtins despite an external PATH override",
		async () => {
			const binDir = path.join(tempDir, "external-query-bin");
			const marker = path.join(binDir, "executed");
			await fs.mkdir(binDir);
			const script = `#!/bin/sh\nprintf invoked > '${marker}'\nprintf external-query-output\n`;
			await fs.writeFile(path.join(binDir, "jq"), script, { mode: 0o700 });
			await fs.writeFile(path.join(binDir, "tail"), script, { mode: 0o700 });
			const values = { PATH: `${binDir}${path.delimiter}${Bun.env.PATH ?? ""}`, PI_DISABLE_UUTILS_BUILTINS: "1" };
			const previous = Object.keys(values).map(key => ({ key, process: process.env[key], bun: Bun.env[key] }));
			try {
				for (const [key, value] of Object.entries(values)) {
					process.env[key] = value;
					Bun.env[key] = value;
				}
				const result = await readTool.execute("builtin-owner", { path: `${jsonFile}?q=.items[0].id` });
				expect(getText(result)).toBe("1");
				expect(await Bun.file(marker).exists()).toBe(false);
			} finally {
				for (const entry of previous) {
					if (entry.process === undefined) delete process.env[entry.key];
					else process.env[entry.key] = entry.process;
					if (entry.bun === undefined) delete Bun.env[entry.key];
					else Bun.env[entry.key] = entry.bun;
				}
			}
		},
	);

	it("preserves JSON query punctuation when a local path precedes it in a read list", async () => {
		const note = path.join(tempDir, "before-query.txt");
		await fs.writeFile(note, "list-prefix");
		const result = await readTool.execute("query-list", {
			path: `${note};${jsonFile}?q=def names: .items[] | .name; names, .version&raw=true`,
		});
		const text = getText(result);
		expect(text).toContain("list-prefix");
		expect(text).toContain("item-one");
		expect(text).toContain("item-two");
		expect(text).toContain("item-three");
		expect(text).toContain("1.2.3");
	});

	it.skipIf(process.platform === "win32")(
		"reads a literal query-looking filename instead of querying its JSON prefix",
		async () => {
			const literal = `${jsonFile}?q=.name`;
			await fs.writeFile(literal, "literal-json-query-filename");
			try {
				const result = await readTool.execute("literal-query", { path: literal });
				expect(getText(result)).toContain("literal-json-query-filename");
				expect(getText(result)).not.toContain("my-project");
			} finally {
				await fs.rm(literal);
			}
		},
	);

	it("queries a simple property from a JSON file", async () => {
		const result = await readTool.execute("call_1", { path: `${jsonFile}?q=.name` });
		const text = getText(result);
		expect(text).toContain('"my-project"');
	});

	it("queries with pipes in jq filter expression", async () => {
		const result = await readTool.execute("call_2", { path: `${jsonFile}?q=.items[] | select(.active) | .name` });
		const text = getText(result);
		expect(text).toContain('"item-one"');
		expect(text).toContain('"item-three"');
		expect(text).not.toContain('"item-two"');
	});

	it("supports raw unquoted output and preserves trailing whitespace", async () => {
		const result = await readTool.execute("call_3", { path: `${jsonFile}?q="foo  "&raw=true` });
		const text = getText(result);
		expect(text).toBe("foo  ");
	});

	it("supports compact output via compact=true parameter", async () => {
		const result = await readTool.execute("call_4", { path: `${jsonFile}?q=.metadata.tags&compact=true` });
		const text = getText(result);
		expect(text.trim()).toBe('["alpha","beta","gamma"]');
	});

	it("queries JSONL stream lines with filtering", async () => {
		const result = await readTool.execute("call_5", {
			path: `${jsonlFile}?q=select(.status == "ok") | .user&raw=true`,
		});
		const text = getText(result);
		const lines = text.trim().split("\n");
		expect(lines).toEqual(["alice", "charlie"]);
	});

	it("rejects invalid jq syntax as a tool error", async () => {
		await expect(readTool.execute("call_6", { path: `${jsonFile}?q=invalid [[[` })).rejects.toThrow(ToolError);
	});

	it("bounds diagnostics while retaining successful values", async () => {
		const query = 'range(0;5000) | debug | if . == 4999 then error("diagnostic-end-marker") else empty end';
		const error = await readTool
			.execute("bounded-diagnostics", { path: `${jsonFile}?q=${query}` })
			.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("diagnostic-end-marker");
		expect(error.message.length).toBeLessThan(10_000);
		const result = await readTool.execute("diagnostic-stdout", {
			path: `${jsonFile}?q=.items[0].id as $id | "kept-diagnostic-marker" | stderr | $id`,
		});
		const lines = getText(result).split("\n");
		expect(lines.pop()).toBe("1");
		expect(lines.join("\n")).toContain("kept-diagnostic-marker");
	});

	it.each([false, true])("retains a large-value error's reason and key after debug=%s", async debug => {
		const largeFile = path.join(tempDir, "large.json");
		const rows = Array.from({ length: 400 }, (_, index) => ({ label: `row ${index}`, input: "x".repeat(40) }));
		await Bun.write(largeFile, JSON.stringify([{ rows }]));

		const query = debug ? ". as $value | (range(0;5000) | debug | empty), ($value.changedFiles)" : ".changedFiles";
		const error = await readTool.execute("large-error", { path: `${largeFile}?q=${query}` }).then(
			() => null,
			error => error,
		);
		const message = String(error);
		expect(message).toContain("changedFiles");
		expect(Buffer.byteLength(message)).toBeLessThan(debug ? 8 * 1024 + 100 : 1000);
	});

	it("bounds an unterminated diagnostic while preserving its endpoints and separate stdout", async () => {
		const result = await readTool.execute("unterminated-diagnostic", {
			path: `${jsonFile}?q=("diagnostic-start:" + ("😀" * 10000) + ":diagnostic-end") | stderr | 7`,
		});
		const text = getText(result);
		expect(text).toContain("diagnostic-start:");
		expect(text).toContain(":diagnostic-end");
		expect(text.split("\n").pop()).toBe("7");
		expect(Buffer.byteLength(text)).toBeLessThan(1000);
	});

	it("reads the file normally without jq query when ?q= is omitted", async () => {
		const result = await readTool.execute("call_7", { path: jsonFile });
		const text = getText(result);
		expect(text).toContain('"my-project"');
		expect(text).toContain('"secret-value"');
	});

	it("supports offset and limit pagination on JSON arrays with repeatable continuation hint", async () => {
		const result = await readTool.execute("call_p1", { path: `${jsonFile}?q=.items&offset=1&limit=1` });
		const text = getText(result);
		expect(text).toContain('"item-two"');
		expect(text).not.toContain('"item-one"');
		expect(text).not.toContain('"item-three"');
		const suffix = /append (\?.*) to continue\]$/.exec(text)?.[1];
		const nextResult = await readTool.execute("call_p1_cont", { path: `${jsonFile}${suffix}` });
		const nextText = getText(nextResult);
		expect(nextText).toContain('"item-three"');
		expect(nextText).not.toContain('"item-two"');
	});

	it("preserves compact format when paging an array with compact=true", async () => {
		const result = await readTool.execute("call_compact_page", {
			path: `${jsonFile}?q=.items&compact=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain('[{"id":2,"name":"item-two","active":false}]');
	});

	it("does not slice a single JSON object mid-syntax when limit is supplied", async () => {
		const result = await readTool.execute("call_obj_limit", {
			path: `${jsonFile}?q=.metadata&limit=2`,
		});
		const text = getText(result);
		expect(JSON.parse(text)).toEqual({
			tags: ["alpha", "beta", "gamma"],
			nested: { deep: "secret-value" },
		});
	});

	it("preserves arithmetic + operator in jq filters without URL corruption", async () => {
		const result = await readTool.execute("call_plus", {
			path: `${jsonFile}?q=.items | length + 1`,
		});
		const text = getText(result);
		expect(text.trim()).toBe("4");
	});

	it("supports offset and limit pagination on JSONL streams with continuation hint", async () => {
		const result = await readTool.execute("call_p2", {
			path: `${jsonlFile}?q=.user&raw=true&offset=1&limit=1`,
		});
		const text = getText(result);
		expect(text).toContain("bob");
		expect(text).not.toContain("alice");
		expect(text).not.toContain("charlie");
		const suffix = /append (\?.*) to continue\]$/.exec(text)?.[1];
		const next = await readTool.execute("call_p2_cont", { path: `${jsonlFile}${suffix}` });
		expect(getText(next)).toBe("charlie");
	});

	it("queries located local JSONL and artifact JSON without losing pagination or URI identity", async () => {
		const artifactsDir = path.join(tempDir, "artifacts");
		const localProtocolOptions = { getArtifactsDir: () => artifactsDir, getSessionId: () => "json-query" };
		const locatedTool = new ReadTool(
			createSession(tempDir, { getArtifactsDir: () => artifactsDir, localProtocolOptions }),
		);
		const localFile = resolveLocalUrlToPath("local://events.jsonl", localProtocolOptions);
		await fs.mkdir(path.dirname(localFile), { recursive: true });
		await fs.mkdir(artifactsDir, { recursive: true });
		await fs.copyFile(jsonlFile, localFile);
		await fs.copyFile(jsonFile, path.join(artifactsDir, "0.json"));

		const localUrl = "local://events.jsonl?q=.user&raw=true&offset=1&limit=1";
		const localResult = await locatedTool.execute("local-json-page", { path: localUrl });
		expect(getText(localResult)).toBe("bob\n[more results; append ?q=.user&raw=true&limit=1&offset=2 to continue]");
		expect(localResult.details?.meta?.source).toEqual({ type: "internal", value: localUrl });
		expect(
			getText(
				await locatedTool.execute("local-next-page", {
					path: "local://events.jsonl?q=.user&raw=true&limit=1&offset=2",
				}),
			),
		).toBe("charlie");

		const artifactUrl = "artifact://0?q=.items&compact=true&offset=1&limit=1";
		const artifactResult = await locatedTool.execute("artifact-json-page", { path: artifactUrl });
		expect(getText(artifactResult)).toBe(
			'[{"id":2,"name":"item-two","active":false}]\n[1 more items; append ?q=.items&compact=true&limit=1&offset=2 to continue]',
		);
		expect(artifactResult.details?.meta?.source).toEqual({ type: "internal", value: artifactUrl });
	});

	it("keeps number literals verbatim when paging an array", async () => {
		const result = await readTool.execute("call_big", { path: `${numbersFile}?q=.ids&limit=2` });
		const text = getText(result);
		expect(text).toContain("12345678901234567890");
		expect(text).toContain("1.0");
		expect(text).not.toContain("12345678901234567000");
		const suffix = /append (\?.*) to continue\]$/.exec(text)?.[1];
		const next = await readTool.execute("call_big_next", { path: `${numbersFile}${suffix}` });
		expect(JSON.parse(getText(next))).toEqual([3]);
	});

	it("pages pretty streams by whole value and the hint round-trips the filter", async () => {
		const first = getText(
			await readTool.execute("call_mixed", { path: `${jsonFile}?q=.items[] | .id, {name}&limit=3` }),
		);
		const firstValues = first.slice(0, first.lastIndexOf("\n[")).replace(/\n(?=[{\d])/g, ",");
		expect(JSON.parse(`[${firstValues}]`)).toEqual([1, { name: "item-one" }, 2]);

		const suffix = /append (\?.*) to continue\]$/.exec(first)?.[1];
		const next = getText(await readTool.execute("call_mixed_next", { path: `${jsonFile}${suffix}` }));
		expect(JSON.parse(`[${next.trim().replace(/\n(?=[{\d])/g, ",")}]`)).toEqual([
			{ name: "item-two" },
			3,
			{ name: "item-three" },
		]);
	});

	it("pages raw streams of objects by whole value", async () => {
		const result = await readTool.execute("call_raw_objects", { path: `${jsonFile}?q=.items[]&raw=true&limit=1` });
		const text = getText(result);
		const output = text.slice(0, text.lastIndexOf("\n["));
		expect(JSON.parse(output)).toEqual({ id: 1, name: "item-one", active: true });
	});

	it("stops jq once the page is full, before later results fail", async () => {
		const result = await readTool.execute("call_early_stop", { path: `${mixedFile}?q=.[] | .name&raw=true&limit=1` });
		expect(getText(result).split("\n").slice(-2, -1)).toEqual(["a"]);
	});

	// Holds for the bundled jq and, with PI_DISABLE_UUTILS_BUILTINS set, for a system jq.
	it("reports a line that fails mid-file alongside the other lines' results", async () => {
		const text = getText(await readTool.execute("call_mid_error", { path: `${failingLineFile}?q=.n + 1` }));
		expect(text).toStartWith("[jq stderr: ");
		expect(text.split("\n").slice(1)).toEqual(["2", "4"]);

		const paged = getText(
			await readTool.execute("call_mid_error_page", { path: `${failingLineFile}?q=.n + 1&limit=1` }),
		);
		expect(paged).toStartWith("[jq stderr: ");
		expect(paged.split("\n").slice(-2, -1)).toEqual(["2"]);
	});

	it("strips terminal controls from jq's stderr", async () => {
		const query = String.raw`.name as $name | "\u001b[31mred\u0000" | stderr | $name`;
		const text = getText(await readTool.execute("call_stderr_controls", { path: `${jsonFile}?q=${query}` }));
		expect(text).toBe('[jq stderr: red]\n"my-project"');
	});

	it("treats a filter starting with - as a filter, not jq flags", async () => {
		const result = await readTool.execute("call_negate", { path: `${jsonFile}?q=-.items[0].id` });
		expect(getText(result)).toBe("-1");
	});

	it("applies trailing line range selectors over query output", async () => {
		const result = await readTool.execute("call_sel", {
			path: `${jsonFile}?q=.items[] | .name&raw=true:raw:1-2`,
		});
		const text = getText(result);
		expect(text).toContain("item-one");
		expect(text).toContain("item-two");
		expect(text).not.toContain("item-three");
	});
});
