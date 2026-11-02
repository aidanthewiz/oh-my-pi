import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { TempDir } from "@oh-my-pi/pi-utils";

it("searches an explicit large file beyond the directory and multiline prefix window", async () => {
	using directory = TempDir.createSync("@omp-grep-large-file-");
	await Bun.write(directory.join("large.txt"), `${"padding\n".repeat(650_000)}late needle\n`);
	const session: ToolSession = {
		cwd: directory.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
	const tool = new GrepTool(session);
	const explicit = await tool.execute("explicit", { path: "large.txt", pattern: "late needle" });
	expect(explicit.details?.matchCount).toBe(1);
	const inRange = await tool.execute("range", { path: "large.txt:650001-650001", pattern: "late needle" });
	expect(inRange.details?.matchCount).toBe(1);
	const directoryResult = await tool.execute("directory", { path: ".", pattern: "late needle" });
	expect(directoryResult.details?.matchCount).toBe(0);
	const multiline = await tool.execute("multiline", { path: "large.txt", pattern: "late needle\\n" });
	expect(multiline.details?.matchCount).toBe(0);
});
