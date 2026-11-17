import { describe, expect, test } from "bun:test";
import type * as BunFfi from "bun:ffi";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	inspectStdinPrivateChannel,
	isLocallyAnonymousStdinChannel,
	isSupportedFiniteStdinDescriptor,
	isVerifiedStdinPrivateChannelEvidence,
} from "../fixtures/aws-secret-input-stdin-metadata";

const SYMBOLS = {
	socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" },
	pipe: { args: ["ptr"], returns: "i32" },
	socket: { args: ["i32", "i32", "i32"], returns: "i32" },
	bind: { args: ["i32", "ptr", "u32"], returns: "i32" },
	listen: { args: ["i32", "i32"], returns: "i32" },
	connect: { args: ["i32", "ptr", "u32"], returns: "i32" },
	accept: { args: ["i32", "ptr", "ptr"], returns: "i32" },
	close: { args: ["i32"], returns: "i32" },
} as const;
type SocketLibrary = BunFfi.Library<typeof SYMBOLS>;
const loadBuiltin = createRequire(import.meta.url);

function withSockets(
	exercise: (library: SocketLibrary, pointer: typeof BunFfi.ptr, retain: (fd: number) => number) => void,
): void {
	const ffi = loadBuiltin("bun:ffi") as typeof BunFfi;
	const musl = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
	const names =
		process.platform === "darwin"
			? ["/usr/lib/libSystem.B.dylib"]
			: ["libc.so.6", "libc.so", ...(musl ? [`/lib/ld-musl-${musl}.so.1`] : [])];
	let library: SocketLibrary | undefined;
	for (const name of names) {
		try {
			library = ffi.dlopen(name, SYMBOLS);
			break;
		} catch {}
	}
	if (!library) throw new Error("Socket metadata fixture library unavailable");
	const owned: number[] = [];
	try {
		exercise(library, ffi.ptr, fd => {
			if (!Number.isInteger(fd) || fd < 0) throw new Error("Socket metadata fixture allocation failed");
			owned.push(fd);
			return fd;
		});
	} finally {
		for (const fd of owned.reverse()) library.symbols.close(fd);
		library.close();
	}
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("private stdin channel metadata", () => {
	test("accepts both ends of an actual unnamed Unix stream pair", () => {
		withSockets((library, pointer, retain) => {
			const pair = new Int32Array([-1, -1]);
			expect(library.symbols.socketpair(1, 1, 0, pointer(pair))).toBe(0);
			const descriptors = [...pair].map(retain);
			for (const fd of descriptors) {
				const evidence = inspectStdinPrivateChannel(fd);
				expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(true);
				expect(isLocallyAnonymousStdinChannel(evidence)).toBe(true);
				expect(evidence).toMatchObject({
					verified: true,
					kind: "anonymous-unix-stream",
					isSocket: true,
					isRegularFile: false,
					isTerminal: false,
					isFifo: false,
					socketFamily: "unix",
					socketType: "stream",
					localAddress: "unnamed",
					peerAddress: "unnamed",
					failure: "none",
				});
			}
		});
	});

	test("rejects a connected Unix stream with a named endpoint", () => {
		const root = mkdtempSync("/tmp/asi-meta-");
		try {
			withSockets((library, pointer, retain) => {
				const listener = retain(library.symbols.socket(1, 1, 0));
				const pathname = new TextEncoder().encode(join(root, "endpoint"));
				const address = new Uint8Array(2 + pathname.byteLength + 1);
				if (process.platform === "darwin") {
					address[0] = address.byteLength;
					address[1] = 1;
				} else new Uint16Array(address.buffer, 0, 1)[0] = 1;
				address.set(pathname, 2);
				expect(library.symbols.bind(listener, pointer(address), address.byteLength)).toBe(0);
				expect(library.symbols.listen(listener, 1)).toBe(0);
				const client = retain(library.symbols.socket(1, 1, 0));
				expect(library.symbols.connect(client, pointer(address), address.byteLength)).toBe(0);
				const server = retain(library.symbols.accept(listener, null, null));
				for (const fd of [client, server]) {
					const evidence = inspectStdinPrivateChannel(fd);
					expect(evidence.isSocket).toBe(true);
					expect(evidence.socketType).toBe("stream");
					expect(evidence.localAddress === "named" || evidence.peerAddress === "named").toBe(true);
					expect(evidence.verified).toBe(false);
					expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(false);
					expect(isLocallyAnonymousStdinChannel(evidence)).toBe(false);
				}
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("does not classify an Internet socket as private stdin", () => {
		withSockets((library, _pointer, retain) => {
			const fd = retain(library.symbols.socket(2, 1, 0));
			const evidence = inspectStdinPrivateChannel(fd);
			expect(evidence.isSocket).toBe(true);
			expect(evidence.socketFamily).toBe("other");
			expect(evidence.verified).toBe(false);
			expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(false);
			expect(isLocallyAnonymousStdinChannel(evidence)).toBe(false);
		});
	});

	test("rejects anonymous Unix datagrams rather than assuming every socket is a byte stream", () => {
		withSockets((library, pointer, retain) => {
			const pair = new Int32Array([-1, -1]);
			expect(library.symbols.socketpair(1, 2, 0, pointer(pair))).toBe(0);
			const descriptors = [...pair].map(retain);
			for (const fd of descriptors) {
				const evidence = inspectStdinPrivateChannel(fd);
				expect(evidence.isSocket).toBe(true);
				expect(evidence.socketType).toBe("other");
				expect(evidence.verified).toBe(false);
				expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(false);
				expect(isLocallyAnonymousStdinChannel(evidence)).toBe(false);
			}
		});
	});

	test.skipIf(process.platform !== "linux")("rejects connected abstract Unix names despite their leading NUL", () => {
		withSockets((library, pointer, retain) => {
			const listener = retain(library.symbols.socket(1, 1, 0));
			const name = new TextEncoder().encode(`asi-meta-${crypto.randomUUID()}`);
			const address = new Uint8Array(3 + name.byteLength);
			new Uint16Array(address.buffer, 0, 1)[0] = 1;
			address.set(name, 3);
			expect(library.symbols.bind(listener, pointer(address), address.byteLength)).toBe(0);
			expect(library.symbols.listen(listener, 1)).toBe(0);
			const client = retain(library.symbols.socket(1, 1, 0));
			expect(library.symbols.connect(client, pointer(address), address.byteLength)).toBe(0);
			const server = retain(library.symbols.accept(listener, null, null));
			for (const fd of [client, server]) {
				const evidence = inspectStdinPrivateChannel(fd);
				expect(evidence.isSocket).toBe(true);
				expect(evidence.socketFamily).toBe("unix");
				expect(evidence.localAddress === "named" || evidence.peerAddress === "named").toBe(true);
				expect(evidence.verified).toBe(false);
				expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(false);
				expect(isLocallyAnonymousStdinChannel(evidence)).toBe(false);
			}
		});
	});

	test.skipIf(process.platform !== "linux")("accepts an actual pipe with kernel anonymous-pipe identity", () => {
		withSockets((library, pointer, retain) => {
			const pair = new Int32Array([-1, -1]);
			expect(library.symbols.pipe(pointer(pair))).toBe(0);
			const descriptors = [...pair].map(retain);
			const evidence = inspectStdinPrivateChannel(descriptors[0]!);
			expect(isVerifiedStdinPrivateChannelEvidence(evidence)).toBe(true);
			expect(isLocallyAnonymousStdinChannel(evidence)).toBe(true);
			expect(evidence).toMatchObject({
				verified: true,
				kind: "anonymous-pipe",
				isFifo: true,
				isSocket: false,
				socketFamily: null,
				socketType: null,
				localAddress: null,
				peerAddress: null,
				failure: "none",
			});
		});
	});

	test("distinguishes null-device EOF from an anonymous channel and other character devices", () => {
		let emptyFd: number | undefined;
		let otherFd: number | undefined;
		try {
			emptyFd = openSync("/dev/null", "r");
			otherFd = openSync("/dev/zero", "r");
			const empty = inspectStdinPrivateChannel(emptyFd);
			expect(empty).toMatchObject({
				verified: false,
				kind: "unverified",
				isCharacterDevice: true,
				matchesDevNull: true,
				isRegularFile: false,
				isTerminal: false,
				isSocket: false,
				isFifo: false,
				socketFamily: null,
				localSocketFamily: null,
				peerSocketFamily: null,
				socketType: null,
				localAddress: null,
				peerAddress: null,
				failure: "unsupported-channel",
			});
			expect(isVerifiedStdinPrivateChannelEvidence(empty)).toBe(false);
			expect(isLocallyAnonymousStdinChannel(empty)).toBe(false);
			expect(isSupportedFiniteStdinDescriptor(empty)).toBe(false);
			const other = inspectStdinPrivateChannel(otherFd);
			expect(other.isCharacterDevice).toBe(true);
			expect(other.matchesDevNull).toBe(false);
			expect(isSupportedFiniteStdinDescriptor(other)).toBe(false);
		} finally {
			if (otherFd !== undefined) closeSync(otherFd);
			if (emptyFd !== undefined) closeSync(emptyFd);
		}
	});

	test("rejects regular backing files and unavailable descriptor metadata", () => {
		const root = mkdtempSync("/tmp/asi-meta-");
		let fd: number | undefined;
		try {
			fd = openSync(join(root, "ordinary-file"), "wx+");
			const file = inspectStdinPrivateChannel(fd);
			expect(file.isRegularFile).toBe(true);
			expect(file.verified).toBe(false);
			expect(isVerifiedStdinPrivateChannelEvidence(file)).toBe(false);
			expect(isLocallyAnonymousStdinChannel(file)).toBe(false);
			expect(isSupportedFiniteStdinDescriptor(file)).toBe(false);
			const unavailable = inspectStdinPrivateChannel(-1);
			expect(unavailable.failure).toBe("metadata-unavailable");
			expect(unavailable.verified).toBe(false);
			expect(isVerifiedStdinPrivateChannelEvidence(unavailable)).toBe(false);
			expect(isLocallyAnonymousStdinChannel(unavailable)).toBe(false);
			expect(isSupportedFiniteStdinDescriptor(unavailable)).toBe(false);
		} finally {
			if (fd !== undefined) closeSync(fd);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
