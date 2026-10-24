import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, IpcServer } from "@oh-my-pi/pi-natives";
import { type Component, Input, Text, TUI, TuiDebugServer, type TuiDebugTreeNode } from "../src";
import { VirtualTerminal } from "./virtual-terminal";

interface DebugReply {
	ok: boolean;
	error?: string;
	lines?: string[];
	values?: Record<string, unknown>;
	tree?: { root: TuiDebugTreeNode };
	injected?: number;
}

class DebugClient {
	readonly #connection: IpcConnection;
	#pending: PromiseWithResolvers<DebugReply> | undefined;

	constructor(connection: IpcConnection) {
		this.#connection = connection;
		connection.start(
			frame => {
				const pending = this.#pending;
				this.#pending = undefined;
				pending?.resolve(JSON.parse(frame) as DebugReply);
			},
			reason => {
				const pending = this.#pending;
				this.#pending = undefined;
				pending?.reject(new Error(`debug socket closed: ${reason ?? "eof"}`));
			},
		);
	}

	async request(request: Record<string, unknown>): Promise<DebugReply> {
		if (this.#pending !== undefined) throw new Error("debug client request already pending");
		const pending = Promise.withResolvers<DebugReply>();
		this.#pending = pending;
		this.#connection.send(JSON.stringify(request));
		return pending.promise;
	}

	close(): void {
		this.#connection.destroy();
	}
}

async function nextEventLoopTurn(): Promise<void> {
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
}

/** The TUI starts its debug listener asynchronously; dial until it binds. */
async function connectDebugSocket(path: string): Promise<DebugClient> {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			return new DebugClient(await IpcConnection.connect(path, { framing: "lines", timeoutMs: 1000 }));
		} catch {
			await Bun.sleep(10);
		}
	}
	throw new Error(`debug socket did not become available: ${path}`);
}

function findNode(node: TuiDebugTreeNode, id: string): TuiDebugTreeNode | undefined {
	if (node.id === id) return node;
	for (const child of node.children ?? []) {
		const found = findNode(child, id);
		if (found !== undefined) return found;
	}
	return undefined;
}

async function paintedText(client: DebugClient): Promise<DebugReply> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const reply = await client.request({ op: "text" });
		if (reply.ok) return reply;
		expect(reply.error).toContain("no frame painted yet");
		await nextEventLoopTurn();
	}
	throw new Error("TUI did not paint a debug frame");
}

test("OMP_TUI_DEBUG drives and inspects a live TUI", async () => {
	const previousDebugPath = process.env.OMP_TUI_DEBUG;
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-debug-"));
	const socketPath = path.join(root, "debug.sock");
	process.env.OMP_TUI_DEBUG = socketPath;
	const terminal = new VirtualTerminal(50, 12);
	const tui = new TUI(terminal);
	const title = new Text("Known debug content", 0, 0);
	const debugTitle: Component = title;
	debugTitle.debugId = "title";
	const input = new Input();
	const debugInput: Component = input;
	debugInput.debugId = "input";
	input.prompt = "Input: ";
	tui.addChild(title);
	tui.addChild(input);
	tui.setFocus(input);

	let client: DebugClient | undefined;
	try {
		tui.start();
		client = await connectDebugSocket(socketPath);
		if (process.platform !== "win32") {
			expect((await fs.lstat(socketPath)).mode & 0o777).toBe(0o600);
		}
		const text = await paintedText(client);
		expect(text.lines?.join("\n")).toContain("Known debug content");
		const frame = await client.request({ op: "frame" });
		expect(frame.lines?.join("\n")).toContain("Known debug content");
		expect(await client.request({ op: "info" })).toMatchObject({ ok: true });

		const keys = await client.request({ op: "keys", keys: "'hello'" });
		expect(keys).toEqual({ ok: true, injected: 5 });
		const valuesAfterKeys = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterKeys.values)).toContain("hello");
		const chords = await client.request({ op: "keys", keys: "C-a 'X' C-e" });
		expect(chords).toEqual({ ok: true, injected: 3 });
		const valuesAfterChords = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterChords.values)).toContain("Xhello");

		const tree = await client.request({ op: "tree" });
		expect(tree.ok).toBe(true);
		expect(tree.tree?.root.kind).toBe("TUI");
		const inputNode = tree.tree === undefined ? undefined : findNode(tree.tree.root, "input");
		expect(inputNode?.kind).toBe("Input");
		expect(inputNode?.focusable).toBe(true);
		expect(inputNode?.focused).toBe(true);

		expect(await client.request({ op: "not-an-op" })).toEqual({ ok: false, error: "unknown op not-an-op" });
		expect(await client.request({ op: "bytes", data: "!" })).toEqual({ ok: true });
		expect(await client.request({ op: "paste", text: " pasted" })).toEqual({ ok: true });
		expect(await client.request({ op: "mouse", x: 1, y: 1 })).toEqual({ ok: true });
		const valuesAfterRawInput = await client.request({ op: "values" });
		expect(JSON.stringify(valuesAfterRawInput.values)).toContain("Xhello! pasted");
	} finally {
		client?.close();
		tui.stop();
		await fs.rm(root, { recursive: true, force: true });
		if (previousDebugPath === undefined) delete process.env.OMP_TUI_DEBUG;
		else process.env.OMP_TUI_DEBUG = previousDebugPath;
	}
});

