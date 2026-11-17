import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { LIFECYCLE_FAILURE, lifecycleContainsSensitive } from "./aws-secret-input-lifecycle-values";
import type { StdinPrivateChannelEvidence, StdinProducerWitness } from "./aws-secret-input-stdin-metadata";

export interface AwsSecretInputLifecycleDescriptorIdentity {
	fd: number;
	dev: string;
	ino: string;
	target: string;
	kind: "socket" | "pipe" | "file" | "other";
}
export interface AwsSecretInputLifecycleDescriptor extends AwsSecretInputLifecycleDescriptorIdentity {
	measurable: boolean;
	aliases: number[];
}

export function measureAwsSecretInputLifecycleDescriptors(
	descriptors: readonly AwsSecretInputLifecycleDescriptorIdentity[],
): AwsSecretInputLifecycleDescriptor[] {
	const identities = new Map<string, AwsSecretInputLifecycleDescriptorIdentity[]>();
	for (const descriptor of descriptors) {
		const key = `${descriptor.dev}:${descriptor.ino}`;
		identities.set(key, [...(identities.get(key) ?? []), descriptor]);
	}
	const result: AwsSecretInputLifecycleDescriptor[] = [];
	for (const group of identities.values()) {
		const first = group[0]!;
		const kernelTarget = /^(socket|pipe):\[([1-9][0-9]*)\]$/u.exec(first.target);
		const kernelIdentity =
			kernelTarget !== null &&
			kernelTarget[1] === first.kind &&
			kernelTarget[2] === first.ino &&
			group.every(descriptor => descriptor.kind === first.kind && descriptor.target === first.target);
		const measurable =
			first.dev !== "0" &&
			first.ino !== "0" &&
			(first.kind === "socket" || first.kind === "pipe" ? kernelIdentity : group.length === 1);
		if (measurable && kernelIdentity) {
			result.push({ ...first, measurable: true, aliases: group.slice(1).map(descriptor => descriptor.fd) });
		} else {
			for (const descriptor of group) result.push({ ...descriptor, measurable, aliases: [] });
		}
	}
	return result;
}

export function snapshotAwsSecretInputLifecycleDescriptors(pid = process.pid): {
	descriptors: AwsSecretInputLifecycleDescriptor[];
	available: boolean;
} {
	if (pid !== process.pid && process.platform !== "linux") return { descriptors: [], available: false };
	const directory = process.platform === "linux" ? `/proc/${pid}/fd` : "/dev/fd";
	const descriptors: AwsSecretInputLifecycleDescriptorIdentity[] = [];
	const unavailable = new Set<number>();
	let available = true;
	const controlPath = path.join(process.cwd(), "aws-secret-input-lifecycle-control-fd");
	let controlStat: fs.BigIntStats | undefined;
	try {
		controlStat = fs.statSync(controlPath, { bigint: true });
	} catch {}
	try {
		const entries = fs.readdirSync(directory);
		for (const name of entries) {
			const fd = Number(name);
			if (!Number.isSafeInteger(fd) || fd < 3) continue;
			try {
				const filename = path.join(directory, name);
				const stat =
					pid === process.pid ? fs.fstatSync(fd, { bigint: true }) : fs.statSync(filename, { bigint: true });
				let target = "";
				try {
					target = fs.readlinkSync(filename);
				} catch {
					if (process.platform === "linux") throw new Error("LIFECYCLE_DESCRIPTOR_TARGET_UNAVAILABLE");
				}
				if (process.platform === "linux" && fs.readlinkSync(filename) !== target) available = false;
				if (controlStat?.dev === stat.dev && controlStat.ino === stat.ino) target = controlPath;
				descriptors.push({
					fd,
					dev: String(stat.dev),
					ino: String(stat.ino),
					target,
					kind: stat.isSocket() ? "socket" : stat.isFIFO() ? "pipe" : stat.isFile() ? "file" : "other",
				});
			} catch (error) {
				if (
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error.code === "ENOENT" || error.code === "EBADF")
				)
					unavailable.add(fd);
				else available = false;
			}
		}
		// The directory iterator closes its own descriptor before this snapshot can inspect it.
		for (const fd of unavailable) {
			try {
				if (pid === process.pid) fs.fstatSync(fd);
				else fs.statSync(path.join(directory, String(fd)));
				available = false;
			} catch (error) {
				if (
					!error ||
					typeof error !== "object" ||
					!("code" in error) ||
					!["ENOENT", "EBADF"].includes(String(error.code))
				)
					available = false;
			}
		}
	} catch {
		available = false;
	}
	const measured = measureAwsSecretInputLifecycleDescriptors(descriptors);
	if (
		process.platform === "linux" &&
		measured.some(fd => (fd.kind === "socket" || fd.kind === "pipe") && !fd.measurable)
	)
		available = false;
	return { descriptors: measured, available };
}

