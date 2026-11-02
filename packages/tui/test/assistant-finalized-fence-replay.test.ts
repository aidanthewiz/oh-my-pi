import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageComponent } from "../src/chat/assistant-message";
import { TranscriptContainer, trimBlankEdges } from "../src/chrome/transcript-container";
import { initTheme } from "../src/theme";

const frame = { tick: 0, now: 0 };

function message(source: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: source }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function withFinalizedFence(
	closeFence: boolean,
	inspect: (
		transcript: TranscriptContainer,
		component: AssistantMessageComponent,
		emitted: number,
		published: readonly string[],
		statements: readonly string[],
	) => void,
): void {
	const transcript = new TranscriptContainer();
	const component = new AssistantMessageComponent();
	transcript.addChild(component);
	try {
		const statements = Array.from({ length: 14 }, (_, index) => `SELECT column_${index} FROM orders_${index};`);
		let source = "```sql\n";
		for (const statement of statements.slice(0, 12)) {
			source += `${statement}\n`;
			component.updateContent(message(source), { transient: true });
			transcript.renderViewport(60, 4, frame);
		}
		const batch = transcript.peekFinalizedBatch(60, 4);
		if (!batch) throw new Error("Fixture did not offer partial open-fence retirement");
		transcript.acknowledgeFinalizedBatch(batch.id);
		const [emitted = 0] = transcript.emittedStableRows();
		if (emitted <= 1) throw new Error("Fixture did not retire multiple stable snapshots");
		const published = [...component.renderTranscriptStableRows(emitted, 60)];
		const finalSource = source + statements.slice(12).join("\n") + (closeFence ? "\n```" : "");
		component.updateContent(message(finalSource), { transient: false });
		component.markTranscriptBlockFinalized();
		inspect(transcript, component, emitted, published, statements);
	} finally {
		transcript.dispose();
	}
}

describe("finalized open-fence stable snapshots", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	for (const closeFence of [false, true]) {
		const ending = closeFence ? "closed" : "open";

		it(`[TuiChat-fence-stable-${ending}] keeps retired prefix bytes unchanged when the final message seals`, () => {
			withFinalizedFence(closeFence, (_transcript, component, emitted, published) => {
				expect(component.renderTranscriptStableRows(emitted, 60)).toEqual(published);
			});
		});

		it(`[TuiChat-fence-replay-${ending}] replays every SQL statement exactly once at a fresh width and back`, () => {
			withFinalizedFence(closeFence, (transcript, component, _emitted, _published, statements) => {
				for (const width of [44, 60]) {
					transcript.beginReplay();
					const replay = transcript.peekReplayBatch(width);
					if (!replay) throw new Error("Fixture did not offer history replay");
					const viewport = transcript.renderViewport(width, 1000, frame);
					const combined = [...replay.rows, ...viewport];
					expect(combined).toEqual([...trimBlankEdges(component.render(width))]);
					const plain = Bun.stripANSI(combined.join("\n"));
					for (const statement of statements) expect(plain.split(statement)).toHaveLength(2);
					transcript.acknowledgeFinalizedBatch(replay.id);
				}
			});
		});
	}
});
