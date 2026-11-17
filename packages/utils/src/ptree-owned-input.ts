import { dlopen, FFIType, ptr } from "bun:ffi";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type NetConnectOpts, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import type { Subprocess } from "bun";
import { TempDir } from "./temp";

export class OwnedInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OwnedInputError";
	}
}

export interface OwnedInputIdentity {
	pid: number;
	groupId: number;
	receiverPid: number | null;
}

export interface OwnedInputCommand {
	argv: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	uid?: number;
	gid?: number;
	argv0?: string;
}

function loadedNativeBindingPath(): string | undefined {
	try {
		for (const [filename, entry] of Object.entries(createRequire(import.meta.url).cache)) {
			if (filename.endsWith(".node") && entry?.exports?.Process === Process) return filename;
		}
	} catch {}
	return undefined;
}

const nativeBindingPath = loadedNativeBindingPath();

function hasOwnedInputPrimitives(): boolean {
	try {
		if (!nativeBindingPath || (process.platform !== "linux" && process.platform !== "darwin")) return false;
		if (
			typeof Process.fromPid !== "function" ||
			!["groupId", "children", "killTree", "terminate", "waitForExit", "status"].every(
				name => typeof (Process.prototype as unknown as Record<string, unknown>)[name] === "function",
			)
		)
			return false;
		const self = Process.fromPid(process.pid);
		const groupId = self?.groupId();
		if (!self || groupId === undefined || groupId === null || self.ppid === null) return false;
		const descriptors = readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd");
		if (process.platform === "linux") {
			const record = readFileSync("/proc/self/stat", "utf8");
			const fields = record
				.slice(record.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/u);
			if (
				!record.startsWith(`${process.pid} (`) ||
				!/^[0-9]+$/u.test(fields[19] ?? "") ||
				!/^[0-9]+$/u.test(fields[1] ?? "") ||
				!/^[0-9]+$/u.test(fields[2] ?? "")
			)
				return false;
		}
		const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"];
		const libcSymbols = {
			fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
			waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		} as const;
		let loaded = false;
		for (const candidate of candidates) {
			try {
				const linuxLibc =
					process.platform === "linux"
						? dlopen(candidate, {
								...libcSymbols,
								prctl: {
									args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
									returns: FFIType.i32,
								},
							})
						: undefined;
				const libc = linuxLibc ?? dlopen(candidate, libcSymbols);
				try {
					let descriptorUsable = false;
					for (const name of descriptors) {
						const descriptor = Number(name);
						if (!Number.isInteger(descriptor) || descriptor < 0) continue;
						const flags = libc.symbols.fcntl(descriptor, 1, 0);
						if (flags < 0) continue;
						if (libc.symbols.fcntl(descriptor, 2, flags) < 0) return false;
						descriptorUsable = true;
						break;
					}
					if (!descriptorUsable) return false;
					if (linuxLibc) {
						const prctl = linuxLibc.symbols.prctl;
						const state = new Int32Array(1);
						if (prctl(37, ptr(state), 0, 0, 0) !== 0 || prctl(36, state[0]!, 0, 0, 0) !== 0) return false;
					}
				} finally {
					libc.close();
				}
				loaded = true;
				break;
			} catch {}
		}
		if (!loaded) return false;
		if (process.platform === "darwin") {
			const libproc = dlopen("/usr/lib/libproc.dylib", {
				proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
				proc_pidinfo: {
					args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
					returns: FFIType.i32,
				},
			});
			try {
				if (libproc.symbols.proc_listpids(2, groupId, null, 0) <= 0) return false;
				const identity = new Uint8Array(136);
				if (
					libproc.symbols.proc_pidinfo(process.pid, 3, 1, ptr(identity), identity.byteLength) !==
					identity.byteLength
				)
					return false;
				const view = new DataView(identity.buffer);
				if (
					view.getUint32(12, true) !== process.pid ||
					view.getUint32(100, true) !== groupId ||
					view.getBigUint64(120, true) <= 0 ||
					view.getBigUint64(128, true) >= 1_000_000
				)
					return false;
			} finally {
				libproc.close();
			}
		}
		return true;
	} catch {
		return false;
	}
}

/** Requires the loaded identity-safe native binding, not an assumed package version. */
export const PTREE_OWNED_INPUT_SUPPORTED = hasOwnedInputPrimitives();

