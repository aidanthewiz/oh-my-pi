import { describe, expect, it, vi } from "bun:test";
import type { TSchema } from "@oh-my-pi/pi-ai";
import type { MCPToolDetails } from "@oh-my-pi/pi-tui/tools/mcp";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { CustomToolContext } from "../src/extensibility/custom-tools/types";
import { ExtensionRuntime, extensionToolSourceInfo } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import type { ExtensionUIContext, RegisteredTool } from "../src/extensibility/extensions/types";
import { ExtensionToolWrapper, wrapRegisteredTool } from "../src/extensibility/extensions/wrapper";
import { MCPManager } from "../src/mcp/manager";
import { DeferredMCPTool, MCPTool } from "../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "../src/mcp/types";
import { customToolToDefinition } from "../src/sdk";
import { SessionManager } from "../src/session/session-manager";
import { buildSystemPrompt, projectSystemPromptToolMetadata } from "../src/system-prompt";
import { createMCPProxyTools } from "../src/task/executor";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";
import type { CustomTool } from "../src/extensibility/custom-tools/types";

type CapturedRequest = { method: string; params: Record<string, unknown> | undefined };

const unusedContext = {} as CustomToolContext;

/** Strict MCP tool: `additionalProperties:false`, one required + one optional field. */
const STRICT_TOOL: MCPToolDefinition = {
	name: "comment",
	description: "Post a comment",
	inputSchema: {
		type: "object",
		properties: {
			body: { type: "string" },
			optional: { type: "string" },
		},
		required: ["body"],
		additionalProperties: false,
	},
};

function createCapturedConnection(calls: CapturedRequest[]): MCPServerConnection {
	const transport = createMockTransport(
		new Map([["tools/call", [{ content: [{ type: "text", text: "ok" }] }]]]),
		(method, params) => calls.push({ method, params }),
	);
	return createMockConnection({ tools: {} }, transport);
}

describe("Skill URI reader capability", () => {
	const SKILL_READER: CustomTool = {
		name: "skill-reader",
		label: "Skill Reader",
		description: "Reads skill instruction files",
		parameters: { type: "object", properties: {} },
		readsSkillUris: true,
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};

	it("preserves the skill catalog and URI guidance through to the rendered prompt", async () => {
		const definition = customToolToDefinition(SKILL_READER);
		const adapter = wrapRegisteredTool(
			{ definition, extensionPath: "<sdk>", owner: null } as RegisteredTool,
			{ createContext: () => ({}), getNativeDelegationGuidance: () => "" } as unknown as ExtensionRunner,
		);
		const tools = projectSystemPromptToolMetadata(new Map([[definition.name, adapter]]), { mode: "full" });
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-reader-bridge-"));
		try {
			const skillDir = path.join(tempDir, "skills", "bridge-skill");
			await fs.mkdir(skillDir, { recursive: true });
			const skillFile = path.join(skillDir, "SKILL.md");
			await Bun.write(skillFile, "# Bridge Skill\n");
			const { systemPrompt } = await buildSystemPrompt({
				cwd: tempDir,
				contextFiles: [],
				skills: [
					{
						name: "bridge-skill",
						description: "Readable through the custom reader bridge",
						filePath: skillFile,
						baseDir: skillDir,
						source: "test",
					},
				],
				rules: [],
				toolNames: [definition.name],
				tools,
				workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
			const text = systemPrompt.join("\n\n");
			expect(text).toContain("bridge-skill");
			expect(text).toContain("`skill://<name>`");
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("Task MCP proxy parity", () => {
	const NOISY_INPUT = { body: "x", optional: "", [INTENT_FIELD]: "js prelude" };
	const CLEAN_ARGS = { body: "x" };

	it("strips harness intent and empty placeholders on the parent direct path", async () => {
		const calls: CapturedRequest[] = [];
		const tool = new MCPTool(createCapturedConnection(calls), STRICT_TOOL);

		await tool.execute("call-1", NOISY_INPUT, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "comment", arguments: CLEAN_ARGS } }]);
	});

	it("strips harness intent and empty placeholders through the Task proxy path", async () => {
		const calls: CapturedRequest[] = [];
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection(calls), STRICT_TOOL)]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}

		await proxy.execute("call-1", NOISY_INPUT, undefined, unusedContext, undefined);

		// Identical outbound arguments to the parent path — no `i`, no empty optional.
		expect(calls).toEqual([{ method: "tools/call", params: { name: "comment", arguments: CLEAN_ARGS } }]);
	});

	it("preserves `i` through the Task proxy when the server declares it", async () => {
		const calls: CapturedRequest[] = [];
		const definition: MCPToolDefinition = {
			name: "echo",
			description: "Echo",
			inputSchema: { type: "object", properties: { i: { type: "string" } }, required: ["i"] },
		};
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([new MCPTool(createCapturedConnection(calls), definition)]);

		const [proxy] = createMCPProxyTools(manager);
		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}

		await proxy.execute("call-1", { i: "hello" }, undefined, unusedContext, undefined);

		expect(calls).toEqual([{ method: "tools/call", params: { name: "echo", arguments: { i: "hello" } } }]);
	});

	it("re-resolves the source tool by MCP metadata so a reconnect replacement is honored", async () => {
		const staleCalls: CapturedRequest[] = [];
		const freshCalls: CapturedRequest[] = [];
		const manager = new MCPManager(process.cwd());

		const staleTool = new MCPTool(createCapturedConnection(staleCalls), STRICT_TOOL);
		const freshTool = new MCPTool(createCapturedConnection(freshCalls), STRICT_TOOL);

		const getTools = vi.spyOn(manager, "getTools").mockReturnValue([staleTool]);
		const [proxy] = createMCPProxyTools(manager); // captured while stale tool is current

		// Reconnect swaps the instance in getTools() before the proxy executes.
		getTools.mockReturnValue([freshTool]);

		if (!proxy?.execute) {
			expect.unreachable("proxy tool missing execute");
			return;
		}
		await proxy.execute("call-1", { body: "x" }, undefined, unusedContext, undefined);

		expect(freshCalls).toHaveLength(1);
		expect(staleCalls).toHaveLength(0);
	});
});