test("TUI debug server preserves an occupied non-socket path", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-debug-"));
	const occupiedPath = path.join(root, "occupied.sock");
	await fs.writeFile(occupiedPath, "keep");
	const server = new TuiDebugServer(new TUI(new VirtualTerminal(20, 4)), occupiedPath);
	try {
		server.start();
		expect(await server.ready).toBe(false);
		expect(await fs.readFile(occupiedPath, "utf8")).toBe("keep");
	} finally {
		server.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("a second debug server cannot replace or remove the live endpoint", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-debug-"));
	const endpoint = path.join(root, "debug.sock");
	const tui = new TUI(new VirtualTerminal(20, 4));
	const owner = new TuiDebugServer(tui, endpoint);
	const contender = new TuiDebugServer(tui, endpoint);
	let client: DebugClient | undefined;
	try {
		owner.start();
		expect(await owner.ready).toBe(true);
		contender.start();
		expect(await contender.ready).toBe(false);
		contender.stop();
		client = await connectDebugSocket(endpoint);
		expect((await client.request({ op: "info" })).ok).toBe(true);
	} finally {
		client?.close();
		contender.stop();
		owner.stop();
		await fs.rm(root, { recursive: true, force: true });
	}
});

test("stopped pending debug listeners cannot publish into a restarted lifetime", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-debug-"));
	const endpoint = path.join(root, "debug.sock");
	const tui = new TUI(new VirtualTerminal(20, 4));
	const input = new Input();
	tui.addChild(input);
	tui.setFocus(input);
	const server = new TuiDebugServer(tui, endpoint);
	let client: DebugClient | undefined;
	try {
		server.start();
		const stoppedReady = server.ready;
		server.stop();
		server.start();
		const restartedReady = server.ready;
		expect(await stoppedReady).toBe(false);
		expect(await restartedReady).toBe(true);
		if (process.platform !== "win32") {
			expect((await fs.lstat(endpoint)).mode & 0o777).toBe(0o600);
		}
		client = await connectDebugSocket(endpoint);
		await client.request({ op: "keys", keys: "'first'" });
		expect(JSON.stringify((await client.request({ op: "values" })).values)).toContain("first");
		client.close();
		client = undefined;

		server.stop();
		server.start();
		expect(await server.ready).toBe(true);
		client = await connectDebugSocket(endpoint);
		await client.request({ op: "keys", keys: "'-second'" });
		expect(JSON.stringify((await client.request({ op: "values" })).values)).toContain("first-second");
	} finally {
		client?.close();
		server.stop();
		for (let attempt = 0; attempt < 100; attempt++) {
			if (
				!(await fs.lstat(endpoint).then(
					() => true,
					() => false,
				))
			)
				break;
			await nextEventLoopTurn();
		}
		const endpointRemains = await fs.lstat(endpoint).then(
			() => true,
			() => false,
		);
		await fs.rm(root, { recursive: true, force: true });
		expect(endpointRemains).toBe(false);
	}
});

