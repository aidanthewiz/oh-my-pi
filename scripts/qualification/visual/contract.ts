import assert from "node:assert/strict";

export type Mode = "source" | "compiled";
export type Domain = "presentation" | "async-media" | "approval" | "title";

export interface Capture {
	id: string;
	domain: Domain;
	file: string;
	sha256: string;
	bytes: number;
	columns?: number;
	rows?: number;
	expectedRows?: string[];
	displayed?: string;
}

export type DomainCapture = Omit<Capture, "domain"> & { domain: string };

export interface VisualInputs {
	schema: "CoreforgeQualificationVisualInputs";
	mode: Mode;
	sourceSha: string;
	nativeSha256: string;
	manifestSha256: string;
	captures: Capture[];
	evidenceCaptures: DomainCapture[];
	unmet?: unknown[];
}

export const requiredSurfaces = {
	presentation: 4,
	"async-media": 9,
	approval: 1,
	title: 6,
} as const;

export function selectVisualCaptures(captures: readonly DomainCapture[]): {
	captures: Capture[];
	evidenceCaptures: DomainCapture[];
} {
	const visual: Capture[] = [],
		evidence: DomainCapture[] = [];
	const seen = new Set<string>();
	for (const capture of captures) {
		const key = `${capture.domain}/${capture.id}`;
		assert(!seen.has(key), `Duplicate domain capture: ${key}`);
		seen.add(key);
		if (Object.hasOwn(requiredSurfaces, capture.domain)) visual.push(capture as Capture);
		else {
			assert.equal(capture.domain, "early-replay", `Unknown capture domain: ${capture.domain}`);
			evidence.push(capture);
		}
	}
	return { captures: visual, evidenceCaptures: evidence };
}