export function awsSecretInputLifecycleSocketIdentitiesAvailable(
	descriptors: readonly AwsSecretInputLifecycleDescriptor[],
): boolean {
	const sockets = descriptors.filter(descriptor => descriptor.kind === "socket");
	return sockets.length > 0 && sockets.every(descriptor => descriptor.measurable);
}

export interface AwsSecretInputLifecycleEvent {
	kind: string;
	source?: string;
	pid?: number;
	descendantPid?: number;
	inputWasEmpty?: boolean;
	stdinPrivateChannel?: StdinPrivateChannelEvidence;
	stdinProducerWitness?: StdinProducerWitness | null;
	[key: string]: unknown;
}

export interface AwsSecretInputLifecycleControl {
	port: number;
	events: AwsSecretInputLifecycleEvent[];
	readonly clean: boolean;
	waitForEvent(
		kind: string,
		timeoutMs?: number,
		predicate?: (event: AwsSecretInputLifecycleEvent) => boolean,
	): Promise<AwsSecretInputLifecycleEvent>;
	send(command: string): void;
	close(): Promise<void>;
}

export interface AwsSecretInputLifecycleConnection {
	send(event: AwsSecretInputLifecycleEvent): void;
	waitForCommand(command: string): Promise<void>;
	close(): Promise<void>;
}

export async function createAwsSecretInputLifecycleControl(): Promise<AwsSecretInputLifecycleControl> {
	const events: AwsSecretInputLifecycleEvent[] = [];
	const sockets = new Set<net.Socket>();
	const waiters = new Set<{
		kind: string;
		predicate: (event: AwsSecretInputLifecycleEvent) => boolean;
		resolve: (event: AwsSecretInputLifecycleEvent) => void;
		reject: (error: Error) => void;
		timer: Timer;
	}>();
	let leaked = false;
	let invalid = false;
	const publish = (event: AwsSecretInputLifecycleEvent): void => {
		if (lifecycleContainsSensitive(event)) {
			leaked = true;
			return;
		}
		events.push(event);
		for (const waiter of waiters) {
			if (waiter.kind !== event.kind || !waiter.predicate(event)) continue;
			waiters.delete(waiter);
			clearTimeout(waiter.timer);
			waiter.resolve(event);
		}
	};
	const server = net.createServer(socket => {
		sockets.add(socket);
		let pending = "";
		let source: string | undefined;
		let pid: number | undefined;
		socket.setEncoding("utf8");
		socket.on("data", chunk => {
			pending += chunk;
			if (pending.length > 16_384) {
				invalid = true;
				socket.destroy();
				return;
			}
			let newline: number;
			while ((newline = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				try {
					const event: unknown = JSON.parse(line);
					if (
						!event ||
						typeof event !== "object" ||
						Array.isArray(event) ||
						typeof (event as AwsSecretInputLifecycleEvent).kind !== "string"
					) {
						invalid = true;
						continue;
					}
					const receipt = event as AwsSecretInputLifecycleEvent;
					if (typeof receipt.source === "string") source = receipt.source;
					if (typeof receipt.sourcePid === "number") pid = receipt.sourcePid;
					else if (typeof receipt.pid === "number") pid = receipt.pid;
					publish(receipt);
				} catch {
					invalid = true;
					if (lifecycleContainsSensitive(line)) leaked = true;
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			sockets.delete(socket);
			publish({ kind: `${source ?? "unknown"}-control-closed`, source, pid });
		});
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "127.0.0.1", () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	await listening.promise;
	const address = server.address();
	if (!address || typeof address === "string") throw new Error(LIFECYCLE_FAILURE);
	return {
		port: address.port,
		events,
		get clean() {
			return !leaked && !invalid;
		},
		waitForEvent(
			kind: string,
			timeoutMs = 20_000,
			predicate = (_event: AwsSecretInputLifecycleEvent) => true,
		): Promise<AwsSecretInputLifecycleEvent> {
			const existing = events.find(event => event.kind === kind && predicate(event));
			if (existing) return Promise.resolve(existing);
			const { promise, resolve, reject } = Promise.withResolvers<AwsSecretInputLifecycleEvent>();
			const waiter = {
				kind,
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`${LIFECYCLE_FAILURE}: missing ${kind}`));
				}, timeoutMs),
			};
			waiters.add(waiter);
			return promise;
		},
		send(command: string): void {
			for (const socket of sockets) socket.write(`${JSON.stringify({ command })}\n`);
		},
		async close(): Promise<void> {
			for (const waiter of waiters) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error(LIFECYCLE_FAILURE));
			}
			waiters.clear();
			for (const socket of sockets) socket.destroy();
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.close(error => (error ? reject(error) : resolve()));
			await promise;
		},
	};
}

