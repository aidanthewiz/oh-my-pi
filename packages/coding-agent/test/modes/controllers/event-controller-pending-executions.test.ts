import { beforeAll, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

beforeAll(async () => {
	await initTheme(false);
});

for (const language of ["bash", "python"] as const) {
	it(`keeps deferred ${language} output live when steering drains and flushes completion exactly once`, async () => {
		let queue = { steering: ["queued steer marker"], followUp: [] as string[], liveSteered: 0 };
		const admitted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const ctx = createInteractiveModeContext({
			settings: Settings.isolated(),
			session: { isStreaming: true, getQueuedMessages: () => queue },
			compactionQueuedMessages: [],
		});
		const helpers = new UiHelpers(ctx);
		ctx.updatePendingMessagesDisplay = () => helpers.updatePendingMessagesDisplay();
		const events = new EventController(ctx);
		const output = "ready>finished\n";
		const complete = {
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			totalLines: 1,
			totalBytes: Buffer.byteLength(output),
			outputLines: 1,
			outputBytes: Buffer.byteLength(output),
		};
		ctx.session.executeBash = async (_command, onChunk) => {
			onChunk?.("ready>");
			admitted.resolve();
			await release.promise;
			return complete;
		};
		ctx.session.executePython = async (_code, onChunk) => {
			onChunk?.("ready>");
			admitted.resolve();
			await release.promise;
			return { ...complete, displayOutputs: [], stdinRequested: false };
		};
		let run: Promise<void> | undefined;
		vi.useFakeTimers();
		try {
			await events.handleEvent({ type: "queue_update", ...queue });
			const commands = new CommandController(ctx);
			run =
				language === "bash" ? commands.handleBashCommand("read answer") : commands.handlePythonCommand("input()");
			await Promise.race([
				admitted.promise,
				run.then(() => {
					throw new Error(`${language} command finished before streaming output admission`);
				}),
			]);
			const renderExecution = () => Bun.stripANSI(ctx.pendingShellContainer.render(120).join("\n"));
			const beforeDrain = Bun.stripANSI(ctx.pendingMessagesContainer.render(120).join("\n"));
			expect(beforeDrain).toContain("queued steer marker");
			expect(renderExecution()).toContain("ready>");
			queue = { steering: [], followUp: [], liveSteered: 1 };
			await events.handleEvent({ type: "queue_update", ...queue });
			const afterDrain = Bun.stripANSI(ctx.pendingMessagesContainer.render(120).join("\n"));
			expect(afterDrain).not.toContain("queued steer marker");
			expect(renderExecution()).toContain("ready>");
			release.resolve();
			await run;
			expect(renderExecution()).toContain("ready>finished");
			helpers.flushPendingBashComponents();
			helpers.flushPendingBashComponents();
			expect(renderExecution()).not.toContain("ready>");
			const transcript = Bun.stripANSI(ctx.chatContainer.render(120).join("\n"));
			expect(transcript.split("ready>finished").length - 1).toBe(1);
		} finally {
			release.resolve();
			await run;
			admitted.resolve();
			events.dispose();
			const components = new Set([...ctx.pendingBashComponents, ...ctx.pendingPythonComponents]);
			for (const component of components) {
				ctx.pendingShellContainer.removeChild(component);
				ctx.chatContainer.removeChild(component);
				component.dispose();
			}
			ctx.pendingBashComponents = [];
			ctx.pendingPythonComponents = [];
			ctx.pendingMessagesContainer.disposeChildren();
			ctx.pendingShellContainer.disposeChildren();
			ctx.chatContainer.disposeChildren();
			vi.runAllTimers();
			vi.useRealTimers();
		}
	});
}
