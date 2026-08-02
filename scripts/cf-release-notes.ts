#!/usr/bin/env bun
import { $, Glob } from "bun";
import { mergePackageSection } from "./ci-release-notes";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const DEFAULT_REPOSITORY = "Coreforce-CAD/oh-my-pi";
const DEFAULT_UPSTREAM_REPOSITORY = "can1357/oh-my-pi";
const GITHUB_RELEASE_BODY_LIMIT = 125_000;
export const RELEASE_BODY_BUDGET = 120_000;

export interface CoreforceVersion {
	tag: string;
	upstream: string;
	roll: number;
	parts: [number, number, number, number];
}

export interface ReleaseNoteGroups {
	"Breaking Changes": string[];
	Security: string[];
	Added: string[];
	Changed: string[];
	Fixed: string[];
	Maintenance: string[];
}

const GROUP_ORDER = ["Breaking Changes", "Security", "Added", "Changed", "Fixed", "Maintenance"] as const;
const UPSTREAM_HIGHLIGHT_CATEGORY_ORDER = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"] as const;
const COREFORCE_HIGHLIGHT_WEIGHTS = [
	[/identity|authentication|credential|security|\bauth\b/i, 40],
	[/model|provider|bedrock|mcp/i, 30],
	[/managed|policy|allowlist/i, 20],
	[/release|update/i, 10],
] as const;

export function parseCoreforceVersion(tag: string): CoreforceVersion | null {
	const match = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (!match) return null;
	const parts = match.slice(1).map(Number) as [number, number, number, number];
	return {
		tag: `v${parts.join(".")}`,
		upstream: parts.slice(0, 3).join("."),
		roll: parts[3],
		parts,
	};
}

