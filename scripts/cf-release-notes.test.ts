import { describe, expect, it } from "bun:test";
import {
	groupCoreforceCommitSubjects,
	parseCoreforceVersion,
	RELEASE_BODY_BUDGET,
	renderCoreforceReleaseNotes,
	selectCoreforceRangeBase,
	selectPreviousCoreforceTag,
} from "./cf-release-notes";

describe("Coreforce release versions", () => {
	it("parses the upstream version and independent Coreforce roll", () => {
		expect(parseCoreforceVersion("v17.0.9.3")).toEqual({
			tag: "v17.0.9.3",
			upstream: "17.0.9",
			roll: 3,
			parts: [17, 0, 9, 3],
		});
		expect(parseCoreforceVersion("v17.0.9")).toBeNull();
	});

	it("selects the highest earlier stable Coreforce release", () => {
		expect(selectPreviousCoreforceTag(["v17.0.2.3", "v17.0.9", "v17.0.9.2", "v16.3.11.9"], "v17.0.9.3")).toBe(
			"v17.0.9.2",
		);
	});

	it("uses the upstream tag after an upstream jump and the prior fork tag for another roll", () => {
		expect(selectCoreforceRangeBase("v17.0.2.3", "17.0.9")).toBe("v17.0.9");
		expect(selectCoreforceRangeBase("v17.0.9.1", "17.0.9")).toBe("v17.0.9.1");
	});
	it("keeps canceled rolls in the next published release range", () => {
		const previousPublished = selectPreviousCoreforceTag(["v18.1.15.1"], "v18.1.15.3");

		expect(previousPublished).toBe("v18.1.15.1");
		expect(selectCoreforceRangeBase(previousPublished, "18.1.15")).toBe("v18.1.15.1");
	});
});

describe("Coreforce change grouping", () => {
	it("prioritizes product changes, links fork PRs, and omits replay bookkeeping", () => {
		const groups = groupCoreforceCommitSubjects(
			[
				"feat(models): route managed models through Bedrock (#14)",
				"fix(auth): refresh managed AWS sessions (#18)",
				"security!: reject unmanaged provider credentials (#20)",
				"chore: rebase Coreforce engine onto v17.0.2 (#19)",
				"chore: align Coreforce v17.0.9 ancestry",
			],
			"Coreforce-CAD/oh-my-pi",
		);

		expect(groups.Added).toEqual([
			"Route managed models through Bedrock ([#14](https://github.com/Coreforce-CAD/oh-my-pi/pull/14))",
		]);
		expect(groups.Fixed).toEqual([
			"Refresh managed AWS sessions ([#18](https://github.com/Coreforce-CAD/oh-my-pi/pull/18))",
		]);
		expect(groups["Breaking Changes"]).toEqual([
			"Reject unmanaged provider credentials ([#20](https://github.com/Coreforce-CAD/oh-my-pi/pull/20))",
		]);
		expect(groups.Maintenance).toEqual([]);
	});
});

describe("Coreforce release body", () => {
	it("leads with highlights and retains complete Coreforce and upstream sections", () => {
		const groups = groupCoreforceCommitSubjects([
			"feat: add welcome hammer",
			"feat(models): add managed model routing (#14)",
			"fix(auth): refresh SSO sessions (#18)",
		]);
		const body = renderCoreforceReleaseNotes({
			currentTag: "v17.0.9.1",
			currentSha: "0123456789abcdef",
			previousTag: "v17.0.2.3",
			coreforceGroups: groups,
			upstreamNotes:
				"## @oh-my-pi/pi-ai\n\n### Added\n\n- Added upstream model support.\n\n### Fixed\n\n- Fixed stream recovery.",
		});

		expect(body.indexOf("## Highlights")).toBeLessThan(body.indexOf("## Coreforce changes"));
		const coreforceHighlights = body.slice(body.indexOf("### Coreforce"), body.indexOf("### Upstream"));
		expect(coreforceHighlights.indexOf("Add managed model routing")).toBeLessThan(
			coreforceHighlights.indexOf("Add welcome hammer"),
		);
		expect(body).toContain("## Upstream oh-my-pi changes");
		expect(body).toContain("Added upstream model support.");
		expect(body).toContain("Fixed stream recovery.");
		expect(body).toContain("compare/v17.0.2.3...v17.0.9.1");
		expect(body).toContain("compare/v17.0.2...v17.0.9");
		expect(body).toContain("engine.lock");
	});

	it("compacts oversized upstream details without dropping release metadata", () => {
		const groups = groupCoreforceCommitSubjects(["feat(models): add managed model routing (#14)"]);
		const upstreamNotes = `## @oh-my-pi/pi-ai\n\n### Changed\n\n${Array.from(
			{ length: 2_000 },
			(_, index) => `- Upstream detail ${index}: ${"x".repeat(80)}`,
		).join("\n")}`;
		const body = renderCoreforceReleaseNotes({
			currentTag: "v17.2.4.1",
			currentSha: "0123456789abcdef",
			previousTag: "v17.0.9.20",
			coreforceGroups: groups,
			upstreamNotes,
		});

		expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET);
		expect(body).toContain("Add managed model routing");
		expect(body).toContain("Detailed upstream notes are omitted");
		expect(body).not.toContain("Upstream detail 1999");
		expect(body).toContain("compare/v17.0.9...v17.2.4");
		expect(body).toContain("engine.lock");
	});

	it("falls back to linked summaries when every detailed section is oversized", () => {
		const coreforceGroups = {
			"Breaking Changes": [],
			Security: [],
			Added: Array.from({ length: 2_000 }, (_, index) => `Coreforce detail ${index}: ${"x".repeat(80)}`),
			Changed: [],
			Fixed: [],
			Maintenance: [],
		};
		const body = renderCoreforceReleaseNotes({
			currentTag: "v17.2.4.1",
			currentSha: "0123456789abcdef",
			previousTag: "v17.0.9.20",
			coreforceGroups,
			upstreamNotes: `## @oh-my-pi/pi-ai\n\n### Changed\n\n- ${"y".repeat(RELEASE_BODY_BUDGET)}`,
		});

		expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET);
		expect(body).not.toContain("## Highlights");
		expect(body).toContain("Detailed Coreforce changes are omitted");
		expect(body).toContain("Detailed upstream notes are omitted");
		expect(body).toContain("Coreforce full changelog");
		expect(body).toContain("Upstream full changelog");
	});
});
