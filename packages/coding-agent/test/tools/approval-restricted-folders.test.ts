import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolContext, type ToolTier } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { ClientBridge, ClientBridgePermissionOutcome } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type ApprovalMode,
	type ApprovalRestrictions,
	captureApprovalTargets,
	recordApprovalGrant,
	resolveApproval,
	sessionApprovalScope,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalDirectoryKey, getApprovalGrants } from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey, approvalTreeSearchKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { cfgToolsApprovalMode, cfgToolsRestrictedFolders } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { quotePosixArgv } from "@oh-my-pi/pi-coding-agent/utils/shell-quote";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: "Read, replace, or delete a fixture file",
		parameters: type({ path: "string", "content?": "string" }),
		approval: tier,
		approvalCacheTargets: args => {
			if (!isRecord(args) || typeof args.path !== "string") throw new Error("Missing path");
			const target = approvalTargetKey(cwd, args.path);
			if (target === undefined) throw new Error("Missing filesystem target");
			return [target];
		},
		execute: async (_id, args) => {
			if (!isRecord(args) || typeof args.path !== "string") throw new Error("Missing path");
			const file = path.resolve(cwd, args.path);
			if (name === "delete") {
				fs.unlinkSync(file);
				return { content: [{ type: "text", text: "deleted" }] };
			}
			if (tier === "write") fs.writeFileSync(file, String(args.content));
			return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
		},
	};
}

const bash = { name: "bash", approval: "exec" } as const;
let temp: TempDir;
let cwd: string;
let restricted: string;
let previousAgentDir: string;
let shared: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
let session: AgentSession | undefined;

beforeAll(async () => {
	shared = TempDir.createSync("@omp-restricted-auth-");
	auth = await AuthStorage.create(shared.join("auth.db"));
	registry = new ModelRegistry(auth);
});
afterAll(async () => {
	await auth.close();
	shared.removeSync();
});
beforeEach(() => {
	temp = TempDir.createSync("@omp-restricted-folders-");
	cwd = temp.path();
	restricted = path.join(cwd, "restricted");
	fs.mkdirSync(path.join(restricted, "nested"), { recursive: true });
	fs.mkdirSync(path.join(cwd, "plain"));
	fs.writeFileSync(path.join(restricted, "secret.txt"), "secret\n");
	fs.writeFileSync(path.join(cwd, "plain", "open.txt"), "open\n");
	previousAgentDir = getAgentDir();
	setAgentDir(path.join(cwd, "agent"));
});
afterEach(async () => {
	await session?.dispose();
	session = undefined;
	setAgentDir(previousAgentDir);
	temp.removeSync();
});

function restrictions(): ApprovalRestrictions {
	return { restrictedFolders: [restricted], cwd };
}

async function resolve(
	tool: Parameters<typeof resolveApproval>[0],
	args: unknown,
	policy: ApprovalRestrictions = restrictions(),
	mode: ApprovalMode = "yolo",
	userPolicies: Record<string, unknown> = {},
) {
	const targets = await captureApprovalTargets(tool, args, cwd);
	return resolveApproval(tool, args, mode, userPolicies, undefined, policy, targets);
}

