import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { NativeImageCache, getNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";

const SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';

describe("read immutable media identity", () => {
	let dir: string;
	let tool: ReadTool;
	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "read-media-path-"));
		await fs.writeFile(path.join(dir, "image.png"), encodeRawPng(Uint8Array.of(255, 255, 255, 0), 1, 1, 4));
		await fs.writeFile(path.join(dir, "model.obj"), "mtllib private.mtl\nv 0 0 0\nv 1 0 0\nf 1 2 3\n");
		await fs.writeFile(path.join(dir, "logo.svg"), SVG);
		await fs.writeFile(path.join(dir, "renamed.png"), SVG);
		tool = new ReadTool({
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getActiveModel: () => ({ input: ["text", "image"] }),
			settings: Settings.isolated({ "images.autoResize": false }),
		} as unknown as ToolSession);
	});
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("retains admitted image bytes after replacement and gives a later read its own blob identity", async () => {
		const result = await tool.execute("raster", { path: "image.png" });
		const image = result.content.find(block => block.type === "image");
		expect(image?.type).toBe("image");
		if (image?.type !== "image") throw new Error("Expected admitted raster image");
		const original = Buffer.from(image.data, "base64");
		await fs.writeFile(path.join(dir, "image.png"), encodeRawPng(Uint8Array.of(255, 0, 0, 255), 1, 1, 4));
		const cache = new NativeImageCache();
		const node = cache.get("read", image.data, image.mimeType);
		const props = node.p;
		if (!props || !("blob" in props) || typeof props.blob !== "string") throw new Error("Expected image blob");
		expect(Buffer.from(getNativeBlob(props.blob)!.bytes)).toEqual(original);
		expect(node.k).toBe("image");
		expect(Object.hasOwn(result.details ?? {}, "mediaPath")).toBe(false);
		const next = await tool.execute("next", { path: "image.png" });
		const nextImage = next.content.find(block => block.type === "image");
		if (nextImage?.type !== "image") throw new Error("Expected replacement raster image");
		const nextNode = cache.get("read", nextImage.data, nextImage.mimeType);
		expect(nextNode).not.toBe(node);
		expect(nextImage.data).not.toBe(image.data);
	});

	it("keeps sidecar readers and renamed SVG content off automatic host file loading", async () => {
		for (const target of ["model.obj", "logo.svg", "renamed.png"]) {
			const result = await tool.execute(target, { path: target });
			expect(Object.hasOwn(result.details ?? {}, "mediaPath")).toBe(false);
		}
	});
});
