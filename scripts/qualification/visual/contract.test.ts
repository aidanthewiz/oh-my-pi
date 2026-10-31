import { describe, expect, test } from "bun:test";
import { selectVisualCaptures } from "./contract";
import type { DomainCapture } from "./contract";

const capture = (domain: string, id: string): DomainCapture => ({
	id,
	domain,
	file: `/captures/${domain}/${id}`,
	sha256: "0".repeat(64),
	bytes: 1,
});

describe("runtime capture selection", () => {
	test("retains every required surface without rasterizing early replay evidence", () => {
		const surfaces = (["presentation", "async-media", "approval", "title"] as const).map(domain => ({
			...capture(domain, "surface.ansi"),
			domain,
		}));
		const bash = capture("early-replay", "bash.ansi");
		const evalCapture = capture("early-replay", "eval.ansi");
		const selected = selectVisualCaptures([surfaces[0]!, bash, ...surfaces.slice(1), evalCapture]);
		expect(selected.captures).toEqual(surfaces);
		expect(selected.evidenceCaptures).toEqual([bash, evalCapture]);
	});

	test.each(["unknown", "constructor"])(
		"rejects unclassified ANSI from %s instead of silently filtering it",
		domain => {
			expect(() =>
				selectVisualCaptures([capture("presentation", "surface.ansi"), capture(domain, "output.ansi")]),
			).toThrow(`Unknown capture domain: ${domain}`);
		},
	);

	test("rejects duplicate capture identities", () => {
		const replay = capture("early-replay", "bash.ansi");
		expect(() => selectVisualCaptures([replay, replay])).toThrow("Duplicate domain capture");
	});
});
