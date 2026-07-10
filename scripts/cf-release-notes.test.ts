import { describe, expect, it } from "bun:test";
import {
	groupCoreforceCommitSubjects,
	parseCoreforceVersion,
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
});
