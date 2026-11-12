import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createQualificationBrowserPipe } from "./browser-pipe";

const version = JSON.stringify({ id: 0, result: { product: "Chrome/qualification" } }) + "\0";
function fixture() {
	const writer = new PassThrough();
	const reader = new PassThrough();
	const pipe = createQualificationBrowserPipe(writer, reader);
	return { writer, reader, pipe };
}

describe("qualification Chromium readiness", () => {
	test("preserves fragmented UTF-8 CDP events across the readiness handoff", async () => {
		const { reader, pipe } = fixture();
		try {
			const ready = pipe.waitUntilReady(1000);
			const event = JSON.stringify({ method: "Target.targetCreated", params: { title: "owned € page" } });
			const bytes = Buffer.from(version + event + "\0");
			const split = bytes.indexOf(Buffer.from("€")) + 1;
			reader.write(bytes.subarray(0, split));
			await ready;
			const messages: string[] = [];
			pipe.transport.onmessage = message => messages.push(message);
			reader.write(bytes.subarray(split));
			expect(messages).toEqual([event]);
		} finally {
			pipe.transport.close();
		}
	});

	test("buffers a complete event received before Puppeteer installs its receiver", async () => {
		const { reader, pipe } = fixture();
		try {
			const ready = pipe.waitUntilReady(1000);
			const event = JSON.stringify({ method: "Target.targetDestroyed", params: { targetId: "owned" } });
			reader.write(version + event + "\0");
			await ready;
			const messages: string[] = [];
			pipe.transport.onmessage = message => messages.push(message);
			expect(messages).toEqual([event]);
		} finally {
			pipe.transport.close();
		}
	});

	test("makes a readiness deadline terminal before a late browser response", async () => {
		const { writer, reader, pipe } = fixture();
		await expect(pipe.waitUntilReady(0)).rejects.toThrow("Browser.getVersion readiness exceeded 0ms");
		expect(writer.writableEnded).toBe(true);
		expect(reader.destroyed).toBe(true);
		reader.emit("data", Buffer.from(version));
		expect(() => pipe.transport.send('{"id":1,"method":"Target.getTargets"}')).toThrow(
			"Owned CDP transport is closed",
		);
	});

	test("preserves a spawn failure that arrives before the readiness probe", async () => {
		const { pipe } = fixture();
		const error = Object.assign(new Error("owned Chromium spawn failed"), { code: "ENOENT" });
		pipe.fail(error);
		await expect(pipe.waitUntilReady(1000)).rejects.toBe(error);
	});

	test("preserves a pipe failure while waiting for the first protocol response", async () => {
		const { writer, pipe } = fixture();
		const ready = pipe.waitUntilReady(1000);
		const error = Object.assign(new Error("owned Chromium pipe failed"), { code: "EPIPE" });
		writer.emit("error", error);
		await expect(ready).rejects.toBe(error);
	});

	test("rejects a browser protocol error without replacing it with a deadline", async () => {
		const { reader, pipe } = fixture();
		const ready = pipe.waitUntilReady(1000);
		const error = { code: -32000, message: "owned browser setup failed" };
		reader.write(JSON.stringify({ id: 0, error }) + "\0");
		await expect(ready).rejects.toThrow(JSON.stringify(error));
	});

	test("notifies a late connection of pipe closure exactly once", async () => {
		const { reader, pipe } = fixture();
		const ready = pipe.waitUntilReady(1000);
		reader.write(version);
		await ready;
		reader.emit("end");
		reader.emit("close");
		let closed = 0;
		pipe.transport.onclose = () => closed++;
		pipe.transport.close();
		expect(closed).toBe(1);
		expect(() => pipe.transport.send("{}")).toThrow("Owned CDP transport is closed");
	});
});
