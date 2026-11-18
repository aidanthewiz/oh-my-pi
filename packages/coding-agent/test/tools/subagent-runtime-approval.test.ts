import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionUiController } from "@oh-my-pi/pi-coding-agent/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	ParentRuntimeApprovalError,
	type SubagentRuntimeApprovalHandler,
	type SubagentRuntimeApprovalRequest,
} from "@oh-my-pi/pi-coding-agent/tools/subagent-runtime-approval";
import * as runtimeApproval from "@oh-my-pi/pi-coding-agent/tools/subagent-runtime-approval";
import { cfgToolsApproval, cfgToolsApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { Container, TUI } from "@oh-my-pi/pi-tui";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme, getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { AbortError } from "@oh-my-pi/pi-utils/abortable";
import { RemoteAgentSession } from "../../src/thread/remote-agent-session";
import { setSubagentWorkerPoolForTests, SubagentWorkerPool } from "../../src/thread/subagent-worker";

const DCG_ENV = [
	"OMP_DCG_PATH",
	"OMP_DCG_VERSION",
	"OMP_DCG_BINARY_SHA256",
	"OMP_DCG_CONFIG",
	"OMP_DCG_CONFIG_SHA256",
] as const;
const originalFetch = globalThis.fetch;
const MOCK_API_SOURCE = "test/subagent-runtime-approval";

describe.skipIf(process.platform === "win32")("headless subagent runtime approval", () => {
	let root: string;
	let previous: Record<string, string | undefined>;
	let serial = 0;
	const sessions: AgentSession[] = [];
	const authStores: AuthStorage[] = [];
	const displays: TUI[] = [];
	let workerPool: SubagentWorkerPool | undefined;
	let restoreRoute: (() => void) | undefined;

	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Missing owned-fixture theme");
		setThemeInstance(theme);
		globalThis.fetch = Object.assign(
			async () => {
				throw new Error("Owned approval fixture refuses network");
			},
			{ preconnect: originalFetch.preconnect },
		);
		previous = Object.fromEntries(DCG_ENV.map(key => [key, process.env[key]]));
		root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-approval-"));
		const guard =
			'#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"decision":"ask","rule_id":"test:review","reason":"Review this owned fixture command"}\'\nexit 1\n';
		const config = '[packs]\nenabled = ["core"]\n';
		const guardPath = path.join(root, "guard");
		const configPath = path.join(root, "guard.toml");
		fs.writeFileSync(guardPath, guard, { mode: 0o755 });
		fs.writeFileSync(configPath, config);
		Object.assign(process.env, {
			OMP_DCG_PATH: guardPath,
			OMP_DCG_VERSION: "0.6.7",
			OMP_DCG_BINARY_SHA256: createHash("sha256").update(guard).digest("hex"),
			OMP_DCG_CONFIG: configPath,
			OMP_DCG_CONFIG_SHA256: createHash("sha256").update(config).digest("hex"),
		});
	});

	afterEach(async () => {
		restoreRoute?.();
		restoreRoute = undefined;
		await AgentLifecycleManager.global().dispose();
		AgentLifecycleManager.resetGlobalForTests();
		for (const session of sessions.splice(0)) await session.dispose();
		for (const display of displays.splice(0)) display.stop();
		for (const auth of authStores.splice(0)) auth.close();
		workerPool?.dispose();
		workerPool = undefined;
		setSubagentWorkerPoolForTests(undefined);
		AgentRegistry.resetGlobalForTests();
		unregisterCustomApis(MOCK_API_SOURCE);
	});

	afterAll(() => {
		globalThis.fetch = originalFetch;
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		AgentStorage.close();
		closeModelCache();
		removeSyncWithRetries(root);
	});

	async function child(
		parentRuntimeApproval?: SubagentRuntimeApprovalHandler,
		overrides: Partial<CreateAgentSessionOptions> = {},
	) {
		const cwd = path.join(root, `child-${++serial}`);
		fs.mkdirSync(cwd);
		const authStorage = await AuthStorage.create(":memory:");
		authStores.push(authStorage);
		const settings = Settings.isolated({
			"async.enabled": false,
			"launch.enabled": false,
			"bash.autoBackground.enabled": false,
			"bashInterceptor.enabled": false,
			"tools.approvalMode": "yolo",
			"approval.notify": "off",
			"compaction.enabled": false,
		});
		const options = {
			cwd,
			agentDir: cwd,
			authStorage,
			sessionManager: SessionManager.inMemory(cwd),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			agentId: "ApprovalChild",
			parentAgentId: "Main",
			taskDepth: 1,
			hasUI: false,
			toolNames: ["bash"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] },
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			parentRuntimeApproval,
			...overrides,
		} satisfies CreateAgentSessionOptions;
		const { session } = await createAgentSession(options);
		sessions.push(session);
		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error;
			},
		});
		const bash = session.getToolForEvalBridge("bash");
		if (!bash) throw new Error("Missing child bash tool");
		const bridgeSession = {
			cwd,
			hasUI: options.hasUI ?? false,
			settings: options.settings,
			getSessionFile: () => null,
			getToolForEvalBridge: (name: string) => session.getToolForEvalBridge(name),
			getToolByName: (name: string) => session.getToolByName(name),
		} as ToolSession;
		return { session, cwd, bash, bridgeSession, settings: options.settings };
	}

	async function parent(mode: "tui" | "rpc" = "tui", overrides: Partial<CreateAgentSessionOptions> = {}) {
		const fixture = await child(undefined, {
			agentId: "Main",
			parentAgentId: undefined,
			taskDepth: 0,
			hasUI: true,
			...overrides,
		});
		const terminal = new VirtualTerminal(160, 60);
		const display = new TUI(terminal);
		const editor = new CustomEditor(getEditorTheme());
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		display.addChild(editorContainer);
		display.setFocus(editor);
		const context = {
			ui: display,
			editor,
			editorContainer,
			session: fixture.session,
			composer: { rowsBelow: () => undefined },
			closeLinkBrowser: () => undefined,
		} as unknown as InteractiveModeContext;
		const controller = new ExtensionUiController(context);
		const runner = fixture.session.extensionRunner;
		if (!runner) throw new Error("Missing parent extension runner");
		const uiContext: ExtensionUIContext = {
			...runner.getUIContext(),
			select: (title, options, dialogOptions) => controller.showCollabAwareSelector(title, options, dialogOptions),
		};
		await initializeExtensions(fixture.session, {
			mode,
			uiContext,
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error;
			},
		});
		display.start();
		displays.push(display);
		return { ...fixture, terminal, display, context, uiContext };
	}

	async function reinitializeParent(owner: { session: AgentSession; uiContext: ExtensionUIContext }): Promise<void> {
		await initializeExtensions(owner.session, {
			mode: "tui",
			uiContext: owner.uiContext,
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error;
			},
		});
	}

	it("runs the reviewed child command once through Eval without enabling general child UI", async () => {
		const owner = await parent();
		const route = owner.session.extensionRunner?.getSubagentRuntimeApproval();
		if (!route) throw new Error("Missing owned parent approval route");
		const requested = Promise.withResolvers<SubagentRuntimeApprovalRequest>();
		let requests = 0;
		const fixture = await child(async (request, signal) => {
			if (++requests > 1) return { decision: "denied" };
			requested.resolve(request);
			return await route(request, signal);
		});
		const marker = path.join(fixture.cwd, "approved.txt");
		const args = {
			command: `printf reviewed >> ${JSON.stringify(marker)}`,
			cwd: fixture.cwd,
			timeout: 10,
			pty: false,
		};
		const execution = callSessionTool("bash", args, { session: fixture.bridgeSession });
		const request = await Promise.race([
			requested.promise,
			execution.then(() => {
				throw new Error("Child executed without requesting approval");
			}),
		]);
		expect(fs.existsSync(marker)).toBeFalse();
		expect(fixture.session.extensionRunner?.hasUI()).toBeFalse();
		expect(request.agentId).toBe("ApprovalChild");
		expect(request.sessionId).toBe(fixture.session.sessionId);
		expect(request.args).toMatchObject(args);
		expect(request.approval.prompt).toContain(JSON.stringify(args.command));
		expect(request.approval.prompt).toContain("test:review");
		await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined);
		expect(owner.context.hookSelector).toBeDefined();
		owner.terminal.sendInput("\x1b[B");
		owner.terminal.sendInput("\r");
		await execution;
		expect(fs.readFileSync(marker, "utf8")).toBe("reviewed");
		await expect(fixture.bash.execute("unapproved-next-call", args)).rejects.toMatchObject({
			code: "parent_approval_denied",
			decision: "denied",
		});
		expect(requests).toBe(2);
		expect(fs.readFileSync(marker, "utf8")).toBe("reviewed");
	}, 30_000);

	it("denies a forwarded request without running or remembering the command", async () => {
		const fixture = await child(async () => ({ decision: "denied" }));
		const marker = path.join(fixture.cwd, "denied.txt");
		await expect(
			callSessionTool(
				"bash",
				{ command: `printf denied > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession },
			),
		).rejects.toMatchObject({ code: "parent_approval_denied", decision: "denied" });
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it("ignores a late approval after the caller cancels", async () => {
		const owner = await parent();
		const route = owner.session.extensionRunner?.getSubagentRuntimeApproval();
		if (!route) throw new Error("Missing owned parent approval route");
		const approved = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const hostSettled = Promise.withResolvers<void>();
		const fixture = await child(async (request, signal) => {
			try {
				const result = await route(request, signal);
				approved.resolve();
				await release.promise;
				return result;
			} finally {
				hostSettled.resolve();
			}
		});
		const marker = path.join(fixture.cwd, "cancelled.txt");
		const controller = new AbortController();
		const settled = callSessionTool(
			"bash",
			{ command: `printf cancelled > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
			{ session: fixture.bridgeSession, signal: controller.signal },
		).then(
			() => "executed",
			(error: unknown) => error,
		);
		try {
			await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined);
			expect(owner.context.hookSelector).toBeDefined();
			owner.terminal.sendInput("\x1b[B");
			owner.terminal.sendInput("\r");
			await Promise.race([
				approved.promise,
				settled.then(() => {
					throw new Error("Child settled before the approved host response handshake");
				}),
			]);
			controller.abort();
			expect(await settled).toBeInstanceOf(AbortError);
			expect(fs.existsSync(marker)).toBeFalse();
		} finally {
			release.resolve();
			controller.abort();
			await settled;
			await hostSettled.promise;
		}
		expect(fs.existsSync(marker)).toBeFalse();
	}, 30_000);

	it.each(["yolo", "explicit-allow"] as const)(
		"executes reviewed child bytes through the actual parent selector under %s policy",
		async policy => {
			const owner = await parent();
			if (policy === "explicit-allow") {
				cfgToolsApprovalMode.override(owner.settings, "always-ask");
				cfgToolsApproval.override(owner.settings, { bash: "allow" });
			}
			const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
			const marker = path.join(fixture.cwd, "parent-approved.txt");
			const command = `printf parent-reviewed > ${JSON.stringify(marker)}`;
			const execution = callSessionTool("bash", { command, cwd: fixture.cwd }, { session: fixture.bridgeSession });
			await owner.terminal.waitForRender(() =>
				owner.terminal.getScrollBuffer().join("\n").includes("ApprovalChild"),
			);
			expect(owner.context.hookSelector).toBeDefined();
			const screen = owner.terminal.getScrollBuffer().join("\n");
			expect(screen).toContain("ApprovalChild");
			expect(screen).toContain(fixture.cwd);
			expect(screen).toContain("test:review");
			expect(fs.existsSync(marker)).toBeFalse();
			owner.terminal.sendInput("\x1b[B");
			owner.terminal.sendInput("\r");
			await execution;
			expect(fs.readFileSync(marker, "utf8")).toBe("parent-reviewed");
			expect(owner.context.hookSelector).toBeUndefined();
		},
	);

	it.each(["reinitialize", "replace-root"] as const)(
		"refuses stale parent approval during the approved child event after %s",
		async retirement => {
			const owner = await parent();
			const ownerSignal = owner.session.extensionRunner!.getUIContextSignal();
			const approved = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			let prompts = 0;
			const select = owner.uiContext.select;
			owner.uiContext.select = (...args) => {
				prompts++;
				return select(...args);
			};
			const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval(), {
				extensions: [
					api => {
						api.on("tool_approval_resolved", async event => {
							if (event.toolName !== "bash" || !event.approved) return;
							approved.resolve();
							await release.promise;
						});
					},
				],
			});
			const marker = path.join(fixture.cwd, "stale-approved-event.txt");
			let finished = false;
			const settled = callSessionTool(
				"bash",
				{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession, signal: controller.signal },
			)
				.then(
					value => ({ value }),
					(error: unknown) => ({ error }),
				)
				.finally(() => {
					finished = true;
				});
			try {
				await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined || finished);
				expect(owner.context.hookSelector).toBeDefined();
				owner.terminal.sendInput("\x1b[B");
				owner.terminal.sendInput("\r");
				await Promise.race([
					approved.promise,
					settled.then(() => {
						throw new Error("Child settled before the approved event handshake");
					}),
				]);
				expect(owner.context.hookSelector).toBeUndefined();
				expect(fs.existsSync(marker)).toBeFalse();
				if (retirement === "reinitialize") {
					await reinitializeParent(owner);
					expect(ownerSignal.aborted).toBeTrue();
				} else {
					const registry = AgentRegistry.global();
					const origin = registry.get("Main");
					if (!origin) throw new Error("Missing owned root identity");
					registry.register({
						id: origin.id,
						displayName: origin.displayName,
						kind: origin.kind,
						parentId: origin.parentId,
						session: origin.session,
						sessionFile: origin.sessionFile,
						status: origin.status,
					});
					expect(registry.get("Main")).not.toBe(origin);
				}
				expect(controller.signal.aborted).toBeFalse();
				release.resolve();
				const outcome = await settled;
				expect(fs.existsSync(marker)).toBeFalse();
				const refusal = "error" in outcome ? outcome.error : undefined;
				expect(refusal).toBeInstanceOf(ParentRuntimeApprovalError);
				expect(refusal).toMatchObject({
					code: "parent_approval_unavailable",
					decision: "unavailable",
					reason: "state-changed",
				});
				expect(controller.signal.aborted).toBeFalse();
				expect(prompts).toBe(1);
				expect(owner.context.hookSelector).toBeUndefined();
				expect(fs.existsSync(marker)).toBeFalse();
			} finally {
				release.resolve();
				controller.abort();
				await settled;
			}
		},
	);

	it.each(["parent", "child-deny", "input"] as const)(
		"refuses stale %s approval after Bash output-artifact allocation",
		async drift => {
			const owner = await parent();
			const ownerSignal = owner.session.extensionRunner!.getUIContextSignal();
			const rootPolicy = structuredClone(cfgToolsApproval.get(owner.settings));
			const allocating = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			let approved = false;
			let prompts = 0;
			const select = owner.uiContext.select;
			owner.uiContext.select = (...args) => {
				prompts++;
				return select(...args);
			};
			const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval(), {
				extensions: [
					api => {
						api.on("tool_approval_resolved", event => {
							if (event.toolName === "bash" && event.approved) approved = true;
						});
					},
				],
			});
			const allocate = fixture.session.sessionManager.allocateArtifactPath.bind(fixture.session.sessionManager);
			const allocation = spyOn(fixture.session.sessionManager, "allocateArtifactPath").mockImplementation(
				async toolType => {
					if (toolType === "bash") {
						allocating.resolve();
						await release.promise;
					}
					return await allocate(toolType);
				},
			);
			const marker = path.join(fixture.cwd, "stale-bash-allocation.txt");
			const args = { command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd };
			let finished = false;
			const execution =
				drift === "input"
					? fixture.bash.execute("stale-allocation-input", args, controller.signal)
					: callSessionTool("bash", args, { session: fixture.bridgeSession, signal: controller.signal });
			const settled = execution
				.then(
					value => ({ value }),
					(error: unknown) => ({ error }),
				)
				.finally(() => {
					finished = true;
				});
			try {
				await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined || finished);
				expect(owner.context.hookSelector).toBeDefined();
				owner.terminal.sendInput("\x1b[B");
				owner.terminal.sendInput("\r");
				await Promise.race([
					allocating.promise,
					settled.then(() => {
						throw new Error("Child settled before the Bash allocation handshake");
					}),
				]);
				expect(approved).toBeTrue();
				expect(owner.context.hookSelector).toBeUndefined();
				expect(fs.existsSync(marker)).toBeFalse();
				if (drift === "parent") {
					await reinitializeParent(owner);
					expect(ownerSignal.aborted).toBeTrue();
				} else {
					if (drift === "child-deny") cfgToolsApproval.override(fixture.settings, { bash: "deny" });
					else args.command = `printf changed > ${JSON.stringify(marker)}`;
					expect(owner.session.extensionRunner!.getUIContextSignal()).toBe(ownerSignal);
					expect(ownerSignal.aborted).toBeFalse();
					expect(cfgToolsApproval.get(owner.settings)).toEqual(rootPolicy);
				}
				expect(controller.signal.aborted).toBeFalse();
				release.resolve();
				const outcome = await settled;
				expect(fs.existsSync(marker)).toBeFalse();
				const refusal = "error" in outcome ? outcome.error : undefined;
				expect(refusal).toBeInstanceOf(ParentRuntimeApprovalError);
				expect(refusal).toMatchObject({
					code: "parent_approval_unavailable",
					decision: "unavailable",
					reason: "state-changed",
				});
				expect(controller.signal.aborted).toBeFalse();
				expect(prompts).toBe(1);
				expect(owner.context.hookSelector).toBeUndefined();
				expect(fs.existsSync(marker)).toBeFalse();
			} finally {
				release.resolve();
				await settled;
				controller.abort();
				allocation.mockRestore();
			}
		},
	);

	it.each(["deny", "escape", "cancel", "dispose", "reinitialize"] as const)(
		"refuses the owned child after parent TUI %s",
		async action => {
			const owner = await parent();
			const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
			const marker = path.join(fixture.cwd, `${action}.txt`);
			const controller = new AbortController();
			const execution = callSessionTool(
				"bash",
				{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession, signal: controller.signal },
			);
			const settled = execution.then(
				() => "executed",
				(error: unknown) => error,
			);
			await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined);
			expect(owner.context.hookSelector).toBeDefined();
			if (action === "deny") owner.terminal.sendInput("\r");
			else if (action === "escape") owner.terminal.sendInput("\x1b");
			else if (action === "cancel") controller.abort();
			else if (action === "dispose") await owner.session.dispose();
			else
				await initializeExtensions(owner.session, {
					mode: "tui",
					uiContext: owner.uiContext,
					reportSendError: (_action, error) => {
						throw error;
					},
					reportRuntimeError: error => {
						throw error;
					},
				});
			const refusal = await settled;
			expect(refusal).toBeInstanceOf(Error);
			if (action === "deny") expect(refusal).toMatchObject({ code: "parent_approval_denied", decision: "denied" });
			if (action === "escape")
				expect(refusal).toMatchObject({
					code: "parent_approval_cancelled",
					decision: "cancelled",
					reason: "selector-cancelled",
				});
			expect(owner.context.hookSelector).toBeUndefined();
			owner.terminal.sendInput("\x1b[B");
			owner.terminal.sendInput("\r");
			expect(fs.existsSync(marker)).toBeFalse();
		},
	);

	it("keeps RPC parents from supplying the child approval host", async () => {
		const owner = await parent("rpc");
		const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
		const marker = path.join(fixture.cwd, "rpc.txt");
		await expect(
			callSessionTool(
				"bash",
				{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession },
			),
		).rejects.toThrow(/runtime approval but no interactive UI/);
		expect(owner.context.hookSelector).toBeUndefined();
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it("retires the old capability after a real session-id change and requires fresh approval", async () => {
		const owner = await parent();
		const originalId = owner.session.sessionId;
		const originalRoute = owner.session.extensionRunner?.getSubagentRuntimeApproval();
		const retired = await child(originalRoute);
		const oldMarker = path.join(retired.cwd, "retired.txt");
		expect(await owner.session.newSession()).toBeTrue();
		expect(owner.session.sessionId).not.toBe(originalId);
		await expect(
			callSessionTool(
				"bash",
				{ command: `printf forbidden > ${JSON.stringify(oldMarker)}`, cwd: retired.cwd },
				{ session: retired.bridgeSession },
			),
		).rejects.toMatchObject({
			code: "parent_approval_unavailable",
			decision: "unavailable",
			reason: "host-retired",
		});
		expect(owner.context.hookSelector).toBeUndefined();
		expect(fs.existsSync(oldMarker)).toBeFalse();
		const current = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval(), {
			agentId: "FreshApprovalChild",
		});
		const marker = path.join(current.cwd, "fresh.txt");
		let finished = false;
		const settled = callSessionTool(
			"bash",
			{ command: `printf freshly-reviewed > ${JSON.stringify(marker)}`, cwd: current.cwd },
			{ session: current.bridgeSession },
		)
			.then(
				value => ({ value }),
				(error: unknown) => ({ error }),
			)
			.finally(() => {
				finished = true;
			});
		await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined || finished);
		if (!owner.context.hookSelector) {
			const outcome = await settled;
			if ("error" in outcome) throw outcome.error;
			throw new Error("Fresh session command completed without its required selector");
		}
		expect(fs.existsSync(marker)).toBeFalse();
		owner.terminal.sendInput("\x1b[B");
		owner.terminal.sendInput("\r");
		const outcome = await settled;
		if ("error" in outcome) throw outcome.error;
		expect(fs.readFileSync(marker, "utf8")).toBe("freshly-reviewed");
	}, 30_000);

	it.each(["deny", "prompt"] as const)("never forwards a concurrent child %s policy", async policy => {
		let requests = 0;
		const fixture = await child(async () => {
			requests++;
			return { decision: "denied" };
		});
		cfgToolsApproval.override(fixture.settings, { bash: policy });
		const marker = path.join(fixture.cwd, `child-${policy}.txt`);
		await expect(
			callSessionTool(
				"bash",
				{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession },
			),
		).rejects.toThrow();
		expect(requests).toBe(0);
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it.each(["deny", "prompt"] as const)(
		"reports the parent's %s policy as unavailable without a dialog",
		async policy => {
			const owner = await parent();
			cfgToolsApproval.override(owner.settings, { bash: policy });
			const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
			const marker = path.join(fixture.cwd, `root-${policy}.txt`);
			await expect(
				callSessionTool(
					"bash",
					{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
					{ session: fixture.bridgeSession },
				),
			).rejects.toMatchObject({
				code: "parent_approval_unavailable",
				decision: "unavailable",
				reason: "parent-policy",
			});
			expect(owner.context.hookSelector).toBeUndefined();
			expect(fs.existsSync(marker)).toBeFalse();
		},
	);

	it.each(["input", "authority"] as const)("refuses %s drift without prompting again or executing", async drift => {
		const owner = await parent();
		const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
		const marker = path.join(fixture.cwd, "drift.txt");
		const args = { command: `printf original > ${JSON.stringify(marker)}`, cwd: fixture.cwd };
		const settled = fixture.bash.execute("drifting-call", args).then(
			() => "executed",
			(error: unknown) => error,
		);
		await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined);
		expect(owner.context.hookSelector).toBeDefined();
		if (drift === "input") args.command = `printf changed > ${JSON.stringify(marker)}`;
		else cfgToolsApprovalMode.override(owner.settings, "always-ask");
		owner.terminal.sendInput("\x1b[B");
		owner.terminal.sendInput("\r");
		const refusal = await settled;
		expect(refusal).toBeInstanceOf(Error);
		if (drift === "authority")
			expect(refusal).toMatchObject({
				code: "parent_approval_unavailable",
				decision: "unavailable",
				reason: "state-changed",
			});
		expect(owner.context.hookSelector).toBeUndefined();
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it("routes a headless grandchild through the same root with its complete engine identity chain", async () => {
		const owner = await parent();
		const intermediate = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
		const fixture = await child(intermediate.session.extensionRunner?.getSubagentRuntimeApproval(), {
			agentId: "ApprovalGrandchild",
			parentAgentId: "ApprovalChild",
			taskDepth: 2,
		});
		const marker = path.join(fixture.cwd, "nested.txt");
		const execution = callSessionTool(
			"bash",
			{ command: `printf nested-reviewed > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
			{ session: fixture.bridgeSession },
		);
		await owner.terminal.waitForRender(() =>
			owner.terminal.getScrollBuffer().join("\n").includes("ApprovalGrandchild"),
		);
		const screen = owner.terminal.getScrollBuffer().join("\n");
		expect(screen).toContain("ApprovalChild");
		expect(screen).toContain("ApprovalGrandchild");
		expect(fs.existsSync(marker)).toBeFalse();
		owner.terminal.sendInput("\x1b[B");
		owner.terminal.sendInput("\r");
		await execution;
		expect(fs.readFileSync(marker, "utf8")).toBe("nested-reviewed");
	});

	it("refuses a requester registry replacement made while its approval is open", async () => {
		const owner = await parent();
		const fixture = await child(owner.session.extensionRunner?.getSubagentRuntimeApproval());
		const marker = path.join(fixture.cwd, "replaced.txt");
		const settled = callSessionTool(
			"bash",
			{ command: `printf forbidden > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
			{ session: fixture.bridgeSession },
		).then(
			() => "executed",
			(error: unknown) => error,
		);
		await owner.terminal.waitForRender(() => owner.context.hookSelector !== undefined);
		expect(owner.context.hookSelector).toBeDefined();
		const registry = AgentRegistry.global();
		const origin = registry.get("ApprovalChild");
		if (!origin) throw new Error("Missing owned requester identity");
		registry.register({
			id: origin.id,
			displayName: origin.displayName,
			kind: origin.kind,
			parentId: origin.parentId,
			session: origin.session,
			sessionFile: origin.sessionFile,
			status: origin.status,
		});
		owner.terminal.sendInput("\x1b[B");
		owner.terminal.sendInput("\r");
		expect(await settled).toBeInstanceOf(Error);
		expect(owner.context.hookSelector).toBeUndefined();
		expect(fs.existsSync(marker)).toBeFalse();
	});

	it.each(["main", "worker", "mutated-worker"] as const)(
		"carries the live route through an actual task spawn on %s",
		async placement => {
			const marker = path.join(root, `task-effect-${placement}.txt`);
			const command = `printf task-reviewed > ${JSON.stringify(marker)}`;
			let bashResultIsError = false;
			let bashOutcome: unknown;
			let mutations = 0;
			const model = createMockModel({
				id: "approval-fixture",
				handler: context => {
					const ranBash = context.messages.findLast(
						message => message.role === "toolResult" && message.toolName === "bash",
					);
					if (ranBash?.role === "toolResult") bashResultIsError = ranBash.isError === true;
					bashOutcome = ranBash;
					return ranBash
						? {
								content: [
									{ type: "toolCall", name: "yield", arguments: { type: "result", data: { reviewed: true } } },
								],
							}
						: { content: [{ type: "toolCall", name: "bash", arguments: { command } }] };
				},
			});
			const authStorage = await AuthStorage.create(":memory:");
			authStores.push(authStorage);
			authStorage.keys.setRuntime("mock", "owned-fixture");
			const modelRegistry = new ModelRegistry(authStorage);
			modelRegistry.registerProvider("mock", {
				api: model.api,
				baseUrl: model.baseUrl,
				apiKey: "owned-fixture",
				streamSimple: (candidate, context, options) => model.stream(candidate, context, options),
				models: [{ ...toModelSpec(model), contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
			});
			registerCustomApi(
				model.api,
				(candidate, context, options) => model.stream(candidate, context, options),
				MOCK_API_SOURCE,
			);
			const registeredModel = modelRegistry.find("mock", model.id);
			if (!registeredModel) throw new Error("Missing registered approval fixture model");
			if (placement !== "main") {
				workerPool = new SubagentWorkerPool({ maxWorkers: () => 1, hostsOnMain: false });
				setSubagentWorkerPoolForTests(workerPool);
			}
			if (placement === "mutated-worker") {
				const createHandler = runtimeApproval.createSubagentRuntimeApprovalHandler;
				const spy = spyOn(runtimeApproval, "createSubagentRuntimeApprovalHandler").mockImplementation(options => {
					const route = createHandler(options);
					return async (request, signal) => {
						const result = await route(request, signal);
						if (result.decision === "approved") {
							Reflect.set(request, "toolCallId", `${request.toolCallId}-changed`);
							mutations++;
						}
						return result;
					};
				});
				restoreRoute = () => spy.mockRestore();
			}
			const owner = await parent("tui", {
				model: registeredModel,
				modelRegistry,
				authStorage,
				toolNames: ["bash", "task"],
				inheritedSessionAgents: [
					{
						name: "owned-approval",
						description: "One owned approval fixture",
						source: "project",
						systemPrompt: "Run the owned fixture command, then yield its result.",
						tools: ["bash"],
						model: ["mock/approval-fixture"],
					},
				],
				settings: Settings.isolated({
					"async.enabled": false,
					"task.batch": false,
					"task.structured": true,
					"task.isolation.enabled": false,
					"task.enableLsp": false,
					"task.agentIdleTtlMs": 0,
					"memory.backend": "off",
					"compaction.enabled": false,
					"retry.enabled": false,
					"todo.enabled": false,
					"advisor.enabled": false,
					"bashInterceptor.enabled": false,
					"bash.autoBackground.enabled": false,
					"launch.enabled": false,
					"approval.notify": "off",
					"tools.approvalMode": "yolo",
					modelRoles: {
						default: "mock/approval-fixture",
						task: "mock/approval-fixture",
						smol: "mock/approval-fixture",
					},
				}),
				enableIrc: false,
				skipPythonPreflight: true,
				cacheWarming: false,
			});
			let finished = false;
			const settled = callSessionTool(
				"task",
				{
					name: "OwnedSpawn",
					agent: "owned-approval",
					task: "Run the one owned command.",
					solutionSpace: "One exact synthetic command.",
					outputSchema: {
						type: "object",
						properties: { reviewed: { type: "boolean" } },
						required: ["reviewed"],
						additionalProperties: false,
					},
					contextFilePolicy: "none",
				},
				{ session: owner.bridgeSession },
			)
				.then(
					value => ({ value }),
					(error: unknown) => ({ error }),
				)
				.finally(() => {
					finished = true;
				});
			await owner.terminal.waitForRender(
				() => owner.terminal.getScrollBuffer().join("\n").includes("OwnedSpawn") || finished,
			);
			if (finished || !owner.context.hookSelector)
				throw new Error(`Task ended before approval: ${JSON.stringify({ task: await settled, bashOutcome })}`);
			expect(owner.terminal.getScrollBuffer().join("\n")).toContain("OwnedSpawn");
			const childSession = AgentRegistry.global().get("OwnedSpawn")?.session;
			if (!childSession) throw new Error("Missing spawned approval child");
			expect(childSession instanceof RemoteAgentSession).toBe(placement !== "main");
			expect(fs.existsSync(marker)).toBeFalse();
			owner.terminal.sendInput("\x1b[B");
			owner.terminal.sendInput("\r");
			const result = await settled;
			if ("error" in result) throw result.error;
			expect(result.value).toMatchObject({ details: { results: [{ exitCode: 0 }] } });
			expect(mutations).toBe(placement === "mutated-worker" ? 1 : 0);
			if (placement === "mutated-worker") expect(fs.existsSync(marker)).toBeFalse();
			else expect(fs.readFileSync(marker, "utf8")).toBe("task-reviewed");
			expect(bashResultIsError).toBe(placement === "mutated-worker");
		},
	);

	it("preserves fail-closed refusal when no live parent approval route exists", async () => {
		const fixture = await child();
		const marker = path.join(fixture.cwd, "headless.txt");
		await expect(
			callSessionTool(
				"bash",
				{ command: `printf headless > ${JSON.stringify(marker)}`, cwd: fixture.cwd },
				{ session: fixture.bridgeSession },
			),
		).rejects.toThrow(/runtime approval but no interactive UI/);
		expect(fs.existsSync(marker)).toBeFalse();
	});
});
