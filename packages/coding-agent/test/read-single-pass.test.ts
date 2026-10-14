/** Snapshot fidelity and byte accounting at the public Read/Edit boundary. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { formatBytes } from "@oh-my-pi/pi-tui/render/render-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgReadSummarizeEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

function textOutput(result: AgentToolResult<ReadToolDetails>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	// Structural summarization would answer whole-file reads from the summarizer
	// instead of the range path under test.
	cfgReadSummarizeEnabled.set(settings, false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
	} as ToolSession;
}

describe("read tool single-pass file access", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-single-pass-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("hashes the snapshot from BOM-stripped text so a whole-file tag validates without recovery", async () => {
		// `Bun.file().text()` strips a leading BOM and the patcher's live read goes
		// through it, so a tag hashed from BOM-bearing text only ever applies via
		// stale-hash recovery — which tells the model the file changed externally
		// when nothing changed.
		const filePath = path.join(tmpDir, "bom.ts");
		await fs.writeFile(filePath, Buffer.from("\uFEFFexport const a = 1;\nexport const b = 2;\n", "utf-8"));

		const session = createSession(tmpDir);
		const header = textOutput(await new ReadTool(session).execute("bom-read", { path: filePath })).split("\n")[0];
		expect(header).toMatch(/^\[bom\.ts#[0-9A-F]{4}\]$/);

		await new EditTool(session, "hashline").execute("bom-edit", {
			input: `${header}\nPUT 2.=2:\n+export const b = 22;`,
		});
		// The BOM survives the write; only the addressed line changed.
		expect(await fs.readFile(filePath, "utf8")).toBe("\uFEFFexport const a = 1;\nexport const b = 22;\n");
	});

	it("reports on-disk byte lengths for a line that is not valid UTF-8", async () => {
		// Decoding replaces each stray byte with U+FFFD, which re-encodes to three
		// bytes. Measuring the decoded string instead of the buffer would inflate
		// every reported length by two bytes per stray byte.
		const strayBytes = 512;
		const lineBytes = 60 * 1024;
		const filePath = path.join(tmpDir, "invalid-utf8.txt");
		await fs.writeFile(
			filePath,
			Buffer.concat([
				// Stray bytes sit past the 8KiB binary sniff window, so the file still
				// reads as text and reaches the oversized-line notice.
				Buffer.from("z".repeat(lineBytes - strayBytes), "utf-8"),
				Buffer.from(Array.from({ length: strayBytes }, () => 0xff)),
				Buffer.from("\ntail\n", "utf-8"),
			]),
		);

		// `:1-1` keeps the byte budget at its 50KB floor, which the 60KB line exceeds.
		const text = textOutput(await new ReadTool(createSession(tmpDir)).execute("bytes", { path: `${filePath}:1-1` }));

		expect(text).toContain(`[Line 1 is ${formatBytes(lineBytes)}, exceeds ${formatBytes(50 * 1024)} limit`);
		expect(text).not.toContain(formatBytes(lineBytes + strayBytes * 2));
	});

	it("exposes the terminal newline as an empty raw line", async () => {
		const filePath = path.join(tmpDir, "trailing.txt");
		await fs.writeFile(filePath, "alpha\nbeta\n");
		const tool = new ReadTool(createSession(tmpDir));

		expect(textOutput(await tool.execute("raw-sentinel", { path: `${filePath}:raw:3` }))).toBe("");
	});
});
