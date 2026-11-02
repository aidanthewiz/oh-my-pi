import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";
import { sharpshooterBankDir } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

describe("sharpshooter memory backend", () => {
	it("injects only populated project decision files", async () => {
		const root = await makeTempDir("sharpshooter-backend");
		const agentDir = path.join(root, "agent");
		const cwd = path.join(root, "project");
		await fs.mkdir(cwd, { recursive: true });
		const settings = Settings.isolated({
			"memory.backend": "sharpshooter",
			"sharpshooter.injectionTokenLimit": 2400,
		});
		const hostCwd = path.join(root, "host");
		await settings.reloadForCwd(hostCwd);
		await Bun.write(path.join(sharpshooterBankDir(agentDir, hostCwd), "architecture.md"), "HOST_SCOPE_DECISION");

		await expect(sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings)).resolves.toBeUndefined();

		const bankDir = sharpshooterBankDir(agentDir, cwd);
		await fs.mkdir(bankDir, { recursive: true });
		await Promise.all([
			Bun.write(path.join(bankDir, "architecture.md"), "- Keep storage project-scoped.\n"),
			Bun.write(path.join(bankDir, "product.md"), "- Prefer explicit user controls.\n"),
			Bun.write(path.join(bankDir, "style.md"), "   \n"),
		]);

		const instructions = await sharpshooterBackend.buildDeveloperInstructions(agentDir, cwd, settings);
		expect(instructions).toContain("Keep storage project-scoped.");
		expect(instructions).toContain("Prefer explicit user controls.");
		expect(instructions).not.toContain("HOST_SCOPE_DECISION");
		expect(instructions).not.toContain("## style");
	});
});
