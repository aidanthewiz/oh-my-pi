import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function createSession(cwd: string, sourcePath: string): ToolSession {
	const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "images.autoResize": false }),
		getImageAttachments: () => [{ label: "Image #1", uri: "attachment://1", image, sourcePath }],
	};
}

describe("read attachment URLs", () => {
	let testDir: string;
	let imagePath: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-attachment-"));
		imagePath = path.join(testDir, "original.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("decodes attachment URLs through the underlying image file path", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));
		const attachmentResult = await tool.execute("read-attachment", { path: "attachment://1" });
		const fileResult = await tool.execute("read-file", { path: imagePath });

		expect(attachmentResult.content).toEqual(fileResult.content);
		expect(attachmentResult.content).toContainEqual({
			type: "image",
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
		});
	});

	it("reports unknown attachment URLs with the available URIs", async () => {
		const tool = new ReadTool(createSession(testDir, imagePath));

		await expect(tool.execute("read-missing-attachment", { path: "attachment://2" })).rejects.toThrow(
			"Could not resolve image attachment 'attachment://2'. Available attachment URIs: attachment://1.",
		);
	});
});

describe("read text output contracts", () => {
	let testDir: string;
	let textPath: string;

	beforeEach(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-text-"));
		textPath = path.join(testDir, "notes.txt");
		fs.writeFileSync(textPath, "alpha\nbeta\n");
	});

	afterEach(() => {
		removeSyncWithRetries(testDir);
	});

	it("keeps repeated raw reads verbatim while retaining hints for formatted reads", async () => {
		const rawTool = new ReadTool(createSession(testDir, textPath));
		for (let index = 0; index < 3; index++) {
			const result = await rawTool.execute(`read-raw-${index}`, { path: `${textPath}:raw` });
			expect(result.content).toEqual([{ type: "text", text: "alpha\nbeta\n" }]);
		}

		const formattedTool = new ReadTool(createSession(testDir, textPath));
		let formattedText = "";
		for (let index = 0; index < 3; index++) {
			const result = await formattedTool.execute(`read-formatted-${index}`, { path: textPath });
			const block = result.content.find(entry => entry.type === "text");
			formattedText = block?.type === "text" ? block.text : "";
		}
		expect(formattedText).toContain("You have received this identical output 3 times");
	});
});
