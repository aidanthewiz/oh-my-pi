import type * as BunFfi from "bun:ffi";
import { closeSync, fstatSync, readlinkSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isatty } from "node:tty";

export interface StdinPrivateChannelEvidence {
	verified: boolean;
	kind: "anonymous-unix-stream" | "anonymous-pipe" | "unverified";
	isRegularFile: boolean | null;
	isTerminal: boolean | null;
	isSocket: boolean | null;
	isFifo: boolean | null;
	isCharacterDevice: boolean | null;
	matchesDevNull: boolean | null;
	socketFamily: "unix" | "other" | "unavailable" | null;
	localSocketFamily: "unix" | "other" | "unavailable" | null;
	peerSocketFamily: "unix" | "other" | "unavailable" | null;
	socketType: "stream" | "other" | "unavailable" | null;
	localAddress: "unnamed" | "named" | "unavailable" | null;
	peerAddress: "unnamed" | "named" | "unavailable" | null;
	failure: "none" | "metadata-unavailable" | "regular-file" | "terminal" | "not-anonymous" | "unsupported-channel";
}

const SOCKET_SYMBOLS = {
	getsockname: { args: ["i32", "ptr", "ptr"], returns: "i32" },
	getpeername: { args: ["i32", "ptr", "ptr"], returns: "i32" },
	getsockopt: { args: ["i32", "i32", "i32", "ptr", "ptr"], returns: "i32" },
} as const;
type SocketLibrary = BunFfi.Library<typeof SOCKET_SYMBOLS>;
type Ffi = typeof BunFfi;
const loadBuiltin = createRequire(import.meta.url);

function openSocketMetadataLibrary(): { library: SocketLibrary; pointer: Ffi["ptr"] } | undefined {
	const musl = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
	const names =
		process.platform === "darwin"
			? ["/usr/lib/libSystem.B.dylib"]
			: process.platform === "linux"
				? ["libc.so.6", "libc.so", ...(musl ? [`/lib/ld-musl-${musl}.so.1`] : [])]
				: [];
	if (names.length === 0) return undefined;
	let ffi: Ffi;
	try {
		ffi = loadBuiltin("bun:ffi") as Ffi;
	} catch {
		return undefined;
	}
	for (const name of names) {
		try {
			return { library: ffi.dlopen(name, SOCKET_SYMBOLS), pointer: ffi.ptr };
		} catch {}
	}
	return undefined;
}

interface SocketAddressEvidence {
	family: "unix" | "other" | "unavailable";
	address: "unnamed" | "named" | "unavailable";
}

function inspectSocketAddress(
	fd: number,
	readAddress: SocketLibrary["symbols"]["getsockname"],
	pointer: Ffi["ptr"],
): SocketAddressEvidence {
	const address = new Uint8Array(256);
	const length = new Uint32Array([address.byteLength]);
	if (readAddress(fd, pointer(address), pointer(length)) !== 0 || length[0]! < 2 || length[0]! > address.byteLength) {
		return { family: "unavailable", address: "unavailable" };
	}
	const size = length[0]!;
	const family = process.platform === "darwin" ? address[1] : new Uint16Array(address.buffer, 0, 1)[0];
	if (family !== 1) return { family: "other", address: "unavailable" };
	if (process.platform === "linux") {
		if (size > 110) return { family: "unix", address: "unavailable" };
		return { family: "unix", address: size === 2 ? "unnamed" : "named" };
	}
	if (process.platform === "darwin") {
		if (size > 106 || address[0] !== size) return { family: "unix", address: "unavailable" };
		// BSD Unix sockets have no abstract namespace; an empty path has no named endpoint.
		return { family: "unix", address: address.subarray(2, size).every(byte => byte === 0) ? "unnamed" : "named" };
	}
	return { family: "unavailable", address: "unavailable" };
}

