import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { DEFAULT_MAX_LINES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

describe("conflict excerpt selector controls", () => {
	let cwd: string;
	let file: string;
	let session: ToolSession;
	let read: ReadTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-excerpt-controls-"));
		file = path.join(cwd, "fixture.txt");
		session = {
			cwd,
			hasUI: false,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "edit.mode": "hashline" }),
		};
		read = new ReadTool(session);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	for (const scope of ["ours", "base", "theirs"] as const) {
		for (const selector of ["raw:1-1,-1", "raw:1-1,4-"]) {
			it(`RC-mixed-${scope}-${selector}: includes the final logical blank row`, async () => {
				const body = ["first", "middle-a", "middle-b", ""];
				await Bun.write(
					file,
					["<<<<<<< HEAD", ...body, "||||||| ancestor", ...body, "=======", ...body, ">>>>>>> topic"].join("\n"),
				);
				await read.execute("register", { path: "fixture.txt:conflicts" });
				expect(text(await read.execute("mixed", { path: `conflict://1/${scope}:${selector}` }))).toBe("first\n");
			});
		}
	}

	it("RC-invalid-selector: refuses conflict-index and range compounds on a side", async () => {
		const source = "<<<<<<< HEAD\nkeep\n\n=======\ntheirs\n>>>>>>> topic\n";
		await Bun.write(file, source);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		await expect(read.execute("invalid", { path: "conflict://1/ours:conflicts:1-1" })).rejects.toThrow();
		expect(await Bun.file(file).text()).toBe(source);
	});

	it("RC-empty-edit: an empty side grants no permission to edit its following marker", async () => {
		const source = "<<<<<<< HEAD\n=======\ntheirs\n>>>>>>> topic\n";
		await Bun.write(file, source);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		await read.execute("empty-side", { path: "conflict://1/ours:raw" });
		const tag = getEditStore(session).recordSnapshotFile(file);
		const refused = await new EditTool(session, "hashline").execute("marker", {
			input: `[fixture.txt#${tag}]\nPUT 2.=2:\n+changed-separator\n`,
		});
		expect(text(refused)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);
	});

	it("RC-cap-edit: grants provenance only to excerpt rows within the output cap", async () => {
		const body = Array.from({ length: DEFAULT_MAX_LINES + 2 }, (_, index) => `row-${index + 1}`);
		body.push("");
		const source = ["<<<<<<< HEAD", ...body, "=======", "theirs", ">>>>>>> topic"].join("\n");
		await Bun.write(file, source);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		const result = await read.execute("capped", { path: "conflict://1/ours:raw" });
		expect(result.details?.totalLines).toBe(body.length);
		expect(text(result)).toBe(body.slice(0, DEFAULT_MAX_LINES).join("\n"));
		const tag = getEditStore(session).recordSnapshotFile(file);
		const hiddenLine = DEFAULT_MAX_LINES + 2;
		const refused = await new EditTool(session, "hashline").execute("hidden", {
			input: `[fixture.txt#${tag}]\nPUT ${hiddenLine}.=${hiddenLine}:\n+changed\n`,
		});
		expect(text(refused)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);
	});
});
