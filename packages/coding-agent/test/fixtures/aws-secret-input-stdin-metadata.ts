import type * as BunFfi from "bun:ffi";
import { fstatSync, readlinkSync, readSync, statSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
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
	fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
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

function verifyStdinPeer(writer: number, reader: number): boolean {
	const metadata = openSocketMetadataLibrary();
	if (!metadata) return false;
	const { library } = metadata;
	const flags = library.symbols.fcntl(reader, 3, 0);
	const nonblocking = process.platform === "darwin" ? 4 : 0x800;
	const probe = new Uint8Array([0x4f, 0x4d, 0x50, 0x50]);
	const received = new Uint8Array(probe.byteLength);
	let verified = false;
	try {
		if (flags >= 0 && library.symbols.fcntl(reader, 4, flags | nonblocking) === 0) {
			verified =
				writeSync(writer, probe) === probe.byteLength &&
				readSync(reader, received, 0, received.byteLength, null) === probe.byteLength &&
				received.every((byte, index) => byte === probe[index]);
		}
	} catch {
		verified = false;
	} finally {
		if (flags < 0 || library.symbols.fcntl(reader, 4, flags) !== 0) verified = false;
		library.close();
	}
	return verified;
}

export interface StdinProducerWitness {
	origin: "observed-anonymous-stdin-descriptor";
	observerPid: number;
	guardianPid: number;
	receiverPid: number;
	stdinPrivateChannel: StdinPrivateChannelEvidence;
	stdinDev: string | null;
	stdinIno: string | null;
	writerDev: string | null;
	writerIno: string | null;
	writerPeerVerified: boolean;
	inputUnmodified: boolean;
	inputWasEmpty: boolean;
}

const PRODUCER_KEYS = [
	"origin",
	"observerPid",
	"guardianPid",
	"receiverPid",
	"stdinPrivateChannel",
	"stdinDev",
	"stdinIno",
	"writerDev",
	"writerIno",
	"writerPeerVerified",
	"inputUnmodified",
	"inputWasEmpty",
] as const;

function processId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 0x7fffffff;
}

export function isVerifiedStdinProducerWitness(value: unknown): value is StdinProducerWitness {
	const fields = plainFields(value, PRODUCER_KEYS);
	return (
		fields !== undefined &&
		fields.origin === "observed-anonymous-stdin-descriptor" &&
		isVerifiedStdinPrivateChannelEvidence(fields.stdinPrivateChannel) &&
		typeof fields.stdinDev === "string" &&
		typeof fields.stdinIno === "string" &&
		(process.platform !== "linux" || (fields.stdinDev !== "0" && fields.stdinIno !== "0")) &&
		typeof fields.writerDev === "string" &&
		typeof fields.writerIno === "string" &&
		fields.writerPeerVerified === true &&
		(process.platform !== "linux" ||
			(fields.writerDev !== "0" &&
				fields.writerIno !== "0" &&
				(fields.writerDev !== fields.stdinDev || fields.writerIno !== fields.stdinIno))) &&
		fields.inputUnmodified === true &&
		typeof fields.inputWasEmpty === "boolean" &&
		processId(fields.observerPid) &&
		processId(fields.guardianPid) &&
		processId(fields.receiverPid) &&
		fields.observerPid !== fields.guardianPid &&
		fields.observerPid !== fields.receiverPid &&
		fields.guardianPid !== fields.receiverPid
	);
}

export interface StdinProducerWitnessObserver {
	begin(input: Uint8Array): void;
	captureSpawn(options: unknown): (guardianPid: number) => void;
	isPrivateStdinWrite(socket: object, chunk: unknown): boolean;
	witnessFor(guardianPid: number, receiverPid: number): StdinProducerWitness | undefined;
	end(): void;
}