async function terminateDarwinOwnedGroup(anchor: Process, groupId: number): Promise<void> {
	if (anchor.status() !== ProcessStatus.Running || anchor.groupId() !== groupId)
		throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
	const library = dlopen("/usr/lib/libproc.dylib", {
		proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
	});
	const identity = (pid: number): string | null | undefined => {
		const data = new Uint8Array(136);
		if (library.symbols.proc_pidinfo(pid, 3, 1, ptr(data), data.byteLength) !== data.byteLength) {
			try {
				process.kill(pid, 0);
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return null;
				throw error;
			}
			return undefined;
		}
		const view = new DataView(data.buffer);
		if (view.getUint32(12, true) !== pid) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		return `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`;
	};
	try {
		const size = library.symbols.proc_listpids(2, groupId, null, 0);
		if (size <= 0) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		const entries = new Int32Array(Math.ceil(size / 4) + 256);
		const written = library.symbols.proc_listpids(2, groupId, ptr(entries), entries.byteLength);
		if (written <= 0 || written >= entries.byteLength) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		const owned = new Map<number, string | undefined>();
		let identityUnavailable = false;
		for (const pid of entries.subarray(0, Math.floor(written / 4))) {
			if (pid <= 1 || pid === process.pid) continue;
			const creation = identity(pid);
			if (creation === undefined) identityUnavailable = true;
			if (creation !== null) owned.set(pid, creation);
		}
		if (!owned.has(anchor.pid) || anchor.status() !== ProcessStatus.Running || anchor.groupId() !== groupId)
			throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		if (!(await anchor.terminate({ group: true, gracefulMs: -1, timeoutMs: 5000 })))
			throw new OwnedInputError("PTREE_OWNED_INPUT_CLEANUP_FAILED");
		const deadline = Date.now() + 5000;
		while (owned.size > 0) {
			for (const [pid, creation] of owned) {
				const current = identity(pid);
				if (current === null || (creation !== undefined && current !== undefined && current !== creation))
					owned.delete(pid);
			}
			if (owned.size === 0) {
				if (identityUnavailable) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				return;
			}
			if (Date.now() >= deadline) throw new OwnedInputError("PTREE_OWNED_INPUT_CLEANUP_FAILED");
			await Bun.sleep(5);
		}
	} finally {
		library.close();
	}
}

function darwinKeeperScript(bindingPath: string): string {
	return `
import { createRequire } from "node:module";
import { connect } from "node:net";
const { Process: NativeProcess } = createRequire(import.meta.url)(${JSON.stringify(bindingPath)});
const self = NativeProcess.fromPid(process.pid);
const guardianPid = self?.ppid;
const guardian = Number.isSafeInteger(guardianPid) && guardianPid > 1 ? NativeProcess.fromPid(guardianPid) : undefined;
const killOwnedGroup = () => {
	try {
		if (self?.groupId() === guardianPid) process.kill(0, "SIGKILL");
	} finally { process.exit(1); }
};
if (!self || self.groupId() !== guardianPid || self.ppid !== guardianPid || guardian?.groupId() !== guardianPid)
	killOwnedGroup();
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
process.on("SIGHUP", () => {});
let lost = false;
const liveness = connect({ fd: 3, allowHalfOpen: true });
const ownerLost = () => {
	if (lost) return;
	lost = true;
	setTimeout(killOwnedGroup, 5000);
	void guardian.waitForExit({ timeoutMs: 5000 }).then(exited => { if (exited) killOwnedGroup(); }, killOwnedGroup);
};
liveness.on("end", ownerLost);
liveness.on("close", ownerLost);
liveness.on("error", ownerLost);
liveness.on("data", killOwnedGroup);
await Bun.write(Bun.stdout, "ready\\n");
await Promise.withResolvers().promise;
`;
}

