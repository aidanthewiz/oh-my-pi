import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { writeResourceBackingFile } from "@oh-my-pi/pi-coding-agent/internal-urls/filesystem-resource";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";

it("keeps overlapping reads of the same resource isolated until each reader releases it", async () => {
	const url = "mcp://fixture/shared.bin";
	const firstBytes = new Uint8Array([1, 0, 2, 255]);
	const secondBytes = new Uint8Array([7, 0, 8, 128]);
	let firstPath = "";
	let secondPath = "";
	{
		await using first = await writeResourceBackingFile(url, firstBytes, "application/octet-stream");
		await using second = await writeResourceBackingFile(url, secondBytes, "application/octet-stream");
		firstPath = first.path;
		secondPath = second.path;
		expect(new Uint8Array(await fs.readFile(first.path))).toEqual(firstBytes);
		expect(new Uint8Array(await fs.readFile(second.path))).toEqual(secondBytes);
		await first[Symbol.asyncDispose]();
		await expect(fs.access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(new Uint8Array(await fs.readFile(second.path))).toEqual(secondBytes);
	}
	await expect(fs.access(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
	await expect(fs.access(secondPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("releases resource bytes when the reader fails", async () => {
	let backingPath = "";
	await expect(
		(async () => {
			await using backing = await writeResourceBackingFile(
				"mcp://fixture/failing.bin",
				new Uint8Array([1]),
				"application/octet-stream",
			);
			backingPath = backing.path;
			throw new Error("reader failed");
		})(),
	).rejects.toThrow("reader failed");
	await expect(fs.access(backingPath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("renders a byte-resource card without linking to its released backing file", async () => {
	const uri = "owned-resource-card://document/notes.txt";
	const router = InternalUrlRouter.instance();
	router.register({
		scheme: "owned-resource-card",
		spec: { backing: "remote", selectors: "lines", immutable: true },
		resolve: async () => ({
			url: uri,
			content: Buffer.from("scoped document\n"),
			contentType: "text/plain",
		}),
	});
	applyHyperlinkSetting("always");
	try {
		await initTheme();
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Missing dark theme");
		const session = {
			cwd: process.cwd(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
		} as unknown as ToolSession;
		const result = await new ReadTool(session).execute("resource-card", { path: uri });
		const rendered = readToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, theme, { path: uri })
			.render(180)
			.join("\n");
		expect(Bun.stripANSI(rendered)).toContain(uri);
		expect(Bun.stripANSI(rendered)).toContain("scoped document");
		expect(rendered).not.toContain("file://");
		expect(rendered).not.toContain("omp-resource-");
	} finally {
		router.unregister("owned-resource-card");
		applyHyperlinkSetting("auto");
	}
});
