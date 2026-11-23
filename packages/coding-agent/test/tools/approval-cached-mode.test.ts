import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	captureApprovalTargets,
	recordApprovalGrant,
	requestApproval,
	resolveApproval,
} from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	approvalGrantKey,
	approvalDirectoryKey,
	clearApprovalGrants,
	forgetSessionApprovals,
	getApprovalGrants,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey, approvalTreeSearchKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

let root: TempDir;
let previousAgentDir: string;
let auth: AuthStorage;
let registry: ModelRegistry;
let settings: Settings;
let manager: SessionManager;

beforeEach(async () => {
	root = TempDir.createSync("@pi-cached-approval-");
	previousAgentDir = getAgentDir();
	setAgentDir(root.path());
	auth = await AuthStorage.create(root.join("auth.db"));
	registry = new ModelRegistry(auth);
	settings = Settings.isolated({ "tools.approvalMode": "always-ask-cached" });
	manager = SessionManager.inMemory(root.path());
});

afterEach(async () => {
	await auth.close();
	setAgentDir(previousAgentDir);
	root.removeSync();
});

function fileTool(tier: ToolTier = "read"): AgentTool {
	return {
		name: "file_probe",
		label: "file_probe",
		description: "Read or replace fixture contents",
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: args => {
			if (!isRecord(args) || typeof args.path !== "string") throw new Error("Missing path");
			return [approvalTargetKey(root.path(), args.path)!];
		},
		execute: async (_id, args) => {
			if (!isRecord(args) || typeof args.path !== "string") throw new Error("Missing path");
			const file = path.resolve(root.path(), args.path);
			if (tier !== "read") fs.writeFileSync(file, String(args.content));
			return { content: [{ type: "text", text: fs.readFileSync(file, "utf8") }] };
		},
	};
}

function harness(approve: (prompt: ExtensionApprovalPrompt) => Promise<ExtensionApprovalAnswer>, model?: Model) {
	const runner = new ExtensionRunner([], new ExtensionRuntime(), root.path(), manager, registry, undefined, settings);
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
		{
			approve,
			select: async () => "Deny",
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			rerenderMessage: () => {},
			refreshTranscript: () => {},
			getLinkClicksAvailable: () => false,
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async <T>() => undefined as T,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return {} as never;
			},
			getAllThemes: async () => [],
			getTheme: async () => undefined,
			setTheme: async () => ({ success: false, error: "No test theme" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		} satisfies ExtensionUIContext,
	);
	const context: AgentToolContext = {
		sessionManager: manager,
		modelRegistry: registry,
		model,
		settings,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	};
	return { runner, context, wrap: (tool: AgentTool) => new ExtensionToolWrapper(tool, runner) };
}

