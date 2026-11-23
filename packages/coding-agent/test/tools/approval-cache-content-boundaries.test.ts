import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { Static, TSchema } from "@oh-my-pi/pi-ai";
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
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { AstGrepTool } from "@oh-my-pi/pi-coding-agent/tools/ast-grep";
import { GlobTool } from "@oh-my-pi/pi-coding-agent/tools/glob";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { quotePosixArgv } from "@oh-my-pi/pi-coding-agent/utils/shell-quote";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { writeArchive } from "@oh-my-pi/pi-utils/ar";

const PRIVATE = "protected-content-must-not-cross-approval";

describe("cached approval protects executed content and effects", () => {
	let temp: TempDir;
	let cwd: string;
	let previousAgentDir: string;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let manager: SessionManager;
	let settings: Settings;
	let toolSession: ToolSession;
	let runner: ExtensionRunner;
	let answer: (prompt: ExtensionApprovalPrompt) => Promise<ExtensionApprovalAnswer>;
	let prompts: number;

	beforeEach(async () => {
		temp = TempDir.createSync("@omp-content-approval-");
		cwd = path.join(temp.path(), "work");
		fs.mkdirSync(cwd);
		previousAgentDir = getAgentDir();
		setAgentDir(temp.path());
		auth = await AuthStorage.create(path.join(temp.path(), "auth.db"));
		registry = new ModelRegistry(auth);
		manager = SessionManager.inMemory(cwd);
		settings = Settings.isolated({ "tools.approvalMode": "always-ask-cached", "fetch.enabled": false });
		toolSession = {
			cwd,
			settings,
			hasUI: true,
			modelRegistry: registry,
			sessionManager: manager,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(temp.path(), "artifacts"),
		};
		prompts = 0;
		answer = async () => "deny";
		runner = new ExtensionRunner([], new ExtensionRuntime(), cwd, manager, registry);
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
				getModel: () => undefined,
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
				select: async () => undefined,
				approve: async prompt => {
					prompts++;
					return answer(prompt);
				},
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
				theme: {} as never,
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "unavailable" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
	});

	afterEach(() => {
		auth.close();
		setAgentDir(previousAgentDir);
		temp.removeSync();
	});

	function execute<TParameters extends TSchema, TDetails>(
		tool: AgentTool<NoInfer<TParameters>, TDetails> & { parameters: TParameters },
		args: NoInfer<Static<TParameters>>,
	) {
		const context: AgentToolContext = {
			settings,
			sessionManager: manager,
			modelRegistry: registry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
		return new ExtensionToolWrapper(tool, runner).execute("boundary", args, undefined, undefined, context);
	}

	async function refuses<TParameters extends TSchema, TDetails>(
		tool: AgentTool<NoInfer<TParameters>, TDetails> & { parameters: TParameters },
		args: NoInfer<Static<TParameters>>,
		sensitive = PRIVATE,
	): Promise<void> {
		const output: string[] = [];
		let failure: unknown;
		try {
			output.push(JSON.stringify(await execute(tool, args)));
		} catch (error) {
			failure = error;
		}
		expect(output.join("\n")).not.toContain(sensitive);
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toMatch(/denied|approval|changed|identity|destination/i);
	}

	async function grant(path: string, scope: "folder" | "target" = "target") {
		answer = async () => ({ grant: scope, always: false });
		const result = await execute(new ReadTool(toolSession), { path });
		expect(JSON.stringify(result.content)).toContain("permitted-content");
		answer = async () => "deny";
	}

	it("does not disclose a private list member after a public URL", async () => {
		fs.writeFileSync(path.join(cwd, "notes.txt"), PRIVATE);
		await refuses(new ReadTool(toolSession), { path: "https://example.com/page;notes.txt" });
		expect(prompts).toBe(1);
	});

	it("requires every local list member, not a synthetic joined filename", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "b.txt"), PRIVATE);
		await grant("a.txt");
		await refuses(new ReadTool(toolSession), { path: "a.txt;b.txt" });
	});

	it("does not disclose AST matches outside an approved file", async () => {
		fs.writeFileSync(path.join(cwd, "a.js"), 'const value = "permitted-content";\n');
		fs.writeFileSync(path.join(cwd, "b.js"), `const value = "${PRIVATE}";\n`);
		await grant("a.js");
		await refuses(new AstGrepTool(toolSession), { pat: "$X", lang: "javascript", path: "b.js" });
	});

	it("does not use a selector base grant to disclose a literal colon filename", async () => {
		fs.writeFileSync(path.join(cwd, "notes"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "notes:1-2"), PRIVATE);
		await grant("notes");
		await refuses(new GrepTool(toolSession), { pattern: "protected", path: "notes:1-2" });
	});

	it("does not treat an absent selector base as harmless empty authorization", async () => {
		fs.writeFileSync(path.join(cwd, "notes:1-2"), PRIVATE);
		await refuses(new GrepTool(toolSession), { pattern: "protected", path: "notes:1-2" });
	});

	it("keeps fuzzy URL-named local contents private", async () => {
		fs.writeFileSync(path.join(cwd, "www.example.com"), PRIVATE);
		await refuses(new GrepTool(toolSession), { pattern: "protected", path: "www.example.com" });
	});

	it("requires approval before extracting and searching an archive member", async () => {
		await writeArchive(path.join(cwd, "bundle.zip"), "zip", [["data.txt", PRIVATE]]);
		await refuses(new GrepTool(toolSession), { pattern: "protected", path: "bundle.zip:data.txt" });
	});

	it("does not widen a folder grant to a multisegment child glob", async () => {
		fs.mkdirSync(path.join(cwd, "docs", "child"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "docs", "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "docs", "child", "protected.txt"), PRIVATE);
		await grant("docs/a.txt", "folder");
		const direct = await execute(new GlobTool(toolSession), { path: "docs/*.txt" });
		expect(JSON.stringify(direct.content)).toContain("a.txt");
		expect(JSON.stringify(direct.content)).not.toContain("protected.txt");
		await refuses(new GlobTool(toolSession), { path: "docs/*/*.txt" }, "protected.txt");
	});

	it("does not use a folder grant to disclose a child directory listing", async () => {
		fs.mkdirSync(path.join(cwd, "docs", "child"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "docs", "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "docs", "child", "protected.txt"), PRIVATE);
		await grant("docs/a.txt", "folder");
		await refuses(new ReadTool(toolSession), { path: "docs" }, "protected.txt");
	});

	it("reuses a valid exact grant without widening to another file", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "b.txt"), PRIVATE);
		await grant("a.txt");
		const repeated = await execute(new GrepTool(toolSession), { pattern: "permitted", path: "a.txt" });
		expect(JSON.stringify(repeated.content)).toContain("permitted-content");
		const ranged = await execute(new GrepTool(toolSession), { pattern: "permitted", path: "a.txt:1-1" });
		expect(JSON.stringify(ranged.content)).toContain("permitted-content");
		const raw = await execute(new ReadTool(toolSession), { path: "a.txt:raw" });
		expect(JSON.stringify(raw.content)).toContain("permitted-content");
		expect(prompts).toBe(1);
		await refuses(new ReadTool(toolSession), { path: "b.txt" });
	});

	it("reuses an approved tree for omitted roots and recursive globs", async () => {
		fs.mkdirSync(path.join(cwd, "docs"));
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "docs", "b.txt"), "permitted-child-content");
		answer = async () => ({ grant: "target", always: false });
		const initial = await execute(new GrepTool(toolSession), { pattern: "permitted", path: "." });
		expect(JSON.stringify(initial.content)).toContain("permitted-child-content");
		answer = async () => "deny";
		const omitted = await execute(new GrepTool(toolSession), { pattern: "permitted" });
		expect(JSON.stringify(omitted.content)).toContain("permitted-child-content");
		const glob = await execute(new GlobTool(toolSession), { path: "*.txt" });
		expect(JSON.stringify(glob.content)).toContain("b.txt");
		expect(prompts).toBe(1);
	});

	it("does not disclose a symlink destination changed while approval awaits", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "b.txt"), PRIVATE);
		const link = path.join(cwd, "current.txt");
		fs.symlinkSync("a.txt", link);
		answer = async () => {
			if (prompts > 1) return "deny";
			fs.unlinkSync(link);
			fs.symlinkSync("b.txt", link);
			return { grant: "target", always: false };
		};
		await refuses(new ReadTool(toolSession), { path: "current.txt" });
	});

	it("does not reuse an exact grant after the inode at that path changes", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "replacement.txt"), PRIVATE);
		await grant("a.txt");
		fs.renameSync(path.join(cwd, "replacement.txt"), path.join(cwd, "a.txt"));
		await refuses(new ReadTool(toolSession), { path: "a.txt" });
	});

	it("does not write through a destination changed while approval awaits", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "b.txt"), PRIVATE);
		const link = path.join(cwd, "current.txt");
		fs.symlinkSync("a.txt", link);
		answer = async () => {
			if (prompts > 1) return "deny";
			fs.unlinkSync(link);
			fs.symlinkSync("b.txt", link);
			return "once";
		};
		await refuses(new WriteTool(toolSession), { path: "current.txt", content: "replacement" });
		expect(fs.readFileSync(path.join(cwd, "a.txt"), "utf8")).toBe("permitted-content");
		expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe(PRIVATE);
	});

	it("executes a mounted command Once without recording a filesystem or session grant", async () => {
		const destination = path.join(cwd, "result.txt");
		fs.writeFileSync(destination, "original");
		const device = {
			name: "boundarywriter",
			label: "Writer",
			description: "Persist synthetic content",
			parameters: type({ content: "string" }),
			approval: "exec" as const,
			execute: async (_id: string, args: { content: string }) => {
				fs.writeFileSync(destination, args.content);
				return { content: [{ type: "text" as const, text: "saved" }] };
			},
		};
		const tools = new Map([[device.name, new ExtensionToolWrapper(device, runner)]]);
		toolSession = {
			...toolSession,
			toolRegistry: tools,
			isToolActive: name => name === "bash",
			toolCommands: {
				tools,
				mountedNames: new Set([device.name]),
				builtInNames: new Set(),
				isActive: () => false,
			},
		};
		answer = async () => "once";
		await execute(new BashTool(toolSession), {
			command: quotePosixArgv([device.name, "--json", JSON.stringify({ content: "approved" })]),
		});
		expect(fs.readFileSync(destination, "utf8")).toBe("approved");
		answer = async () => "deny";
		const denied = await execute(new BashTool(toolSession), {
			command: quotePosixArgv([device.name, "--json", JSON.stringify({ content: "unapproved" })]),
		});
		expect(denied.isError).toBe(true);
		expect(fs.readFileSync(destination, "utf8")).toBe("approved");
		expect(prompts).toBe(2);
	});

	it("does not dispatch a replacement command mounted while approval awaits", async () => {
		const first = path.join(cwd, "first.txt");
		const second = path.join(cwd, "second.txt");
		fs.writeFileSync(first, "original");
		fs.writeFileSync(second, PRIVATE);
		const deviceFor = (destination: string) => ({
			name: "boundarywriter",
			label: "Writer",
			description: "Persist synthetic content",
			parameters: type({ content: "string" }),
			approval: "exec" as const,
			execute: async (_id: string, args: { content: string }) => {
				fs.writeFileSync(destination, args.content);
				return { content: [{ type: "text" as const, text: "saved" }] };
			},
		});
		const initial = deviceFor(first);
		const tools = new Map([[initial.name, new ExtensionToolWrapper(initial, runner)]]);
		toolSession = {
			...toolSession,
			toolRegistry: tools,
			isToolActive: name => name === "bash",
			toolCommands: {
				tools,
				mountedNames: new Set([initial.name]),
				builtInNames: new Set(),
				isActive: () => false,
			},
		};
		answer = async () => {
			if (prompts > 1) return "deny";
			tools.set(initial.name, new ExtensionToolWrapper(deviceFor(second), runner));
			return "once";
		};
		const denied = await execute(new BashTool(toolSession), {
			command: quotePosixArgv([initial.name, "--json", JSON.stringify({ content: "unapproved" })]),
		});
		expect(denied.isError).toBe(true);
		expect(fs.readFileSync(first, "utf8")).toBe("original");
		expect(fs.readFileSync(second, "utf8")).toBe(PRIVATE);
	});

	it("revalidates a file protocol's destination after approval awaits", async () => {
		fs.writeFileSync(path.join(cwd, "a.txt"), "permitted-content");
		fs.writeFileSync(path.join(cwd, "b.txt"), PRIVATE);
		let destination = path.join(cwd, "a.txt");
		const router = InternalUrlRouter.instance();
		router.register({
			scheme: "approvalbound",
			spec: { backing: "file", selectors: "lines", immutable: false, linkable: true },
			locate: async () => destination,
			locateSync: () => destination,
			resolve: async url => {
				const content = fs.readFileSync(destination, "utf8");
				return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
			},
		});
		try {
			answer = async () => {
				if (prompts > 1) return "deny";
				destination = path.join(cwd, "b.txt");
				return "once";
			};
			await refuses(new ReadTool(toolSession), { path: "approvalbound://document" });
		} finally {
			router.unregister("approvalbound");
		}
	});

	it("does not execute a resource when destination identity cannot be derived", async () => {
		fs.writeFileSync(path.join(cwd, "data.txt"), PRIVATE);
		let reads = 0;
		const router = InternalUrlRouter.instance();
		router.register({
			scheme: "approvalresource",
			spec: { backing: "virtual", selectors: "lines", immutable: true },
			resolve: async url => {
				reads++;
				const content = fs.readFileSync(path.join(cwd, "data.txt"), "utf8");
				return { url: url.href, content, contentType: "text/plain", size: Buffer.byteLength(content) };
			},
		});
		try {
			answer = async () => "once";
			await refuses(new ReadTool(toolSession), { path: "approvalresource://document" });
			expect(reads).toBe(0);
			expect(fs.readFileSync(path.join(cwd, "data.txt"), "utf8")).toBe(PRIVATE);
		} finally {
			router.unregister("approvalresource");
		}
	});
});
