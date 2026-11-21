import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import {
	cfgBrowserCdpUrl,
	cfgBrowserCmux,
	cfgBrowserEnabled,
	cfgBrowserRelay,
	cfgBrowserTern,
} from "@oh-my-pi/pi-coding-agent/tools/browser/settings";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Guards the SDK/session boundary: browser and computer stay outside the tool
// registry while their eval preludes follow live, session-local settings.
describe("AgentSession eval preludes", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-computer-toggle-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.keys.setRuntime("google", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		await authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("updates enabled preludes without registering browser or computer tools", async () => {
		const settings = Settings.isolated({
			"browser.enabled": false,
			"browser.relay": false,
			"browser.relayUrl": "http://127.0.0.1:19334",
			"archive.enabled": false,
			"commit.enabled": false,
			"disassembler.backend": "none",
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		expect(session.getAllToolNames()).not.toContain("computer");
		expect(session.getAllToolNames()).not.toContain("browser");
		expect(session.getEnabledToolNames()).not.toContain("computer");
		expect(session.getEnabledToolNames()).not.toContain("browser");
		expect(session.getEvalPreludes()).toEqual([]);

		cfgComputerEnabled.override(session.settings, true);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["computer"]);
		expect(session.getAllToolNames()).not.toContain("computer");
		// Setting listeners queue the prompt refresh on the next microtask; the no-op mutation serializes behind it.
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);

		cfgComputerEnabled.override(session.settings, false);
		expect(session.getEvalPreludes()).toEqual([]);
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => undefined);

		const browserReconciled = Promise.withResolvers<void>();
		const refresh = session.refreshBaseSystemPrompt.bind(session);
		const refreshSpy = vi.spyOn(session, "refreshBaseSystemPrompt").mockImplementation(async (...args) => {
			await refresh(...args);
			browserReconciled.resolve();
		});
		cfgBrowserEnabled.override(session.settings, true);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["browser"]);
		expect(session.getAllToolNames()).not.toContain("browser");
		// The prefix assertion below depends on browser.enabled finishing its asynchronous MCP-filter reconcile.
		await browserReconciled.promise;
		refreshSpy.mockRestore();

		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;
		await session.prompt("first browser turn");
		const prefix = session.agent.state.systemPrompt.join("\n\n");
		const browserGuidance = session.getEvalPreludes().find(prelude => prelude.name === "browser")?.guidance;
		cfgBrowserRelay.override(settings, true);
		const relayGuidance = session.getEvalPreludes().find(prelude => prelude.name === "browser")?.guidance;
		expect(relayGuidance).not.toBe(browserGuidance);
		await session.prompt("relay browser turn");
		expect(session.agent.state.systemPrompt.join("\n\n")).toBe(prefix);
		const notices = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "eval-prelude-notice",
		);
		expect(notices).toMatchObject([
			{
				display: false,
				details: {
					added: [],
					removed: [],
					guidance: { browser: relayGuidance },
				},
			},
		]);
		await session.prompt("unchanged relay turn");
		expect(
			session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "eval-prelude-notice",
			),
		).toHaveLength(notices.length);

		const gemini = getBundledModel("google", "gemini-2.5-flash");
		if (!gemini) throw new Error("Expected bundled Google Gemini model to exist");
		await session.setModel(gemini);
		expect(session.model).toBe(gemini);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["browser"]);
	});

	// `/computer on` mid-session used to rebuild the system prompt and eval
	// description, busting the provider prompt cache on the next request.
	it("announces mid-session toggles in a hidden notice without rewriting the cached prefix", async () => {
		const settings = Settings.isolated({
			"browser.enabled": false,
			"archive.enabled": false,
			"commit.enabled": false,
			"disassembler.backend": "none",
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		const mock = createMockModel({ handler: { content: ["ok"] } });
		session.agent.streamFn = mock.stream;
		const toggle = async (enabled: boolean) => {
			cfgComputerEnabled.override(settings, enabled);
			await Promise.resolve();
			await session.runToolRegistryMutation(async () => undefined);
		};
		const prefix = (context: Context) => ({
			systemPrompt: context.systemPrompt,
			eval: context.tools?.find(tool => tool.name === "eval")?.description,
		});
		const requestText = (context: Context) =>
			context.messages
				.flatMap(message =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
				)
				.join("\n");

		await session.prompt("first");
		await toggle(true);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["computer"]);
		const computerGuidance = session.getEvalPreludes()[0]?.guidance;
		if (!computerGuidance) throw new Error("Expected enabled computer prelude guidance");
		await session.prompt("second");
		await toggle(false);
		await session.prompt("third");
		await session.prompt("fourth");

		const [first, second, third, fourth] = mock.calls.map(call => call.context);
		expect(prefix(second!)).toEqual(prefix(first!));
		expect(prefix(third!)).toEqual(prefix(first!));
		expect(prefix(first!).eval).not.toContain("xd://eval/computer");

		const notices = session.agent.state.messages.filter(
			message => message.role === "custom" && message.customType === "eval-prelude-notice",
		);
		expect(notices.map(notice => (notice.role === "custom" ? notice.details : undefined))).toMatchObject([
			{ added: ["computer"], removed: [] },
			{ added: [], removed: ["computer"] },
		]);
		const secondText = requestText(second!);
		expect(secondText).toContain("xd://eval/computer");
		expect(secondText).toContain(computerGuidance);
		expect(requestText(fourth!).match(/<system-notice id="prelude-extension">/g)).toHaveLength(2);
	});

	it("refreshes same-name browser guidance without changing earlier prompt snapshots or leaking endpoints", async () => {
		const envKeys = [
			"PI_BROWSER_RELAY",
			"PI_BROWSER_TERN",
			"PI_BROWSER_CMUX",
			"TERN_PANE_SOCKET",
			"TERN_PANE",
			"CMUX_SOCKET_PATH",
		] as const;
		const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
		for (const key of envKeys) delete process.env[key];
		try {
			const settings = Settings.isolated({
				"browser.enabled": true,
				"browser.relay": false,
				"browser.tern": false,
				"browser.relayUrl": "http://127.0.0.1:19334",
				"browser.cmux": false,
				"archive.enabled": false,
			});
			const { session } = await createAgentSession({
				cwd: registryDir,
				agentDir: registryDir,
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			sessions.push(session);
			const mock = createMockModel({ handler: { content: ["ok"] } });
			session.agent.streamFn = mock.stream;
			const original = session.getEvalPreludes().find(prelude => prelude.name === "browser");
			if (!original) throw new Error("Expected the enabled browser prelude");
			const originalGuidance = original.guidance;
			if (!originalGuidance) throw new Error("Expected browser session guidance");
			await session.prompt("baseline");
			const baselinePrompt = structuredClone(mock.calls[0]!.context.systemPrompt);
			const baselineEval = mock.calls[0]!.context.tools?.find(tool => tool.name === "eval")?.description;
			const guidanceChanges: Array<string | undefined> = [];

			const endpoint =
				"http://synthetic-user:synthetic-password@127.0.0.1:19333/secret-path?token=secret-token&session=secret-session#secret-fragment";
			cfgBrowserCdpUrl.override(settings, endpoint);
			cfgBrowserRelay.override(settings, true);
			const relay = session.getEvalPreludes().find(prelude => prelude.name === "browser");
			if (!relay) throw new Error("Expected the enabled relay prelude");
			const relayGuidance = relay.guidance;
			expect(relayGuidance).not.toBe(originalGuidance);
			guidanceChanges.push(relayGuidance);
			await session.prompt("step one");

			cfgBrowserCdpUrl.override(settings, "");
			cfgBrowserTern.override(settings, true);
			process.env.TERN_PANE_SOCKET = "/tmp/synthetic-guidance-tern.sock";
			process.env.TERN_PANE = "1";
			const ternGuidance = session.getEvalPreludes().find(prelude => prelude.name === "browser")?.guidance;
			expect(ternGuidance).not.toBe(relayGuidance);
			guidanceChanges.push(ternGuidance);
			await session.prompt("step two");

			delete process.env.TERN_PANE_SOCKET;
			delete process.env.TERN_PANE;
			cfgBrowserCmux.override(settings, true);
			process.env.CMUX_SOCKET_PATH = "/tmp/synthetic-guidance-cmux.sock";
			const cmuxGuidance = session.getEvalPreludes().find(prelude => prelude.name === "browser")?.guidance;
			expect(cmuxGuidance).not.toBe(ternGuidance);
			guidanceChanges.push(cmuxGuidance);
			await session.prompt("step three");
			cfgBrowserRelay.override(settings, false);
			const restoredGuidance = session.getEvalPreludes().find(prelude => prelude.name === "browser")?.guidance;
			expect(restoredGuidance).not.toBe(cmuxGuidance);
			expect(restoredGuidance).toBe(originalGuidance);
			guidanceChanges.push(restoredGuidance);
			await session.prompt("step four");
			await session.prompt("step five");

			const notices = session.agent.state.messages.filter(
				message => message.role === "custom" && message.customType === "eval-prelude-notice",
			);
			expect(
				notices.map(notice =>
					notice.role === "custom" && notice.details && typeof notice.details === "object"
						? Reflect.get(Reflect.get(notice.details, "guidance") ?? {}, "browser")
						: undefined,
				),
			).toEqual(guidanceChanges);
			// Endpoint changes can rebuild safety guidance, but not an earlier dispatched context.
			expect(mock.calls[0]!.context.systemPrompt).toEqual(baselinePrompt);
			expect(mock.calls[0]!.context.tools?.find(tool => tool.name === "eval")?.description).toBe(baselineEval);
			const requestTexts = mock.calls.map(({ context }) =>
				context.messages
					.flatMap(message =>
						typeof message.content === "string"
							? [message.content]
							: message.content.flatMap(part => (part.type === "text" ? [part.text] : [])),
					)
					.join("\n"),
			);
			for (const [index, guidance] of guidanceChanges.entries()) {
				if (!guidance) throw new Error("Expected browser session guidance for the selected backend");
				expect(requestTexts[index + 1]).toContain(guidance);
			}
			for (const request of requestTexts.slice(4)) {
				expect(request.match(/<system-notice id="prelude-extension">/g)).toHaveLength(4);
				const latest = request.split('<system-notice id="prelude-extension">').at(-1);
				expect(latest).toContain(originalGuidance);
			}
			const providerContexts = JSON.stringify(mock.calls.map(call => call.context));
			for (const secret of [
				endpoint,
				"synthetic-user",
				"synthetic-password",
				"secret-path",
				"secret-token",
				"secret-session",
				"secret-fragment",
			]) {
				expect(providerContexts).not.toContain(secret);
				expect(JSON.stringify(notices)).not.toContain(secret);
			}
		} finally {
			for (const key of envKeys) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
		}
	});

	it("exposes enabled host preludes to user-initiated Python cells", async () => {
		const settings = Settings.isolated({
			"browser.enabled": false,
			"computer.enabled": true,
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		const result = await session.executePython("print(computer is not None)");
		expect(result.exitCode).toBe(0);
		expect(result.output.trim()).toBe("True");
	});

	it("reconciles browser MCP filtering on live browser toggles", async () => {
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		const reconcile = vi.spyOn(manager, "reconcileBrowserFilter");
		const settings = Settings.isolated({ "browser.enabled": false });
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		cfgBrowserEnabled.override(settings, true);
		await Promise.resolve();
		expect(reconcile).toHaveBeenLastCalledWith(true);
		const enableReconcile = reconcile.mock.results.at(-1);
		if (!enableReconcile || enableReconcile.type !== "return") throw new Error("Expected browser MCP reconcile");
		await enableReconcile.value;
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getEvalPreludes().some(definition => definition.name === "browser")).toBe(true);

		cfgBrowserEnabled.override(settings, false);
		await Promise.resolve();
		expect(reconcile).toHaveBeenLastCalledWith(false);
		const disableReconcile = reconcile.mock.results.at(-1);
		if (!disableReconcile || disableReconcile.type !== "return") throw new Error("Expected browser MCP reconcile");
		await disableReconcile.value;
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getEvalPreludes().some(definition => definition.name === "browser")).toBe(false);
	});

	it("does not add host preludes to a restricted eval-only session", async () => {
		const settings = Settings.isolated({
			"browser.enabled": true,
			"computer.enabled": true,
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			restrictToolNames: true,
			toolNames: ["eval"],
		});
		sessions.push(session);

		expect(session.getEnabledToolNames()).toEqual(["eval"]);
		expect(session.getEvalPreludes()).toEqual([]);
		expect(session.getAllToolNames()).not.toContain("browser");
		expect(session.getAllToolNames()).not.toContain("computer");
	});
});