function guardianScript(bindingPath: string, startupDirectory: string): string {
	return `
import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { finished } from "node:stream/promises";

const startupDirectory = ${JSON.stringify(startupDirectory)};
let stopping = false;
let started = false;
let completed = false;
let released = false;
let receiver;
let keeper;
let keeperRoot;
let keeperRetiring = false;
let keeperRetirementRequested = false;
const keeperRetirement = Promise.withResolvers();
let root;
let libc;
let libproc;
const ownedDarwinIdentities = new Map();
let cleanup;
let run;
let failure;
let connected = true;
let inputOpen = true;
const control = connect({ fd: 5 });
control.setEncoding("utf8");
let controlBuffer = "";
const release = Promise.withResolvers();
const send = message => {
	const { promise, resolve } = Promise.withResolvers();
	if (!connected || control.destroyed) resolve(false);
	else {
		try { control.write(JSON.stringify(message) + "\\n", error => resolve(!error)); } catch { resolve(false); }
	}
	return promise;
};
const fail = async () => {
	failure = true;
	try { rmSync(startupDirectory, { recursive: true, force: true }); } catch {}
	await send({ type: "failure", code: "PTREE_OWNED_INPUT_CLEANUP_FAILED" });
	try { for (const member of root?.children() ?? []) member.killTree(9); } catch {}
	try {
		// Zero selects the caller's live group, not a remembered process-group ID.
		if (root?.groupId() === process.pid) process.kill(0, "SIGKILL");
	} catch {}
	process.exit(1);
};
process.on("uncaughtException", () => { void fail(); });
process.on("unhandledRejection", () => { void fail(); });

function darwinIdentity(pid) {
	const data = new Uint8Array(136);
	if (libproc.symbols.proc_pidinfo(pid, 3, 1, ptr(data), data.byteLength) !== data.byteLength) {
		try { process.kill(pid, 0); }
		catch (error) { if (error?.code === "ESRCH") return null; throw error; }
		return "";
	}
	const view = new DataView(data.buffer);
	if (view.getUint32(12, true) !== pid) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
	return { creation: view.getBigUint64(120, true) + ":" + view.getBigUint64(128, true), groupId: view.getUint32(100, true) };
}

function darwinReapingPending() {
	for (const [pid, creation] of ownedDarwinIdentities) {
		if (pid === keeper?.pid && !keeperRetiring) continue;
		const current = darwinIdentity(pid);
		if (current === "" || current?.creation === creation) return true;
		ownedDarwinIdentities.delete(pid);
	}
	return false;
}

function groupMembers() {
	if (process.platform === "linux") return root.children();
	const size = libproc.symbols.proc_listpids(2, process.pid, null, 0);
	if (size <= 0) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
	const entries = new Int32Array(Math.ceil(size / 4) + 256);
	const written = libproc.symbols.proc_listpids(2, process.pid, ptr(entries), entries.byteLength);
	if (written <= 0 || written >= entries.byteLength) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
	const members = [];
	for (const pid of entries.subarray(0, Math.floor(written / 4))) {
		if (pid <= 1 || pid === process.pid) continue;
		const identity = darwinIdentity(pid);
		if (identity === "") throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
		if (identity === null || identity.groupId !== process.pid) continue;
		ownedDarwinIdentities.set(pid, identity.creation);
		if (pid === keeper?.pid && !keeperRetiring) continue;
		const member = NativeProcess.fromPid(pid);
		if (member && member.groupId() === process.pid) members.push(member);
	}
	return members;
}

function cleanOwnedChildren(gracefulMs = -1) {
	return cleanup ??= (async () => {
		if (gracefulMs >= 0) {
			for (const member of groupMembers()) member.killTree(15);
			if (gracefulMs > 0) await Bun.sleep(Math.min(gracefulMs, 1000));
		}
		const deadline = Date.now() + 5000;
		let empty = 0;
		while (empty < 2) {
			if (Date.now() >= deadline) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
			const members = groupMembers();
			for (const member of members) member.killTree(9);
			if (members.length === 0 && (process.platform === "linux" || !darwinReapingPending())) empty++;
			else empty = 0;
			await Bun.sleep(5);
		}
		if (keeper) {
			keeperRetirementRequested = true;
			const retired = Promise.withResolvers();
			const timer = setTimeout(() => retired.reject(new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED")),
				Math.max(1, deadline - Date.now()));
			try {
				if (connected) {
					const delivered = await Promise.race([
						send({ type: "keeper-retiring", keeperPid: keeper.pid }), retired.promise,
					]);
					if (delivered) await Promise.race([keeperRetirement.promise, retired.promise]);
					else connected = false;
				}
				keeperRetiring = true;
				if (keeperRoot?.groupId() === process.pid) keeperRoot.killTree(9);
				await Promise.race([keeper.exited, retired.promise]);
				while (darwinReapingPending()) {
					if (Date.now() >= deadline) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
					await Bun.sleep(5);
				}
			} finally { clearTimeout(timer); }
		}
	})();
}

function stop(gracefulMs = -1) {
	if (completed) {
		if (!connected) release.resolve();
		return;
	}
	stopping = true;
	if (root) void cleanOwnedChildren(gracefulMs).catch(fail);
	if (!started && !run) {
		run = finish(null, null, Promise.resolve());
		void run.catch(fail);
	}
}
control.on("end", () => { connected = false; keeperRetirement.resolve(); stop(); });
control.on("close", () => { connected = false; keeperRetirement.resolve(); stop(); });
control.on("error", () => { connected = false; keeperRetirement.resolve(); stop(); });
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop());
process.on("SIGHUP", () => stop());

async function relay(stream, descriptor) {
	const writer = connect({ fd: descriptor });
	writer.on("error", () => stop());
	for await (const chunk of stream) {
		if (writer.destroyed) continue;
		const { promise, resolve } = Promise.withResolvers();
		writer.write(chunk, error => { if (error) stop(); resolve(); });
		await promise;
	}
	writer.end();
	await finished(writer).catch(() => stop());
}

async function finish(exitCode, signalCode, output) {
	await cleanOwnedChildren();
	await output;
	if (receiver) await receiver.exited;
	if (process.platform === "linux") {
		let pid;
		do { pid = libc.symbols.waitpid(-1, null, 1); } while (pid > 0);
		if (pid === 0) throw new Error("PTREE_OWNED_INPUT_CLEANUP_FAILED");
	}
	rmSync(startupDirectory, { recursive: true, force: true });
	completed = true;
	if (inputOpen) { inputOpen = false; try { closeSync(0); } catch {} }
	if (connected) {
		await send({ type: "complete", exitCode, signalCode });
		if (connected && !released) await release.promise;
	}
	process.exit(failure ? 1 : 0);
}

let NativeProcess;
try {
	({ Process: NativeProcess } = createRequire(import.meta.url)(${JSON.stringify(bindingPath)}));
	root = NativeProcess.fromPid(process.pid);
	if (!root || root.groupId() !== process.pid) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
	for (const candidate of process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"] : ["libc.so.6", "libc.so"]) {
		try {
			libc = dlopen(candidate, {
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
				waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
				...(process.platform === "linux" ? {
					prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
				} : {}),
			});
			break;
		} catch {}
	}
	if (!libc) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
	if (process.platform === "linux") {
		if (libc.symbols.prctl(36, 1, 0, 0, 0) !== 0) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
	} else {
		libproc = dlopen("/usr/lib/libproc.dylib", {
			proc_listpids: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
			proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
		});
	}
	const closePrivateDescriptorsOnExec = () => {
		for (const name of readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")) {
			const descriptor = Number(name);
			if (!Number.isInteger(descriptor) || descriptor < 3) continue;
			const flags = libc.symbols.fcntl(descriptor, 1, 0);
			if (flags >= 0 && libc.symbols.fcntl(descriptor, 2, flags | 1) < 0)
				throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
		}
	};
	groupMembers();
	const messageReceived = message => {
		if (message?.type === "keeper-retirement-ack") {
			if (!keeperRetirementRequested || message.keeperPid !== keeper?.pid ||
				Object.keys(message).length !== 2) { void fail(); return; }
			keeperRetirement.resolve();
			return;
		}
		if (message?.type === "release" && completed) {
			released = true;
			release.resolve();
			return;
		}
		if (message?.type === "stop") { stop(message.gracefulMs); return; }
		if (message?.type !== "start" || started || stopping || !connected) return;
		started = true;
		run = (async () => {
			closePrivateDescriptorsOnExec();
			receiver = Bun.spawn(message.command.argv, {
				cwd: message.command.cwd,
				env: message.command.env,
				uid: message.command.uid,
				gid: message.command.gid,
				argv0: message.command.argv0,
				stdio: [0, "pipe", "pipe"],
				windowsHide: true,
			});
			if (process.platform === "darwin") groupMembers();
			closeSync(0);
			inputOpen = false;
			await send({ type: "started", receiverPid: receiver.pid });
			const output = Promise.all([relay(receiver.stdout, 3), relay(receiver.stderr, 4)]);
			void output.catch(() => stop());
			await receiver.exited;
			await finish(receiver.exitCode, receiver.signalCode, output);
		})();
		void run.catch(fail);
	};
	control.on("data", chunk => {
		controlBuffer += chunk;
		if (controlBuffer.length > 1024 * 1024) { void fail(); return; }
		let newline;
		while ((newline = controlBuffer.indexOf("\\n")) !== -1) {
			const frame = controlBuffer.slice(0, newline);
			controlBuffer = controlBuffer.slice(newline + 1);
			try { messageReceived(JSON.parse(frame)); } catch { void fail(); }
		}
	});
	if (process.platform === "darwin" && connected && !stopping) {
		closePrivateDescriptorsOnExec();
		keeper = Bun.spawn([
			process.execPath, "--cwd", startupDirectory, "--no-env-file", "--no-install",
			"-e", ${JSON.stringify(darwinKeeperScript(bindingPath))},
		], { cwd: startupDirectory, env: process.env, stdio: ["ignore", "pipe", "ignore", 6], windowsHide: true });
		keeperRoot = NativeProcess.fromPid(keeper.pid);
		if (!keeperRoot || keeperRoot.ppid !== process.pid || keeperRoot.groupId() !== process.pid)
			throw new Error("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		closeSync(6);
		void keeper.exited.then(() => { if (!keeperRetiring && !failure) void fail(); }, fail);
		const reader = keeper.stdout.getReader();
		const deadline = Promise.withResolvers();
		const timer = setTimeout(() => deadline.reject(new Error("PTREE_OWNED_INPUT_OWNERSHIP_LOST")), 5000);
		try {
			const ready = await Promise.race([reader.read(), deadline.promise]);
			if (!stopping && (ready.done || new TextDecoder().decode(ready.value) !== "ready\\n" ||
				keeperRoot.ppid !== process.pid || keeperRoot.groupId() !== process.pid))
				throw new Error("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		} finally {
			clearTimeout(timer);
			reader.releaseLock();
		}
	}
	if (!connected) stop();
	else if (!stopping) {
		await send({ type: "ready", ...(keeper ? { keeperPid: keeper.pid } : {}) });
	}
} catch {
	await fail();
}
`;
}