export function inspectStdinPrivateChannel(fd = 0): StdinPrivateChannelEvidence {
	const evidence: StdinPrivateChannelEvidence = {
		verified: false,
		kind: "unverified",
		isRegularFile: null,
		isTerminal: null,
		isSocket: null,
		isFifo: null,
		isCharacterDevice: null,
		matchesDevNull: null,
		socketFamily: null,
		localSocketFamily: null,
		peerSocketFamily: null,
		socketType: null,
		localAddress: null,
		peerAddress: null,
		failure: "metadata-unavailable",
	};
	if (!Number.isSafeInteger(fd) || fd < 0 || fd > 0x7fffffff) return evidence;
	try {
		const stat = fstatSync(fd, { bigint: true });
		evidence.isRegularFile = stat.isFile();
		evidence.isTerminal = isatty(fd);
		evidence.isSocket = stat.isSocket();
		evidence.isFifo = stat.isFIFO();
		evidence.isCharacterDevice = stat.isCharacterDevice();
		evidence.matchesDevNull = evidence.isCharacterDevice ? null : false;
		if (evidence.isRegularFile) {
			evidence.failure = "regular-file";
			return evidence;
		}
		if (evidence.isTerminal) {
			evidence.failure = "terminal";
			return evidence;
		}
		if (evidence.isCharacterDevice) {
			const empty = statSync("/dev/null", { bigint: true });
			evidence.matchesDevNull =
				empty.isCharacterDevice() && stat.dev === empty.dev && stat.ino === empty.ino && stat.rdev === empty.rdev;
		}
		if (evidence.isFifo) {
			if (process.platform !== "linux") return evidence;
			const target = readlinkSync(`/proc/self/fd/${fd}`);
			if (!/^pipe:\[[0-9]+\]$/u.test(target)) {
				evidence.failure = "not-anonymous";
				return evidence;
			}
			evidence.verified = true;
			evidence.kind = "anonymous-pipe";
			evidence.failure = "none";
			return evidence;
		}
		if (!evidence.isSocket) {
			evidence.failure = "unsupported-channel";
			return evidence;
		}
		evidence.socketFamily = "unavailable";
		evidence.localSocketFamily = "unavailable";
		evidence.peerSocketFamily = "unavailable";
		evidence.socketType = "unavailable";
		evidence.localAddress = "unavailable";
		evidence.peerAddress = "unavailable";
		const metadata = openSocketMetadataLibrary();
		if (!metadata) return evidence;
		const { library, pointer } = metadata;
		try {
			const type = new Int32Array(1);
			const length = new Uint32Array([type.byteLength]);
			const level = process.platform === "darwin" ? 0xffff : 1;
			const option = process.platform === "darwin" ? 0x1008 : 3;
			const typeAvailable =
				library.symbols.getsockopt(fd, level, option, pointer(type), pointer(length)) === 0 &&
				length[0] === type.byteLength;
			if (typeAvailable) evidence.socketType = type[0] === 1 ? "stream" : "other";
			const local = inspectSocketAddress(fd, library.symbols.getsockname, pointer);
			const peer = inspectSocketAddress(fd, library.symbols.getpeername, pointer);
			evidence.localSocketFamily = local.family;
			evidence.peerSocketFamily = peer.family;
			evidence.localAddress = local.address;
			evidence.peerAddress = peer.address;
			evidence.socketFamily =
				local.family === "other" || peer.family === "other"
					? "other"
					: local.family === "unix" && peer.family === "unix"
						? "unix"
						: "unavailable";
			if (evidence.socketFamily === "other" || evidence.socketType === "other") {
				evidence.failure = "unsupported-channel";
				return evidence;
			}
			if (local.address === "named" || peer.address === "named") {
				evidence.failure = "not-anonymous";
				return evidence;
			}
			if (
				!typeAvailable ||
				evidence.socketFamily !== "unix" ||
				local.address !== "unnamed" ||
				peer.address !== "unnamed"
			)
				return evidence;
			evidence.verified = true;
			evidence.kind = "anonymous-unix-stream";
			evidence.failure = "none";
			return evidence;
		} finally {
			library.close();
		}
	} catch {
		evidence.verified = false;
		evidence.kind = "unverified";
		evidence.failure = "metadata-unavailable";
		return evidence;
	}
}

