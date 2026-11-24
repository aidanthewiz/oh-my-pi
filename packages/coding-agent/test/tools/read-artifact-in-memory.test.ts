import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postProcessToolResult } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

function getTextOutput(result: AgentToolResult): string {
	const texts: string[] = [];
	for (const block of result.content) if (block.type === "text") texts.push(block.text);
	return texts.join("\n");
}

describe("read tool spills without a transcript file", () => {
	let testDir: string;
	let manager: SessionManager;
	let authStorage: AuthStorage;

	let spillRoot: string;
	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-artifact-memory-"));
		manager = SessionManager.inMemory(testDir);
		spillRoot = manager.getArtifactManager().dir;
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		LocalProtocolHandler.resetOverrideForTests();
		await manager.close();
		await authStorage.close();
		await fs.rm(spillRoot, { recursive: true, force: true });
		await fs.rm(testDir, { recursive: true, force: true });
	});

	function makeSession(): ToolSession {
		return {
			cwd: testDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionId: () => manager.getSessionId(),
			getSessionSpawns: () => "*",
			getArtifactsDir: () => manager.getArtifactsDir(),
			sessionManager: manager,
			settings: Settings.isolated(),
		};
	}

	async function makeToolContext(): Promise<AgentToolContext> {
		return {
			sessionManager: manager,
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(testDir, "models.yml")),
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
	}

	it("reads the complete output advertised by a spill footer", async () => {
		const fullOutput = Array.from({ length: 8_000 }, (_, index) => `spill line ${index + 1} ${"x".repeat(80)}`).join(
			"\n",
		);
		const spilled = await postProcessToolResult(
			{ content: [{ type: "text", text: fullOutput }], details: {} },
			"bash",
			await makeToolContext(),
		);
		const advertised = getTextOutput(spilled).match(/local:\/\/(\d+)\.log/);
		expect(advertised).not.toBeNull();
		expect(manager.getArtifactsDir()).toBeNull();

		const tool = new ReadTool(makeSession());
		const head = getTextOutput(await tool.execute("call-head", { path: `local://${advertised![1]}.log` }));
		const tail = getTextOutput(
			await tool.execute("call-tail", { path: `local://${advertised![1]}.log:raw:8000-8000` }),
		);

		expect(head).toContain("spill line 1 ");
		expect(tail).toContain("spill line 8000 ");
	});

	it("pages a session spill with a line selector", async () => {
		const lines = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`);
		const id = await manager.saveArtifact(lines.join("\n"));
		if (id === undefined) throw new Error("expected an artifact id");

		const result = await new ReadTool(makeSession()).execute("call-range", { path: `local://${id}.log:raw:10-12` });
		const output = getTextOutput(result);

		expect(output).toContain("line-10");
		expect(output).toContain("line-12");
		expect(output).not.toContain("line-9");
		expect(output).not.toContain("line-13");
	});

	it("prefers the caller's spill over a global default with the same id", async () => {
		const id = await manager.saveArtifact("LOCAL SESSION OUTPUT");
		if (id === undefined) throw new Error("expected an artifact id");
		const foreignDir = path.join(testDir, "foreign-artifacts");
		await fs.mkdir(path.join(foreignDir, "local"), { recursive: true });
		await Bun.write(path.join(foreignDir, "local", `${id}.log`), "FOREIGN SESSION OUTPUT");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => foreignDir });

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-own", { path: `local://${id}.log:raw` }),
		);

		expect(output).toContain("LOCAL SESSION OUTPUT");
		expect(output).not.toContain("FOREIGN");
	});

	it("does not resolve a missing caller spill from the global default root", async () => {
		const foreignDir = path.join(testDir, "foreign-artifacts");
		await fs.mkdir(path.join(foreignDir, "local"), { recursive: true });
		await Bun.write(path.join(foreignDir, "local", "7.log"), "FOREIGN PRIVATE OUTPUT");
		LocalProtocolHandler.setOverride({ getArtifactsDir: () => foreignDir });
		await expect(
			new ReadTool(makeSession()).execute("call-missing", { path: "local://7.log:raw" }),
		).rejects.toThrow();
	});

	it("streams selected lines from a spill larger than the inline resolution cap", async () => {
		const line = "y".repeat(1023);
		const lines = Array.from({ length: 8_200 }, (_, index) => `big-${index + 1} ${line}`);
		const content = lines.join("\n");
		expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
		const id = await manager.saveArtifact(content);
		if (id === undefined) throw new Error("expected an artifact id");
		expect(await manager.getArtifactContent(id, 8 * 1024 * 1024)).toBeNull();

		const output = getTextOutput(
			await new ReadTool(makeSession()).execute("call-big", { path: `local://${id}.log:raw:2-2` }),
		);

		expect(output).toContain("big-2 ");
		expect(output).not.toContain("big-3 ");
	});
});
