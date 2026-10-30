import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentMessage, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type { TUI } from "@oh-my-pi/pi-tui";
import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { stopSharedSpinnerTicker } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});

const reply = "Synthetic delivered identifier 9007199254740993";
type Route = "direct" | "managed";

async function fixture(route: Route) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reply-settlement-"));
	const manager = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		settings: Settings.isolated({
			"out.enabled": true,
			"async.enabled": true,
			"bash.autoBackground.enabled": route === "managed",
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"astGrep.enabled": false,
			"astEdit.enabled": false,
			"grep.enabled": false,
			"glob.enabled": false,
		}),
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getSessionId: () => cwd,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	};
	return {
		cwd,
		manager,
		tool: new BashTool(session),
		async cleanup() {
			try {
				await manager.dispose({ timeoutMs: 1000 });
			} finally {
				releaseShellSessions(cwd);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		},
	};
}

function assertResumedProse(messages: AgentMessage[]) {
	const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
	const builder = new ChatTranscriptBuilder({ ui, cwd: "/tmp", requestRender() {} });
	const resumed = JSON.parse(JSON.stringify(messages)) as AgentMessage[];
	const entries = resumed.map((message, i) => ({
		type: "message" as const,
		id: String(i),
		parentId: i ? String(i - 1) : null,
		timestamp: new Date(i).toISOString(),
		message,
	}));
	try {
		for (let rebuild = 0; rebuild < 2; rebuild++) {
			builder.rebuild(entries);
			const prose = builder.container.children
				.filter(child => child instanceof AssistantMessageComponent)
				.map(child => Bun.stripANSI(child.render(120).join("\n")))
				.join("\n");
			expect(prose.split(reply).length - 1).toBe(1);
		}
	} finally {
		builder.dispose();
		stopSharedSpinnerTicker();
	}
}

