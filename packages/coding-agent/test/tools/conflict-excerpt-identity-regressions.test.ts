import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

const CONFLICT = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";
const SCOPES = ["ours", "base", "theirs"] as const;
const ROW_CASES = [
	{ id: "terminal-blank", lines: ["keep", ""] },
	{ id: "blank-only", lines: [""] },
	{ id: "empty", lines: [] },
	{ id: "two-terminal-blanks", lines: ["keep", "", ""] },
];

describe("conflict excerpt rows and registered identity", () => {
	let cwd: string;
	let file: string;
	let session: ToolSession;
	let read: ReadTool;
	let write: WriteTool;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "conflict-excerpt-identity-"));
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
		write = new WriteTool(session);
	});

	afterEach(async () => {
		await removeWithRetries(cwd);
	});

	for (const scope of SCOPES) {
		for (const { id, lines: body } of ROW_CASES) {
			it(`RC-rows-${scope}-${id}: addresses every logical excerpt row`, async () => {
				await Bun.write(
					file,
					[
						"header",
						"<<<<<<< HEAD",
						...body,
						"||||||| ancestor",
						...body,
						"=======",
						...body,
						">>>>>>> topic",
						"tail",
					].join("\n"),
				);
				await read.execute("register", { path: "fixture.txt:conflicts" });
				const start = scope === "ours" ? 3 : scope === "base" ? 4 + body.length : 5 + 2 * body.length;
				const uri = `conflict://1/${scope}`;
				const whole = await read.execute("whole", { path: `${uri}:raw` });
				expect(text(whole)).toBe(body.join("\n"));
				expect(whole.details?.totalLines).toBe(body.length);
				const tail = await read.execute("tail", { path: `${uri}:raw:-1` });
				expect(text(tail)).toBe(body.at(-1) ?? "");
				if (body.length === 0) {
					expect(tail.details?.displayContent).toBeUndefined();
					const numbered = await read.execute("empty", { path: `${uri}:1-1` });
					expect(numbered.details?.totalLines).toBe(0);
					expect(numbered.details?.displayContent).toBeUndefined();
				} else {
					const end = body.length;
					expect(tail.details?.displayContent?.lineNumbers).toEqual([start + end - 1]);
					const last = await read.execute("last", { path: `${uri}:raw:${end}-${end}` });
					expect(text(last)).toBe(body[end - 1]!);
					expect(last.details?.displayContent?.lineNumbers).toEqual([start + end - 1]);
					const numbered = await read.execute("numbered", { path: `${uri}:1-${end}` });
					expect(numbered.details?.displayContent?.lineNumbers).toEqual(body.map((_, index) => start + index));
					expect(numbered.details?.displayContent?.text).toBe(body.join("\n"));
				}
				const beyond = await read.execute("beyond", { path: `${uri}:raw:${body.length + 1}-${body.length + 1}` });
				expect(text(beyond)).toBe("");
				expect(beyond.details?.displayContent).toBeUndefined();
				expect(beyond.details?.notes?.join("\n")).toContain("beyond end");
			});
		}

		it(`RC-comma-${scope}: selects disjoint blank rows in source coordinates`, async () => {
			const body = ["keep", "", "middle", ""];
			await Bun.write(
				file,
				["<<<<<<< HEAD", ...body, "||||||| ancestor", ...body, "=======", ...body, ">>>>>>> topic"].join("\n"),
			);
			await read.execute("register", { path: "fixture.txt:conflicts" });
			const start = scope === "ours" ? 2 : scope === "base" ? 7 : 12;
			const uri = `conflict://1/${scope}`;
			expect(text(await read.execute("raw-comma", { path: `${uri}:raw:2-2,4-4` }))).toBe("\n");
			const numbered = await read.execute("numbered-comma", { path: `${uri}:2-2,4-4` });
			expect(numbered.details?.displayContent?.lineNumbers).toEqual([start + 1, null, start + 3]);
		});
	}

	it("RC-blank-edit: permits the displayed blank row but refuses the following marker", async () => {
		const lines = ["header", "<<<<<<< HEAD", "keep", "", "=======", "theirs", ">>>>>>> topic", "tail"];
		const source = lines.join("\n");
		await Bun.write(file, source);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		expect(text(await read.execute("blank", { path: "conflict://1/ours:raw:2-2" }))).toBe("");
		const store = getEditStore(session);
		const tag = store.recordSnapshotFile(file);
		expect(store.byHashText(file, tag!)).toBe(source);
		const edit = new EditTool(session, "hashline");
		const refused = await edit.execute("unseen", { input: `[fixture.txt#${tag}]\nPUT 5.=5:\n+changed-separator\n` });
		expect(text(refused)).toContain("never displayed");
		expect(await Bun.file(file).text()).toBe(source);
		await edit.execute("seen", { input: `[fixture.txt#${tag}]\nPUT 4.=4:\n+filled\n` });
		expect(await Bun.file(file).text()).toBe(lines.map((line, index) => (index === 3 ? "filled" : line)).join("\n"));
	});

	it("RC-relocate-cap: retains and resolves an ID moved beyond discovery by prefix insertion", async () => {
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		const filler = `${"x".repeat(1023)}\n`.repeat(10_240);
		await Bun.write(file, filler + CONFLICT);
		const index = await read.execute("capped-index", { path: "fixture.txt:conflicts" });
		expect(index.details?.conflictCount).toBe(0);
		expect(text(await read.execute("original-id", { path: "conflict://1/ours:raw" }))).toBe("ours");
		await write.execute("resolve", { path: "conflict://1", content: "@theirs" });
		expect(await Bun.file(file).text()).toBe(`${filler}theirs\n`);
	});

	it("RC-relocate-stale: refuses stale writes when the hidden block changed", async () => {
		await Bun.write(file, CONFLICT);
		await read.execute("register", { path: "fixture.txt:conflicts" });
		const filler = `${"x".repeat(1023)}\n`.repeat(10_240);
		const changed = filler + CONFLICT.replace("ours\n", "changed\n");
		await Bun.write(file, changed);
		await read.execute("capped-index", { path: "fixture.txt:conflicts" });
		await expect(write.execute("stale", { path: "conflict://1", content: "@ours" })).rejects.toThrow("not found");
		expect(await Bun.file(file).text()).toBe(changed);
	});

	for (const [framing, eol] of [
		["LF", "\n"],
		["CRLF", "\r\n"],
	] as const) {
		for (const terminated of [false, true]) {
			it(`RC-BOM-${framing}-${terminated ? "terminated" : "unterminated"}: serves a short unchanged initial block`, async () => {
				const source = `\uFEFF${["<<<<<<< HEAD", "x", "=======", "y", ">>>>>>>"].join(eol)}${terminated ? eol : ""}`;
				await Bun.write(file, source);
				await read.execute("register", { path: "fixture.txt:conflicts" });
				expect(text(await read.execute("unchanged", { path: "conflict://1/ours:raw" }))).toBe("x");
				expect(text(await read.execute("other-side", { path: "conflict://1/theirs:raw" }))).toBe("y");
			});
		}

		it(`RC-interior-BOM-${framing}: preserves U+FEFF content and rejects its later removal`, async () => {
			const source = ["header", "<<<<<<< HEAD", "\uFEFFx", "=======", "y", ">>>>>>>", ""].join(eol);
			await Bun.write(file, source);
			await read.execute("register", { path: "fixture.txt:conflicts" });
			expect(text(await read.execute("interior", { path: "conflict://1/ours:raw" }))).toBe("\uFEFFx");
			const changed = source.replace("\uFEFFx", "x");
			await Bun.write(file, changed);
			await expect(write.execute("stale", { path: "conflict://1", content: "@ours" })).rejects.toThrow("not found");
			expect(await Bun.file(file).text()).toBe(changed);
		});
	}
});