describe("captured approval grants", () => {
	it("requires every target and never promotes a read grant to a write grant", async () => {
		fs.writeFileSync(root.join("a.txt"), "A");
		fs.writeFileSync(root.join("b.txt"), "B");
		const read = fileTool();
		const write = fileTool("write");
		const grants = getApprovalGrants(root.path(), manager.getSessionId(), "account-and-trust-A");
		const args = { path: "a.txt" };
		const captured = await captureApprovalTargets(read, args, root.path());
		recordApprovalGrant(read, args, grants, "read", { grant: "target", always: false }, captured);
		expect(resolveApproval(read, args, "always-ask-cached", {}, grants, undefined, captured).policy).toBe("allow");
		expect(resolveApproval(write, args, "always-ask-cached", {}, grants, undefined, captured).policy).toBe("prompt");
		const both = {
			...read,
			approvalCacheTargets: () => [
				approvalTargetKey(root.path(), "a.txt")!,
				approvalTargetKey(root.path(), "b.txt")!,
			],
		};
		expect(
			resolveApproval(
				both,
				{},
				"always-ask-cached",
				{},
				grants,
				undefined,
				await captureApprovalTargets(both, {}, root.path()),
			).policy,
		).toBe("prompt");
		const otherArgs = { path: "b.txt" };
		const other = await captureApprovalTargets(write, otherArgs, root.path());
		recordApprovalGrant(write, otherArgs, grants, "write", { grant: "target", always: false }, other);
		expect(resolveApproval(read, otherArgs, "always-ask-cached", {}, grants, undefined, other).policy).toBe("allow");
	});

	it.each([
		[
			"a directory and a file outside it",
			(dir: string) => [approvalDirectoryKey(dir), approvalTargetKey(root.path(), "outside.txt")!],
		],
		[
			"a file and a recursive search",
			(dir: string) => [approvalTargetKey(dir, "a.txt")!, approvalTreeSearchKey(approvalDirectoryKey(dir))],
		],
		["a file and a non-file URL", (dir: string) => [approvalTargetKey(dir, "a.txt")!, "https://example.com/a"]],
	] as const)("refuses a forged folder grant for %s", async (_label, targets) => {
		const dir = root.join("dir");
		fs.mkdirSync(dir);
		fs.writeFileSync(path.join(dir, "a.txt"), "A");
		fs.writeFileSync(root.join("outside.txt"), "OUTSIDE");
		const tool = { ...fileTool(), approvalCacheTargets: () => targets(dir) };
		const captured = await captureApprovalTargets(tool, {}, root.path());
		expect(captured.failed).toBe(false);
		let scopes: string[] = [];
		const answer = await requestApproval(
			{
				select: async () => undefined,
				approve: async prompt => {
					scopes = prompt.grants?.map(grant => grant.scope) ?? [];
					return { grant: "folder", always: false };
				},
			},
			tool,
			{},
			{ grants: true, targets: captured },
		);
		expect(scopes).toEqual(["target"]);
		expect(answer).toBe("deny");
	});

	it("binds persistent grants to account/trust and resolved file identity", async () => {
		fs.writeFileSync(root.join("a.txt"), "A");
		const tool = fileTool();
		const args = { path: "a.txt" };
		const captured = await captureApprovalTargets(tool, args, root.path());
		const first = getApprovalGrants(root.path(), "one", "account-A-trust-A");
		recordApprovalGrant(tool, args, first, "read", { grant: "target", always: true }, captured);
		const same = getApprovalGrants(root.path(), "two", "account-A-trust-A");
		const changed = getApprovalGrants(root.path(), "two", "account-B-trust-A");
		expect(resolveApproval(tool, args, "always-ask-cached", {}, same, undefined, captured).policy).toBe("allow");
		expect(resolveApproval(tool, args, "always-ask-cached", {}, changed, undefined, captured).policy).toBe("prompt");
		fs.renameSync(root.join("a.txt"), root.join("old.txt"));
		fs.writeFileSync(root.join("a.txt"), "PRIVATE");
		expect(
			resolveApproval(
				tool,
				args,
				"always-ask-cached",
				{},
				same,
				undefined,
				await captureApprovalTargets(tool, args, root.path()),
			).policy,
		).toBe("prompt");
	});

	it("does not turn derivation failure into a harmless read", async () => {
		const tool = {
			...fileTool(),
			approvalCacheTargets: async () => {
				throw new Error("permission denied");
			},
		};
		const captured = await captureApprovalTargets(tool, {}, root.path());
		expect(resolveApproval(tool, {}, "always-ask-cached", {}, undefined, undefined, captured).policy).toBe("prompt");
		let ran = false;
		const h = harness(async () => "once");
		await expect(
			h
				.wrap({
					...tool,
					execute: async () => {
						ran = true;
						return { content: [] };
					},
				})
				.execute("failure", {}, undefined, undefined, h.context),
		).rejects.toThrow("identity is unavailable");
		expect(ran).toBe(false);
	});

	it("forgets both lifetimes and reports failed persistent revocation", () => {
		const grants = getApprovalGrants(root.path(), "one", "scope");
		const key = approvalGrantKey("read", "/protected", "identity");
		grants.record(key, "read", "session");
		grants.record(key, "read", "global");
		clearApprovalGrants(root.path());
		expect(grants.present([key]).has(key)).toBe(false);
		fs.rmSync(grants.global.filePath);
		fs.mkdirSync(grants.global.filePath);
		expect(() => clearApprovalGrants(root.path())).toThrow();
	});

	it("retires departed session access without deleting persistent consent", () => {
		const grants = getApprovalGrants(root.path(), "departed", "scope");
		const sessionKey = approvalGrantKey("read", "/session-only", "identity");
		const persistentKey = approvalGrantKey("read", "/persisted", "identity");
		grants.record(sessionKey, "read", "session");
		grants.record(persistentKey, "read", "global");
		forgetSessionApprovals(root.path(), "departed");
		expect(grants.present([sessionKey]).has(sessionKey)).toBe(false);
		expect(getApprovalGrants(root.path(), "departed", "scope").present([sessionKey]).has(sessionKey)).toBe(false);
		expect(getApprovalGrants(root.path(), "successor", "scope").present([persistentKey]).has(persistentKey)).toBe(
			true,
		);
	});

	it("isolates session grants by credential owner and cannot persist unknown authority", () => {
		const firstOwner = {};
		const secondOwner = {};
		const key = approvalGrantKey("read", "/protected", "identity");
		const first = getApprovalGrants(root.path(), "session", "scope", {
			allowPersistent: false,
			sessionAuthority: firstOwner,
		});
		first.record(key, "read", "session");
		const replacement = getApprovalGrants(root.path(), "session", "scope", {
			allowPersistent: false,
			sessionAuthority: secondOwner,
		});
		expect(first.present([key]).has(key)).toBe(true);
		expect(replacement.present([key]).has(key)).toBe(false);
		expect(() => first.record(key, "read", "global")).toThrow("Persistent approval authority is unavailable");
	});
});