export function compareCoreforceVersions(a: CoreforceVersion, b: CoreforceVersion): number {
	for (let index = 0; index < a.parts.length; index++) {
		const difference = a.parts[index] - b.parts[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export function selectPreviousCoreforceTag(tags: string[], currentTag: string): string | null {
	const current = parseCoreforceVersion(currentTag);
	if (!current) throw new Error(`Invalid Coreforce release tag: ${currentTag}`);
	return (
		tags
			.map(parseCoreforceVersion)
			.filter((version): version is CoreforceVersion => version !== null)
			.filter(version => compareCoreforceVersions(version, current) < 0)
			.sort((a, b) => compareCoreforceVersions(b, a))[0]?.tag ?? null
	);
}

export function selectCoreforceRangeBase(previousTag: string | null, currentUpstream: string): string {
	const previous = previousTag ? parseCoreforceVersion(previousTag) : null;
	return previous?.upstream === currentUpstream ? previous.tag : `v${currentUpstream}`;
}

export function groupCoreforceCommitSubjects(subjects: string[], repository = DEFAULT_REPOSITORY): ReleaseNoteGroups {
	const groups: ReleaseNoteGroups = {
		"Breaking Changes": [],
		Security: [],
		Added: [],
		Changed: [],
		Fixed: [],
		Maintenance: [],
	};
	const seen = new Set<string>();
	for (const rawSubject of subjects) {
		const subject = rawSubject.trim();
		if (
			!subject ||
			/^Merge\b/i.test(subject) ||
			/rebase Coreforce engine onto\b/i.test(subject) ||
			/align Coreforce .* ancestry\b/i.test(subject)
		) {
			continue;
		}
		const conventional = subject.match(
			/^(feat|fix|perf|security|docs|test|chore|ci|refactor)(?:\([^)]+\))?(!)?:\s*(.+)$/i,
		);
		const type = conventional?.[1]?.toLowerCase();
		const breaking = conventional?.[2] === "!";
		const linkedSummary = (conventional?.[3] ?? subject).replace(
			/\(#(\d+)\)\s*$/,
			(_match, number: string) => `([#${number}](https://github.com/${repository}/pull/${number}))`,
		);
		const summary =
			linkedSummary.length === 0 ? linkedSummary : linkedSummary[0].toUpperCase() + linkedSummary.slice(1);
		if (seen.has(summary)) continue;
		seen.add(summary);

		if (breaking) groups["Breaking Changes"].push(summary);
		else if (type === "security") groups.Security.push(summary);
		else if (type === "feat") groups.Added.push(summary);
		else if (type === "fix") groups.Fixed.push(summary);
		else if (type === "perf" || type === "refactor") groups.Changed.push(summary);
		else groups.Maintenance.push(summary);
	}
	return groups;
}

function renderGroups(groups: ReleaseNoteGroups): string {
	const sections: string[] = [];
	for (const group of GROUP_ORDER) {
		const entries = groups[group];
		if (entries.length === 0) continue;
		sections.push(`### ${group}\n\n${entries.map(entry => `- ${entry}`).join("\n")}`);
	}
	return sections.join("\n\n");
}

function collectCoreforceHighlights(groups: ReleaseNoteGroups, limit: number): string[] {
	const priority = [
		...groups["Breaking Changes"],
		...groups.Security,
		...groups.Added,
		...groups.Fixed,
		...groups.Changed,
	];
	return priority
		.map((entry, index) => ({
			entry,
			index,
			score: COREFORCE_HIGHLIGHT_WEIGHTS.reduce(
				(total, [pattern, weight]) => total + (pattern.test(entry) ? weight : 0),
				0,
			),
		}))
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.slice(0, limit)
		.map(candidate => candidate.entry);
}

function collectMarkdownHighlights(markdown: string, limit: number): string[] {
	const candidates: Array<{ packageName: string; category: string; entry: string }> = [];
	let packageName = "oh-my-pi";
	let category = "";
	for (const line of markdown.split("\n")) {
		const packageHeading = line.match(/^## ([^#].*)$/);
		if (packageHeading) {
			packageName = packageHeading[1].trim();
			category = "";
			continue;
		}
		const categoryHeading = line.match(/^### (.+)$/);
		if (categoryHeading) {
			category = categoryHeading[1].trim();
			continue;
		}
		if (!line.startsWith("- ")) continue;
		const entry = line.slice(2).trim();
		if (entry) candidates.push({ packageName, category, entry });
	}

	const highlights: string[] = [];
	const seenEntries = new Set<string>();
	for (const preferredCategory of UPSTREAM_HIGHLIGHT_CATEGORY_ORDER) {
		const seenPackages = new Set<string>();
		for (const candidate of candidates) {
			if (
				candidate.category !== preferredCategory ||
				seenPackages.has(candidate.packageName) ||
				seenEntries.has(candidate.entry)
			) {
				continue;
			}
			seenPackages.add(candidate.packageName);
			seenEntries.add(candidate.entry);
			highlights.push(`**${candidate.packageName}:** ${candidate.entry}`);
			if (highlights.length === limit) return highlights;
		}
	}
	return highlights;
}

export function renderCoreforceReleaseNotes(options: {
	currentTag: string;
	currentSha: string;
	previousTag: string | null;
	coreforceGroups: ReleaseNoteGroups;
	upstreamNotes: string;
	repository?: string;
	upstreamRepository?: string;
}): string {
	const current = parseCoreforceVersion(options.currentTag);
	if (!current) throw new Error(`Invalid Coreforce release tag: ${options.currentTag}`);
	const previous = options.previousTag ? parseCoreforceVersion(options.previousTag) : null;
	const repository = options.repository ?? DEFAULT_REPOSITORY;
	const upstreamRepository = options.upstreamRepository ?? DEFAULT_UPSTREAM_REPOSITORY;
	const coreforceHighlights = collectCoreforceHighlights(options.coreforceGroups, 6);
	const upstreamHighlights = collectMarkdownHighlights(options.upstreamNotes, 8);
	const coreforceBody = renderGroups(options.coreforceGroups);
	const upstreamNotes = options.upstreamNotes.trim();
	const coreforceChangelogUrl = previous
		? `https://github.com/${repository}/compare/${previous.tag}...${current.tag}`
		: `https://github.com/${repository}/commits/${current.tag}`;
	const upstreamChangelogUrl =
		previous && previous.upstream !== current.upstream
			? `https://github.com/${upstreamRepository}/compare/v${previous.upstream}...v${current.upstream}`
			: `https://github.com/${upstreamRepository}/releases/tag/v${current.upstream}`;

	const render = (detailMode: "full" | "compact-upstream" | "compact-all", includeHighlights: boolean): string => {
		const sections: string[] = [
			`Coreforge engine \`${current.tag}\` combines oh-my-pi \`v${current.upstream}\` with Coreforce-managed identity, model, policy, and release capabilities.`,
		];

		if (includeHighlights) {
			const highlightSections: string[] = [];
			if (coreforceHighlights.length > 0) {
				highlightSections.push(`### Coreforce\n\n${coreforceHighlights.map(entry => `- ${entry}`).join("\n")}`);
			}
			if (upstreamHighlights.length > 0) {
				highlightSections.push(`### Upstream\n\n${upstreamHighlights.map(entry => `- ${entry}`).join("\n")}`);
			}
			if (highlightSections.length > 0) sections.push(`## Highlights\n\n${highlightSections.join("\n\n")}`);
		}

		sections.push(
			detailMode === "compact-all"
				? `## Coreforce changes\n\nDetailed Coreforce changes are omitted because the combined notes exceed GitHub's ${GITHUB_RELEASE_BODY_LIMIT}-character limit. [Browse Coreforce commits](${coreforceChangelogUrl}).`
				: `## Coreforce changes\n\n${coreforceBody || "No Coreforce-specific changes since the previous release."}`,
		);

		if (upstreamNotes) {
			const range = previous
				? `\`v${previous.upstream}\` through \`v${current.upstream}\``
				: `\`v${current.upstream}\``;
			sections.push(
				detailMode === "full"
					? `## Upstream oh-my-pi changes\n\nChanges included from ${range}.\n\n${upstreamNotes}`
					: `## Upstream oh-my-pi changes\n\nChanges included from ${range}. Detailed upstream notes are omitted because the combined notes exceed GitHub's ${GITHUB_RELEASE_BODY_LIMIT}-character limit. [Browse upstream changes](${upstreamChangelogUrl}).`,
			);
		} else {
			sections.push(`## Upstream oh-my-pi changes\n\nThis release remains on upstream \`v${current.upstream}\`.`);
		}

		sections.push(
			`## Using this release\n\nCoreforge appliances select this immutable engine release through \`engine.lock\`. Direct \`omp update\` on the Coreforce channel also installs it.\n\nBuilt from \`${options.currentSha}\`.`,
		);

		const comparisons: string[] = [];
		if (previous) {
			comparisons.push(`[Coreforce full changelog](${coreforceChangelogUrl})`);
			if (previous.upstream !== current.upstream) {
				comparisons.push(`[Upstream full changelog](${upstreamChangelogUrl})`);
			}
		}
		if (comparisons.length > 0) sections.push(comparisons.join(" | "));
		return `${sections.join("\n\n")}\n`;
	};

	let body = render("full", true);
	if (body.length <= RELEASE_BODY_BUDGET) return body;
	body = render("compact-upstream", true);
	if (body.length <= RELEASE_BODY_BUDGET) return body;
	body = render("compact-all", true);
	if (body.length <= RELEASE_BODY_BUDGET) return body;
	body = render("compact-all", false);
	if (body.length <= RELEASE_BODY_BUDGET) return body;
	throw new Error(`Release notes exceed the ${RELEASE_BODY_BUDGET}-character publication budget after compaction.`);
}

async function loadPackageName(packageDirectory: string): Promise<string> {
	try {
		const packageJson = (await Bun.file(`${packageDirectory}/package.json`).json()) as { name?: unknown };
		return typeof packageJson.name === "string" ? packageJson.name : packageDirectory;
	} catch {
		return packageDirectory;
	}
}

async function generateUpstreamNotes(floorExclusive: string | null, targetInclusive: string): Promise<string> {
	if (floorExclusive === targetInclusive) return "";
	const sections: string[] = [];
	const paths = await Array.fromAsync(changelogGlob.scan("."));
	paths.sort();
	for (const changelogPath of paths) {
		const merged = mergePackageSection(await Bun.file(changelogPath).text(), floorExclusive, targetInclusive);
		if (!merged) continue;
		const packageDirectory = changelogPath.replace(/\/CHANGELOG\.md$/, "");
		sections.push(`## ${await loadPackageName(packageDirectory)}\n\n${merged}`);
	}
	return sections.join("\n\n");
}

async function resolvePreviousReleaseTag(currentTag: string, repository: string): Promise<string | null> {
	const result =
		await $`gh release list --repo ${repository} --limit 200 --exclude-drafts --exclude-pre-releases --json tagName,isDraft,isPrerelease`
			.quiet()
			.nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`gh release list failed: ${result.stderr.toString().trim() || "no error output"}`);
	}
	const releases = JSON.parse(result.stdout.toString()) as Array<{ tagName?: unknown }>;
	return selectPreviousCoreforceTag(
		releases.map(release => (typeof release.tagName === "string" ? release.tagName : "")),
		currentTag,
	);
}

async function main(): Promise<void> {
	const currentTag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
	const outputPath = process.argv[3] ?? "release-notes.md";
	const current = parseCoreforceVersion(currentTag);
	if (!current) throw new Error(`Expected a Coreforce tag like v17.0.9.1, received: ${currentTag || "(empty)"}`);
	const repository = process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY;
	const upstreamRepository = process.env.OMP_UPSTREAM_REPO ?? DEFAULT_UPSTREAM_REPOSITORY;
	const previousTag = await resolvePreviousReleaseTag(current.tag, repository);
	const previous = previousTag ? parseCoreforceVersion(previousTag) : null;
	const rangeBase = selectCoreforceRangeBase(previousTag, current.upstream);
	const range = `${rangeBase}..HEAD`;
	const log = await $`git log --first-parent --format=%s ${range}`.quiet().nothrow();
	if (log.exitCode !== 0) {
		throw new Error(`git log ${range} failed: ${log.stderr.toString().trim() || "no error output"}`);
	}
	const sha = (await $`git rev-parse HEAD`.text()).trim();
	const groups = groupCoreforceCommitSubjects(log.stdout.toString().split("\n"), repository);
	const upstreamNotes = await generateUpstreamNotes(previous?.upstream ?? null, current.upstream);
	const body = renderCoreforceReleaseNotes({
		currentTag: current.tag,
		currentSha: sha,
		previousTag,
		coreforceGroups: groups,
		upstreamNotes,
		repository,
		upstreamRepository,
	});
	await Bun.write(outputPath, body);
	console.log(`Wrote Coreforce and upstream release notes to ${outputPath}.`);
}

if (import.meta.main) await main();