const EVIDENCE_KEYS = [
	"verified",
	"kind",
	"isRegularFile",
	"isTerminal",
	"isSocket",
	"isFifo",
	"isCharacterDevice",
	"matchesDevNull",
	"socketFamily",
	"localSocketFamily",
	"peerSocketFamily",
	"socketType",
	"localAddress",
	"peerAddress",
	"failure",
] as const;

export function isVerifiedStdinPrivateChannelEvidence(
	value: unknown,
): value is StdinPrivateChannelEvidence & { verified: true } {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return false;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Reflect.ownKeys(descriptors).length !== EVIDENCE_KEYS.length) return false;
		const fields: Record<string, unknown> = {};
		for (const key of EVIDENCE_KEYS) {
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
			fields[key] = descriptor.value;
		}
		if (
			fields.verified !== true ||
			fields.failure !== "none" ||
			fields.isRegularFile !== false ||
			fields.isCharacterDevice !== false ||
			fields.matchesDevNull !== false ||
			fields.isTerminal !== false
		)
			return false;
		if (fields.kind === "anonymous-unix-stream") {
			return (
				fields.isSocket === true &&
				fields.isFifo === false &&
				fields.socketFamily === "unix" &&
				fields.localSocketFamily === "unix" &&
				fields.peerSocketFamily === "unix" &&
				fields.socketType === "stream" &&
				fields.localAddress === "unnamed" &&
				fields.peerAddress === "unnamed"
			);
		}
		return (
			process.platform === "linux" &&
			fields.kind === "anonymous-pipe" &&
			fields.isSocket === false &&
			fields.isFifo === true &&
			fields.socketFamily === null &&
			fields.localSocketFamily === null &&
			fields.peerSocketFamily === null &&
			fields.socketType === null &&
			fields.localAddress === null &&
			fields.peerAddress === null
		);
	} catch {
		return false;
	}
}

function plainFields(value: unknown, keys?: readonly string[]): Record<string, unknown> | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const names = Reflect.ownKeys(descriptors);
		if (keys && names.length !== keys.length) return undefined;
		const fields: Record<string, unknown> = {};
		for (const key of keys ?? names) {
			if (typeof key !== "string") return undefined;
			const descriptor = descriptors[key];
			if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
			fields[key] = descriptor.value;
		}
		return fields;
	} catch {
		return undefined;
	}
}

/** Local descriptor evidence does not establish an unavailable peer's identity. */
export function isLocallyAnonymousStdinChannel(value: unknown): value is StdinPrivateChannelEvidence {
	if (isVerifiedStdinPrivateChannelEvidence(value)) return true;
	const fields = plainFields(value, EVIDENCE_KEYS);
	if (
		!fields ||
		fields.verified !== false ||
		fields.kind !== "unverified" ||
		fields.failure !== "metadata-unavailable" ||
		fields.isRegularFile !== false ||
		fields.isCharacterDevice !== false ||
		fields.matchesDevNull !== false ||
		fields.isTerminal !== false ||
		fields.isSocket !== true ||
		fields.isFifo !== false ||
		fields.localSocketFamily !== "unix" ||
		fields.localAddress !== "unnamed" ||
		fields.socketType !== "stream" ||
		fields.peerAddress !== "unavailable"
	)
		return false;
	return (
		(fields.peerSocketFamily === "unavailable" && fields.socketFamily === "unavailable") ||
		(fields.peerSocketFamily === "unix" && fields.socketFamily === "unix")
	);
}

