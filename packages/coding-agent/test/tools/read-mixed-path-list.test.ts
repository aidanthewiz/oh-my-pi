import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Database } from "bun:sqlite";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

let cwd: string;
let session: ToolSession;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "read-mixed-list-"));
	await Bun.write(path.join(cwd, "Makefile"), "build:\n\techo make\n");
	await Bun.write(path.join(cwd, "a.ts"), "export const a = 1;\n");
	await Bun.write(path.join(cwd, "a;b.md"), "literal semicolon file\n");
	await Bun.write(path.join(cwd, "a"), "plain a\n");
	await Bun.write(path.join(cwd, "b.md"), "plain b\n");
	const db = new Database(path.join(cwd, "data.sqlite"));
	db.run("CREATE TABLE t (name TEXT)");
	db.run("INSERT INTO t VALUES ('row-one')");
	db.close();
	await fs.copyFile(path.join(cwd, "data.sqlite"), path.join(cwd, "data;local.sqlite"));
	session = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		enableLsp: false,
	};
});

afterAll(async () => {
	await removeWithRetries(cwd);
});

async function readText(target: string): Promise<string> {
	const result = await new ReadTool(session).execute("r", { path: target });
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

describe("read with a `;` list mixing URLs and local paths", () => {
	it("reads an extensionless file with a selector as a local path, not an MCP resource", async () => {
		const text = await readText("Makefile:1-1;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("build:");
		expect(text).toContain("export const a = 1;");
	});

	it("reads literal question filenames in lists before interpreting SQLite queries", async () => {
		const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-literal-question-lists-"));
		const cases = [
			{ filename: "a?b=c", marker: "literal equals file contents" },
			{ filename: "notes?q=literal", marker: "literal q file contents" },
			{ filename: "data.sqlite?q=SELECT name FROM t", marker: "literal sqlite file contents" },
		];
		try {
			await Bun.write(path.join(fixtureDir, "README"), "companion file contents\n");
			for (const { filename, marker } of cases) {
				await Bun.write(path.join(fixtureDir, filename), `${marker}\n`);
			}
			const db = new Database(path.join(fixtureDir, "data.sqlite"));
			try {
				db.run("CREATE TABLE t (name TEXT)");
				db.run("INSERT INTO t VALUES ('database-only contents')");
			} finally {
				db.close();
			}
			const tool = new ReadTool({ ...session, cwd: fixtureDir });
			for (const { filename, marker } of cases) {
				const result = await tool.execute("read-literal-question-list", { path: `${filename};README` });
				const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
				expect(text).toContain(marker);
				expect(text).toContain("companion file contents");
				expect(text).not.toContain("database-only contents");
			}
		} finally {
			await removeWithRetries(fixtureDir);
		}
	});

	it("splits an internal URL followed by a local path", async () => {
		const text = await readText("omp://;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
		expect(text).not.toContain("Documentation file not found");
	});

	it("splits a URL followed by an existing local path", async () => {
		const text = await readText("https://127.0.0.1:9/x;a.ts:1-1");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("export const a = 1;");
	});

	it("keeps a URL that contains `;` whole", async () => {
		const text = await readText("https://127.0.0.1:9/x;v=1").catch((error: Error) => error.message);
		expect(text).not.toContain("interpreted as");
	});

	it("splits a `;` list whose parts carry their own `?q=` filter", async () => {
		await Bun.write(path.join(cwd, "x.json"), JSON.stringify({ a: "x-a", b: "x-b" }));
		await Bun.write(path.join(cwd, "y.json"), JSON.stringify({ a: "y-a", b: "y-b" }));
		const text = await readText("x.json?q={a,b};y.json?q=.b");
		expect(text).toContain("interpreted as 2 paths");
		expect(text).toContain("x-a");
		expect(text).toContain("y-b");
		expect(text).not.toContain("y-a");
	});

	it("keeps a sqlite query ending in `;` whole", async () => {
		const text = await readText("data.sqlite?q=SELECT * FROM t;");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("row-one");
	});

	it("keeps URL-looking SQL literals inside raw queries without fetching them", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("unrequested fetch");
			},
		});
		try {
			const value = `a;${server.url.origin}/unexpected`;
			for (const database of ["data.sqlite", "data;local.sqlite"]) {
				const text = await readText(`${database}?q=SELECT '${value}' AS name`);
				expect(text).toContain(value);
			}
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	it("keeps URL-looking values inside SQLite table filters", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("unrequested fetch");
			},
		});
		const value = `a;${server.url.origin}/unexpected`;
		const db = new Database(path.join(cwd, "data.sqlite"));
		try {
			db.run("INSERT INTO t VALUES (?)", [value]);
			const text = await readText(`data.sqlite:t?where=name = '${value}'`);
			expect(text).toContain(value);
			expect(text).not.toContain("row-one");
			expect(requests).toBe(0);
		} finally {
			db.run("DELETE FROM t WHERE name = ?", [value]);
			db.close();
			await server.stop(true);
		}
	});

	it("does not fetch URL-looking text in a missing image's question", async () => {
		let requests = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				requests++;
				return new Response("unrequested fetch");
			},
		});
		try {
			await expect(readText(`missing.png?q=is it a cat; ${server.url.origin}/unexpected?`)).rejects.toBeInstanceOf(
				ToolError,
			);
			expect(requests).toBe(0);
		} finally {
			await server.stop(true);
		}
	});

	it("reads `a;b.md:1-1` as the literal file even when `a` and `b.md` exist", async () => {
		const text = await readText("a;b.md:1-1");
		expect(text).not.toContain("interpreted as");
		expect(text).toContain("literal semicolon file");
	});
});
