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
	const aliases = new Map<string, number[]>();
	for (const descriptor of descriptors) {
		const key = `${descriptor.dev}:${descriptor.ino}`;
		const group = aliases.get(key) ?? [];
		group.push(descriptor.fd);
		aliases.set(key, group);
	}
	return descriptors.map(descriptor => ({
		...descriptor,
		aliases: aliases.get(`${descriptor.dev}:${descriptor.ino}`)!,
		measurable:
			descriptor.dev !== "0" &&
			descriptor.ino !== "0" &&
			(descriptor.kind !== "socket" ||
				(process.platform === "linux"
					? descriptor.target === `socket:[${descriptor.ino}]`
					: aliases.get(`${descriptor.dev}:${descriptor.ino}`)?.length === 1)),
	}));
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
