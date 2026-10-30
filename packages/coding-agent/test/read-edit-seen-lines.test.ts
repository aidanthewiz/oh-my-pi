import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

// A call whose arguments span several lines, so a structural read elides the
// inner rows (3-4) and displays the rest.
const SOURCE = [
	"def draw(sheet, anchor, alpha, beta):",
	"    add_native_hole_callout(sheet=sheet,",
	"        nested=nested(alpha,",
	"            beta),",
	"        point=model_point_in_view(",
	"            anchor),",
	"        callout_xy=(0.230, 0.258))",
	"",
].join("\n");

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		settings: Settings.isolated(),
	} as unknown as ToolSession;
}

// Regression: the hashline prompt promises that hunks anchored on lines a read
// never displayed are rejected, but the seen-line guard shipped opt-in. With
// the guard off, a hunk whose range fell inside an elided region was instead
// "auto-repaired" — the syntax probe kept the row the range had selected and
// spliced the body into the neighbouring call, silently and with valid syntax.
describe("read → edit seen-line guard under default settings", () => {
	let cwd: string;
	let file: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seen-lines-"));
		file = path.join(cwd, "draw.py");
		await Bun.write(file, SOURCE);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("rejects a hunk anchored on a line the read elided", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read.split("\n")[0]).toMatch(/^\[draw\.py#[0-9A-F]{4}\]$/);
		expect(read).toContain("…");
		expect(read).not.toContain("beta),");

		const result = await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 4.=4:\n+            beta, gamma),\n`,
		});

		expect(textOutput(result)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(SOURCE);
	});

	it("applies a hunk anchored on a line the read displayed", async () => {
		const session = createSession(cwd);
		const read = textOutput(await new ReadTool(session).execute("read", { path: "draw.py:7-7" }));
		expect(read).toContain("callout_xy=(0.230, 0.258))");

		await new EditTool(session, "hashline").execute("edit", {
			input: `${read.split("\n")[0]}\nPUT 7.=7:\n+        callout_xy=(0.240, 0.258))\n`,
		});

		expect(await Bun.file(file).text()).toBe(SOURCE.replace("0.230", "0.240"));
	});
});

// Regression: an edit under a stale tag went through snapshot recovery without
// the seen-line check, so after one edit changed the file, a header copied
// from the earlier read anchored lines that read never displayed.
describe("read → edit seen-line guard under a stale tag", () => {
	let cwd: string;
	let file: string;
	const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-stale-seen-"));
		file = path.join(cwd, "list.txt");
		await Bun.write(file, `${LINES.join("\n")}\n`);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	it("keeps stale unseen retries blocked until an explicit read", async () => {
		const session = createSession(cwd);
		const header = textOutput(await new ReadTool(session).execute("read", { path: "list.txt:18-22" })).split("\n")[0];
		expect(header).toMatch(/^\[list\.txt#[0-9A-F]{4}\]$/);
		const edit = new EditTool(session, "hashline");
		await edit.execute("edit-1", { input: `${header}\nPUT 20.=20:\n+LINE TWENTY\n` });
		const afterFirst = await Bun.file(file).text();
		expect(afterFirst).toContain("LINE TWENTY");

		// The header now names a stale version, whose read showed lines 18-22.
		const stale = `${header}\nPUT 3.=3:\n+LINE THREE\n`;
		const refused = textOutput(await edit.execute("edit-2", { input: stale }));
		expect(refused).toContain("never displayed");
		expect(refused).toContain("list.txt:3");
		expect(await Bun.file(file).text()).toBe(afterFirst);

		const diagnosticHeader = [...refused.matchAll(/\[list\.txt#[0-9A-F]{4}\]/g)]
			.map(match => match[0])
			.find(candidate => candidate !== header);
		if (!diagnosticHeader) throw new Error("Expected the current snapshot header in the stale-anchor diagnostic");
		const currentEdit = `${diagnosticHeader}\nPUT 3.=3:\n+LINE THREE\n`;
		const retried = await edit.execute("edit-3", { input: currentEdit });
		expect(textOutput(retried)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(afterFirst);

		const current = textOutput(await new ReadTool(session).execute("read-current", { path: "list.txt:3-3" }));
		const currentHeader = current.split("\n")[0];
		expect(currentHeader).toBe(diagnosticHeader);
		await edit.execute("edit-4", { input: currentEdit });
		expect(await Bun.file(file).text()).toBe(afterFirst.replace("line 3\n", "LINE THREE\n"));
	});

	it("requires a read at current line numbers after an unseen stale anchor shifts", async () => {
		const session = createSession(cwd);
		const read = new ReadTool(session);
		const header = textOutput(await read.execute("read", { path: "list.txt:18-22" })).split("\n")[0];
		const shifted = `inserted one\ninserted two\n${LINES.join("\n")}\n`;
		await Bun.write(file, shifted);
		const edit = new EditTool(session, "hashline");

		const refused = textOutput(await edit.execute("edit-stale", { input: `${header}\nPUT 3.=3:\n+LINE THREE\n` }));
		expect(refused).toContain("list.txt:5");
		expect(await Bun.file(file).text()).toBe(shifted);
		const currentHeader = [...refused.matchAll(/\[list\.txt#[0-9A-F]{4}\]/g)]
			.map(match => match[0])
			.find(candidate => candidate !== header);
		if (!currentHeader) throw new Error("Expected the current snapshot header in the stale-anchor diagnostic");
		const currentEdit = `${currentHeader}\nPUT 5.=5:\n+LINE THREE\n`;

		const blindRetry = await edit.execute("edit-blind-current", { input: currentEdit });
		expect(textOutput(blindRetry)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(shifted);

		const revealed = textOutput(await read.execute("read-current", { path: "list.txt:5-5" }));
		expect(revealed.split("\n")[0]).toBe(currentHeader);
		await edit.execute("edit-seen-current", { input: currentEdit });
		expect(await Bun.file(file).text()).toBe(shifted.replace("line 3\n", "LINE THREE\n"));
	});
});
