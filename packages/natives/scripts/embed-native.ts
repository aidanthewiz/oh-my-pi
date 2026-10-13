import * as fs from "node:fs/promises";
import * as path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
	containsLegacyVersionSentinel,
	containsVersionStamp,
	VERSION_STAMP_MAGIC,
} from "../native/version-sentinel.js";

const defaultNativeDir = path.join(import.meta.dir, "../native");

/** Platform/architecture pair whose addons a standalone binary embeds. */
export interface NativeEmbedTarget {
	readonly platform: string;
	readonly arch: string;
}

/** Inputs for {@link embeddedAddonFiles}. */
export interface EmbedOptions extends NativeEmbedTarget {
	/** Directory holding the built `pi_natives.*.node` addons; defaults to this package's `native/`. */
	readonly nativeDir?: string;
	/** Release every embedded addon must be stamped with; defaults to this package's version. */
	readonly version?: string;
}

/**
 * Build the in-memory `Bun.build({ files })` overrides that embed one target's
 * addons into a standalone binary: a gzip tar of the addons and a replacement
 * for the checked-in null `native/embedded-addon.js` manifest that points at it.
 *
 * Nothing is written to disk. Bun.build shares the runtime's directory cache
 * and never re-reads it on a miss, so a process that imported pi-natives before
 * writing the archive cannot resolve it; in-memory files bypass that lookup.
 *
 * @throws when no addon exists for the target, or when an addon lacks both the
 * expected release stamp and the matching legacy version sentinel.
 */
export async function embeddedAddonFiles({
	platform,
	arch,
	nativeDir = defaultNativeDir,
	version = packageJson.version,
}: EmbedOptions): Promise<Record<string, string | Uint8Array>> {
	const platformTag = `${platform}-${arch}`;
	const candidates =
		arch === "x64"
			? [
					{ variant: "modern", filename: `pi_natives.${platformTag}-modern.node` },
					{ variant: "baseline", filename: `pi_natives.${platformTag}-baseline.node` },
				]
			: [{ variant: "default", filename: `pi_natives.${platformTag}.node` }];

	const lexicalDir = path.resolve(nativeDir);
	const dir = await fs.realpath(lexicalDir);
	const present = new Set(await fs.readdir(dir));
	const available = await Promise.all(
		candidates
			.filter(candidate => present.has(candidate.filename))
			.map(async candidate => ({ ...candidate, bytes: await fs.readFile(path.join(dir, candidate.filename)) })),
	);
	if (available.length === 0) {
		const expected = candidates.map(candidate => `  - ${candidate.filename}`).join("\n");
		throw new Error(`No native addons found for ${platformTag}. Expected one of:\n${expected}`);
	}
	for (const { filename, bytes } of available) {
		// Pre-stamp addons (npm releases and main builds before the stamp slot)
		// identify their release by the legacy export, which the loader accepts.
		if (!containsVersionStamp(bytes, version) && !containsLegacyVersionSentinel(bytes, version)) {
			const addonPath = path.join(dir, filename);
			throw new Error(
				`Native addon ${addonPath} does not carry the @oh-my-pi/pi-natives@${version} version stamp ` +
					`\`${VERSION_STAMP_MAGIC}${version}\`. Rebuild it from the matching Coreforge source ` +
					`with \`bun scripts/bazel-natives.ts <target>\` before embedding.`,
			);
		}
	}

	const archiveFilename = `embedded-addons.${platformTag}.tar.gz`;
	const archive = new Bun.Archive(Object.fromEntries(available.map(({ filename, bytes }) => [filename, bytes])), {
		compress: "gzip",
		level: 9,
	});
	const files = available.map(({ variant, filename, bytes }) => ({ variant, filename, size: bytes.length }));
	const manifest = `import filePath from ${JSON.stringify(`./${archiveFilename}`)} with { type: "file" };

export const embeddedAddon = {
	platformTag: ${JSON.stringify(platformTag)},
	version: ${JSON.stringify(version)},
	archive: { format: "tar.gz", filename: ${JSON.stringify(archiveFilename)}, filePath },
	files: ${JSON.stringify(files)},
};
`;

	const archiveBytes = await archive.bytes();
	const overrides: Record<string, string | Uint8Array> = {
		[path.join(dir, archiveFilename)]: archiveBytes,
		[path.join(dir, "embedded-addon.js")]: manifest,
	};
	// Bun.write can cache lexical paths while other imports resolve symlinks.
	if (lexicalDir !== dir) {
		overrides[path.join(lexicalDir, archiveFilename)] = archiveBytes;
		overrides[path.join(lexicalDir, "embedded-addon.js")] = manifest;
	}
	return overrides;
}
