import * as fs from "node:fs";
import type { BunFile } from "bun";
import * as path from "node:path";
import { mock } from "bun:test";
import * as native from "@oh-my-pi/pi-natives";
import type { AgentSession as AgentSessionInstance } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";

export interface AcpHandleWriterMessage {
	event:
		| "ready"
		| "read"
		| "blocked"
		| "staged"
		| "replaced"
		| "forked"
		| "fork-rejected"
		| "opened"
		| "done"
		| "error";
	handle?: string;
	sessionId?: string;
	originalPath?: string;
	continuedPath?: string;
	userMessages?: unknown[];
	reopenedIds?: string[];
	error?: string;
}

const [root, name, mode] = process.argv.slice(2);
if (!root || !name || !mode || !path.isAbsolute(root)) throw new Error("Expected isolated root, writer name, and mode");
const agentDir = path.join(root, "agent");
const cwd = path.join(root, name);
const filePath = path.join(agentDir, "acp-session-handles.json");
const release = Promise.withResolvers<void>();
let armed = false;
let observedRead = false;
let observedLock = false;
let observedWrite = false;
const send = (message: AcpHandleWriterMessage) => process.send?.(message);

if (mode === "observe-lock" || mode === "fail-lock") {
	const bindings = { ...native };
	const NativeFileLock = bindings.FileLock;
	class ObservedFileLock extends NativeFileLock {
		static override tryAcquire(lockPath: string, create?: boolean | null) {
			if (armed && mode === "fail-lock" && lockPath === `${filePath}.lock`) {
				throw new Error("Synthetic ACP handle lock acquisition failure");
			}
			const lock = NativeFileLock.tryAcquire(lockPath, create);
			if (armed && mode === "observe-lock" && lockPath === `${filePath}.lock` && !lock.acquired && !observedLock) {
				observedLock = true;
				send({ event: "blocked" });
			}
			return lock;
		}
	}
	mock.module("@oh-my-pi/pi-natives", () => ({ ...bindings, FileLock: ObservedFileLock }));
}

const [
	{ Agent },
	{ getBundledModel },
	{ ModelRegistry },
	{ Settings },
	{ ExtensionRuntime },
	{ ExtensionRunner },
	{ AcpAgent },
	{ AgentSession },
	{ closeSessionIndex },
	{ SessionManager },
	{ setAgentDir },
	{ createInMemoryAuthStorage },
] = await Promise.all([
	import("@oh-my-pi/pi-agent-core"),
	import("@oh-my-pi/pi-catalog/models"),
	import("@oh-my-pi/pi-coding-agent/config/model-registry"),
	import("@oh-my-pi/pi-coding-agent/config/settings"),
	import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader"),
	import("@oh-my-pi/pi-coding-agent/extensibility/extensions/runner"),
	import("@oh-my-pi/pi-coding-agent/modes/acp/acp-agent"),
	import("@oh-my-pi/pi-coding-agent/session/agent-session"),
	import("@oh-my-pi/pi-coding-agent/session/session-index"),
	import("@oh-my-pi/pi-coding-agent/session/session-manager"),
	import("@oh-my-pi/pi-utils"),
	import("../helpers/agent-session-setup"),
]);
await fs.promises.mkdir(cwd, { recursive: true });
await fs.promises.mkdir(agentDir, { recursive: true });
setAgentDir(agentDir);
process.chdir(cwd);
await Settings.init({ agentDir, inMemory: true });
const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
const connection = {
	sessionUpdate: async () => {},
	extNotification: async () => {},
	signal: new AbortController().signal,
} as unknown as AgentSideConnection;
let session: AgentSessionInstance | undefined;
const acp = new AcpAgent(connection, async sessionCwd => {
	const sessionManager = SessionManager.create(sessionCwd);
	session = new AgentSession({
		agent: new Agent({
			initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: ["Test"], tools: [] },
		}),
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry,
		extensionRunner: new ExtensionRunner([], new ExtensionRuntime(), sessionCwd, sessionManager, modelRegistry),
	});
	return session;
});
const created = await acp.newSession({ cwd, mcpServers: [] });

