/**
 * Measured SDK startup timing fixture. This exercises session readiness and
 * local stdio MCP lifecycle only; it does not claim TUI input/render readiness.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isEnoent, removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { FAKE_AWS_TOOL_RESULT, STARTUP_DELAY_MS } from "./fixtures/delayed-failing-aws-mcp";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "delayed-failing-aws-mcp.ts");
const MCP_SERVER_NAME = "fake-aws";
const MCP_TOOL_NAME = "mcp__fake_aws_get_caller_identity";
const MODEL = getBundledModel("openai", "gpt-4o-mini");
const authStorage = createInMemoryAuthStorage();
const modelRegistry = new ModelRegistry(
	authStorage,
	path.join(os.tmpdir(), `omp-sdk-aws-timing-models-${Snowflake.next()}.yml`),
);

type FixtureEventName =
	| "process_started"
	| "initialize_received"
	| "initialize_failed"
	| "fake_aws_auth_started"
	| "fake_aws_auth_completed";

type FixtureEvent = { name: FixtureEventName; at: number };

type DisabledTimeline = {
	sdkCreationStartedAt: number;
	sdkSessionUsableAt: number;
};

type DelayedTimeline = DisabledTimeline & {
	mcpProcessStartedAt: number;
	allMcpReadyAt: number;
	firstAuthenticatedAwsCallCompletedAt: number;
};

type FailedTimeline = DisabledTimeline & {
	mcpProcessStartedAt: number;
	mcpFailureWrittenAt: number;
	allMcpSettledAt: number;
};

async function journalEvents(journalPath: string): Promise<FixtureEvent[]> {
	try {
		const content = await fs.readFile(journalPath, "utf8");
		return content
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as FixtureEvent);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

async function waitFor<T>(description: string, predicate: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
	// This integration fixture measures real subprocess and SDK lifecycle
	// boundaries. Fake timers cannot drive stdio process scheduling, so poll the
	// journaled event rather than sleeping for a guessed startup duration.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await predicate();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${description}`);
}

async function waitForJournalEvent(journalPath: string, name: FixtureEventName): Promise<FixtureEvent> {
	return waitFor(`fixture event ${name}`, async () =>
		(await journalEvents(journalPath)).find(event => event.name === name),
	);
}

function baseOptions(workDir: string, sessionManager: SessionManager, settings: Settings, enableMCP: boolean) {
	return {
		cwd: workDir,
		agentDir: workDir,
		modelRegistry,
		sessionManager,
		settings,
		model: MODEL,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		rules: [],
		preloadedCustomToolPaths: [],
		enableMCP,
		hasUI: true,
		toolNames: ["read"],
	};
}

async function runMcpDisabled(workDir: string): Promise<DisabledTimeline> {
	await fs.mkdir(workDir, { recursive: true });
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({});
	const launcherStartedAt = Date.now();
	const result = await createAgentSession(baseOptions(workDir, sessionManager, settings, false));
	const sdkSessionUsableAt = Date.now();
	try {
		expect(result.mcpManager).toBeUndefined();
		expect(result.session.getActiveToolNames()).toContain("read");
		return { sdkCreationStartedAt: launcherStartedAt, sdkSessionUsableAt };
	} finally {
		await result.session.dispose();
	}
}

async function runDelayedMcp(workDir: string, journalPath: string): Promise<DelayedTimeline> {
	await fs.mkdir(workDir, { recursive: true });
	await Bun.write(
		path.join(workDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				[MCP_SERVER_NAME]: {
					command: process.execPath,
					args: [FIXTURE_PATH, "delayed", journalPath],
				},
			},
		}),
	);
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({});
	const launcherStartedAt = Date.now();
	const result = await createAgentSession(baseOptions(workDir, sessionManager, settings, true));
	const sdkSessionUsableAt = Date.now();
	const mcpManager = result.mcpManager;
	if (!mcpManager) throw new Error("Expected the enabled SDK session to own an MCP manager");
	try {
		expect(result.session.getActiveToolNames()).toContain("read");
		const processStarted = await waitForJournalEvent(journalPath, "process_started");
		const allMcpReadyAt = await waitFor("the delayed MCP tool discovery", async () => {
			return mcpManager.getTools().some(tool => tool.name === MCP_TOOL_NAME) ? Date.now() : undefined;
		});
		const beforeFirstUse = await journalEvents(journalPath);
		expect(beforeFirstUse.some(event => event.name === "fake_aws_auth_started")).toBe(false);

		const tool = mcpManager.getTools().find(candidate => candidate.name === MCP_TOOL_NAME);
		if (!tool) throw new Error("Expected delayed MCP tool after session mount");
		const toolResult = await tool.execute("sdk-aws-startup-timing", {}, undefined, {
			sessionManager,
			modelRegistry,
			model: MODEL,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings,
		});
		expect(JSON.stringify(toolResult.content)).toContain(FAKE_AWS_TOOL_RESULT);
		const authCompleted = await waitForJournalEvent(journalPath, "fake_aws_auth_completed");
		return {
			sdkCreationStartedAt: launcherStartedAt,
			sdkSessionUsableAt,
			mcpProcessStartedAt: processStarted.at,
			allMcpReadyAt,
			firstAuthenticatedAwsCallCompletedAt: authCompleted.at,
		};
	} finally {
		await result.session.dispose();
	}
}

async function runFailingMcp(workDir: string, journalPath: string): Promise<FailedTimeline> {
	await fs.mkdir(workDir, { recursive: true });
	await Bun.write(
		path.join(workDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				[MCP_SERVER_NAME]: {
					command: process.execPath,
					args: [FIXTURE_PATH, "fail", journalPath],
				},
			},
		}),
	);
	const sessionManager = SessionManager.inMemory();
	const settings = Settings.isolated({});
	const launcherStartedAt = Date.now();
	const result = await createAgentSession(baseOptions(workDir, sessionManager, settings, true));
	const sdkSessionUsableAt = Date.now();
	const mcpManager = result.mcpManager;
	if (!mcpManager) throw new Error("Expected the enabled SDK session to own an MCP manager");
	try {
		expect(result.session.getActiveToolNames()).toContain("read");
		const processStarted = await waitForJournalEvent(journalPath, "process_started");
		const failed = await waitForJournalEvent(journalPath, "initialize_failed");
		const allMcpSettledAt = await waitFor("the failed MCP to settle in the SDK manager", async () => {
			return mcpManager.getConnectionStatus(MCP_SERVER_NAME) === "disconnected" ? Date.now() : undefined;
		});
		return {
			sdkCreationStartedAt: launcherStartedAt,
			sdkSessionUsableAt,
			mcpProcessStartedAt: processStarted.at,
			mcpFailureWrittenAt: failed.at,
			allMcpSettledAt,
		};
	} finally {
		await result.session.dispose();
	}
}

function printTimingFixture(report: Record<string, unknown>): void {
	console.log(`[sdk-aws-startup-timing] ${JSON.stringify(report)}`);
}

describe("SDK AWS startup timing fixture", () => {
	it("keeps the SDK session usable ahead of delayed or failed MCP startup and defers fake AWS auth to first use", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sdk-aws-startup-timing-"));
		try {
			const disabled = await runMcpDisabled(path.join(root, "mcp-disabled"));
			const delayed = await runDelayedMcp(path.join(root, "delayed"), path.join(root, "delayed.jsonl"));
			const failed = await runFailingMcp(path.join(root, "failed"), path.join(root, "failed.jsonl"));

			expect(delayed.sdkSessionUsableAt).toBeLessThan(delayed.allMcpReadyAt);
			expect(delayed.mcpProcessStartedAt).toBeLessThan(delayed.allMcpReadyAt);
			expect(delayed.allMcpReadyAt).toBeLessThan(delayed.firstAuthenticatedAwsCallCompletedAt);
			expect(failed.sdkSessionUsableAt).toBeLessThan(failed.allMcpSettledAt);
			expect(failed.mcpProcessStartedAt).toBeLessThan(failed.allMcpSettledAt);

			const disabledSessionReadyMs = disabled.sdkSessionUsableAt - disabled.sdkCreationStartedAt;
			const delayedSessionReadyMs = delayed.sdkSessionUsableAt - delayed.sdkCreationStartedAt;
			const additionalPromptOverheadMs = delayedSessionReadyMs - disabledSessionReadyMs;
			printTimingFixture({
				scope: "Measured SDK session readiness and local stdio MCP lifecycle; not TUI input or render readiness.",
				reportedBaseline: {
					source: "User-reported baseline; not measured by this fixture.",
					fullStartupMs: 6_030,
					noMcpStartupMs: 2_260,
					engineStartupMsRange: [1_800, 2_000],
					managedIdentityStsMs: 600,
				},
				target: {
					additionalPromptOverheadMs: "<=500 advisory target; deliberately not a wall-clock test assertion.",
				},
				fixtureDelayMs: STARTUP_DELAY_MS,
				measured: { disabled, delayed, failed },
				comparison: { disabledSessionReadyMs, delayedSessionReadyMs, additionalPromptOverheadMs },
			});
		} finally {
			await removeWithRetries(root);
		}
	}, 20_000);
});

afterAll(async () => {
	await authStorage.close();
});