describe("approval execution transitions", () => {
	it("does not reuse persistent access across actual stores with identical account metadata", async () => {
		fs.writeFileSync(root.join("data.txt"), "PUBLIC");
		const credential = {
			type: "oauth" as const,
			access: "synthetic-access",
			refresh: "synthetic-refresh",
			expires: Date.now() + 60_000,
			accountId: "same-account",
			email: "same@example.test",
		};
		await auth.credentials.set("anthropic", credential);
		auth.sessions.pin("anthropic", manager.getSessionId(), auth.credentials.list("anthropic")[0]!.id);
		const model = buildModel({
			id: "approval-account",
			name: "Approval account",
			provider: "anthropic",
			api: "anthropic-messages",
			baseUrl: "https://synthetic.example.test",
			input: ["text"],
			reasoning: false,
			contextWindow: 8192,
			maxTokens: 1024,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		let prompts = 0;
		const h = harness(async () => (++prompts === 1 ? { grant: "target", always: true } : "deny"), model);
		const wrapper = h.wrap(fileTool("write"));
		await wrapper.execute("original", { path: "data.txt", content: "APPROVED" }, undefined, undefined, h.context);
		await wrapper.execute(
			"same-source",
			{ path: "data.txt", content: "SAME AUTHORITY" },
			undefined,
			undefined,
			h.context,
		);
		const replacementPath = root.join("other-auth.db");
		const other = await AuthStorage.create(replacementPath);
		await other.credentials.set("anthropic", credential);
		const sourceIdentity = other.sourceIdentity;
		await other.close();
		await auth.replaceStore(await SqliteAuthCredentialStore.open(replacementPath), { sourceIdentity });
		auth.sessions.pin("anthropic", manager.getSessionId(), auth.credentials.list("anthropic")[0]!.id);
		await expect(
			wrapper.execute("different-source", { path: "data.txt", content: "PRIVATE" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		expect(fs.readFileSync(root.join("data.txt"), "utf8")).toBe("SAME AUTHORITY");
		expect(prompts).toBe(2);
	});

	it("rejects a forced persistent answer from an unknown actual credential source", async () => {
		await auth.replaceStore(await SqliteAuthCredentialStore.open(root.join("unknown-auth.db")));
		fs.writeFileSync(root.join("data.txt"), "PUBLIC");
		const h = harness(async prompt => {
			expect(prompt.allowPersistentGrants).toBe(false);
			return { grant: "target", always: true };
		});
		await expect(
			h
				.wrap(fileTool("write"))
				.execute("unknown-source", { path: "data.txt", content: "PRIVATE" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		expect(fs.readFileSync(root.join("data.txt"), "utf8")).toBe("PUBLIC");
	});
	it("remembers a folder's direct entries but never its descendants", async () => {
		fs.mkdirSync(root.join("dir", "sub"), { recursive: true });
		fs.writeFileSync(root.join("dir", "a.txt"), "A");
		fs.writeFileSync(root.join("dir", "b.txt"), "B");
		fs.writeFileSync(root.join("dir", "sub", "secret.txt"), "PRIVATE");
		let prompts = 0;
		const h = harness(async () => (++prompts === 1 ? { grant: "folder", always: false } : "deny"));
		const wrapper = h.wrap(fileTool());
		await wrapper.execute("a", { path: "dir/a.txt" }, undefined, undefined, h.context);
		const result = await wrapper.execute("b", { path: "dir/b.txt" }, undefined, undefined, h.context);
		expect(result.content).toEqual([{ type: "text", text: "B" }]);
		await expect(
			wrapper.execute("secret", { path: "dir/sub/secret.txt" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		expect(prompts).toBe(2);
	});

	it("re-prompts changed arguments instead of applying the old answer", async () => {
		fs.writeFileSync(root.join("public.txt"), "PUBLIC");
		fs.writeFileSync(root.join("secret.txt"), "PRIVATE");
		const args = { path: "public.txt" };
		let prompts = 0;
		const h = harness(async () => {
			if (++prompts === 1) {
				args.path = "secret.txt";
				return { grant: "target", always: false };
			}
			return "deny";
		});
		await expect(h.wrap(fileTool()).execute("changed", args, undefined, undefined, h.context)).rejects.toThrow(
			"denied by user",
		);
		expect(prompts).toBe(2);
	});

	it("re-prompts a symlink replacement while approval is pending", async () => {
		fs.mkdirSync(root.join("public"));
		fs.mkdirSync(root.join("private"));
		fs.writeFileSync(root.join("public", "data.txt"), "PUBLIC");
		fs.writeFileSync(root.join("private", "data.txt"), "PRIVATE");
		fs.symlinkSync(root.join("public"), root.join("link"), "junction");
		let prompts = 0;
		const h = harness(async () => {
			if (++prompts === 1) {
				fs.unlinkSync(root.join("link"));
				fs.symlinkSync(root.join("private"), root.join("link"), "junction");
				return "once";
			}
			return "deny";
		});
		await expect(
			h.wrap(fileTool()).execute("link", { path: "link/data.txt" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		expect(prompts).toBe(2);
	});

	it("keeps explicit prompt, deny, and runtime safety above remembered access", async () => {
		fs.writeFileSync(root.join("a.txt"), "A");
		let prompts = 0;
		const h = harness(async () => (++prompts === 1 ? { grant: "target", always: false } : "deny"));
		const tool = fileTool("write");
		await h.wrap(tool).execute("grant", { path: "a.txt", content: "first" }, undefined, undefined, h.context);
		tool.approval = { tier: "write", policy: "prompt", reason: "explicit safety" };
		await expect(
			h.wrap(tool).execute("prompt", { path: "a.txt", content: "PRIVATE" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		tool.approval = { tier: "write", policy: "deny", reason: "blocked" };
		await expect(
			h.wrap(tool).execute("deny", { path: "a.txt", content: "PRIVATE" }, undefined, undefined, h.context),
		).rejects.toThrow("blocked by tool policy");
		tool.approval = "write";
		const runtimeTool = Object.assign(tool, {
			prepareRuntimeApproval: async () => ({ reason: "Runtime safety", prompt: "Approve the exact account" }),
			approveRuntimeApproval: () => {},
		});
		await expect(
			h.wrap(runtimeTool).execute("runtime", { path: "a.txt", content: "PRIVATE" }, undefined, undefined, h.context),
		).rejects.toThrow("denied by user");
		expect(fs.readFileSync(root.join("a.txt"), "utf8")).toBe("first");
	});

	it("never records an aborted approval or a forged grant answer", async () => {
		fs.writeFileSync(root.join("a.txt"), "A");
		const controller = new AbortController();
		const h = harness(async () => {
			controller.abort();
			return { grant: "target", always: true };
		});
		await expect(
			h
				.wrap(fileTool("write"))
				.execute("abort", { path: "a.txt", content: "PRIVATE" }, controller.signal, undefined, h.context),
		).rejects.toThrow();
		expect(fs.readFileSync(root.join("a.txt"), "utf8")).toBe("A");
		const answer = await requestApproval(
			{ select: async () => undefined, approve: async () => ({ grant: "folder", always: true }) },
			fileTool(),
			{ path: "a.txt" },
		);
		expect(answer).toBe("deny");
	});
});