/** A known null device supplies EOF, not an anonymous channel. */
export function isSupportedFiniteStdinDescriptor(value: unknown): value is StdinPrivateChannelEvidence {
	if (isLocallyAnonymousStdinChannel(value)) return true;
	const fields = plainFields(value, EVIDENCE_KEYS);
	return (
		fields !== undefined &&
		fields.verified === false &&
		fields.kind === "unverified" &&
		fields.failure === "unsupported-channel" &&
		fields.isRegularFile === false &&
		fields.isTerminal === false &&
		fields.isSocket === false &&
		fields.isFifo === false &&
		fields.isCharacterDevice === true &&
		fields.matchesDevNull === true &&
		fields.socketFamily === null &&
		fields.localSocketFamily === null &&
		fields.peerSocketFamily === null &&
		fields.socketType === null &&
		fields.localAddress === null &&
		fields.peerAddress === null
	);
}

export interface StdinProducerWitness {
	origin: "observed-anonymous-stdin-writes";
	observerPid: number;
	guardianPid: number;
	receiverPid: number;
	pipeConfigured: boolean;
	inputUnmodified: boolean;
	inputWasEmpty: boolean;
	exactWrites: boolean;
	bytesAccepted: number;
	maxChunkBytes: number;
	flushesCompleted: boolean;
	eofClosed: boolean;
	writeFailed: boolean;
	backpressureObserved: boolean;
}

const PRODUCER_KEYS = [
	"origin",
	"observerPid",
	"guardianPid",
	"receiverPid",
	"pipeConfigured",
	"inputUnmodified",
	"inputWasEmpty",
	"exactWrites",
	"bytesAccepted",
	"maxChunkBytes",
	"flushesCompleted",
	"eofClosed",
	"writeFailed",
	"backpressureObserved",
] as const;

function processId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

export function isVerifiedStdinProducerWitness(value: unknown): value is StdinProducerWitness {
	const fields = plainFields(value, PRODUCER_KEYS);
	return (
		fields !== undefined &&
		fields.origin === "observed-anonymous-stdin-writes" &&
		fields.pipeConfigured === true &&
		fields.inputUnmodified === true &&
		fields.exactWrites === true &&
		fields.flushesCompleted === true &&
		fields.eofClosed === true &&
		fields.writeFailed === false &&
		typeof fields.backpressureObserved === "boolean" &&
		typeof fields.inputWasEmpty === "boolean" &&
		Number.isSafeInteger(fields.bytesAccepted) &&
		(fields.bytesAccepted as number) >= 0 &&
		(fields.inputWasEmpty ? fields.bytesAccepted === 0 : (fields.bytesAccepted as number) > 0) &&
		Number.isSafeInteger(fields.maxChunkBytes) &&
		(fields.inputWasEmpty
			? fields.maxChunkBytes === 0
			: (fields.maxChunkBytes as number) > 0 &&
				(fields.maxChunkBytes as number) <= (fields.bytesAccepted as number)) &&
		(fields.maxChunkBytes as number) <= 4096 &&
		processId(fields.observerPid) &&
		processId(fields.guardianPid) &&
		processId(fields.receiverPid) &&
		fields.observerPid !== fields.guardianPid &&
		fields.observerPid !== fields.receiverPid &&
		fields.guardianPid !== fields.receiverPid
	);
}

interface PendingStdinOperation {
	guardianPid: number;
	id: number;
	operation: "write" | "flush";
	bytesAccepted: number;
}

interface StdinObserverOptions {
	constrainBuffer?: boolean;
	onPending?(operation: PendingStdinOperation): void;
	onStressChannel?(evidence: {
		guardianPid: number;
		transport: "fixture-socketpair";
		sendBufferBytes: number;
		channel: StdinPrivateChannelEvidence;
	}): void;
	onStressClosed?(evidence: { guardianPid: number; readerClosed: boolean; writerClosed: boolean }): void;
}

