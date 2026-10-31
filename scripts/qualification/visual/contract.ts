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

export interface VisualInputs {
	schema: "CoreforgeQualificationVisualInputs";
	mode: Mode;
	sourceSha: string;
	nativeSha256: string;
	manifestSha256: string;
	captures: Capture[];
	unmet?: unknown[];
}

export const requiredSurfaces = {
	presentation: 4,
	"async-media": 9,
	approval: 1,
	title: 6,
} as const;
