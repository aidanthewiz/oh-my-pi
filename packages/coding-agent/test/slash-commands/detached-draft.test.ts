import { describe, expect, it, type Mock, vi } from "bun:test";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { createInteractiveModeContext } from "../helpers/interactive-mode-context";

interface Harness {
	ctx: InteractiveModeContext;
	toggleRecording: Mock<() => Promise<void>>;
	editorText(): string;
}

function createHarness(draft: string): Harness {
	let text = draft;
	const toggleRecording = vi.fn(async () => {});
	const ctx = createInteractiveModeContext({
		editor: {
			getText: () => text,
			setText: (next: string) => {
				text = next;
			},
		},
		toggleRecording,
	});
	return { ctx, toggleRecording, editorText: () => text };
}

describe("builtin commands and detached drafts", () => {
	it("/record leaves a newer draft alone once its own draft was detached", async () => {
		const h = createHarness("newer draft");

		await executeBuiltinSlashCommand("/record", { ctx: h.ctx, draftDetached: true });

		expect(h.toggleRecording).toHaveBeenCalledTimes(1);
		expect(h.editorText()).toBe("newer draft");
	});

	it("/record clears its own draft from the editor when it was not detached", async () => {
		const h = createHarness("/record");

		await executeBuiltinSlashCommand("/record", { ctx: h.ctx });

		expect(h.toggleRecording).toHaveBeenCalledTimes(1);
		expect(h.editorText()).toBe("");
	});
});
