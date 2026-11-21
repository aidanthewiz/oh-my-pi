import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	MCP_CONNECTION_STATUS_EVENT_CHANNEL,
	type McpConnectionStatusEvent,
} from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { TspHarness } from "../../tui/test/native/tsp-harness";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";

describe("InteractiveMode MCP connection status", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let harness: TspHarness | undefined;

	const transcript = (): string => Bun.stripANSI(mode.chatContainer.render(160).join("\n"));
	const emit = (event: McpConnectionStatusEvent): void => {
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, event);
	};

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-mcp-connecting-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		cfgStartupQuiet.set(session.settings, false);
		eventBus = new EventBus();
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, eventBus);
		// This contract is the banner wiring, not git branch watching; a real
		// fs.watch in a parallel Bun worker can trip an unrelated-worker SIGTRAP.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		harness?.stop();
		harness = undefined;
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		await authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("retains MCP progress in the classic transcript without native toasts", async () => {
		harness = await TspHarness.start(tui => tui.addChild(mode.chatContainer));
		emit({ type: "connecting", serverNames: ["mcp-pending-control", "mcp-failure-control"] });
		expect(transcript()).toContain("mcp-pending-control");
		expect(transcript()).toContain("mcp-failure-control");
		await harness.render();
		expect(harness.find(node => node.k === "toast")).toBeUndefined();

		emit({ type: "failed", serverName: "mcp-failure-control", error: "mcp-error-control" });
		expect(transcript()).toContain("mcp-error-control");
		await harness.render();
		expect(harness.find(node => node.k === "toast")).toBeUndefined();

		mode.showStatus("unrelated-status-control");
		await harness.render();
		expect(harness.find(node => node.k === "toast")?.p).toMatchObject({ text: "unrelated-status-control" });
		expect(transcript()).not.toContain("mcp-error-control");
	});

	it("keeps MCP progress out of the transcript when startup.quiet is enabled", () => {
		cfgStartupQuiet.set(session.settings, true);
		emit({ type: "connecting", serverNames: ["mcp-quiet-control"] });
		expect(transcript()).not.toContain("mcp-quiet-control");
	});

	it("preserves connection outcomes while replacing pending progress", () => {
		emit({ type: "connecting", serverNames: ["alpha", "broken", "slow"] });
		emit({ type: "connected", serverName: "alpha" });
		emit({ type: "failed", serverName: "broken", error: "failure-control", sourcePath: "/tmp/source-control.toml" });
		expect(transcript()).toContain("alpha");
		expect(transcript()).toContain("slow");
		expect(transcript()).toContain("failure-control");
		expect(transcript()).toContain("/tmp/source-control.toml");
		emit({ type: "connected", serverName: "slow" });
		expect(transcript()).toContain("alpha");
		expect(transcript()).toContain("slow");
		expect(transcript()).toContain("failure-control");
		expect(mode.chatContainer.children).toHaveLength(1);
	});

	it("removes canceled servers without presenting them as failures", () => {
		emit({ type: "connecting", serverNames: ["canceled-control", "connected-control"] });
		emit({ type: "cancelled", serverName: "canceled-control" });
		emit({ type: "connected", serverName: "connected-control" });
		expect(transcript()).not.toContain("canceled-control");
		expect(transcript()).toContain("connected-control");
	});

	it("keeps other server outcomes visible when retrying one server", () => {
		emit({ type: "connecting", serverNames: ["alpha", "retry", "broken"] });
		emit({ type: "connected", serverName: "alpha" });
		emit({ type: "failed", serverName: "broken", error: "retained-error-control" });
		emit({ type: "failed", serverName: "retry", error: "retired-error-control" });
		emit({ type: "reconnecting", serverName: "retry" });
		expect(transcript()).toContain("alpha");
		expect(transcript()).toContain("retained-error-control");
		expect(transcript()).toContain("retry");
		expect(transcript()).not.toContain("retired-error-control");
	});

	it("preserves the last valid status when a malformed event follows", () => {
		emit({ type: "connecting", serverNames: ["valid-status-control"] });
		const before = transcript();
		eventBus.emit(MCP_CONNECTION_STATUS_EVENT_CHANNEL, { wrong: "shape" });
		expect(transcript()).toBe(before);
		expect(transcript()).toContain("valid-status-control");
	});
});
