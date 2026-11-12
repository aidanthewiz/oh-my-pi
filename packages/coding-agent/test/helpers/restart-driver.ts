import { existsSync } from "node:fs";
import * as path from "node:path";

const root = process.env.OMP_RESTART_TEST_ROOT;
if (!root) throw new Error("Missing owned restart fixture directory");
if (existsSync(path.join(root, "initial.json"))) throw new Error("Replacement bypassed its startup observer");

// The startup observer must run before application dotenv imports in this test.
const { Agent } = await import("@oh-my-pi/pi-agent-core");
const { ModelRegistry } = await import("../../src/config/model-registry");
const { SessionAccountPoolScope } = await import("../../src/config/account-pool-scope");
const { Settings } = await import("../../src/config/settings");
const { InteractiveMode } = await import("../../src/modes/interactive-mode");
const { AgentSession } = await import("../../src/session/agent-session");
const { AuthStorage } = await import("../../src/session/auth-storage");
const { SessionManager } = await import("../../src/session/session-manager");
const { cfgDefaultThinkingLevel } = await import("../../src/session/settings");
const { initTheme } = await import("@oh-my-pi/pi-tui/theme");
const { Composer } = await import("@oh-my-pi/pi-tui/prompt/composer");
const { VirtualTerminal } = await import("../../../tui/test/virtual-terminal");
const { setAgentDir } = await import("@oh-my-pi/pi-utils/dirs");
const { declareWorkerHostEntry } = await import("../../../utils/src/worker-host");

declareWorkerHostEntry();
const agentDir = path.join(root, "agent");
setAgentDir(agentDir);
await initTheme();
const cwd = path.join(root, "initial-project");
const settings = await Settings.init({
	cwd,
	agentDir,
	configFiles: ["./overlay.yml"],
	overrides: { "compaction.enabled": false },
});
const auth = await AuthStorage.create(path.join(root, "auth.db"));
auth.keys.setRuntime("anthropic", "owned-restart-key");
const registry = new ModelRegistry(auth, undefined, { ignoreLocalModelConfig: true });
const model = registry.find("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing bundled model");
const manager = SessionManager.create(cwd, path.join(root, "sessions"));
const policy = process.env.OMP_RESTART_TEST_POLICY ?? "unpooled";
const scope =
	policy === "unpooled"
		? undefined
		: SessionAccountPoolScope.create(registry, { anthropic: [] }, manager.getSessionId());
const session = new AgentSession({
	agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
	sessionManager: manager,
	settings,
	modelRegistry: scope?.registry(registry) ?? registry,
	accountPoolScope: scope,
});
const mode = new InteractiveMode(
	session,
	"test",
	undefined,
	undefined,
	undefined,
	undefined,
	new Composer({ terminal: new VirtualTerminal() }),
);
const errors: string[] = [];
mode.showStatus = () => {};
mode.showError = message => {
	errors.push(message);
};
try {
	manager.appendMessage({ role: "user", content: "owned restart transcript", timestamp: 1 });
	await manager.ensureOnDisk();
	if (policy === "unpooled") await mode.handleMoveCommand(path.join(root, "hostile-project"));
	if (policy === "released") scope?.release();
	const file = manager.getSessionFile();
	if (!file) throw new Error("Missing durable session");
	const source = await Bun.file(file).text();
	await Bun.write(
		path.join(root, "initial.json"),
		JSON.stringify({
			pid: process.pid,
			cwd: manager.getCwd(),
			sessionId: session.sessionId,
			sessionFile: file,
			configFiles: settings.getConfigFiles(),
			managedConfigFile: settings.getManagedConfigFile(),
			thinking: cfgDefaultThinkingLevel.get(settings),
		}),
	);
	// Exercise the real spawn fallback on this host without replacing native exec.
	if (process.env.OMP_RESTART_TEST_SPAWN === "1") Object.defineProperty(process, "platform", { value: "win32" });
	await mode.restart();
	const credentials = await session.modelRegistry.getApiKeyAndHeaders(model);
	await Bun.write(
		path.join(root, "returned.json"),
		JSON.stringify({
			errors,
			isDisposed: session.isDisposed,
			isShuttingDown: mode.isShuttingDown,
			sessionId: session.sessionId,
			unchangedTranscript: (await Bun.file(file).text()) === source,
			credentialsAllowed: credentials.ok,
		}),
	);
} finally {
	mode.stop();
	await session.dispose();
	await auth.close();
}
