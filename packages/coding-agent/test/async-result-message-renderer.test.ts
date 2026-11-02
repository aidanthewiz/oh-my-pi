import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import { describedVisibility } from "@oh-my-pi/pi-tui/chat/transcript-outline";
import type { MessageRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

const BUILT_IN = "Background job completed";

function replay(renderer: MessageRenderer): ChatTranscriptBuilder {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: process.cwd(),
		requestRender: vi.fn(),
		getMessageRenderer: () => renderer,
	});
	const message = {
		role: "custom",
		customType: "async-result",
		content: "<system-notice>Background job bg_1 has completed.</system-notice>",
		display: true,
		details: { jobId: "bg_1", type: "bash", label: "npm test", durationMs: 1234 },
	} as unknown as AgentMessage;
	builder.rebuild([
		{ type: "message", id: "e1", parentId: null, timestamp: new Date(0).toISOString(), message } as never,
	]);
	return builder;
}

beforeAll(async () => {
	await initTheme();
});

describe("async-result message renderer (#14131)", () => {
	it("lets a registered renderer own the card", () => {
		const rendered = replay(() => new Text("EXTENSION CARD"))
			.container.render(120)
			.join("\n");
		expect(rendered).toContain("EXTENSION CARD");
		expect(rendered).not.toContain(BUILT_IN);
	});

	it("preserves native visibility, expansion and disposal for registered activity cards", () => {
		class Card extends Text {
			disposed = false;
			dispose(): void {
				this.disposed = true;
			}
		}
		const cards: Card[] = [];
		const builder = replay((_message, options) => {
			const card = new Card(options.expanded ? "EXPANDED CARD" : "COLLAPSED CARD");
			cards.push(card);
			return card;
		});
		const targets = builder.container.children.map((_, index) => ({
			entryId: `entry-${index}`,
			turnId: `entry-${index}`,
			isUserTurn: false,
			start: index,
			end: index + 1,
			entries: [],
		}));
		const cx = { cols: 120, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
		expect(describedVisibility(builder.container.children, targets, cx)).toContain(true);
		builder.container.setToolActivityVisible(false);
		expect(builder.container.render(120).join("\n")).not.toContain("COLLAPSED CARD");
		expect(describedVisibility(builder.container.children, targets, cx).every(visible => !visible)).toBe(true);
		builder.setExpanded(true);
		expect(builder.container.render(120).join("\n")).not.toContain("EXPANDED CARD");
		builder.container.setToolActivityVisible(true);
		expect(builder.container.render(120).join("\n")).toContain("EXPANDED CARD");
		expect(describedVisibility(builder.container.children, targets, cx)).toContain(true);
		builder.setExpanded(false);
		expect(builder.container.render(120).join("\n")).toContain("COLLAPSED CARD");
		expect(cards.at(-1)?.disposed).toBe(false);
		builder.dispose();
		expect(cards.every(card => card.disposed)).toBe(true);
	});

	it("keeps the built-in card when the renderer throws", () => {
		const rendered = replay(() => {
			throw new Error("boom");
		})
			.container.render(120)
			.join("\n");
		expect(rendered).toContain(BUILT_IN);
		expect(rendered).not.toContain("<system-notice>");
	});
});
