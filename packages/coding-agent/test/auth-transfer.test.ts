import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AuthCredential, type OAuthCredential, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	AuthTransferError,
	exportAuthCredentials,
	importAuthCredentials,
	parseAuthExport,
} from "@oh-my-pi/pi-coding-agent/commands/auth";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "../src/mcp/oauth-flow";

const API_KEY: AuthCredential = { type: "api_key", key: "sk-laptop" };
const OAUTH: OAuthCredential = {
	type: "oauth",
	access: "access-laptop",
	refresh: "refresh-laptop",
	expires: 1_900_000_000_000,
	email: "dev@example.com",
	accountId: "acct-1",
};

function stored(store: SqliteAuthCredentialStore, provider: string): AuthCredential[] {
	return store.listAuthCredentials(provider).map(row => row.credential);
}

describe("omp auth export/import", () => {
	it("round-trips an API key and an OAuth login, refresh token included, into an empty store", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const laptop = await SqliteAuthCredentialStore.open(path.join(dir.path(), "laptop.db"));
		const cloud = await SqliteAuthCredentialStore.open(path.join(dir.path(), "cloud.db"));
		try {
			await laptop.upsertAuthCredential("openai", API_KEY);
			await laptop.upsertAuthCredential("anthropic", OAUTH);

			const document = JSON.stringify(exportAuthCredentials(laptop));
			const summary = await importAuthCredentials(cloud, parseAuthExport(document));

			expect(summary.imported).toBe(2);
			expect(stored(cloud, "openai")).toEqual([API_KEY]);
			expect(stored(cloud, "anthropic")).toEqual([OAUTH]);
		} finally {
			laptop.close();
			cloud.close();
		}
	});

	it("replaces the same account and the provider API key, keeping other accounts", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			const otherAccount: OAuthCredential = {
				type: "oauth",
				access: "access-other",
				refresh: "refresh-other",
				expires: 1_900_000_000_000,
				email: "other@example.com",
				accountId: "acct-2",
			};
			await store.upsertAuthCredential("anthropic", { ...OAUTH, access: "stale", refresh: "stale" });
			await store.upsertAuthCredential("anthropic", otherAccount);
			await store.upsertAuthCredential("openai", { type: "api_key", key: "sk-old" });

			await importAuthCredentials(store, {
				version: 1,
				credentials: [
					{ provider: "anthropic", credential: OAUTH },
					{ provider: "openai", credential: API_KEY },
				],
			});

			const anthropic = stored(store, "anthropic");
			expect(anthropic).toHaveLength(2);
			expect(anthropic).toContainEqual(OAUTH);
			expect(anthropic).toContainEqual(otherAccount);
			expect(stored(store, "openai")).toEqual([API_KEY]);
		} finally {
			store.close();
		}
	});

	it("preserves separate organizations for the same OAuth account", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			const personal = { ...OAUTH, orgId: "personal", access: "personal-access" };
			const team = { ...OAUTH, orgId: "team", access: "team-access" };
			await store.upsertAuthCredential("anthropic", personal);
			await store.upsertAuthCredential("anthropic", { ...team, access: "stale" });
			await importAuthCredentials(store, {
				version: 1,
				credentials: [{ provider: "anthropic", credential: team }],
			});
			expect(stored(store, "anthropic")).toEqual(expect.arrayContaining([personal, team]));
			expect(stored(store, "anthropic")).toHaveLength(2);
		} finally {
			store.close();
		}
	});

	it("exports only this profile's MCP credentials and round-trips own-profile and legacy metadata", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const source = await SqliteAuthCredentialStore.open(path.join(dir.path(), "source.db"));
		const destination = await SqliteAuthCredentialStore.open(path.join(dir.path(), "destination.db"));
		const own = mcpOAuthCredentialId("https://mcp.example.test");
		const foreign = mcpOAuthCredentialId("https://mcp.example.test", `other-${getActiveProfile() ?? "default"}`);
		const legacy = "mcp_oauth:https://legacy.example.test";
		const credential: MCPStoredOAuthCredential = {
			...OAUTH,
			tokenUrl: "https://auth.example.test/token",
			clientId: "synthetic-client",
			clientSecret: "synthetic-secret",
			resource: "https://mcp.example.test",
			authorizationUrl: "https://auth.example.test/authorize",
		};
		try {
			for (const provider of [own, foreign, legacy]) await source.upsertAuthCredential(provider, credential);
			const exported = exportAuthCredentials(source);
			expect(exported.credentials.map(entry => entry.provider).sort()).toEqual([own, legacy].sort());
			await importAuthCredentials(destination, parseAuthExport(JSON.stringify(exported)));
			expect(stored(destination, own)).toEqual([credential]);
			expect(stored(destination, legacy)).toEqual([credential]);
			expect(stored(destination, foreign)).toEqual([]);
		} finally {
			source.close();
			destination.close();
		}
	});

	it("refuses a foreign-profile MCP import before writing any preceding provider", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		const foreign = mcpOAuthCredentialId("https://mcp.example.test", `other-${getActiveProfile() ?? "default"}`);
		const previous: AuthCredential = { type: "api_key", key: "keep-local" };
		try {
			await store.upsertAuthCredential("openai", previous);
			await expect(
				importAuthCredentials(store, {
					version: 1,
					credentials: [
						{ provider: "openai", credential: API_KEY },
						{ provider: foreign, credential: OAUTH },
					],
				}),
			).rejects.toThrow(/another profile/);
			expect(stored(store, "openai")).toEqual([previous]);
			expect(stored(store, foreign)).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("rejects malformed optional OAuth identities before normalizing or writing any provider", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			await store.upsertAuthCredential("openai", API_KEY);
			for (const field of ["email", "accountId", "projectId", "orgId"] as const) {
				const data = {
					version: 1 as const,
					credentials: [
						{ provider: "openai", credential: { type: "api_key" as const, key: "must-not-write" } },
						{ provider: "anthropic", credential: { ...OAUTH, [field]: 7 } as unknown as OAuthCredential },
					],
				};
				expect(() => parseAuthExport(JSON.stringify(data))).toThrow(AuthTransferError);
				await expect(importAuthCredentials(store, data)).rejects.toThrow(AuthTransferError);
				expect(stored(store, "openai")).toEqual([API_KEY]);
				expect(stored(store, "anthropic")).toEqual([]);
			}
		} finally {
			store.close();
		}
	});

	it("refuses direct imports of broker snapshots before writing an earlier credential", async () => {
		using dir = TempDir.createSync("@omp-auth-transfer-");
		const store = await SqliteAuthCredentialStore.open(path.join(dir.path(), "agent.db"));
		try {
			await expect(
				importAuthCredentials(store, {
					version: 1,
					credentials: [
						{ provider: "openai", credential: API_KEY },
						{ provider: "anthropic", credential: { ...OAUTH, refresh: "__remote__" } },
					],
				}),
			).rejects.toThrow(AuthTransferError);
			expect(store.listAuthCredentials()).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("rejects an OAuth entry whose refresh token stayed on an auth broker", () => {
		const document = JSON.stringify({
			version: 1,
			credentials: [{ provider: "anthropic", credential: { ...OAUTH, refresh: "__remote__" } }],
		});
		expect(() => parseAuthExport(document)).toThrow(AuthTransferError);
		expect(() => parseAuthExport(document)).toThrow(/credentials\[0\] \(anthropic\).*refresh token/);
	});
});