function descriptorIsClosed(fd: number): boolean {
	try {
		fstatSync(fd);
		return false;
	} catch (error) {
		return !!error && typeof error === "object" && "code" in error && error.code === "EBADF";
	}
}

function fixtureSocketIdentity(fd: number): string {
	const stat = fstatSync(fd, { bigint: true });
	if (!stat.isSocket()) throw new Error("STDIN_STRESS_OWNERSHIP_LOST");
	if (process.platform === "linux") {
		if (stat.ino <= 0n || readlinkSync(`/proc/self/fd/${fd}`) !== `socket:[${stat.ino}]`)
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		return `linux:${stat.dev}:${stat.ino}`;
	}
	if (process.platform !== "darwin") throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
	const ffi = loadBuiltin("bun:ffi") as Ffi;
	const library = ffi.dlopen("/usr/lib/libproc.dylib", {
		proc_pidfdinfo: { args: ["i32", "i32", "i32", "ptr", "i32"], returns: "i32" },
	} as const);
	try {
		const buffer = new Uint8Array(4096);
		const written = library.symbols.proc_pidfdinfo(process.pid, fd, 3, ffi.ptr(buffer), buffer.byteLength);
		if (written < 188 || written > buffer.byteLength) throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		const view = new DataView(buffer.buffer);
		// socket_fdinfo starts with 24-byte proc_fileinfo and 136-byte vinfo_stat.
		const socket = view.getBigUint64(160, true);
		const pcb = view.getBigUint64(168, true);
		if (socket === 0n || pcb === 0n || view.getInt32(176, true) !== 1 || view.getInt32(184, true) !== 1)
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		return `darwin:${socket}:${pcb}`;
	} finally {
		library.close();
	}
}

function closeFixtureSocket(fd: number, identity: string): void {
	let current: string;
	try {
		current = fixtureSocketIdentity(fd);
	} catch (error) {
		if (descriptorIsClosed(fd)) return;
		throw error;
	}
	if (current !== identity) throw new Error("STDIN_STRESS_OWNERSHIP_LOST");
	closeSync(fd);
}