test.each(["same-path", "disabled-reenabled", "changed-path", "changed-back"] as const)(
	"actual TUI retains pending native debug ownership across %s",
	async scenario => {
		const previousDebugPath = process.env.OMP_TUI_DEBUG;
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tui-debug-"));
		const endpoint = path.join(root, "debug.sock");
		const changedEndpoint = path.join(root, "changed.sock");
		process.env.OMP_TUI_DEBUG = endpoint;
		const tui = new TUI(new VirtualTerminal(40, 8));
		const input = new Input();
		(input as Component).debugId = "owner-input";
		input.setValue("retained");
		tui.addChild(input);
		tui.setFocus(input);

		const originalListen = IpcServer.listen;
		const bound = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const servers = new Set<IpcServer>();
		const connections = new Set<IpcConnection>();
		const nativeAttempts: Promise<IpcServer>[] = [];
		const deliveries = new Set<Promise<IpcServer>>();
		let firstAttempt = true;
		const listen = spyOn(IpcServer, "listen");
		listen.mockImplementation((...args) => {
			const held = firstAttempt;
			firstAttempt = false;
			const nativeAttempt = originalListen.call(IpcServer, args[0], args[1], connection => {
				connections.add(connection);
				args[2](connection);
			});
			nativeAttempts.push(nativeAttempt);
			const delivery = (async () => {
				const server = await nativeAttempt;
				servers.add(server);
				if (held) {
					bound.resolve();
					await release.promise;
				}
				return server;
			})();
			deliveries.add(delivery);
			void delivery.finally(() => deliveries.delete(delivery)).catch(() => {});
			return delivery;
		});

		let client: DebugClient | undefined;
		try {
			tui.start();
			await bound.promise;
			const transitions =
				scenario === "disabled-reenabled"
					? [undefined, endpoint]
					: scenario === "changed-path"
						? [changedEndpoint]
						: scenario === "changed-back"
							? [changedEndpoint, endpoint]
							: [endpoint];
			for (const nextPath of transitions) {
				tui.stop();
				if (nextPath === undefined) delete process.env.OMP_TUI_DEBUG;
				else process.env.OMP_TUI_DEBUG = nextPath;
				tui.start();
			}
			await nextEventLoopTurn();
			await Promise.allSettled(nativeAttempts);
			release.resolve();
			await Promise.allSettled(deliveries);
			await nextEventLoopTurn();
			const activePath = transitions.at(-1);
			if (activePath === undefined) throw new Error("fixture must end with debugging enabled");
			client = await connectDebugSocket(activePath);
			expect(await client.request({ op: "info" })).toMatchObject({
				ok: true,
				columns: 40,
				rows: 8,
			});
			await client.request({ op: "keys", keys: "'-live'" });
			expect(input.getValue()).toBe("retained-live");
			expect((await client.request({ op: "values" })).values?.["Input#owner-input"]).toMatchObject({
				textPreview: "retained-live",
				textLength: 13,
			});
			if (process.platform !== "win32") {
				expect((await fs.lstat(activePath)).mode & 0o777).toBe(0o600);
			}
			for (const inactivePath of [endpoint, changedEndpoint].filter(value => value !== activePath)) {
				expect(
					await fs.lstat(inactivePath).then(
						() => true,
						() => false,
					),
				).toBe(false);
			}
		} finally {
			release.resolve();
			client?.close();
			tui.stop();
			try {
				await Promise.allSettled(deliveries);
			} finally {
				listen.mockRestore();
				for (const connection of connections) connection.destroy();
				await Promise.all([...servers].map(server => server.close()));
				await fs.rm(root, { recursive: true, force: true });
				if (previousDebugPath === undefined) delete process.env.OMP_TUI_DEBUG;
				else process.env.OMP_TUI_DEBUG = previousDebugPath;
			}
		}
	},
	10_000,
);
