import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { captureApprovalTargets, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";

import { TempDir } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

describe("execution target parsing", () => {
	let temp: TempDir;
	let cwd: string;
	let session: ToolSession;
	beforeEach(() => {
		temp = TempDir.createSync("@omp-target-content-");
		cwd = temp.path();
		session = {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(cwd, "artifacts"),
			settings: Settings.isolated(),
		};
	});
	afterEach(() => temp.removeSync());

	it("searches every member of a local semicolon list", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "needle-alpha\n");
		fs.writeFileSync(path.join(cwd, "b.txt"), "needle-beta\n");
		const result = await new GrepTool(session).execute("list", { pattern: "needle", path: "a.txt;b.txt" });
		expect(JSON.stringify(result.content)).toContain("needle-alpha");
		expect(JSON.stringify(result.content)).toContain("needle-beta");
	});

	it("does not expand an existing delimiter filename into other files", async () => {
		fs.writeFileSync(path.join(cwd, "a;b"), "needle-literal\n");
		fs.writeFileSync(path.join(cwd, "a"), "needle-other-alpha\n");
		fs.writeFileSync(path.join(cwd, "b"), "needle-other-beta\n");
		const result = await new GrepTool(session).execute("literal-list", { pattern: "needle", path: "a;b" });
		expect(JSON.stringify(result.content)).toContain("needle-literal");
		expect(JSON.stringify(result.content)).not.toContain("needle-other-alpha");
		expect(JSON.stringify(result.content)).not.toContain("needle-other-beta");
	});

	it("prefers a literal colon filename but honors a selector when only the base exists", async () => {
		fs.writeFileSync(path.join(cwd, "notes:1-2"), "needle-literal\n");
		fs.writeFileSync(path.join(cwd, "notes"), "needle-one\nneedle-two\nneedle-three\n");
		const tool = new GrepTool(session);
		const literal = await tool.execute("colon", { pattern: "needle", path: "notes:1-2" });
		expect(JSON.stringify(literal.content)).toContain("needle-literal");
		expect(JSON.stringify(literal.content)).not.toContain("needle-one");
		const selected = await tool.execute("range", { pattern: "needle", path: "notes:2-3" });
		expect(JSON.stringify(selected.content)).toContain("needle-two");
		expect(JSON.stringify(selected.content)).toContain("needle-three");
		expect(JSON.stringify(selected.content)).not.toContain("needle-one");
	});

	it("searches the requested archive member and not a different member", async () => {
		await writeArchive(path.join(cwd, "bundle.zip"), "zip", [
			["a.txt", "needle-member\n"],
			["b.txt", "needle-other\n"],
		]);
		const result = await new GrepTool(session).execute("member", { pattern: "needle", path: "bundle.zip:a.txt" });
		expect(JSON.stringify(result.content)).toContain("needle-member");
		expect(JSON.stringify(result.content)).not.toContain("needle-other");
	});

	it("distinguishes direct child, multisegment and recursive glob contents", async () => {
		fs.mkdirSync(path.join(cwd, "docs", "child", "deep"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "docs", "a.txt"), "a");
		fs.writeFileSync(path.join(cwd, "docs", "child", "b.txt"), "b");
		fs.writeFileSync(path.join(cwd, "docs", "child", "deep", "c.txt"), "c");
		const tool = new GlobTool(session);
		const direct = JSON.stringify((await tool.execute("direct", { path: "docs/*.txt" })).content);
		expect(direct).toContain("a.txt");
		expect(direct).not.toContain("b.txt");
		const child = JSON.stringify((await tool.execute("child", { path: "docs/*/*.txt" })).content);
		expect(child).toContain("b.txt");
		expect(child).not.toContain("c.txt");
		const recursive = JSON.stringify((await tool.execute("recursive", { path: "docs/**/*.txt" })).content);
		expect(recursive).toContain("c.txt");
	});

	it("reads every local list member without losing literal selector filenames", async () => {
		fs.writeFileSync(path.join(cwd, "a:1-2"), "first-content\n");
		fs.writeFileSync(path.join(cwd, "b.txt"), "second-content\n");
		const result = await new ReadTool(session).execute("read-list", { path: "a:1-2;b.txt" });
		expect(JSON.stringify(result.content)).toContain("first-content");
		expect(JSON.stringify(result.content)).toContain("second-content");
	});
	it("requires approval for absolute private host names across read and search", async () => {
		for (const tool of [new ReadTool(session), new GrepTool(session), new GlobTool(session)]) {
			for (const url of [
				"http://intranet./a.txt",
				"http://localhost.:8080/a.txt",
				"http://db.corp.internal./a.txt",
			]) {
				const args = tool.name === "grep" ? { pattern: "hello", path: url } : { path: url };
				const targets = await captureApprovalTargets(tool, args, cwd);
				expect(targets.failed).toBe(false);
				expect(resolveApproval(tool, args, "always-ask-cached", {}, undefined, undefined, targets).policy).toBe(
					"prompt",
				);
			}
		}
	});
});
