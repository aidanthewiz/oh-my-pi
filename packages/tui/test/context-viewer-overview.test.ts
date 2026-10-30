import { describe, expect, it } from "bun:test";
import { contextSnapcompactLines } from "../src/overlays/context-viewer-overview";
import type { ContextBreakdown } from "../src/status-line/context-usage";

/**
 * Contract: the /context Overview surfaces estimated snapcompact wire savings —
 * applied swaps show "saves" figures, inactive states say why.
 */
describe("contextSnapcompactLines", () => {
	function breakdownWith(snapcompact: ContextBreakdown["snapcompact"]): ContextBreakdown {
		return {
			model: { id: "test-model", name: "Test Model", contextWindow: 200000 } as never,
			contextWindow: 200000,
			categories: [],
			usedTokens: 27929,
			autoCompactBufferTokens: 0,
			freeTokens: 172071,
			snapcompact,
		};
	}

	it("renders savings, skip reasons, and the wire total", () => {
		const output = contextSnapcompactLines(
			breakdownWith({
				visionCapable: true,
				systemPrompt: {
					applied: true,
					scope: "all",
					textTokens: 9768,
					frames: 2,
					imageTokens: 6600,
					savedTokens: 3168,
				},
				toolResults: { total: 3, swapped: 0, textTokens: 0, frames: 0, imageTokens: 0, savedTokens: 0 },
				savedTokens: 3168,
			}),
		).join("\n");
		expect(output.match(/\d+(?:\.\d+)?[KMB]?/gi)).toEqual(["3.2K", "9.8K", "2", "6.6K", "3", "25K"]);
	});

	it("does not advertise wire savings for text-only models", () => {
		const output = contextSnapcompactLines(breakdownWith({ visionCapable: false, savedTokens: 3168 })).join("\n");
		expect(output.match(/\d+(?:\.\d+)?[KMB]?/gi)).toBeNull();
	});

	it("omits the section entirely when no snapcompact setting is on", () => {
		expect(contextSnapcompactLines(breakdownWith(undefined))).toEqual([]);
	});
});
