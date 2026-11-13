import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Component } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { formatExtensionLink, setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { withoutTerminalMultiplexer } from "./helpers/terminal-multiplexer";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

withoutTerminalMultiplexer();

beforeAll(async () => {
	await initTheme(false);
});

const envKeys = ["TERM_PROGRAM", "PI_TUI_RESIZE_IN_PLACE"] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of envKeys) saved[key] = Bun.env[key];
	Bun.env.TERM_PROGRAM = "xterm";
	setExtensionLinks(["demo"]);
});

afterEach(() => {
	for (const key of envKeys) {
		if (saved[key] === undefined) delete Bun.env[key];
		else Bun.env[key] = saved[key];
	}
	setExtensionLinks([]);
});

class UnansweredProbeTerminal extends VirtualTerminal {
	droppedReports = 0;
	written = "";

	override write(data: string): void {
		this.written += data;
		super.write(data);
	}

	override start(onInput: (data: string) => void, onResize: () => void): void {
		super.start(data => {
			if (/^\x1b\[\d+;\d+R$/.test(data)) this.droppedReports++;
			else onInput(data);
		}, onResize);
	}
}

class LinkTail implements Component {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}

	render(): readonly string[] {
		return [
			formatExtensionLink("visible-target", "demo:open/7", "resize-target"),
			...Array.from({ length: 9 }, (_, index) => `tail-${index}`),
		];
	}
}

function shownHint(terminal: UnansweredProbeTerminal): string {
	const tag = [...terminal.written.matchAll(/\x1b\[1;7m(.*?)\x1b\[22;27m/g)].at(-1)?.[1];
	if (tag === undefined) throw new Error("No link hint is displayed");
	return Bun.stripANSI(tag);
}

describe("link hints require a displayed viewport", () => {
	for (const phase of ["alt", "in-place", "probe"] as const) {
		it(`rejects the old tag during ${phase} resize and permits fresh hints after recovery`, async () => {
			Bun.env.PI_TUI_RESIZE_IN_PLACE = phase === "alt" ? "0" : "1";
			const terminal = new UnansweredProbeTerminal(80, 24);
			const scheduler = new VirtualRenderScheduler();
			const composer = new Composer({
				terminal,
				preferences: { quiet: true, resizeScrollback: "preserve" },
				tuiOptions: { renderScheduler: scheduler },
			});
			const transcript = new TranscriptContainer();
			transcript.addChild(new LinkTail());
			composer.setRuntimeChildren([transcript]);
			const activations: string[] = [];
			const removeInput = composer.ui.addInputListener(data => {
				if (!composer.linkHintsActive) return;
				const picked = composer.typeLinkHint(data);
				if (typeof picked === "object") activations.push(picked.url);
				return { consume: true };
			});
			try {
				composer.start();
				await scheduler.settle(terminal);
				expect(terminal.getViewport().join("\n")).toContain("visible-target");
				expect(composer.viewportLinkCount()).toBe(1);
				composer.startLinkHints(() => {});
				composer.ui.renderNow();
				terminal.sendInput(shownHint(terminal));
				expect(activations).toEqual(["demo:open/7"]);
				activations.length = 0;
				composer.startLinkHints(() => {});
				composer.ui.renderNow();
				const staleTag = shownHint(terminal);
				expect(composer.linkHintsActive).toBe(true);
				terminal.droppedReports = 0;

				terminal.resize(40, 5);
				if (phase === "alt") await scheduler.settle(terminal);
				if (phase === "probe") {
					await scheduler.advance(terminal, 150);
					expect(terminal.droppedReports).toBeGreaterThan(0);
				} else if (phase === "in-place") {
					expect(terminal.droppedReports).toBe(0);
				}
				expect(composer.ui.getMutableViewport().length).toBe(0);
				terminal.sendInput(staleTag);
				expect(activations).toEqual([]);
				expect(composer.linkHintsActive).toBe(false);

				await scheduler.advance(terminal, 500);
				terminal.resize(80, 24);
				await scheduler.advance(terminal, 700);
				expect(terminal.getViewport().join("\n")).toContain("visible-target");
				expect(composer.viewportLinkCount()).toBe(1);
				composer.startLinkHints(() => {});
				composer.ui.renderNow();
				terminal.sendInput(shownHint(terminal));
				expect(activations).toEqual(["demo:open/7"]);
			} finally {
				removeInput();
				composer.stop();
				scheduler.reset();
			}
		});
	}
});
