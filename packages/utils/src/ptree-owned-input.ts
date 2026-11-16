import { dlopen, FFIType, ptr } from "bun:ffi";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, type NetConnectOpts, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { Process } from "@oh-my-pi/pi-natives";
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
			});
			try {
				if (libproc.symbols.proc_listpids(2, groupId, null, 0) <= 0) return false;
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
let root;
let libc;
let libproc;
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
			if (members.length === 0) empty++;
			else empty = 0;
			await Bun.sleep(5);
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
control.on("end", () => { connected = false; stop(); });
control.on("close", () => { connected = false; stop(); });
control.on("error", () => { connected = false; stop(); });
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
		});
	}
	groupMembers();
	const messageReceived = message => {
		if (message?.type === "release" && completed) {
			released = true;
			release.resolve();
			return;
		}
		if (message?.type === "stop") { stop(message.gracefulMs); return; }
		if (message?.type !== "start" || started || stopping || !connected) return;
		started = true;
		run = (async () => {
			const descriptors = readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd");
			for (const name of descriptors) {
				const descriptor = Number(name);
				if (!Number.isInteger(descriptor) || descriptor < 3) continue;
				const flags = libc.symbols.fcntl(descriptor, 1, 0);
				if (flags >= 0 && libc.symbols.fcntl(descriptor, 2, flags | 1) < 0) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
			}
			receiver = Bun.spawn(message.command.argv, {
				cwd: message.command.cwd,
				env: message.command.env,
				uid: message.command.uid,
				gid: message.command.gid,
				argv0: message.command.argv0,
				stdio: [0, "pipe", "pipe"],
				windowsHide: true,
			});
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
	if (!connected) stop();
	else await send({ type: "ready" });
} catch {
	await fail();
}
`;
}

type GuardianProcess = Subprocess<Uint8Array, "pipe", "pipe">;

export class OwnedInputSupervisor {
	readonly proc: GuardianProcess;
	readonly stdout: ReadableStream<Uint8Array>;
	readonly stderr: ReadableStream<Uint8Array>;
	readonly exited: Promise<number | null>;
	readonly stopped: Promise<void>;
	readonly identity: OwnedInputIdentity;
	#anchor: Process | null = null;
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

	constructor(command: OwnedInputCommand, input: Uint8Array) {
		if (!PTREE_OWNED_INPUT_SUPPORTED || !nativeBindingPath) throw new Error("PTREE_OWNED_INPUT_UNSUPPORTED");
		this.#command = command;
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
					stdio: [input, "pipe", "pipe", "socket-fd", "socket-fd", "socket-fd"],
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
			typeof descriptors[5] !== "number"
		) {
			void this.#fail("PTREE_OWNED_INPUT_UNSUPPORTED");
			throw new OwnedInputError("PTREE_OWNED_INPUT_UNSUPPORTED");
		}
		// Bun adopts connected descriptors through connect({ fd }), outside Node's typed options.
		this.#out = connect({ fd: descriptors[3] } as NetConnectOpts);
		this.#err = connect({ fd: descriptors[4] } as NetConnectOpts);
		this.#control = connect({ fd: descriptors[5] } as NetConnectOpts);
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
			code => {
				if (this.#complete && this.#released && code === 0 && this.proc.signalCode === null && !this.#failed) {
					this.#cleanupAcknowledged = true;
					clearTimeout(this.#stopTimer);
					this.#control?.destroy();
					this.#anchor = null;
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
	}

	acknowledgeRegistration(): void {
		this.#releaseEnabled = true;
		if (this.#complete && !this.#released) {
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

	#message(message: unknown): void {
		if (this.#failed || !message || typeof message !== "object") return;
		const value = message as Record<string, unknown>;
		if (value.type === "ready") {
			this.#ready.resolve();
			return;
		}
		if (value.type === "started" && Number.isSafeInteger(value.receiverPid) && (value.receiverPid as number) > 1) {
			this.identity.receiverPid = value.receiverPid as number;
			this.#started.resolve();
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
			this.#started.resolve();
			if (this.#releaseEnabled) this.acknowledgeRegistration();
			return;
		}
		void this.#fail(
			value.type === "failure" ? "PTREE_OWNED_INPUT_CLEANUP_FAILED" : "PTREE_OWNED_INPUT_OWNERSHIP_LOST",
		);
	}

	#removeStartupDirectory(): void {
		if (!this.#startupDirectory) return;
		this.#startupDirectory.removeSync();
		this.#startupDirectory = undefined;
	}

	async #fail(code: string): Promise<void> {
		if (this.#failed) return;
		this.#failed = true;
		this.#stopRequested.resolve();
		clearTimeout(this.#stopTimer);
		try {
			if (await this.#anchor?.terminate({ group: true, gracefulMs: -1, timeoutMs: 5000 })) {
				await this.proc.exited.catch(() => {});
			}
		} catch {}
		this.#control?.destroy();
		this.#out?.destroy();
		this.#err?.destroy();
		this.#anchor = null;
		try {
			this.#removeStartupDirectory();
		} catch {}
		const error = new OwnedInputError(code);
		this.#ready.reject(error);
		this.#started.reject(error);
		this.#finished.reject(error);
	}
}