function constrainedStdinSocketpair() {
	const ffi = loadBuiltin("bun:ffi") as Ffi;
	const symbols = {
		socketpair: { args: ["i32", "i32", "i32", "ptr"], returns: "i32" },
		setsockopt: { args: ["i32", "i32", "i32", "ptr", "i32"], returns: "i32" },
		getsockopt: SOCKET_SYMBOLS.getsockopt,
		fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
	} as const;
	let library: BunFfi.Library<typeof symbols> | undefined;
	for (const filename of process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"]) {
		try {
			library = ffi.dlopen(filename, symbols);
			break;
		} catch {}
	}
	if (!library) throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
	const descriptors = new Int32Array([-1, -1]);
	let readerOpen = false;
	let writerOwned = false;
	try {
		if (library.symbols.socketpair(1, 1, 0, ffi.ptr(descriptors)) !== 0)
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		readerOpen = descriptors[0]! >= 0;
		writerOwned = descriptors[1]! >= 0 && descriptors[0] !== descriptors[1];
		if (descriptors[0]! <= 2 || descriptors[1]! <= 2 || descriptors[0] === descriptors[1])
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		for (const fd of descriptors) {
			const flags = library.symbols.fcntl(fd, 1, 0);
			if (flags < 0 || library.symbols.fcntl(fd, 2, flags | 1) !== 0)
				throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		}
		const writerFd = descriptors[1]!;
		const flags = library.symbols.fcntl(writerFd, 3, 0);
		if (flags < 0 || library.symbols.fcntl(writerFd, 4, flags | (process.platform === "darwin" ? 4 : 2048)) !== 0)
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		const level = process.platform === "darwin" ? 0xffff : 1;
		const option = process.platform === "darwin" ? 0x1001 : 7;
		const capacity = new Int32Array([4096]);
		const length = new Uint32Array([capacity.byteLength]);
		if (
			library.symbols.setsockopt(writerFd, level, option, ffi.ptr(capacity), capacity.byteLength) !== 0 ||
			library.symbols.getsockopt(writerFd, level, option, ffi.ptr(capacity), ffi.ptr(length)) !== 0 ||
			length[0] !== capacity.byteLength ||
			capacity[0]! <= 0 ||
			capacity[0]! >= 65_536
		)
			throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		const channel = inspectStdinPrivateChannel(writerFd);
		if (!isVerifiedStdinPrivateChannelEvidence(channel)) throw new Error("STDIN_STRESS_METADATA_UNAVAILABLE");
		const readerFd = descriptors[0]!;
		const readerIdentity = fixtureSocketIdentity(readerFd);
		const writerIdentity = fixtureSocketIdentity(writerFd);
		const closeReader = () => {
			if (!readerOpen) return;
			closeFixtureSocket(readerFd, readerIdentity);
			readerOpen = false;
		};
		const closeWriter = () => {
			if (!writerOwned) return;
			closeFixtureSocket(writerFd, writerIdentity);
			writerOwned = false;
		};
		const writer = Bun.file(writerFd).writer({ highWaterMark: 16_384 });
		let endStarted = false;
		let endResult: number | Promise<number> | undefined;
		let endFailed = false;
		let endFailure: unknown;
		const endWriter: Bun.FileSink["end"] = error => {
			if (endStarted) {
				if (endFailed) throw endFailure;
				return endResult!;
			}
			endStarted = true;
			try {
				const result = writer.end(error);
				if (typeof result === "number") {
					closeWriter();
					endResult = result;
				} else {
					endResult = result.then(
						bytes => {
							closeWriter();
							return bytes;
						},
						error => {
							closeWriter();
							throw error;
						},
					);
					void endResult.catch(() => {});
				}
				return endResult;
			} catch (error) {
				try {
					closeWriter();
				} catch (closeError) {
					error = closeError;
				}
				endFailed = true;
				endFailure = error;
				throw error;
			}
		};
		return {
			readerFd,
			writer,
			channel,
			sendBufferBytes: capacity[0]!,
			closeReader,
			endWriter,
			readerClosed: () => !readerOpen,
			writerClosed: () => !writerOwned,
		};
	} catch (error) {
		if (readerOpen) closeSync(descriptors[0]!);
		if (writerOwned) closeSync(descriptors[1]!);
		throw error;
	} finally {
		library.close();
	}
}

export interface StdinProducerWitnessObserver {
	begin(input: Uint8Array, options?: StdinObserverOptions): void;
	captureSpawn(options: unknown): <T extends { pid: number; stdin: unknown }>(guardian: T) => T;
	witnessFor(guardianPid: number, receiverPid: number): Promise<StdinProducerWitness | undefined>;
	pendingFor(guardianPid: number): PendingStdinOperation | undefined;
	end(): Promise<void>;
}

