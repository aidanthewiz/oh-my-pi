import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import authorities from "./authorities.json" with { type: "json" };

export type Mode = "source" | "compiled";
export const inventory = [
	{ id: "native-builtins", file: "v18102-native-builtins-runtime-proof.ts", cases: 14 },
	{ id: "task-lifecycle", file: "v18102-task-lifecycle-runtime-proof.ts", cases: 10 },
	{ id: "presentation", file: "v18102-presentation-runtime-proof.ts", cases: 4, invoke: "runPresentationProof" },
	{ id: "async-media", file: "v18102-async-media-runtime-proof.ts", cases: 15 },
	{ id: "early-replay", file: "v18102-early-replay-runtime-proof.ts", cases: 2 },
	{ id: "task-dispatch", file: "task-dispatch-runtime-proof.ts", cases: 5 },
	{ id: "title", file: "final-portable-title-runtime-proof.ts", proof: "final-portable-title-real-file-picker-osc" },
	{ id: "sol", file: "final-sol-ultrafast-runtime-proof.ts", proof: "final-sol-ultrafast-actual-owner" },
	{ id: "beta", file: "v18102-provider-beta-corrected-runtime-proof.ts", cases: 18, resultDomain: "provider-beta" },
	{ id: "accounting", file: "v18103-accounting-runtime-proof.ts", cases: 6, proof: "v18103-accounting-runtime" },
	{ id: "restore", file: "v18103-restore-runtime-proof.ts", cases: 11, proof: "v18103-restore-runtime" },
	{ id: "approval", file: "v18104-approval-runtime-proof.ts", cases: 4, proof: "v18104-approval-runtime" },
] as const;
export type Domain = (typeof inventory)[number]["id"];
export const modes: readonly Mode[] = ["source", "compiled"];
export const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const fixturePrefix = "post95-domain-v18122-r1-";
export const databaseFixture = "final-portable-title-database-proof.ts";

export function inside(root: string, file: string): boolean {
	const relative = path.relative(root, file);
	return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

/** Copies authored behavior sources; it never imports or executes a behavior fixture. */
export async function materialize({ checkout, work }: { checkout: string; work: string }) {
	assert(path.isAbsolute(checkout) && path.isAbsolute(work));
	assert.equal(await fs.realpath(checkout), checkout);
	assert.equal(await fs.realpath(work), work);
	assert(work !== checkout && !inside(checkout, work) && !inside(work, checkout));
	const directory = path.join(work, "sources");
	await fs.mkdir(directory, { mode: 0o700 });
	const names = [...inventory.map(row => row.file), databaseFixture];
	const templates: Record<string, { file: string; sha256: string }> = authorities.templates;
	const historicalSources: Record<string, string> = authorities.historicalSources;
	const sources = [];
	for (const name of names) {
		const template = templates[name];
		assert(template, `Unlisted current template: ${name}`);
		assert.equal(template.file, fixturePrefix + name + ".txt");
		const input = await fs.readFile(path.join(import.meta.dir, "fixtures", template.file), "utf8");
		assert.equal(sha256(input), template.sha256, `Authored template changed: ${template.file}`);
		assert(input.includes("../../packages/"), name);
		const text = input.replaceAll("../../packages/", checkout + "/packages/");
		const file = path.join(directory, fixturePrefix + name);
		await fs.writeFile(file, text, { flag: "wx", mode: 0o600 });
		sources.push({
			name,
			file,
			templateFile: template.file,
			historicalSourceSha256: historicalSources[name],
			authoredSha256: template.sha256,
			effectiveSha256: sha256(text),
		});
	}
	return {
		directory,
		sources,
		fixtures: inventory.map(row => ({ ...row, entrypoint: path.join(directory, fixturePrefix + row.file) })),
	};
}
