import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { findRepoRoot } from "../capability/fs";

const PROJECT_TRUST_FILENAME = "mcp-project-trust.json";
const SHA256_RE = /^[0-9a-f]{64}$/;

interface ProjectTrustEntry {
	projectRoot: string;
	configSha256: string;
}

interface ProjectTrustStore {
	version: 1;
	entries: ProjectTrustEntry[];
}

export interface MCPProjectTrustRequest {
	projectRoot: string;
	configPath: string;
	configSha256: string;
}

export type MCPProjectTrustHandler = (request: MCPProjectTrustRequest) => Promise<boolean>;

export interface ResolveMCPProjectTrustOptions {
	requestTrust?: MCPProjectTrustHandler;
	trustStorePath?: string;
}

export type ResolvedMCPProjectTrust = MCPProjectTrustRequest;

function emptyStore(): ProjectTrustStore {
	return { version: 1, entries: [] };
}

function parseStore(content: string, storePath: string): ProjectTrustStore {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		throw new Error(`Invalid MCP project trust store: ${storePath}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		!("entries" in parsed) ||
		parsed.version !== 1 ||
		!Array.isArray(parsed.entries)
	) {
		throw new Error(`Invalid MCP project trust store: ${storePath}`);
	}
	const entries: ProjectTrustEntry[] = [];
	for (const entry of parsed.entries) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			!("projectRoot" in entry) ||
			typeof entry.projectRoot !== "string" ||
			!path.isAbsolute(entry.projectRoot) ||
			!("configSha256" in entry) ||
			typeof entry.configSha256 !== "string" ||
			!SHA256_RE.test(entry.configSha256)
		) {
			throw new Error(`Invalid MCP project trust store: ${storePath}`);
		}
		entries.push({ projectRoot: entry.projectRoot, configSha256: entry.configSha256 });
	}
	return { version: 1, entries };
}

async function readStore(storePath: string): Promise<ProjectTrustStore> {
	try {
		return parseStore(await fs.readFile(storePath, "utf8"), storePath);
	} catch (error) {
		if (isEnoent(error)) return emptyStore();
		throw error;
	}
}

async function writeStore(storePath: string, store: ProjectTrustStore): Promise<void> {
	const tempPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		try {
			await fs.rename(tempPath, storePath);
		} catch (error) {
			if (process.platform !== "win32") throw error;
			await fs.rm(storePath, { force: true });
			await fs.rename(tempPath, storePath);
		}
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

async function persistTrust(storePath: string, trust: MCPProjectTrustRequest): Promise<void> {
	await fs.mkdir(path.dirname(storePath), { recursive: true, mode: 0o700 });
	await withFileLock(storePath, async () => {
		const store = await readStore(storePath);
		const rootKey = normalizePathForComparison(trust.projectRoot);
		store.entries = store.entries.filter(entry => normalizePathForComparison(entry.projectRoot) !== rootKey);
		store.entries.push({ projectRoot: trust.projectRoot, configSha256: trust.configSha256 });
		store.entries.sort((left, right) => left.projectRoot.localeCompare(right.projectRoot));
		await writeStore(storePath, store);
	});
}

export async function resolveCoreforgeProjectTrust(
	cwd: string,
	options: ResolveMCPProjectTrustOptions = {},
): Promise<ResolvedMCPProjectTrust | undefined> {
	const discoveredRoot = (await findRepoRoot(cwd)) ?? cwd;
	const projectRoot = await fs.realpath(discoveredRoot);
	const configPath = path.join(projectRoot, ".coreforge", "mcp.json");
	let content: Buffer;
	try {
		content = await fs.readFile(configPath);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	const configSha256 = createHash("sha256").update(content).digest("hex");
	const trust = { projectRoot, configPath, configSha256 };
	const storePath = options.trustStorePath ?? path.join(getAgentDir(), PROJECT_TRUST_FILENAME);
	const store = await readStore(storePath);
	const rootKey = normalizePathForComparison(projectRoot);
	if (
		store.entries.some(
			entry => normalizePathForComparison(entry.projectRoot) === rootKey && entry.configSha256 === configSha256,
		)
	) {
		return trust;
	}
	if (!options.requestTrust || !(await options.requestTrust(trust))) return undefined;
	await persistTrust(storePath, trust);
	return trust;
}