export function createStdinProducerWitnessObserver(): StdinProducerWitnessObserver {
	let ownedInput: Uint8Array | undefined;
	let snapshot: Uint8Array | undefined;
	let configuration: StdinObserverOptions | undefined;
	let stress: ReturnType<typeof constrainedStdinSocketpair> | undefined;
	type Observation = Omit<StdinProducerWitness, "receiverPid">;
	const observed = new Map<
		number,
		{
			promise: Promise<Observation>;
			finish(): void;
			pending?: PendingStdinOperation;
		}
	>();
	return {
		begin(input, options) {
			if (!(input instanceof Uint8Array) || ownedInput !== undefined)
				throw new Error("STDIN_PRODUCER_OBSERVER_INVALID_INPUT");
			snapshot = Uint8Array.from(input);
			ownedInput = input;
			configuration = options;
		},
		captureSpawn(options) {
			const fields = plainFields(options);
			const stdio = fields?.stdio;
			let supplied = Array.isArray(stdio) ? Object.getOwnPropertyDescriptor(stdio, "0")?.value : fields?.stdin;
			const input = ownedInput;
			const expected = snapshot;
			if (input && expected && configuration?.constrainBuffer) {
				if (!Array.isArray(stdio) || supplied !== "pipe" || stress) throw new Error("STDIN_STRESS_INVALID_SPAWN");
				stress = constrainedStdinSocketpair();
				stdio[0] = stress.readerFd;
				supplied = stress.readerFd;
			}
			return guardian => {
				if (!input || !expected || !processId(guardian.pid)) return guardian;
				const { promise, resolve } = Promise.withResolvers<Observation>();
				let offset = 0;
				let pending = 0;
				let finished = false;
				let operationId = 0;
				const observation: Observation = {
					origin: "observed-anonymous-stdin-writes",
					observerPid: process.pid,
					guardianPid: guardian.pid,
					pipeConfigured: supplied === "pipe",
					inputUnmodified: true,
					inputWasEmpty: expected.byteLength === 0,
					exactWrites: true,
					bytesAccepted: 0,
					maxChunkBytes: 0,
					flushesCompleted: false,
					eofClosed: false,
					writeFailed: false,
					backpressureObserved: false,
				};
				const finish = () => {
					if (finished) return;
					finished = true;
					observation.inputUnmodified =
						input.byteLength === expected.byteLength && input.every((byte, index) => byte === expected[index]);
					observation.exactWrites &&= offset === expected.byteLength;
					observation.flushesCompleted = pending === 0;
					resolve({ ...observation });
				};
				const record = { promise, finish, pending: undefined as PendingStdinOperation | undefined };
				observed.set(guardian.pid, record);
				const stressChannel = stress;
				const writer = stressChannel?.writer ?? (guardian.stdin as Bun.FileSink | undefined);
				if (stressChannel) {
					try {
						stressChannel.closeReader();
						configuration?.onStressChannel?.({
							guardianPid: guardian.pid,
							transport: "fixture-socketpair",
							sendBufferBytes: stressChannel.sendBufferBytes,
							channel: stressChannel.channel,
						});
					} catch {
						observation.writeFailed = true;
					}
				}
				if (!writer || typeof writer !== "object" || typeof writer.write !== "function") {
					observation.writeFailed = true;
					finish();
					return guardian;
				}
				const originalWrite = writer.write.bind(writer);
				const originalFlush = writer.flush.bind(writer);
				const originalEnd = stressChannel ? stressChannel.endWriter : writer.end.bind(writer);
				const completed = (
					value: number | Promise<number>,
					accept: (bytes: number) => void,
					operation?: "write" | "flush",
				) => {
					if (typeof value === "number") {
						accept(value);
						return value;
					}
					observation.backpressureObserved = true;
					pending++;
					const id = ++operationId;
					if (operation) {
						record.pending = {
							guardianPid: guardian.pid,
							id,
							operation,
							bytesAccepted: observation.bytesAccepted,
						};
						try {
							configuration?.onPending?.({ ...record.pending });
						} catch {
							observation.writeFailed = true;
						}
					}
					return value.then(
						bytes => {
							pending--;
							if (record.pending?.id === id) record.pending = undefined;
							accept(bytes);
							return bytes;
						},
						error => {
							pending--;
							if (record.pending?.id === id) record.pending = undefined;
							observation.writeFailed = true;
							throw error;
						},
					);
				};
				const observedWrite: Bun.FileSink["write"] = chunk => {
					if (!(chunk instanceof Uint8Array) || pending !== 0) observation.exactWrites = false;
					if (chunk instanceof Uint8Array) {
						observation.maxChunkBytes = Math.max(observation.maxChunkBytes, chunk.byteLength);
						for (const byte of chunk) {
							if (byte !== expected[offset]) observation.exactWrites = false;
							offset++;
						}
					}
					try {
						return completed(
							originalWrite(chunk),
							bytes => {
								observation.bytesAccepted += bytes;
							},
							"write",
						);
					} catch (error) {
						observation.writeFailed = true;
						throw error;
					}
				};
				const observedFlush: Bun.FileSink["flush"] = () => {
					try {
						return completed(originalFlush(), () => {}, "flush");
					} catch (error) {
						observation.writeFailed = true;
						throw error;
					}
				};
				const closeObserved = () => {
					if (stressChannel) {
						try {
							configuration?.onStressClosed?.({
								guardianPid: guardian.pid,
								readerClosed: stressChannel.readerClosed(),
								writerClosed: stressChannel.writerClosed(),
							});
						} catch {
							observation.writeFailed = true;
						}
					}
					finish();
				};
				const observedEnd: Bun.FileSink["end"] = error => {
					try {
						const result = completed(originalEnd(error), () => {
							observation.eofClosed = true;
						});
						if (typeof result === "number") {
							closeObserved();
							return result;
						}
						return result.then(
							bytes => {
								closeObserved();
								return bytes;
							},
							error => {
								closeObserved();
								throw error;
							},
						);
					} catch (error) {
						observation.writeFailed = true;
						closeObserved();
						throw error;
					}
				};
				const observedWriter = new Proxy(Object.create(null) as Bun.FileSink, {
					get(_target, property) {
						if (property === "write") return observedWrite;
						if (property === "flush") return observedFlush;
						if (property === "end") return observedEnd;
						const value = Reflect.get(writer, property, writer);
						return typeof value === "function" ? value.bind(writer) : value;
					},
					getPrototypeOf: () => Object.getPrototypeOf(writer),
				});
				return new Proxy(Object.create(null) as typeof guardian, {
					get(_target, property) {
						if (property === "stdin") return observedWriter;
						const value = Reflect.get(guardian, property, guardian);
						return typeof value === "function" ? value.bind(guardian) : value;
					},
					getPrototypeOf: () => Object.getPrototypeOf(guardian),
				});
			};
		},
		async witnessFor(guardianPid, receiverPid) {
			const observation = observed.get(guardianPid);
			if (!observation || !processId(receiverPid)) return undefined;
			return { ...(await observation.promise), receiverPid };
		},
		pendingFor(guardianPid) {
			const pending = observed.get(guardianPid)?.pending;
			return pending ? { ...pending } : undefined;
		},
		async end() {
			try {
				if (stress) {
					try {
						stress.closeReader();
					} finally {
						try {
							await stress.endWriter();
						} catch (error) {
							if (!stress.writerClosed()) throw error;
						}
					}
					if (!stress.readerClosed() || !stress.writerClosed()) throw new Error("STDIN_STRESS_OWNERSHIP_LOST");
				}
			} finally {
				for (const observation of observed.values()) observation.finish();
				snapshot?.fill(0);
				snapshot = undefined;
				ownedInput = undefined;
				configuration = undefined;
				stress = undefined;
				observed.clear();
			}
		},
	};
}

export function isVerifiedFiniteStdinHandoff(
	descriptor: unknown,
	producer: unknown,
	received: unknown,
	spawned: unknown,
): boolean {
	if (!isVerifiedStdinProducerWitness(producer)) return false;
	const input = plainFields(received);
	const launch = plainFields(spawned);
	if (
		!input ||
		!launch ||
		input.inputWasEmpty !== producer.inputWasEmpty ||
		input.pid !== producer.receiverPid ||
		input.exactInput !== true ||
		input.eof !== true ||
		launch.pid !== producer.guardianPid ||
		launch.receiverPid !== producer.receiverPid ||
		launch.workerPid !== producer.observerPid
	)
		return false;
	return isLocallyAnonymousStdinChannel(descriptor);
}