describe("restricted folder resolution", () => {
	const modes: ApprovalMode[] = ["yolo", "write", "always-ask", "always-ask-cached"];
	it.each(modes)("requires per-call approval in %s mode", async mode => {
		const read = pathTool("read", "read", cwd);
		const result = await resolve(read, { path: "restricted/secret.txt" }, restrictions(), mode);
		expect(result).toMatchObject({ policy: "prompt", source: "restriction", override: true });
		expect(sessionApprovalScope(result, "read")).toBeUndefined();
		expect((await resolve(read, { path: "restricted" }, restrictions(), mode)).policy).toBe("prompt");
	});

	it("overrides an identity-bound remembered grant and user allow, but preserves deny", async () => {
		const read = pathTool("read", "read", cwd);
		const args = { path: "restricted/secret.txt" };
		const targets = await captureApprovalTargets(read, args, cwd);
		const grants = getApprovalGrants(path.join(cwd, "agent"), "s1", "restricted-account-and-trust");
		recordApprovalGrant(read, args, grants, "read", { grant: "target", always: false }, targets);
		expect(resolveApproval(read, args, "always-ask-cached", {}, grants, undefined, targets).policy).toBe("allow");
		expect(resolveApproval(read, args, "always-ask-cached", {}, grants, restrictions(), targets).policy).toBe(
			"prompt",
		);
		expect((await resolve(read, args, restrictions(), "yolo", { read: "allow" })).policy).toBe("prompt");
		expect(await resolve(read, args, restrictions(), "yolo", { read: "deny" })).toMatchObject({
			policy: "deny",
			source: "user",
		});
	});

	it("does not restrict siblings with a common name prefix or dot-prefixed children", async () => {
		const read = pathTool("read", "read", cwd);
		fs.mkdirSync(path.join(cwd, "restricted-other"));
		fs.mkdirSync(path.join(restricted, "..child"));
		expect((await resolve(read, { path: "restricted-other/file.txt" })).policy).toBe("allow");
		expect((await resolve(read, { path: "plain/open.txt" })).policy).toBe("allow");
		expect((await resolve(read, { path: "restricted/..child/file.txt" })).policy).toBe("prompt");
	});

	it("matches no-target calls by session cwd and explicit cwd", async () => {
		const inside = { restrictedFolders: [restricted], cwd: path.join(restricted, "nested") };
		expect((await resolve(bash, {}, inside)).policy).toBe("prompt");
		expect((await resolve(bash, {})).policy).toBe("allow");
		expect((await resolve(bash, { cwd: "restricted" })).policy).toBe("prompt");
		expect((await resolve(bash, { cwd: "../../plain" }, inside)).policy).toBe("allow");
	});

	it("distinguishes a recursive ancestor search from a one-level ancestor listing", async () => {
		const search = (key: string) => ({ name: "grep", approval: "read" as const, approvalCacheTargets: () => [key] });
		expect((await resolve(search(approvalTreeSearchKey(approvalDirectoryKey(cwd))), {})).policy).toBe("prompt");
		expect((await resolve(search(approvalDirectoryKey(cwd)), {})).policy).toBe("allow");
	});

	it("matches tilde, symlink destinations, and configured symlink roots", async () => {
		const read = pathTool("read", "read", cwd);
		const home = path.join(os.homedir(), ".omp-restricted-probe", "file.txt");
		const probe = { ...read, approvalCacheTargets: () => [home] };
		expect((await resolve(probe, {}, { restrictedFolders: ["~/.omp-restricted-probe"], cwd })).policy).toBe("prompt");
		const link = path.join(cwd, "link");
		fs.symlinkSync(restricted, link, "junction");
		expect((await resolve(read, { path: "link/secret.txt" })).policy).toBe("prompt");
		expect((await resolve(read, { path: "restricted/secret.txt" }, { restrictedFolders: [link], cwd })).policy).toBe(
			"prompt",
		);
	});

	it.skipIf(process.platform !== "win32")("case-folds Windows filesystem paths", async () => {
		const read = pathTool("read", "read", cwd);
		expect(
			(
				await resolve(
					read,
					{ path: "restricted/secret.txt" },
					{ restrictedFolders: [restricted.toUpperCase()], cwd },
				)
			).policy,
		).toBe("prompt");
	});

	it("does not reinterpret non-filesystem targets as the restricted cwd", async () => {
		const remote = {
			name: "read",
			approval: "read" as const,
			approvalCacheTargets: () => ["https://example.test/data"],
		};
		expect((await resolve(remote, {}, { restrictedFolders: [restricted], cwd: restricted })).policy).toBe("allow");
	});

	it("fails closed when a target identity cannot be captured", async () => {
		const read = {
			...pathTool("read", "read", cwd),
			approvalCacheTargets: async () => {
				throw new Error("unavailable target");
			},
		};
		expect((await resolve(read, { path: "restricted/secret.txt" })).policy).toBe("prompt");
	});
});

