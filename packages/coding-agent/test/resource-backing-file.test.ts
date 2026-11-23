import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { writeResourceBackingFile } from "@oh-my-pi/pi-coding-agent/internal-urls/filesystem-resource";

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