export async function connectAwsSecretInputLifecycleControl(
	port: number,
	source: "worker" | "consumer",
): Promise<AwsSecretInputLifecycleConnection> {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error(LIFECYCLE_FAILURE);
	const socket = net.createConnection({ port, host: "127.0.0.1" });
	const connected = Promise.withResolvers<void>();
	socket.once("connect", connected.resolve);
	socket.once("error", connected.reject);
	await connected.promise;
	socket.on("error", () => {});
	let pending = "";
	const commands = new Set<string>();
	const waiting = new Map<string, (() => void)[]>();
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		pending += chunk;
		let newline: number;
		while ((newline = pending.indexOf("\n")) !== -1) {
			const line = pending.slice(0, newline);
			pending = pending.slice(newline + 1);
			try {
				const value = JSON.parse(line) as { command?: unknown };
				if (typeof value.command !== "string") continue;
				commands.add(value.command);
				for (const resolve of waiting.get(value.command) ?? []) resolve();
				waiting.delete(value.command);
			} catch {}
		}
	});
	return {
		send(event: AwsSecretInputLifecycleEvent): void {
			if (lifecycleContainsSensitive(event)) throw new Error(LIFECYCLE_FAILURE);
			socket.write(`${JSON.stringify({ ...event, source, sourcePid: process.pid })}\n`);
		},
		waitForCommand(command: string): Promise<void> {
			if (commands.has(command)) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.set(command, [...(waiting.get(command) ?? []), resolve]);
			return promise;
		},
		async close(): Promise<void> {
			if (socket.destroyed) return;
			const { promise, resolve } = Promise.withResolvers<void>();
			socket.once("close", resolve);
			socket.end();
			await promise;
		},
	};
}

export interface AwsSecretInputLifecycleProcessIdentity {
	pid: number;
	parentPid: number;
	groupId: number;
	creation: string;
	state: "live" | "stopped" | "zombie";
}

export function awsSecretInputLifecycleProcessIdentity(pid: number): AwsSecretInputLifecycleProcessIdentity | null {
	if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(LIFECYCLE_FAILURE);
	try {
		if (process.platform === "linux") {
			const record = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = record
				.slice(record.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/u);
			if (
				!/^[0-9]+$/u.test(fields[19] ?? "") ||
				!/^[0-9]+$/u.test(fields[1] ?? "") ||
				!/^[0-9]+$/u.test(fields[2] ?? "") ||
				!/^[RSDTtWKPIZXx]$/u.test(fields[0] ?? "")
			)
				throw new Error(LIFECYCLE_FAILURE);
			return {
				pid,
				parentPid: Number(fields[1]),
				groupId: Number(fields[2]),
				creation: fields[19]!,
				state:
					fields[0] === "Z" || fields[0] === "X" || fields[0] === "x"
						? "zombie"
						: fields[0] === "T" || fields[0] === "t"
							? "stopped"
							: "live",
			};
		}
		if (process.platform === "darwin") {
			const library = dlopen("/usr/lib/libproc.dylib", {
				proc_pidinfo: {
					args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
					returns: FFIType.i32,
				},
			});
			try {
				const data = new Uint8Array(136);
				if (library.symbols.proc_pidinfo(pid, 3, 1, ptr(data), data.byteLength) !== data.byteLength) {
					try {
						process.kill(pid, 0);
					} catch (error) {
						if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return null;
						throw error;
					}
					throw new Error(LIFECYCLE_FAILURE);
				}
				const view = new DataView(data.buffer);
				if (view.getUint32(12, true) !== pid || ![1, 2, 3, 4, 5].includes(view.getUint32(4, true)))
					throw new Error(LIFECYCLE_FAILURE);
				return {
					pid,
					parentPid: view.getUint32(16, true),
					groupId: view.getUint32(100, true),
					creation: `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`,
					state: view.getUint32(4, true) === 5 ? "zombie" : view.getUint32(4, true) === 4 ? "stopped" : "live",
				};
			} finally {
				library.close();
			}
		}
		throw new Error(LIFECYCLE_FAILURE);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

export function awsSecretInputLifecycleProcessDisposition(identity: AwsSecretInputLifecycleProcessIdentity) {
	const current = awsSecretInputLifecycleProcessIdentity(identity.pid);
	return {
		pid: identity.pid,
		creation: identity.creation,
		state: current === null ? "reaped" : current.creation !== identity.creation ? "reused" : current.state,
	};
}