// Pause after a real disk snapshot, not before it: an unlocked writer retains stale state.
const file = Bun.file;
Object.defineProperty(Bun, "file", {
	value: (...args: unknown[]) => {
		const result: BunFile = Reflect.apply(file, Bun, args);
		if (args[0] !== filePath) return result;
		const json = result.json.bind(result);
		result.json = async () => {
			let value: unknown;
			let failure: unknown;
			try {
				value = await json();
			} catch (error) {
				failure = error;
			}
			if (armed && !observedRead) {
				observedRead = true;
				send({ event: "read" });
				if (mode === "hold-read") await release.promise;
			}
			if (failure) throw failure;
			return value;
		};
		return result;
	},
});

async function stageWrite(content: string, write: (chunk: string) => Promise<unknown>): Promise<void> {
	const midpoint = Math.floor(content.length / 2);
	await write(content.slice(0, midpoint));
	send({ event: "staged" });
	await release.promise;
	await write(content.slice(midpoint));
}
const open = fs.promises.open;
fs.promises.open = async (...args: Parameters<typeof open>) => {
	const handle = await open(...args);
	if (armed && mode === "hold-write" && String(args[0]).startsWith(`${filePath}.`) && !observedWrite) {
		const writeFile = handle.writeFile.bind(handle);
		handle.writeFile = async (content, options) => {
			if (typeof content !== "string") return writeFile(content, options);
			observedWrite = true;
			await stageWrite(content, chunk => writeFile(chunk, options));
		};
	}
	return handle;
};
const write = Bun.write;
Object.defineProperty(Bun, "write", {
	value: async (...args: unknown[]) => {
		if (armed && mode === "hold-write" && args[0] === filePath && typeof args[1] === "string" && !observedWrite) {
			observedWrite = true;
			await fs.promises.writeFile(filePath, "");
			await stageWrite(args[1], chunk => fs.promises.appendFile(filePath, chunk));
			return Buffer.byteLength(args[1]);
		}
		return Reflect.apply(write, Bun, args);
	},
});

process.on("message", message => {
	if (!message || typeof message !== "object" || !("command" in message) || typeof message.command !== "string") {
		throw new Error("Expected ACP writer command");
	}
	const command = message.command;
	if (command === "release") {
		release.resolve();
		return;
	}
	void (async () => {
		if (command === "replace") {
			if (mode === "consumer") {
				session!.sessionManager.appendMessage({
					role: "user",
					content: "original conversation",
					timestamp: Date.now(),
				});
				await session!.sessionManager.flush();
			}
			const originalPath = session!.sessionManager.getSessionFile()!;
			armed = true;
			const result = await session!.extensionRunner!.createCommandContext().newSession({
				setup: async manager => {
					if (mode !== "consumer") return;
					manager.appendMessage({ role: "user", content: "continued conversation", timestamp: Date.now() });
					await manager.flush();
				},
			});
			if (result.cancelled) throw new Error("Extension replacement was cancelled");
			send({
				event: "replaced",
				sessionId: session!.sessionId,
				originalPath,
				continuedPath: session!.sessionManager.getSessionFile()!,
			});
		} else if (command === "fork" || command === "reopen") {
			if (!("sessionId" in message) || typeof message.sessionId !== "string") throw new Error("Expected ACP handle");
			const sessionId = message.sessionId;
			if (command === "fork") {
				const forked = await acp.unstable_forkSession({ sessionId, cwd, mcpServers: [] });
				send({
					event: "forked",
					sessionId: forked.sessionId,
					userMessages: session!.sessionManager
						.buildSessionContext()
						.messages.filter(entry => entry.role === "user")
						.map(entry => entry.content),
				});
				await acp.closeSession({ sessionId: forked.sessionId });
			} else {
				await acp.loadSession({ sessionId, cwd, mcpServers: [] });
				const loadedId = session!.sessionId;
				await acp.closeSession({ sessionId });
				await acp.resumeSession({ sessionId, cwd, mcpServers: [] });
				send({ event: "opened", reopenedIds: [loadedId, session!.sessionId] });
			}
		} else if (command === "dispose") {
			if (mode === "consumer") await acp.closeSession({ sessionId: created.sessionId });
			await acp.dispose();
			await authStorage.close();
			closeSessionIndex();
			send({ event: "done" });
			process.disconnect?.();
		}
	})().catch(error => send({ event: command === "fork" ? "fork-rejected" : "error", error: String(error) }));
});
send({ event: "ready", handle: created.sessionId });
