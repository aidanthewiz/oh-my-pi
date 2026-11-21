import { type MessagePort, parentPort } from "node:worker_threads";
import type { ModelRegistry } from "../../src/config/model-registry";
import type { Settings } from "../../src/config/settings";
import type { MCPManagerApi } from "../../src/mcp/manager";
import type { MCPCallToolOptions, MCPHostCallContext, MCPToolCallResult } from "../../src/mcp/types";
import { createAgentSession } from "../../src/sdk";
import type { AgentSessionHandle } from "../../src/session/agent-session-handle";
import { SessionManager } from "../../src/session/session-manager";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { agentsThreadService } from "../../src/thread/services/agents";
import { authService } from "../../src/thread/services/auth";
import { identityThreadService } from "../../src/thread/services/identity";
import { integrationsThreadService } from "../../src/thread/services/integrations";
import { settingsThreadService } from "../../src/thread/services/settings";
import { cfgToolsApproval } from "../../src/tools/settings";

export interface McpHookGate {
	entered(): void | Promise<void>;
	readonly release: Promise<void>;
}

export interface McpExtensionHooks {
	readonly call?: McpHookGate;
	readonly result?: McpHookGate;
	readonly replaceInput?: Record<string, unknown>;
	readonly redact?: boolean;
}

export interface McpExtensionSession {
	readonly owner: AgentSessionHandle;
	call(
		server: string,
		tool: string,
		args?: Record<string, unknown>,
		options?: MCPCallToolOptions,
	): Promise<MCPToolCallResult>;
	/** Exercise main authority independently of the worker's additional lifecycle assertion. */
	uncheckedCall(server: string, tool: string, options?: MCPCallToolOptions): Promise<MCPToolCallResult>;
	contextFreeCall(server: string, tool: string, args?: Record<string, unknown>): Promise<MCPToolCallResult>;
	setApproval(policy: "allow" | "deny"): Promise<void>;
	hooksCompleted(): Promise<number>;
	dispose(): Promise<void>;
}

export interface McpExtensionProbe {
	open(
		manager: MCPManagerApi,
		registry: ModelRegistry,
		settings: Settings,
		cwd: string,
		id: string,
		hooks?: McpExtensionHooks,
	): Promise<McpExtensionSession>;
}

function isTestGlobals(value: unknown): value is { ready(probe: McpExtensionProbe): void | Promise<void> } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probe: McpExtensionProbe = {
	async open(manager, registry, base, cwd, id, hooks = {}) {
		const settings = base.overlay();
		let hooksCompleted = 0;
		const created = await createAgentSession({
			cwd,
			agentDir: cwd,
			authStorage: registry.authStorage,
			modelRegistry: registry,
			settings,
			agentId: id,
			parentTaskPrefix: id,
			sessionManager: SessionManager.inMemory(cwd),
			disableExtensionDiscovery: true,
			extensions: [
				pi => {
					pi.on("tool_call", async () => {
						if (hooks.call) {
							await hooks.call.entered();
							await hooks.call.release;
						}
						if (hooks.replaceInput) return { input: hooks.replaceInput };
					});
					pi.on("tool_result", async () => {
						if (hooks.result) {
							await hooks.result.entered();
							await hooks.result.release;
						}
						hooksCompleted++;
						if (hooks.redact) return { content: [{ type: "text", text: "redacted by owning extension" }] };
					});
				},
			],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			preloadedCustomToolPaths: [],
			enableMCP: true,
			mcpManager: manager,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["read"],
		});
		const session = created.session;
		const api = session.extensionRunner!.createContext().mcp!;
		return {
			owner: session,
			call: (server, tool, args, options) => api.callTool(server, tool, args, options),
			uncheckedCall: (server, tool, options) => {
				const context: MCPHostCallContext = {
					sessionManager: session.sessionManager,
					modelRegistry: session.modelRegistry,
					model: session.model,
					settings: session.settings,
					isIdle: () => !session.isStreaming,
					hasQueuedMessages: () => session.agent.hasQueuedMessages(),
					abort: () => {
						void session.abort();
					},
					mcpOwnerCurrent: () => true,
				};
				return manager.callTool(server, tool, {}, options, context);
			},
			contextFreeCall: (server, tool, args) => manager.callTool(server, tool, args, { retry: "never" }),
			setApproval: async policy => cfgToolsApproval.override(settings, { mcp__minions_create_task: policy }),
			hooksCompleted: async () => hooksCompleted,
			dispose: () => session.dispose(),
		};
	},
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "mcp-extension-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	const services = [
		identityThreadService,
		settingsThreadService,
		authService,
		agentsThreadService,
		integrationsThreadService,
	];
	for (const service of services) service.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		for (const service of services) await service.boot?.(globals[service.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("MCP extension fixture: missing test globals");
		await test.ready(probe);
	});
	port.postMessage({ ready: true });
});