type GuardianProcess = Subprocess<"pipe", "pipe", "pipe">;

export class OwnedInputSupervisor {
	readonly proc: GuardianProcess;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number | null>;
	readonly stopped: Promise<void>;
	readonly identity: OwnedInputIdentity;
	#anchor: Process | null = null;
	#receiverAnchor: Process | null = null;
	#keeperAnchor: Process | null = null;
	#keeperLiveness?: Socket;
	#keeperGone = Promise.withResolvers<void>();
	#keeperRetirementAcknowledged = false;
	#ready = Promise.withResolvers<void>();
	#started = Promise.withResolvers<void>();
	#finished = Promise.withResolvers<number | null>();
	#stopRequested = Promise.withResolvers<void>();
	#out: Socket;
	#err: Socket;
	#command: OwnedInputCommand;
	#control?: Socket;
	#controlBuffer = "";
	#stopping = false;
	#released = false;
	#releaseEnabled = false;
	#complete = false;
	#failed = false;
	#cleanupAcknowledged = false;
	#receiverExitCode: number | null = null;
	#receiverSignalCode: NodeJS.Signals | null = null;
	#stopTimer?: NodeJS.Timeout;
	#startupDirectory?: TempDir;
	#input?: Uint8Array;
	#inputDone?: Promise<void>;
	#inputFailed = false;
	#inputSettled = false;