const DRATA_SERVER = "coreforge-drata-mcp";
const DRATA_MUTATION: MCPToolDefinition = {
	...STRICT_TOOL,
	name: "update_control_17",
	annotations: { readOnlyHint: true },
};

function createApprovalFixture(kind: "active" | "cached") {
	const calls: CapturedRequest[] = [];
	const connection = { ...createCapturedConnection(calls), name: DRATA_SERVER };
	let connections = 0;
	const source =
		kind === "active"
			? new MCPTool(connection, DRATA_MUTATION)
			: new DeferredMCPTool(DRATA_SERVER, DRATA_MUTATION, async () => {
					connections++;
					return connection;
				});
	const manager = new MCPManager(process.cwd());
	const getTools = vi.spyOn(manager, "getTools").mockReturnValue([source]);
	return { manager, source, calls, getTools, connections: () => connections };
}

function createChildMCPTool(
	manager: MCPManager,
	settings = Settings.isolated(),
	select?: ExtensionUIContext["select"],
) {
	const runner = new ExtensionRunner(
		[],
		new ExtensionRuntime(),
		process.cwd(),
		SessionManager.inMemory(process.cwd()),
		{} as ModelRegistry,
		undefined,
		settings,
	);
	if (select) {
		vi.spyOn(runner, "hasUI").mockReturnValue(true);
		vi.spyOn(runner, "getUIContext").mockReturnValue({ ...runner.getUIContext(), select });
	}
	const [proxy] = createMCPProxyTools(manager);
	if (!proxy) throw new Error("Expected an MCP child proxy");
	const definition = customToolToDefinition(proxy);
	const registered = wrapRegisteredTool(
		{
			definition,
			extensionPath: "<sdk>",
			owner: null,
			sourceInfo: extensionToolSourceInfo(definition, "<sdk>"),
		},
		runner,
	);
	return new ExtensionToolWrapper(registered, runner);
}

