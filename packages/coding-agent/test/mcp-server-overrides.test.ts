import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setServerOverrides } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("MCP server overrides", () => {
	let tempDir = "";

	afterEach(async () => {
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("atomically partitions selected servers without replacing user definitions", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-overrides-"));
		const filePath = path.join(tempDir, "mcp.json");
		await fs.writeFile(
			filePath,
			JSON.stringify({
				mcpServers: { local: { type: "http", url: "https://local.example/mcp" } },
				enabledServers: ["sentry", "unrelated"],
				disabledServers: ["rootly"],
			}),
		);

		await setServerOverrides(
			filePath,
			new Map([
				["rootly", true],
				["sentry", false],
			]),
		);

		const updated = JSON.parse(await fs.readFile(filePath, "utf8"));
		expect(updated.mcpServers).toEqual({ local: { type: "http", url: "https://local.example/mcp" } });
		expect(updated.enabledServers).toEqual(["rootly", "unrelated"]);
		expect(updated.disabledServers).toEqual(["sentry"]);
	});
});