interface RestrictionHarness {
	settings: Settings;
	manager: SessionManager;
	runner: ExtensionRunner;
	context: AgentToolContext;
	model: Model;
	wrap(tool: AgentTool): ExtensionToolWrapper;
}

function harness(
	options: {
		mode?: ApprovalMode;
		folders?: string[];
		approve?: (prompt: ExtensionApprovalPrompt) => Promise<ExtensionApprovalAnswer>;
		onToolCall?: () => ToolCallEventResult | undefined;
		registry?: ModelRegistry;
		model?: Model;
	} = {},
): RestrictionHarness {
	const settings = Settings.isolated({
		"tools.approvalMode": options.mode ?? "yolo",
		"tools.restrictedFolders": options.folders ?? [restricted],
		"approval.notify": "off",
		"compaction.enabled": false,
	});
	const manager = SessionManager.inMemory(cwd);
	const modelRegistry = options.registry ?? registry;
	const model = options.model ?? getBundledModel("openai", "gpt-4o-mini");
	if (!model) throw new Error("Expected bundled fixture model");
	const extensions: Extension[] = options.onToolCall
		? [
				{
					path: path.join(cwd, "policy-extension.ts"),
					resolvedPath: path.join(cwd, "policy-extension.ts"),
					handlers: new Map([["tool_call", [async () => options.onToolCall?.()]]]),
					tools: new Map(),
					assistantThinkingRenderers: [],
					assistantTextRenderers: [],
					transcriptPresenters: [],
					linkSchemes: [],
					fileWriteFallbackHandlers: [],
					fileDeleteFallbackHandlers: [],
					messageRenderers: new Map(),
					composerShapes: new Map(),
					commands: new Map(),
					flags: new Map(),
					shortcuts: new Map(),
				},
			]
		: [];
	const runner = new ExtensionRunner(
		extensions,
		new ExtensionRuntime(),
		cwd,
		manager,
		modelRegistry,
		undefined,
		settings,
	);
	runner.initialize(
		{
			sendMessage: () => {},
			sendUserMessage: async () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		},
		{
			getModel: () => model,
			isIdle: () => true,
			getLifecycleState: () => null,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		},
		undefined,
		options.approve ? { ...runner.getUIContext(), approve: options.approve } : undefined,
	);
	const context: AgentToolContext = {
		sessionManager: manager,
		modelRegistry,
		model,
		settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
	return {
		settings,
		manager,
		runner,
		context,
		model,
		wrap: (tool: AgentTool) => new ExtensionToolWrapper(tool, runner),
	};
}

describe("restricted folder execution", () => {
	it("allows only the approved call and leaves the file unchanged after a later denial", async () => {
		let prompts = 0;
		const h = harness({ approve: async () => (++prompts === 1 ? "once" : "deny") });
		const write = h.wrap(pathTool("write", "write", cwd));
		await write.execute(
			"w1",
			{ path: "restricted/secret.txt", content: "approved" },
			undefined,
			undefined,
			h.context,
		);
		await expect(
			write.execute("w2", { path: "restricted/secret.txt", content: "denied" }, undefined, undefined, h.context),
		).rejects.toThrow(/denied by user/);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("approved");
		await write.execute("w3", { path: "plain/open.txt", content: "outside" }, undefined, undefined, h.context);
		expect(fs.readFileSync(path.join(cwd, "plain/open.txt"), "utf8")).toBe("outside");
		expect(prompts).toBe(2);
	});

	it("does not accept a session answer or old ACP argument approval for restricted calls", async () => {
		const h = harness({ approve: async () => "session" });
		const write = h.wrap(pathTool("write", "write", cwd));
		const args = { path: "restricted/secret.txt", content: "blocked" };
		await expect(write.execute("session-grant", args, undefined, undefined, h.context)).rejects.toThrow(
			/denied by user/,
		);
		const noUI = harness();
		const legacyContext = { ...noUI.context, acpApprovedArgs: args };
		await expect(
			noUI.wrap(pathTool("write", "write", cwd)).execute("stale-acp", args, undefined, undefined, legacyContext),
		).rejects.toThrow(/requires approval/);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("secret\n");
	});

	it("fails closed without UI when a native command targets restricted content", async () => {
		const h = harness();
		const write = h.wrap(pathTool("write", "write", cwd));
		const tools = new Map([[write.name, write]]);
		const session: ToolSession = {
			cwd,
			settings: h.settings,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			toolRegistry: tools,
			isToolActive: name => name === "bash",
			toolCommands: {
				tools,
				mountedNames: new Set([write.name]),
				builtInNames: new Set(),
				isActive: () => false,
			},
		};
		const bash = h.wrap(new BashTool(session) as unknown as AgentTool);
		const result = await bash.execute(
			"no-ui",
			{
				command: quotePosixArgv([
					write.name,
					"--json",
					JSON.stringify({
						path: "restricted/secret.txt",
						content: "blocked",
					}),
				]),
			},
			undefined,
			undefined,
			h.context,
		);
		expect(result.isError).toBe(true);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("secret\n");
	});

	it("enforces restrictions after an extension rewrites the effective target", async () => {
		const h = harness({
			approve: async () => "deny",
			onToolCall: () => ({ input: { path: "restricted/secret.txt", content: "rewritten" } }),
		});
		await expect(
			h
				.wrap(pathTool("write", "write", cwd))
				.execute("rewrite", { path: "plain/open.txt", content: "original" }, undefined, undefined, h.context),
		).rejects.toThrow(/denied by user/);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("secret\n");
		expect(fs.readFileSync(path.join(cwd, "plain/open.txt"), "utf8")).toBe("open\n");
	});
});

async function acpSession(h: RestrictionHarness, bridge: ClientBridge) {
	const tool = h.wrap(pathTool("delete", "write", cwd));
	const agent = new Agent({ initialState: { model: h.model, tools: [tool], systemPrompt: ["Fixture"] } });
	session = new AgentSession({
		agent,
		sessionManager: h.manager,
		settings: h.settings,
		modelRegistry: h.context.modelRegistry,
		extensionRunner: h.runner,
		toolRegistry: new Map([[tool.name, tool]]),
	});
	session.setClientBridge(bridge);
	await session.setActiveToolsByName(["delete"]);
	const wrapped = session.agent.state.tools.find(candidate => candidate.name === "delete");
	if (!wrapped) throw new Error("Missing ACP delete tool");
	return wrapped;
}

describe("restricted folder ACP permission", () => {
	it("accepts a fresh approval in explicit yolo but asks again instead of remembering it", async () => {
		const h = harness();
		let requests = 0;
		const tool = await acpSession(h, {
			capabilities: { requestPermission: true },
			requestPermission: async () => {
				requests++;
				return { outcome: "selected", optionId: requests === 1 ? "allow_always" : "reject_once" };
			},
		});
		await tool.execute("fresh", { path: "restricted/secret.txt" }, undefined, undefined, h.context);
		expect(fs.existsSync(path.join(restricted, "secret.txt"))).toBe(false);
		fs.writeFileSync(path.join(restricted, "secret.txt"), "second\n");
		await expect(
			tool.execute("fresh-deny", { path: "restricted/secret.txt" }, undefined, undefined, h.context),
		).rejects.toThrow(/rejected by user/);
		expect(requests).toBe(2);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("second\n");
	});

	it("does not reuse a cached ACP allow when live policy restricts the target before execution", async () => {
		let armRestriction = false;
		const h = harness({
			mode: "always-ask",
			folders: [],
			onToolCall: () => {
				if (armRestriction) cfgToolsRestrictedFolders.override(h.settings, [restricted]);
				return undefined;
			},
		});
		let requests = 0;
		const tool = await acpSession(h, {
			capabilities: { requestPermission: true },
			requestPermission: async (): Promise<ClientBridgePermissionOutcome> => {
				requests++;
				return { outcome: "selected", optionId: "allow_always" };
			},
		});
		await tool.execute("remember", { path: "plain/open.txt" }, undefined, undefined, h.context);
		expect(fs.existsSync(path.join(cwd, "plain/open.txt"))).toBe(false);
		armRestriction = true;
		await expect(
			tool.execute("new-restriction", { path: "restricted/secret.txt" }, undefined, undefined, h.context),
		).rejects.toThrow(/requires approval/);
		expect(requests).toBe(1);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("secret\n");
	});

	it("invalidates fresh ACP permission when policy authority changes during the client wait", async () => {
		const h = harness();
		const requested = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<ClientBridgePermissionOutcome>();
		const tool = await acpSession(h, {
			capabilities: { requestPermission: true },
			requestPermission: () => {
				requested.resolve();
				return answer.promise;
			},
		});
		const pending = tool.execute(
			"fresh-policy-race",
			{ path: "restricted/secret.txt" },
			undefined,
			undefined,
			h.context,
		);
		const observed = pending.then(
			() => undefined,
			error => error,
		);
		await requested.promise;
		cfgToolsApprovalMode.override(h.settings, "write");
		answer.resolve({ outcome: "selected", optionId: "allow_once" });
		expect(await observed).toBeInstanceOf(Error);
		expect(fs.readFileSync(path.join(restricted, "secret.txt"), "utf8")).toBe("secret\n");
	});

	it("does not rebind a cached ACP allow to a replaced credential source with identical account metadata", async () => {
		const owner = await AuthStorage.create(temp.join("original-owner.db"));
		try {
			const credential = {
				type: "oauth" as const,
				access: "synthetic-access",
				refresh: "synthetic-refresh",
				expires: Date.now() + 60_000,
				accountId: "same-account",
				email: "same@example.test",
			};
			await owner.credentials.set("anthropic", credential);
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled source-boundary fixture model");
			const h = harness({ mode: "always-ask", folders: [], registry: new ModelRegistry(owner), model });
			const originalAccount = owner.credentials.list("anthropic")[0];
			if (!originalAccount) throw new Error("Expected original fixture account");
			owner.sessions.pin("anthropic", h.manager.getSessionId(), originalAccount.id);
			let requests = 0;
			const tool = await acpSession(h, {
				capabilities: { requestPermission: true },
				requestPermission: async () => ({
					outcome: "selected",
					optionId: ++requests === 1 ? "allow_always" : "reject_once",
				}),
			});
			await tool.execute("original-principal", { path: "plain/open.txt" }, undefined, undefined, h.context);
			fs.writeFileSync(temp.join("plain/second.txt"), "same principal");
			await tool.execute("same-principal", { path: "plain/second.txt" }, undefined, undefined, h.context);
			expect(fs.existsSync(temp.join("plain/open.txt"))).toBe(false);
			expect(fs.existsSync(temp.join("plain/second.txt"))).toBe(false);
			expect(requests).toBe(1);

			const replacementPath = temp.join("replacement-owner.db");
			const replacement = await AuthStorage.create(replacementPath);
			let sourceIdentity: string | undefined;
			try {
				await replacement.credentials.set("anthropic", credential);
				sourceIdentity = replacement.sourceIdentity;
			} finally {
				await replacement.close();
			}
			await owner.replaceStore(await SqliteAuthCredentialStore.open(replacementPath), { sourceIdentity });
			const replacementAccount = owner.credentials.list("anthropic")[0];
			if (!replacementAccount) throw new Error("Expected replacement fixture account");
			owner.sessions.pin("anthropic", h.manager.getSessionId(), replacementAccount.id);
			fs.writeFileSync(temp.join("plain/new-principal.txt"), "retain after denial");
			await expect(
				tool.execute("changed-principal", { path: "plain/new-principal.txt" }, undefined, undefined, h.context),
			).rejects.toThrow(/rejected by user/);
			expect(requests).toBe(2);
			expect(fs.readFileSync(temp.join("plain/new-principal.txt"), "utf8")).toBe("retain after denial");
		} finally {
			await session?.dispose();
			session = undefined;
			await owner.close();
		}
	});
});
