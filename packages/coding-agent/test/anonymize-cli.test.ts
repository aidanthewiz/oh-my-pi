import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runAnonymizeCommand } from "../src/cli/anonymize-cli";
import { CliUsageError } from "../src/cli/usage-error";

const SESSION = `${JSON.stringify({ type: "session", version: 3, id: "01a0c9ac", timestamp: "2026-10-01T00:00:00.000Z", cwd: "/tmp" })}
${JSON.stringify({ type: "message", id: "a1b2c3d4", parentId: null, timestamp: "2026-10-01T00:00:01.000Z", message: { role: "user", content: "keep me", timestamp: 1 } })}
`;

describe("omp anonymize output", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-anonymize-");
	});

	afterEach(async () => {
		await tempDir.remove();
	});

	it("refuses an --out directory that would overwrite or bundle the source session", async () => {
		const source = path.join(tempDir.path(), "session.jsonl");
		await Bun.write(source, SESSION);

		await expect(runAnonymizeCommand({ session: source, out: tempDir.path() })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(source).text()).toBe(SESSION);
	});

	it("refuses an --out directory inside the raw subagent directory, even before it exists", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		await Bun.write(source, SESSION);
		await Bun.write(path.join(tempDir.path(), "main", "Scout.jsonl"), SESSION);

		await expect(runAnonymizeCommand({ session: source, out: path.join(tempDir.path(), "main") })).rejects.toThrow(
			"would mix the export with raw session transcripts",
		);
		expect(await Bun.file(path.join(tempDir.path(), "main", "session.jsonl")).exists()).toBe(false);
	});

	it("refuses an existing non-empty --out directory instead of merging into it", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		const out = path.join(tempDir.path(), "report");
		await Bun.write(source, SESSION);
		await Bun.write(path.join(out, "raw-notes.txt"), "keep me");

		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not empty");
		expect(await Bun.file(path.join(out, "session.jsonl")).exists()).toBe(false);
	});

	it("rejects a file without a valid session header instead of writing an empty bundle", async () => {
		const source = path.join(tempDir.path(), "notes.jsonl");
		const out = path.join(tempDir.path(), "out");
		await Bun.write(source, `${JSON.stringify({ hello: "world" })}\n`);

		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not a valid session file");
		expect(await Bun.file(path.join(out, "session.jsonl")).exists()).toBe(false);
	});

	it("reports a directory session argument as a usage error", async () => {
		await expect(
			runAnonymizeCommand({ session: `${tempDir.path()}${path.sep}`, out: path.join(tempDir.path(), "out") }),
		).rejects.toBeInstanceOf(CliUsageError);
	});

	it("reports an --out path that is an existing file as a usage error", async () => {
		const source = path.join(tempDir.path(), "main.jsonl");
		const out = path.join(tempDir.path(), "report.zip");
		await Bun.write(source, SESSION);
		await Bun.write(out, "zip");
		await expect(runAnonymizeCommand({ session: source, out })).rejects.toThrow("is not a directory");
	});

	it("reports an unknown session path as a usage error", async () => {
		const missing = path.join(tempDir.path(), "missing.jsonl");
		await expect(
			runAnonymizeCommand({ session: missing, out: path.join(tempDir.path(), "out") }),
		).rejects.toBeInstanceOf(CliUsageError);
	});

	it.skipIf(process.platform === "win32")(
		"finds real subagents and preserves source files through a session symlink",
		async () => {
			const real = path.join(tempDir.path(), "real", "main.jsonl");
			await Bun.write(real, SESSION);
			const child = path.join(tempDir.path(), "real", "main", "Scout.jsonl");
			const childSession = SESSION.replace("keep me", "child secret");
			await Bun.write(child, childSession);
			const link = path.join(tempDir.path(), "link.jsonl");
			await fs.symlink(real, link, "file");
			const out = path.join(tempDir.path(), "out");
			await runAnonymizeCommand({ session: link, out });
			const [member] = await Array.fromAsync(new Bun.Glob("subagents/*.jsonl").scan(out));
			const exportedChild = await Bun.file(path.join(out, member)).text();
			const exportedMain = await Bun.file(path.join(out, "session.jsonl")).text();
			expect(exportedChild).not.toContain("child secret");
			expect(exportedMain).not.toContain("keep me");
			expect(JSON.parse(exportedChild.trim().split("\n")[1]).message.content).toMatch(/^\[redacted #/);
			expect(JSON.parse(exportedMain.trim().split("\n")[1]).id).toBe("a1b2c3d4");
			expect(await Bun.file(real).text()).toBe(SESSION);
			expect(await Bun.file(link).text()).toBe(SESSION);
			expect(await Bun.file(child).text()).toBe(childSession);
		},
	);

	it.skipIf(process.platform === "win32")(
		"refuses raw-source destinations reached through a directory symlink",
		async () => {
			const real = path.join(tempDir.path(), "real", "main.jsonl");
			const child = path.join(tempDir.path(), "real", "main", "Scout.jsonl");
			await Bun.write(real, SESSION);
			await Bun.write(child, SESSION);
			const alias = path.join(tempDir.path(), "alias");
			await fs.symlink(path.dirname(real), alias, "dir");
			for (const out of [alias, path.join(alias, "main", "missing", "report")]) {
				await expect(runAnonymizeCommand({ session: real, out })).rejects.toBeInstanceOf(CliUsageError);
			}
			expect(await Bun.file(real).text()).toBe(SESSION);
			expect(await Bun.file(child).text()).toBe(SESSION);
			expect(await fs.readdir(path.dirname(child))).toEqual(["Scout.jsonl"]);
		},
	);
});
