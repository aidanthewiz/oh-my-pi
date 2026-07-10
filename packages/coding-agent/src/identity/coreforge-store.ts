import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import { getAgentDbPath, logger } from "@oh-my-pi/pi-utils";

const IDENTITY_ROW_ID = 1;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

export interface CoreforgeAwsIdentity {
	profile: string;
	region: string;
	accountId: string;
	roleArn: string;
	userId?: string;
	validatedAt: number;
}

/** Stable signed-in product identity. Tokens remain in the separate opaque MSAL cache. */
export interface CoreforgeIdentityProfile {
	tenantId: string;
	objectId: string;
	homeAccountId: string;
	username: string;
	displayName: string;
	givenName?: string;
	familyName?: string;
	email: string;
	authorityHost: string;
	authenticatedAt: number;
	updatedAt: number;
	aws?: CoreforgeAwsIdentity;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isFiniteTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isAwsIdentity(value: unknown): value is CoreforgeAwsIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const aws = value as Partial<CoreforgeAwsIdentity>;
	return (
		isNonEmptyString(aws.profile) &&
		isNonEmptyString(aws.region) &&
		isNonEmptyString(aws.accountId) &&
		isNonEmptyString(aws.roleArn) &&
		(aws.userId === undefined || typeof aws.userId === "string") &&
		isFiniteTimestamp(aws.validatedAt)
	);
}

export function isCoreforgeIdentityProfile(value: unknown): value is CoreforgeIdentityProfile {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const profile = value as Partial<CoreforgeIdentityProfile>;
	return (
		isNonEmptyString(profile.tenantId) &&
		isNonEmptyString(profile.objectId) &&
		isNonEmptyString(profile.homeAccountId) &&
		isNonEmptyString(profile.username) &&
		isNonEmptyString(profile.displayName) &&
		(profile.givenName === undefined || typeof profile.givenName === "string") &&
		(profile.familyName === undefined || typeof profile.familyName === "string") &&
		isNonEmptyString(profile.email) &&
		isNonEmptyString(profile.authorityHost) &&
		isFiniteTimestamp(profile.authenticatedAt) &&
		isFiniteTimestamp(profile.updatedAt) &&
		(profile.aws === undefined || isAwsIdentity(profile.aws))
	);
}

/**
 * Stores the MSAL cache and identity profile in the existing per-profile agent.db.
 * The database and parent directory use the same 0700/0600 policy as AgentStorage.
 */
export class CoreforgeIdentityStore {
	#db: Database;

	constructor(dbPath: string = getAgentDbPath()) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		this.#db = new Database(dbPath);
		this.#db.run("PRAGMA busy_timeout = 5000");
		this.#db.run("PRAGMA journal_mode=WAL");
		this.#db.run("PRAGMA synchronous=NORMAL");
		this.#db.run(`
CREATE TABLE IF NOT EXISTS coreforge_identity (
	id INTEGER PRIMARY KEY CHECK (id = ${IDENTITY_ROW_ID}),
	msal_cache TEXT NOT NULL DEFAULT '',
	profile_json TEXT,
	updated_at INTEGER NOT NULL DEFAULT (${SQLITE_NOW_EPOCH})
)
`);
		try {
			fs.chmodSync(dir, 0o700);
			fs.chmodSync(dbPath, 0o600);
			// WAL mode creates -wal/-shm companions that carry token-cache bytes
			// until checkpointed; under a permissive umask they would be created
			// world-readable. Defence-in-depth beside the 0700 directory.
			for (const suffix of ["-wal", "-shm"]) {
				const companion = `${dbPath}${suffix}`;
				if (fs.existsSync(companion)) fs.chmodSync(companion, 0o600);
			}
		} catch (error) {
			logger.debug("Coreforge identity store permission hardening unavailable", { error: String(error) });
		}
	}

	getTokenCache(): string {
		const row = this.#db.prepare("SELECT msal_cache FROM coreforge_identity WHERE id = ?").get(IDENTITY_ROW_ID) as {
			msal_cache?: string;
		} | null;
		return row?.msal_cache ?? "";
	}

	hasTokenCache(): boolean {
		return this.getTokenCache().trim().length > 0;
	}

	setTokenCache(serialized: string): void {
		this.#db
			.prepare(`
INSERT INTO coreforge_identity (id, msal_cache, updated_at)
VALUES (?, ?, ${SQLITE_NOW_EPOCH})
ON CONFLICT(id) DO UPDATE SET msal_cache = excluded.msal_cache, updated_at = excluded.updated_at
`)
			.run(IDENTITY_ROW_ID, serialized);
	}

	getProfile(): CoreforgeIdentityProfile | undefined {
		const row = this.#db.prepare("SELECT profile_json FROM coreforge_identity WHERE id = ?").get(IDENTITY_ROW_ID) as {
			profile_json?: string | null;
		} | null;
		if (!row?.profile_json) return undefined;
		try {
			const parsed: unknown = JSON.parse(row.profile_json);
			if (isCoreforgeIdentityProfile(parsed)) return parsed;
			logger.warn("Ignoring malformed Coreforge identity profile");
		} catch (error) {
			logger.warn("Ignoring unreadable Coreforge identity profile", { error: String(error) });
		}
		return undefined;
	}

	setProfile(profile: CoreforgeIdentityProfile): void {
		this.#db
			.prepare(`
INSERT INTO coreforge_identity (id, profile_json, updated_at)
VALUES (?, ?, ${SQLITE_NOW_EPOCH})
ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at
`)
			.run(IDENTITY_ROW_ID, JSON.stringify(profile));
	}

	setAwsIdentity(aws: CoreforgeAwsIdentity): CoreforgeIdentityProfile {
		const profile = this.getProfile();
		if (!profile) throw new Error("Coreforge identity is not signed in");
		const updated = { ...profile, aws, updatedAt: Date.now() };
		this.setProfile(updated);
		return updated;
	}

	clear(): void {
		this.#db.prepare("DELETE FROM coreforge_identity WHERE id = ?").run(IDENTITY_ROW_ID);
	}

	cachePlugin(): ICachePlugin {
		return {
			beforeCacheAccess: async (context: TokenCacheContext): Promise<void> => {
				const serialized = this.getTokenCache();
				if (serialized) context.tokenCache.deserialize(serialized);
			},
			afterCacheAccess: async (context: TokenCacheContext): Promise<void> => {
				if (context.cacheHasChanged) this.setTokenCache(context.tokenCache.serialize());
			},
		};
	}

	close(): void {
		this.#db.close(false);
	}
}

export function loadCoreforgeIdentityProfile(dbPath?: string): CoreforgeIdentityProfile | undefined {
	const store = new CoreforgeIdentityStore(dbPath);
	try {
		return store.getProfile();
	} finally {
		store.close();
	}
}

export function coreforgeIdentityFirstName(profile: CoreforgeIdentityProfile | undefined): string | undefined {
	const preferred = profile?.givenName?.trim() || profile?.displayName.trim().split(/\s+/)[0];
	if (!preferred) return undefined;
	return preferred.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64) || undefined;
}