describe.skipIf(process.platform === "win32")("delivered foreground bash replies survive settlement", () => {
	for (const route of ["direct", "managed"] as const) {
		const settlements =
			route === "direct"
				? (["abort", "success", "nonzero", "timeout", "hook-error"] as const)
				: (["abort", "success", "nonzero", "hook-error"] as const);
		it.each([...settlements])(
			`${route} persists one delivered reply on %s`,
			async settlement => {
				const f = await fixture(route);
				const suffix =
					settlement === "abort" || settlement === "timeout"
						? "sleep 30"
						: settlement === "nonzero"
							? "exit 3"
							: "printf complete";
				const command = `printf '%s' '${reply}' > out://; ${suffix}`;
				let hookCalls = 0;
				const scripted = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: "reply-call",
									name: "bash",
									arguments: { command, timeout: settlement === "timeout" ? 1 : 30 },
								},
							],
							stopReason: "toolUse",
						},
						{ content: ["Synthetic stop"], stopReason: "stop" },
					],
				});
				const agent = new Agent({
					getApiKey: () => "synthetic-unused-key",
					initialState: {
						model: scripted.model,
						systemPrompt: ["Synthetic local tool test"],
						tools: [f.tool as unknown as AgentTool],
						messages: [],
					},
					convertToLlm,
					streamFn: scripted.stream,
					afterToolCall: () => {
						hookCalls++;
						if (settlement === "hook-error") throw new Error("Synthetic after-tool failure");
						return undefined;
					},
				});
				let liveDelivered = false;
				let watchdogExpired = false;
				const unsubscribe = agent.subscribe(event => {
					if (event.type !== "tool_execution_update") return;
					const details = event.partialResult.details;
					if (!details || typeof details !== "object" || !("replies" in details)) return;
					const replies = details.replies;
					if (Array.isArray(replies) && replies.includes(reply)) {
						liveDelivered = true;
						if (settlement === "abort") agent.abort();
					}
				});
				// Real native subprocess cancellation cannot be bounded with fake timers.
				const watchdog = setTimeout(() => {
					watchdogExpired = true;
					agent.abort(new Error("Synthetic watchdog expired"));
				}, 8000);
				try {
					await agent.prompt("Run the synthetic local reply command");
					expect(watchdogExpired).toBe(false);
					expect(liveDelivered).toBe(true);
					const results = agent.state.messages.filter(
						message => message.role === "toolResult" && message.toolCallId === "reply-call",
					);
					expect(results).toHaveLength(1);
					const result = results[0]!;
					if (result.role !== "toolResult") throw new Error("Expected tool result");
					const text = result.content
						.filter(block => block.type === "text")
						.map(block => block.text)
						.join("\n");
					expect(result.isError).toBe(settlement !== "success");
					expect(text).not.toContain(reply);
					expect(hookCalls).toBe(settlement === "abort" ? 0 : 1);
					if (settlement === "abort") expect(text).toMatch(/Command (?:cancelled|aborted)/);
					if (settlement === "timeout") expect(result.details).toMatchObject({ timedOut: true });
					if (settlement === "nonzero") expect(result.details).toMatchObject({ exitCode: 3 });
					if (settlement === "hook-error") expect(text).toBe("Synthetic after-tool failure");
					assertResumedProse(agent.state.messages);
					expect(result.details).toMatchObject({ replies: [reply] });
					if (settlement === "abort" || settlement === "hook-error") {
						expect(Object.keys(result.details as object)).toEqual(["replies"]);
					}
				} finally {
					clearTimeout(watchdog);
					agent.abort();
					try {
						await agent.waitForIdle();
					} finally {
						unsubscribe();
						await f.cleanup();
					}
				}
			},
			12000,
		);
	}

	it("still rejects with ToolAbortError after delivering a direct reply", async () => {
		const f = await fixture("direct");
		const controller = new AbortController();
		let watchdogExpired = false;
		// Real native subprocess cancellation cannot be bounded with fake timers.
		const watchdog = setTimeout(() => {
			watchdogExpired = true;
			controller.abort();
		}, 8000);
		let delivered = false;
		try {
			const execution = f.tool.execute(
				"direct-throw",
				{
					command: `printf '%s' '${reply}' > out://; sleep 30`,
				},
				controller.signal,
				update => {
					if (update.details?.replies?.includes(reply)) {
						delivered = true;
						controller.abort();
					}
				},
			);
			await expect(execution).rejects.toBeInstanceOf(ToolAbortError);
			expect(delivered).toBe(true);
			expect(watchdogExpired).toBe(false);
		} finally {
			clearTimeout(watchdog);
			controller.abort();
			await f.cleanup();
		}
	}, 12000);

	it("retains the foreground reply but refuses a later write after background handoff", async () => {
		const f = await fixture("managed");
		const steering = new AbortController();
		const controller = new AbortController();
		const seen: string[][] = [];
		let watchdogExpired = false;
		// Real native subprocess completion cannot be bounded with fake timers.
		const watchdog = setTimeout(() => {
			watchdogExpired = true;
			controller.abort();
			f.manager.cancelAll();
		}, 8000);
		try {
			const result = await f.tool.execute(
				"background-replies",
				{
					command: `printf '%s' '${reply}' > out://; while [ ! -f release ]; do sleep 0.01; done; printf attempted > late-attempt; printf forbidden-late-reply > out://`,
					timeout: 30,
				},
				controller.signal,
				update => {
					if (update.details?.replies) {
						seen.push([...update.details.replies]);
						if (update.details.replies.includes(reply)) steering.abort();
					}
				},
				{ toolCall: { steeringSignal: steering.signal } } as unknown as AgentToolContext,
			);
			expect(result.details?.replies).toEqual([reply]);
			const id = result.details?.async?.jobId;
			if (!id) throw new Error("Expected foreground-to-background transition");
			await fs.writeFile(path.join(f.cwd, "release"), "synthetic\n");
			await f.manager.waitForAll();
			expect(watchdogExpired).toBe(false);
			const job = f.manager.getJob(id);
			expect(job?.status).toBe("failed");
			expect(await fs.readFile(path.join(f.cwd, "late-attempt"), "utf8")).toBe("attempted");
			expect(seen.flat()).not.toContain("forbidden-late-reply");
			expect(result.details?.replies).toEqual([reply]);
		} finally {
			clearTimeout(watchdog);
			controller.abort();
			await f.cleanup();
		}
	}, 12000);
});
