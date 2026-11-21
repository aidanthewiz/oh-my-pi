import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ExtensionFactory, ToolResultEvent } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { __resetDirsFromEnvForTests, setAgentDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

interface BashDetails {
	async?: { state?: string; jobId?: string };
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	// Fake timers cannot advance native subprocesses; this deadline only bounds missing events.
	const expired = Promise.withResolvers<T>();
	const timer = setTimeout(() => expired.reject(new Error(`Missing ${label}`)), 10_000);
	try {
		return await Promise.race([promise, expired.promise]);
	} finally {
		clearTimeout(timer);
	}
}

function details(result: { details?: unknown }): BashDetails {
	return result.details as BashDetails;
}

function output(result: { content: ToolResultEvent["content"] }): string {
	return result.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe.skipIf(process.platform === "win32")("real Bash deferred tool results", () => {
	it("orders early completion after returned hooks and retains origin after eval, abort, and session replacement", async () => {
		const root = await mkdtemp("/tmp/omp-deferred-");
		const agentDir = join(root, "agent");
		const gatePath = join(root, "gate.sock");
		const scriptPath = join(root, "gated-job.mjs");
		const auth = createInMemoryAuthStorage();
		const environment = new Map(["HOME", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
		const originalFetch = globalThis.fetch;
		const networkRequests: string[] = [];
		const errors: unknown[] = [];
		const results: ToolResultEvent[] = [];
		const updates: string[] = [];
		const starts = new Map<string, PromiseWithResolvers<Socket>>();
		const completions = new Map<string, PromiseWithResolvers<ToolResultEvent>>();
		const sockets = new Set<Socket>();
		let session: AgentSession | undefined;
		let earlyJobSettledInsideHook = false;
		const gate = createServer(socket => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", error => errors.push(error));
			let input = "";
			socket.on("data", chunk => {
				input += chunk.toString();
				const newline = input.indexOf("\n");
				if (newline < 0) return;
				const start = starts.get(input.slice(0, newline));
				if (!start) throw new Error("Unexpected isolated Bash child");
				start.resolve(socket);
			});
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
			"tools.approvalMode": "yolo",
			"async.enabled": true,
			"async.widgets": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
		});
		try {
			const blockFetch = async (input: Request | string | URL): Promise<Response> => {
				const url = input instanceof Request ? input.url : String(input);
				networkRequests.push(url);
				throw new Error(`External requests are prohibited: ${url}`);
			};
			globalThis.fetch = Object.assign(blockFetch, { preconnect: originalFetch.preconnect });
			process.env.HOME = root;
			setAgentDir(agentDir);
			await mkdir(agentDir);
			await writeFile(
				scriptPath,
				`
import { createConnection } from "node:net";
const id = process.argv[2];
process.stdout.write("preview:" + id + "\\n");
const released = Promise.withResolvers();
const socket = createConnection(${JSON.stringify(gatePath)});
socket.on("error", released.reject);
socket.on("connect", () => socket.write(id + "\\n"));
socket.on("data", () => {});
socket.on("end", released.resolve);
await released.promise;
process.stdout.write("final:" + id + "\\n");
`,
			);
			const listening = Promise.withResolvers<void>();
			gate.once("error", listening.reject);
			gate.listen(gatePath, listening.resolve);
			await listening.promise;
			const manager = SessionManager.create(root, join(root, "sessions"));
			const origin = manager.getSessionId();
			const extension: ExtensionFactory = pi => {
				pi.on("tool_result", async event => {
					if (event.toolCallId !== "early" || event.completion === "deferred") return;
					const socket = await bounded(starts.get("early")!.promise, "early child start");
					socket.end();
					const job = session!.asyncJobManager!.getJob(details(event).async!.jobId!)!;
					await bounded(job.promise, "child completion inside returned-result hook");
					earlyJobSettledInsideHook = job.status === "completed";
					event.input.command = "returned middleware replaced the input";
				});
				pi.on("tool_result", event => {
					results.push(structuredClone(event));
					if (event.completion === "deferred") completions.get(event.toolCallId)?.resolve(event);
				});
				pi.on("tool_execution_update", event => {
					updates.push(event.toolCallId);
				});
			};
			({ session } = await createAgentSession({
				cwd: root,
				agentDir,
				authStorage: auth,
				modelRegistry: new ModelRegistry(auth, join(agentDir, "models.yml")),
				sessionManager: manager,
				settings,
				hasUI: true,
				toolNames: ["bash"],
				disableExtensionDiscovery: true,
				extensions: [extension],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				preloadedCustomToolPaths: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			}));
			await initializeExtensions(session, {
				mode: "tui",
				uiContext: {
					...session.extensionRunner!.getUIContext(),
					notify: (message, kind) => {
						if (kind === "error" || kind === "warning") errors.push(message);
					},
				},
				reportSendError: (_action, error) => errors.push(error),
				reportRuntimeError: error => errors.push(error),
			});
			const args = (id: string) => ({
				command: `${quote(process.execPath)} ${quote(scriptPath)} ${id}`,
				async: true,
				timeout: 10,
			});
			starts.set("early", Promise.withResolvers<Socket>());
			completions.set("early", Promise.withResolvers<ToolResultEvent>());
			const earlyArgs = args("early");
			const early = await session.getToolForEvalBridge("bash")!.execute("early", structuredClone(earlyArgs));
			expect(details(early).async?.state).toBe("running");
			const earlyFinal = await bounded(completions.get("early")!.promise, "early deferred result");
			expect(earlyJobSettledInsideHook).toBe(true);
			expect(
				results.filter(event => event.toolCallId === "early").map(event => event.completion ?? "returned"),
			).toEqual(["returned", "deferred"]);
			expect(earlyFinal).toMatchObject({
				completion: "deferred",
				sessionId: origin,
				cwd: root,
				input: earlyArgs,
				isError: false,
			});
			expect(details(earlyFinal)).toMatchObject({
				async: { state: "completed", jobId: details(early).async!.jobId },
			});
			expect(output(earlyFinal)).toContain("final:early");

			const bridgeSession: ToolSession = {
				cwd: root,
				hasUI: true,
				settings,
				getSessionFile: () => manager.getSessionFile() ?? null,
				getSessionSpawns: () => null,
				getToolForEvalBridge: name => session!.getToolForEvalBridge(name),
			};
			async function startBridge(id: string) {
				starts.set(id, Promise.withResolvers<Socket>());
				const input = args(id);
				await callSessionTool("bash", input, { session: bridgeSession });
				const returned = results.findLast(
					event => event.input.command === input.command && event.completion !== "deferred",
				)!;
				expect(details(returned).async?.state).toBe("running");
				const completion = Promise.withResolvers<ToolResultEvent>();
				completions.set(returned.toolCallId, completion);
				const socket = await bounded(starts.get(id)!.promise, `${id} child start`);
				return {
					input,
					returned,
					completion,
					socket,
					job: session!.asyncJobManager!.getJob(details(returned).async!.jobId!)!,
				};
			}
			const aborted = await startBridge("after-abort");
			await session.abort();
			expect(aborted.job.status).toBe("running");
			aborted.socket.end();
			const abortedFinal = await bounded(aborted.completion.promise, "eval completion after abort");
			expect(abortedFinal).toMatchObject({
				completion: "deferred",
				toolCallId: aborted.returned.toolCallId,
				sessionId: origin,
				input: aborted.input,
				isError: false,
			});
			expect(details(abortedFinal).async?.state).toBe("completed");
			expect(output(abortedFinal)).toContain("final:after-abort");
			expect(updates).not.toContain(aborted.returned.toolCallId);

			const switched = await startBridge("old-session");
			expect(await session.newSession()).toBe(true);
			expect(manager.getSessionId()).not.toBe(origin);
			const cancelled = await bounded(switched.completion.promise, "original-session cancellation");
			expect(cancelled).toMatchObject({
				completion: "deferred",
				toolCallId: switched.returned.toolCallId,
				sessionId: origin,
				cwd: root,
				input: switched.input,
				isError: true,
			});
			expect(details(cancelled).async?.state).toBe("cancelled");
			const jobs = session.asyncJobManager!;
			await bounded(
				jobs.waitForAll().then(() => jobs.drainDeliveries()),
				"deferred delivery drain",
			);
			expect(results.filter(event => event.completion === "deferred").map(event => event.toolCallId)).toEqual([
				"early",
				aborted.returned.toolCallId,
				switched.returned.toolCallId,
			]);
			expect(networkRequests).toEqual([]);
			expect(errors).toEqual([]);
		} finally {
			for (const socket of sockets) socket.end();
			try {
				await session?.dispose();
				await auth.close();
			} finally {
				globalThis.fetch = originalFetch;
				for (const [key, value] of environment) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				__resetDirsFromEnvForTests();
				for (const socket of sockets) socket.destroy();
				if (gate.listening) {
					const closed = Promise.withResolvers<void>();
					gate.close(() => closed.resolve());
					await closed.promise;
				}
				await rm(root, { recursive: true, force: true });
			}
		}
	}, 60_000);
});