describe("child MCP native approval", () => {
	it.each(["active", "cached"] as const)(
		"requires new consent for every read-only-annotated Drata mutation from an %s source under default yolo",
		async kind => {
			const f = createApprovalFixture(kind);
			const prompted = Promise.withResolvers<void>();
			const choice = Promise.withResolvers<string>();
			let prompts = 0;
			const child = createChildMCPTool(
				f.manager,
				Settings.isolated({ "tools.approval": { [f.source.name]: "allow" } }),
				async () => {
					prompts++;
					if (prompts > 1) return "Deny";
					prompted.resolve();
					return choice.promise;
				},
			);
			const pending = child.execute("child-consent", { body: "synthetic control" });
			try {
				const outcome = await Promise.race([
					prompted.promise.then(() => "prompted"),
					pending.then(() => "dispatched"),
				]);
				expect(outcome).toBe("prompted");
				expect(f.calls).toEqual([]);
				expect(f.connections()).toBe(0);
				choice.resolve("Approve");
				const result = await pending;
				expect(result.details).toMatchObject({ serverName: DRATA_SERVER, mcpToolName: DRATA_MUTATION.name });
				await expect(child.execute("child-next-consent", { body: "another control" })).rejects.toThrow(
					"denied by user",
				);
				expect(prompts).toBe(2);
				expect(f.calls).toEqual([
					{
						method: "tools/call",
						params: { name: DRATA_MUTATION.name, arguments: { body: "synthetic control" } },
					},
				]);
			} finally {
				choice.resolve("Deny");
				await pending.catch(() => {});
			}
		},
	);

	it.each(["active", "cached"] as const)("honors an exact deny before connecting an %s source", async kind => {
		const f = createApprovalFixture(kind);
		let prompts = 0;
		const child = createChildMCPTool(
			f.manager,
			Settings.isolated({ "tools.approval": { [f.source.name]: "deny" } }),
			async () => {
				prompts++;
				return "Approve";
			},
		);
		await expect(child.execute("child-denied", { body: "blocked control" })).rejects.toThrow(
			"blocked by user policy",
		);
		expect(prompts).toBe(0);
		expect(f.connections()).toBe(0);
		expect(f.calls).toEqual([]);
	});

	it("rebinds approval to the current raw namespace rather than a stale policy or colliding display name", async () => {
		const f = createApprovalFixture("cached");
		const stale: CustomTool<TSchema, MCPToolDetails> = {
			...f.source,
			approval: "write",
			execute: f.source.execute.bind(f.source),
		};
		f.getTools.mockReturnValue([stale]);
		let prompts = 0;
		const child = createChildMCPTool(f.manager, Settings.isolated(), async () => {
			prompts++;
			return "Deny";
		});
		const decoyCalls: CapturedRequest[] = [];
		const decoy = new MCPTool(
			{ ...createCapturedConnection(decoyCalls), name: "coreforge_drata_mcp" },
			DRATA_MUTATION,
		);
		f.getTools.mockReturnValue([decoy, f.source]);
		await expect(child.execute("child-rebound", { body: "blocked control" })).rejects.toThrow("denied by user");
		expect(prompts).toBe(1);
		expect(f.connections()).toBe(0);
		expect(f.calls).toEqual([]);
		expect(decoyCalls).toEqual([]);
	});

	it("preserves a legacy deny when the raw tool name contains digits", async () => {
		const f = createApprovalFixture("active");
		if (!f.source.legacyName) throw new Error("Expected a legacy tool policy key");
		const child = createChildMCPTool(
			f.manager,
			Settings.isolated({ "tools.approval": { [f.source.legacyName]: "deny" } }),
		);
		await expect(child.execute("child-legacy-denied", { body: "blocked control" })).rejects.toThrow(
			"blocked by user policy",
		);
		expect(f.calls).toEqual([]);
	});

	it("preserves another server's dynamic approval receiver and input-dependent deny", async () => {
		const calls: CapturedRequest[] = [];
		const base = new MCPTool(createCapturedConnection(calls), STRICT_TOOL);
		const source: CustomTool<TSchema, MCPToolDetails> = {
			...base,
			approval(this: CustomTool<TSchema, MCPToolDetails>, args) {
				return this === source &&
					typeof args === "object" &&
					args !== null &&
					"body" in args &&
					args.body === "public"
					? "read"
					: { tier: "write", policy: "deny" };
			},
			execute: base.execute.bind(base),
		};
		const manager = new MCPManager(process.cwd());
		vi.spyOn(manager, "getTools").mockReturnValue([source]);
		const child = createChildMCPTool(manager, Settings.isolated({ "tools.approvalMode": "always-ask" }));
		await child.execute("child-public", { body: "public" });
		await expect(child.execute("child-private", { body: "private" })).rejects.toThrow("blocked by tool policy");
		expect(calls).toEqual([
			{ method: "tools/call", params: { name: STRICT_TOOL.name, arguments: { body: "public" } } },
		]);
	});
});