export function createStdinProducerWitnessObserver(): StdinProducerWitnessObserver {
	let ownedInput: Uint8Array | undefined;
	let snapshot: Uint8Array | undefined;
	const originalConnect = Socket.prototype.connect;
	const candidates = new Map<Socket, number>();
	let writer: Socket | undefined;
	const observed = new Map<number, Omit<StdinProducerWitness, "receiverPid">>();
	return {
		begin(input) {
			if (!(input instanceof Uint8Array) || ownedInput !== undefined)
				throw new Error("STDIN_PRODUCER_OBSERVER_INVALID_INPUT");
			snapshot = Uint8Array.from(input);
			ownedInput = input;
			Socket.prototype.connect = new Proxy(originalConnect, {
				apply(target, receiver, args) {
					const socket = Reflect.apply(target, receiver, args) as Socket;
					const options = Array.isArray(args[0]) ? args[0][0] : args[0];
					const fd = plainFields(options)?.fd;
					if (typeof fd === "number" && isVerifiedStdinPrivateChannelEvidence(inspectStdinPrivateChannel(fd))) {
						candidates.set(socket, fd);
					}
					return socket;
				},
			});
		},
		captureSpawn(options) {
			const fields = plainFields(options);
			const stdio = fields?.stdio;
			const supplied = Array.isArray(stdio) ? Object.getOwnPropertyDescriptor(stdio, "0")?.value : fields?.stdin;
			const stdinPrivateChannel = inspectStdinPrivateChannel(typeof supplied === "number" ? supplied : -1);
			let stdinDev: string | null = null;
			let stdinIno: string | null = null;
			try {
				const stat = fstatSync(supplied, { bigint: true });
				stdinDev = String(stat.dev);
				stdinIno = String(stat.ino);
			} catch {}
			let writerDev: string | null = null;
			let writerIno: string | null = null;
			let writerPeerVerified = false;
			if (typeof supplied === "number" && candidates.size === 1) {
				const [socket, fd] = candidates.entries().next().value!;
				writerPeerVerified = verifyStdinPeer(fd, supplied);
				if (writerPeerVerified) {
					writer = socket;
					const stat = fstatSync(fd, { bigint: true });
					writerDev = String(stat.dev);
					writerIno = String(stat.ino);
				}
			}
			if (
				ownedInput !== undefined &&
				(!writerPeerVerified || !isVerifiedStdinPrivateChannelEvidence(stdinPrivateChannel))
			)
				throw new Error("STDIN_PRODUCER_PEER_UNVERIFIED");
			let inputUnmodified =
				ownedInput !== undefined && snapshot !== undefined && ownedInput.byteLength === snapshot.byteLength;
			if (inputUnmodified) {
				for (let index = 0; index < ownedInput!.byteLength; index++) {
					if (ownedInput![index] !== snapshot![index]) {
						inputUnmodified = false;
						break;
					}
				}
			}
			const observation: Omit<StdinProducerWitness, "receiverPid" | "guardianPid"> = {
				origin: "observed-anonymous-stdin-descriptor",
				observerPid: process.pid,
				stdinPrivateChannel,
				stdinDev,
				stdinIno,
				writerDev,
				writerIno,
				writerPeerVerified,
				inputUnmodified,
				inputWasEmpty: ownedInput?.byteLength === 0,
			};
			return guardianPid => {
				if (processId(guardianPid)) observed.set(guardianPid, { ...observation, guardianPid });
			};
		},
		isPrivateStdinWrite(socket, chunk) {
			return (
				socket === writer &&
				ownedInput !== undefined &&
				chunk instanceof Uint8Array &&
				chunk.buffer === ownedInput.buffer &&
				chunk.byteLength > 0 &&
				chunk.byteLength <= 16_384 &&
				chunk.byteOffset >= ownedInput.byteOffset &&
				chunk.byteOffset + chunk.byteLength <= ownedInput.byteOffset + ownedInput.byteLength
			);
		},
		witnessFor(guardianPid, receiverPid) {
			const observation = observed.get(guardianPid);
			if (!observation || !processId(receiverPid)) return undefined;
			return { ...observation, receiverPid };
		},
		end() {
			try {
				snapshot?.fill(0);
			} finally {
				snapshot = undefined;
				writer = undefined;
				candidates.clear();
				ownedInput = undefined;
				observed.clear();
				Socket.prototype.connect = originalConnect;
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
		launch.workerPid !== producer.observerPid ||
		(process.platform === "linux" && (input.stdinDev !== producer.stdinDev || input.stdinIno !== producer.stdinIno))
	)
		return false;
	return isLocallyAnonymousStdinChannel(descriptor);
}