	constructor(command: OwnedInputCommand, input: Uint8Array) {
		if (!PTREE_OWNED_INPUT_SUPPORTED || !nativeBindingPath) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
		this.#command = command;
		this.#input = input;
		this.exited = this.#finished.promise;
		this.stopped = this.#stopRequested.promise;
		void this.exited.catch(() => {});
		void this.#ready.promise.catch(() => {});
		void this.#started.promise.catch(() => {});
		try {
			// Bun evaluates cwd preloads before the guardian entrypoint.
			this.#startupDirectory = TempDir.createSync(join(resolve(tmpdir()), "omp-owned-input-"));
			const startupDirectory = this.#startupDirectory.path();
			this.proc = Bun.spawn(
				[
					process.execPath,
					"--cwd",
					startupDirectory,
					"--no-env-file",
					"--no-install",
					"-e",
					guardianScript(nativeBindingPath, startupDirectory),
				],
				{
					cwd: startupDirectory,
					env: {
						HOME: startupDirectory,
						USERPROFILE: startupDirectory,
						XDG_CONFIG_HOME: startupDirectory,
						XDG_CACHE_HOME: startupDirectory,
						BUN_INSTALL: startupDirectory,
						TMPDIR: startupDirectory,
						BUN_OPTIONS: "",
						NODE_OPTIONS: "",
						BUN_BE_BUN: "1",
						BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
						DO_NOT_TRACK: "1",
					},
					stdio:
						process.platform === "darwin"
							? ["pipe", "pipe", "pipe", "socket-fd", "socket-fd", "socket-fd", "socket-fd"]
							: ["pipe", "pipe", "pipe", "socket-fd", "socket-fd", "socket-fd"],
					detached: true,
					windowsHide: true,
				},
			);
		} catch {
			try {
				this.#removeStartupDirectory();
			} catch {}
			throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
		}
		void this.proc.exited
			.finally(() => {
				try {
					this.#removeStartupDirectory();
				} catch {
					void this.#fail("PTREE_OWNED_INPUT_CLEANUP_FAILED");
				}
			})
			.catch(() => {});
		this.identity = { pid: this.proc.pid, groupId: this.proc.pid, receiverPid: null };
		this.#anchor = Process.fromPid(this.proc.pid);
		const descriptors = this.proc.stdio;
		if (
			typeof descriptors[3] !== "number" ||
			typeof descriptors[4] !== "number" ||
			typeof descriptors[5] !== "number" ||
			(process.platform === "darwin" && typeof descriptors[6] !== "number")
		) {
			void this.#fail("PTREE_OWNED_INPUT_UNSUPPORTED");
			throw new OwnedInputError("PTREE_OWNED_INPUT_UNSUPPORTED");
		}
		// Bun adopts connected descriptors through connect({ fd }), outside Node's typed options.
		this.#out = connect({ fd: descriptors[3] } as NetConnectOpts);
		this.#err = connect({ fd: descriptors[4] } as NetConnectOpts);
		this.#control = connect({ fd: descriptors[5] } as NetConnectOpts);
		if (process.platform === "darwin") {
			this.#keeperLiveness = connect({ fd: descriptors[6], allowHalfOpen: true } as NetConnectOpts);
			this.#keeperLiveness.on("end", () => {
				if (!this.#keeperRetirementAcknowledged && !this.#failed) {
					void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
					return;
				}
				if (!this.#keeperLiveness?.writableEnded) this.#keeperLiveness?.end();
			});
			this.#keeperLiveness.on("close", () => {
				if (this.#keeperRetirementAcknowledged || this.#failed) this.#keeperGone.resolve();
				else void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			});
			this.#keeperLiveness.on("error", error => {
				const reset = Object.getOwnPropertyDescriptor(error, "code")?.value === "ECONNRESET";
				if (this.#failed || (this.#keeperRetirementAcknowledged && reset)) return;
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			});
		}
		this.#control.setEncoding("utf8");
		this.#control.on("data", chunk => {
			this.#controlBuffer += chunk;
			if (this.#controlBuffer.length > 4096) {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				return;
			}
			let newline: number;
			while ((newline = this.#controlBuffer.indexOf("\n")) !== -1) {
				const frame = this.#controlBuffer.slice(0, newline);
				this.#controlBuffer = this.#controlBuffer.slice(newline + 1);
				try {
					this.#message(JSON.parse(frame));
				} catch {
					void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				}
			}
		});
		this.#control.on("end", () => {
			if (!this.#released) void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		});
		this.#control.on("error", () => {
			if (!this.#released) void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		});
		// Node and DOM declare incompatible BYOB reader overloads for Bun's web streams.
		this.stdout = Readable.toWeb(this.#out) as unknown as ReadableStream<Uint8Array>;
		this.stderr = Readable.toWeb(this.#err) as unknown as ReadableStream<Uint8Array>;
		void this.proc.stdout.pipeTo(new WritableStream({ write() {} })).catch(() => {});
		void this.proc.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => {});
		void this.proc.exited.then(
			async code => {
				if (this.#complete && this.#released && code === 0 && this.proc.signalCode === null && !this.#failed) {
					await this.#inputDone;
					await this.#joinKeeper();
					if (this.#failed) return;
					this.#cleanupAcknowledged = true;
					clearTimeout(this.#stopTimer);
					this.#control?.destroy();
					this.#keeperLiveness?.destroy();
					this.#keeperAnchor = null;
					this.#anchor = null;
					this.#receiverAnchor = null;
					this.#finished.resolve(this.#receiverExitCode);
				} else {
					void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				}
			},
			() => this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST"),
		);
		if (!this.#anchor || this.#anchor.ppid !== process.pid || this.#anchor.groupId() !== this.proc.pid) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		}
	}

	get exitCode(): number | null {
		return this.#receiverExitCode;
	}
	get signalCode(): NodeJS.Signals | null {
		return this.#receiverSignalCode;
	}
	get cleanupAcknowledged(): boolean {
		return this.#cleanupAcknowledged;
	}

	async start(): Promise<void> {
		await this.#ready.promise;
		if (!this.#stopping) this.#send({ type: "start", command: this.#command });
		await this.#started.promise;
		if (!this.#stopping) this.#inputDone ??= Promise.resolve().then(() => this.#writeInput());
	}

	acknowledgeRegistration(): void {
		this.#releaseEnabled = true;
		if (this.#complete && this.#inputSettled && !this.#released) {
			try {
				this.#send({ type: "release" });
				this.#released = true;
			} catch {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			}
		}
	}

	stop(gracefulMs = -1): Promise<boolean> {
		if (this.#cleanupAcknowledged) return this.exited.then(() => true);
		if (!this.#stopping) {
			this.#stopping = true;
			this.#stopRequested.resolve();
			this.#stopTimer = setTimeout(() => {
				void this.#fail("PTREE_OWNED_INPUT_CLEANUP_FAILED");
			}, 6000);
			this.#stopTimer.unref?.();
			try {
				this.#send({ type: "stop", gracefulMs });
			} catch {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			}
		}
		return this.exited.then(() => this.#cleanupAcknowledged);
	}

	#send(message: unknown): void {
		if (!this.#control || this.#control.destroyed) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
		this.#control.write(`${JSON.stringify(message)}\n`);
	}

	#pinKeeper(pid: unknown): boolean {
		if (
			!Number.isSafeInteger(pid) ||
			(pid as number) <= 1 ||
			(this.#keeperAnchor && this.#keeperAnchor.pid !== pid)
		) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			return false;
		}
		const keeper = this.#keeperAnchor ?? Process.fromPid(pid as number);
		if (!keeper) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			return false;
		}
		if (keeper.status() !== ProcessStatus.Running) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			return false;
		}
		if (keeper.ppid !== this.proc.pid) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			return false;
		}
		if (keeper.groupId() !== this.proc.pid) {
			void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			return false;
		}
		this.#keeperAnchor = keeper;
		return true;
	}

	#message(message: unknown): void {
		if (this.#failed || !message || typeof message !== "object") return;
		const value = message as Record<string, unknown>;
		if (value.type === "keeper-retiring") {
			if (
				process.platform !== "darwin" ||
				this.#keeperRetirementAcknowledged ||
				this.#complete ||
				Object.keys(value).length !== 2 ||
				!this.#anchor ||
				this.#anchor.status() !== ProcessStatus.Running ||
				this.#anchor.ppid !== process.pid ||
				this.#anchor.groupId() !== this.proc.pid
			) {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				return;
			}
			if (!this.#pinKeeper(value.keeperPid)) return;
			if (
				this.#anchor.status() !== ProcessStatus.Running ||
				this.#anchor.ppid !== process.pid ||
				this.#anchor.groupId() !== this.proc.pid
			) {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				return;
			}
			this.#keeperRetirementAcknowledged = true;
			this.#send({ type: "keeper-retirement-ack", keeperPid: value.keeperPid });
			return;
		}
		if (value.type === "ready") {
			if (process.platform === "darwin" && !this.#pinKeeper(value.keeperPid)) return;
			this.#ready.resolve();
			return;
		}
		if (value.type === "started" && Number.isSafeInteger(value.receiverPid) && (value.receiverPid as number) > 1) {
			const receiver = Process.fromPid(value.receiverPid as number);
			if (
				receiver?.status() === ProcessStatus.Running &&
				(receiver.ppid !== this.proc.pid || receiver.groupId() !== this.proc.pid)
			) {
				void this.#fail("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
				return;
			}
			this.#receiverAnchor = receiver;
			this.identity.receiverPid = value.receiverPid as number;
			this.#started.resolve();
			this.#inputDone ??= Promise.resolve().then(() => this.#writeInput());
			return;
		}
		if (
			value.type === "complete" &&
			(value.exitCode === null || Number.isInteger(value.exitCode)) &&
			(value.signalCode === null ||
				(typeof value.signalCode === "string" && /^SIG[A-Z0-9]+$/.test(value.signalCode)))
		) {
			this.#receiverExitCode = value.exitCode as number | null;
			this.#receiverSignalCode = value.signalCode as NodeJS.Signals | null;
			this.#complete = true;
			this.#ready.resolve();
			this.#started.resolve();
			void this.#finishInputAndRelease();
			return;
		}
		void this.#fail(
			value.type === "failure" ? "PTREE_OWNED_INPUT_CLEANUP_FAILED" : "PTREE_OWNED_INPUT_OWNERSHIP_LOST",
		);
	}

	async #writeInput(): Promise<void> {
		const input = this.#input;
		try {
			if (!input) throw new OwnedInputError("PTREE_OWNED_INPUT_OWNERSHIP_LOST");
			const writer = this.proc.stdin;
			for (let offset = 0; offset < input.byteLength && !this.#stopping; offset += 4096) {
				const chunk = input.subarray(offset, Math.min(offset + 4096, input.byteLength));
				if ((await writer.write(chunk)) !== chunk.byteLength)
					throw new OwnedInputError("PTREE_OWNED_INPUT_WRITE_FAILED");
				await writer.flush();
			}
		} catch (error) {
			this.#inputFailed = true;
			const brokenPipe = error !== null && typeof error === "object" && "code" in error && error.code === "EPIPE";
			if (!brokenPipe && !this.#stopping) void this.#fail("PTREE_OWNED_INPUT_WRITE_FAILED");
		} finally {
			try {
				await this.proc.stdin.end();
			} catch {
				this.#inputFailed = true;
			}
			this.#input = undefined;
		}
	}

	async #finishInputAndRelease(): Promise<void> {
		await (this.#inputDone ??= Promise.resolve().then(() => this.#writeInput()));
		if (this.#failed) return;
		if (this.#inputFailed && !this.#stopping && this.#receiverExitCode === 0 && this.#receiverSignalCode === null) {
			await this.#fail("PTREE_OWNED_INPUT_WRITE_FAILED");
			return;
		}
		try {
			await this.#joinKeeper();
		} catch {
			await this.#fail("PTREE_OWNED_INPUT_CLEANUP_FAILED");
			return;
		}
		if (this.#failed) return;
		this.#inputSettled = true;
		if (this.#releaseEnabled) this.acknowledgeRegistration();
	}
	async #joinKeeper(): Promise<void> {
		if (!this.#keeperLiveness) return;
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(() => deadline.reject(new OwnedInputError("PTREE_OWNED_INPUT_CLEANUP_FAILED")), 6000);
		try {
			await Promise.race([this.#keeperGone.promise, deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#removeStartupDirectory(): void {
		if (!this.#startupDirectory) return;
		this.#startupDirectory.removeSync();
		this.#startupDirectory = undefined;
	}

	async #fail(code: string): Promise<void> {
		if (this.#failed) return;
		this.#failed = true;
		this.#stopping = true;
		this.#stopRequested.resolve();
		clearTimeout(this.#stopTimer);
		try {
			this.#control?.end();
		} catch {}
		try {
			if (process.platform === "darwin") {
				const anchor = [this.#keeperAnchor, this.#anchor, this.#receiverAnchor].find(
					candidate => candidate?.status() === ProcessStatus.Running,
				);
				if (anchor) await terminateDarwinOwnedGroup(anchor, this.identity.groupId);
			} else {
				await this.#anchor?.terminate({ group: true, gracefulMs: -1, timeoutMs: 5000 });
			}
		} catch {}
		try {
			this.#keeperLiveness?.end();
		} catch {}
		const guardianExit = Promise.withResolvers<void>();
		const guardianTimer = setTimeout(guardianExit.resolve, 6000);
		try {
			await Promise.race([this.proc.exited.catch(() => {}), guardianExit.promise]);
		} finally {
			clearTimeout(guardianTimer);
		}
		try {
			await this.#receiverAnchor?.terminate({ group: true, gracefulMs: -1, timeoutMs: 5000 });
		} catch {}
		try {
			await (this.#inputDone ??= Promise.resolve().then(() => this.#writeInput()));
		} catch {}
		try {
			await this.#joinKeeper();
		} catch {}
		this.#keeperLiveness?.destroy();
		this.#keeperAnchor = null;
		this.#control?.destroy();
		this.#out?.destroy();
		this.#err?.destroy();
		this.#anchor = null;
		this.#receiverAnchor = null;
		try {
			this.#removeStartupDirectory();
		} catch {}
		const error = new OwnedInputError(code);
		this.#ready.reject(error);
		this.#started.reject(error);
		this.#finished.reject(error);
	}
}
