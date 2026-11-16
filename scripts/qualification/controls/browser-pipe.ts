import assert from "node:assert/strict";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";

export function createQualificationBrowserPipe(writer: Writable, reader: Readable) {
	const ready = Promise.withResolvers<void>();
	void ready.promise.catch(() => undefined);
	const decoder = new StringDecoder("utf8");
	let pending = "";
	let closed = false;
	let startupComplete = false;
	let receive: ((message: string) => void) | undefined;
	let onclose: (() => void) | undefined;
	let closeNotified = false;
	const inbox: string[] = [];
	const notifyClosed = () => {
		if (!onclose || closeNotified) return;
		closeNotified = true;
		onclose();
	};
	const close = () => {
		if (closed) return;
		closed = true;
		ready.reject(new Error("Owned Chromium CDP pipe closed before readiness"));
		inbox.length = 0;
		writer.end();
		reader.destroy();
		notifyClosed();
	};
	const fail = (error: unknown) => {
		ready.reject(error);
		close();
	};
	const transport = {
		send(message: string) {
			assert(!closed, "Owned CDP transport is closed");
			writer.write(message + "\0");
		},
		close,
		get onmessage() {
			return receive;
		},
		set onmessage(callback: ((message: string) => void) | undefined) {
			receive = callback;
			if (callback && !closed) for (const message of inbox.splice(0)) callback(message);
		},
		get onclose() {
			return onclose;
		},
		set onclose(callback: (() => void) | undefined) {
			onclose = callback;
			if (closed) notifyClosed();
		},
	};
	reader.on("data", (chunk: Buffer) => {
		if (closed) return;
		pending += decoder.write(chunk);
		let boundary: number;
		while ((boundary = pending.indexOf("\0")) !== -1) {
			const message = pending.slice(0, boundary);
			pending = pending.slice(boundary + 1);
			if (!startupComplete) {
				try {
					const response = JSON.parse(message);
					if (response.id === 0) {
						if (response.error) throw new Error(JSON.stringify(response.error));
						assert.equal(typeof response.result?.product, "string");
						startupComplete = true;
						ready.resolve();
						continue;
					}
				} catch (error) {
					fail(error);
					return;
				}
			}
			if (receive) receive(message);
			else inbox.push(message);
		}
	});
	reader.on("close", close);
	reader.on("end", close);
	reader.on("error", fail);
	writer.on("error", fail);
	let started = false;
	return {
		transport,
		fail,
		async waitUntilReady(timeoutMs: number) {
			assert(!started, "Chromium readiness probe already started");
			started = true;
			const timer = setTimeout(
				() => fail(new Error(`Owned Chromium Browser.getVersion readiness exceeded ${timeoutMs}ms`)),
				timeoutMs,
			);
			try {
				if (closed) await ready.promise;
				transport.send(JSON.stringify({ id: 0, method: "Browser.getVersion" }));
				await ready.promise;
				assert(!closed, "Owned Chromium CDP pipe closed during readiness");
			} catch (error) {
				fail(error);
				throw error;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
