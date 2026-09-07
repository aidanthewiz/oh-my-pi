import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const temporaryDirectories: string[] = [];
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("browser-relay install", () => {
	it("installs legal files without overwriting the injected relay token", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "coreforge-relay-install-"));
		temporaryDirectories.push(root);
		const home = path.join(root, "home");
		const extensionDir = path.join(root, "extension");
		const repoRoot = path.resolve(import.meta.dir, "../../../..");
		const cli = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
		const proc = Bun.spawn(
			[process.execPath, "--no-env-file", cli, "browser-relay", "install", "--dir", extensionDir],
			{
				cwd: repoRoot,
				env: { HOME: home, PATH: process.env.PATH },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);

		const token = await fs.readFile(path.join(home, ".omp", "browser-relay", "token"), "utf8");
		const background = await fs.readFile(path.join(extensionDir, "background.js"), "utf8");
		expect(background).toContain(JSON.stringify(token));
		expect(background).not.toContain("__COREFORGE_BROWSER_RELAY_TOKEN__");
		expect(await fs.readFile(path.join(extensionDir, "LICENSE"), "utf8")).toContain("MIT License");
		expect(await fs.readFile(path.join(extensionDir, "THIRD-PARTY-NOTICES.txt"), "utf8")).toContain(
			"COREFORGE THIRD-PARTY NOTICES",
		);
	});
});
