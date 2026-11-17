import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type MCPServer, mcpCapability } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { addMCPServer, readMCPConfigFile } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { OAuthIssuerMismatchError } from "@oh-my-pi/pi-coding-agent/mcp/oauth-discovery";
import { mcpOAuthCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { reauthorizeMcpServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPHttpServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const READ_SCOPE = "openid offline_access read:controls read:framework read:policy read:evidence";
const ADVERTISED_SCOPES = [...READ_SCOPE.split(" "), "write:controls", "write:evidence", "delete:evidence"];

type Registration = { client_name?: string; redirect_uris?: string[]; scope?: string };
type FixtureOptions = {
	handshake?: "bare" | "anonymous" | "json-endpoints";
	issuer?: "mismatched" | "unavailable";
	metadata?: "unavailable" | "without-issuers";
};

interface OAuthFixture {
	server: Bun.Server<undefined>;
	origin: string;
	serverUrl: string;
	metadataUrl: string;
	requests: string[];
	registrations: Registration[];
	authorizations: URL[];
	tokens: URLSearchParams[];
}

function oauthFixture(options: FixtureOptions = {}): OAuthFixture {
	const requests: string[] = [];
	const registrations: Registration[] = [];
	const authorizations: URL[] = [];
	const tokens: URLSearchParams[] = [];
	let pendingGrant: URL | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const origin = url.origin;
			const issuer = `${origin}/auth0-proxy`;
			requests.push(url.pathname);
			if (url.pathname === "/mcp/") {
				if (options.handshake === "anonymous") {
					if (request.method !== "POST") return new Response(null, { status: 202 });
					const message = (await request.json()) as { id?: number | string; method?: string };
					return message.method === "initialize"
						? Response.json({
								jsonrpc: "2.0",
								id: message.id,
								result: {
									protocolVersion: "2025-11-25",
									capabilities: {},
									serverInfo: { name: "synthetic-mcp", version: "1" },
								},
							})
						: new Response(null, { status: 202 });
				}
				return Response.json(
					options.handshake === "json-endpoints"
						? {
								authorization_url: `${origin}/unadvertised/authorize`,
								token_url: `${origin}/unadvertised/token`,
							}
						: { error: "unauthorized" },
					{ status: 401, headers: { "WWW-Authenticate": 'Bearer realm="drata-mcp"' } },
				);
			}
			if (url.pathname === "/.well-known/oauth-protected-resource") {
				if (options.metadata === "unavailable") return new Response("not found", { status: 404 });
				return Response.json({
					resource: origin,
					authorization_servers:
						options.metadata === "without-issuers"
							? undefined
							: [options.issuer === "unavailable" ? `${origin}/unknown-issuer` : issuer],
					scopes_supported: ADVERTISED_SCOPES,
				});
			}
			if (
				url.pathname === "/auth0-proxy/.well-known/oauth-authorization-server" &&
				options.issuer !== "unavailable"
			) {
				return Response.json({
					issuer: options.issuer === "mismatched" ? origin : issuer,
					authorization_endpoint: `${issuer}/authorize?scope=write%3Acontrols%20write%3Aevidence`,
					token_endpoint: `${issuer}/oauth/token`,
					registration_endpoint: `${origin}/regional-auth0/oidc/register`,
				});
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: origin,
					authorization_endpoint: `${origin}/unadvertised/authorize`,
					token_endpoint: `${origin}/unadvertised/token`,
				});
			}
			if (url.pathname === "/regional-auth0/oidc/register" && request.method === "POST") {
				registrations.push((await request.json()) as Registration);
				return Response.json({ client_id: "synthetic-dcr-client" }, { status: 201 });
			}
			if (url.pathname === "/auth0-proxy/authorize") {
				const params = url.searchParams;
				if (!params.has("response_type")) return new Response("not found", { status: 404 });
				authorizations.push(url);
				const registration = registrations.at(-1);
				const redirectUri = params.get("redirect_uri");
				if (
					params.get("response_type") !== "code" ||
					!redirectUri ||
					!registration?.redirect_uris?.includes(redirectUri) ||
					params.get("client_id") !== "synthetic-dcr-client" ||
					params.get("scope") !== (registration.scope ?? null) ||
					params.get("resource") !== origin ||
					params.get("code_challenge_method") !== "S256"
				) {
					return Response.json({ error: "invalid_request" }, { status: 400 });
				}
				pendingGrant = url;
				const callback = new URL(redirectUri);
				callback.searchParams.set("code", "synthetic-authorization-code");
				callback.searchParams.set("state", params.get("state") ?? "");
				return Response.redirect(callback.href);
			}
			if (url.pathname === "/auth0-proxy/oauth/token" && request.method === "POST") {
				const params = new URLSearchParams(await request.text());
				tokens.push(params);
				const challenge = createHash("sha256")
					.update(params.get("code_verifier") ?? "")
					.digest("base64url");
				if (
					!pendingGrant ||
					params.get("code") !== "synthetic-authorization-code" ||
					params.get("client_id") !== "synthetic-dcr-client" ||
					params.get("resource") !== origin ||
					params.get("redirect_uri") !== pendingGrant.searchParams.get("redirect_uri") ||
					challenge !== pendingGrant.searchParams.get("code_challenge")
				) {
					return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
				pendingGrant = undefined;
				return Response.json({
					access_token: "synthetic-access",
					refresh_token: "synthetic-refresh",
					token_type: "Bearer",
					expires_in: 3600,
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	const origin = `http://127.0.0.1:${server.port}`;
	return {
		server,
		origin,
		serverUrl: `${origin}/mcp/`,
		metadataUrl: `${origin}/.well-known/oauth-protected-resource`,
		requests,
		registrations,
		authorizations,
		tokens,
	};
}

describe("explicit MCP protected-resource metadata", () => {
	let directory = "";
	let filePath = "";
	let authStorage: AuthStorage;
	let fixture: OAuthFixture | undefined;
	let presentedAuthorizations: string[];

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-resource-metadata-"));
		filePath = path.join(directory, "mcp.json");
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.credentials.reload();
		presentedAuthorizations = [];
	});

	afterEach(async () => {
		fixture?.server.stop(true);
		fixture = undefined;
		await authStorage.close();
		await removeWithRetries(directory);
	});

	function authorize(config: MCPHttpServerConfig, challenge?: string[]) {
		const abort = new AbortController();
		let browser: Promise<void> | undefined;
		const flow = reauthorizeMcpServer(
			"synthetic-drata",
			{ filePath, scope: "user", config, discovered: false },
			{
				authStorage,
				cwd: directory,
				authChallenge: challenge ? { wwwAuthenticate: challenge } : undefined,
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
				onAuth: info => {
					presentedAuthorizations.push(info.url);
					browser = fetch(info.url)
						.then(async response => {
							await response.text();
							if (!response.ok) throw new Error(`Synthetic authorization failed: ${response.status}`);
						})
						.catch(error => {
							abort.abort(error);
							throw error;
						});
					void browser.catch(() => {});
				},
			},
		);
		return flow.finally(async () => {
			await browser;
		});
	}

	test("does not trust origin-canonical root metadata inferred from a bare Bearer challenge", async () => {
		fixture = oauthFixture();
		const config: MCPHttpServerConfig = { type: "http", url: fixture.serverUrl, oauth: { scope: READ_SCOPE } };
		await expect(authorize(config)).rejects.toThrow("Could not discover OAuth endpoints");
		expect(fixture.requests).toContain("/.well-known/oauth-protected-resource");
		expect(fixture.registrations).toEqual([]);
		expect(fixture.authorizations).toEqual([]);
		expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.serverUrl))).toBeUndefined();
	});

	test.each([
		{ handshake: "bare", challenge: false, scope: READ_SCOPE },
		{ handshake: "anonymous", challenge: false, scope: READ_SCOPE },
		{ handshake: "bare", challenge: true, scope: READ_SCOPE },
		{ handshake: "json-endpoints", challenge: false, scope: READ_SCOPE },
		{ handshake: "bare", challenge: false, scope: "" },
	] as const)(
		"authorizes $handshake handshake with configured scope '$scope' and tool challenge $challenge",
		async options => {
			fixture = oauthFixture(options);
			const config: MCPHttpServerConfig = {
				type: "http",
				url: fixture.serverUrl,
				oauth: {
					resourceMetadataUrl: ` ${fixture.metadataUrl} `,
					clientName: "Coreforge",
					callbackPort: 0,
					scope: options.scope,
				},
			};
			const definition = JSON.stringify({ mcpServers: { "synthetic-drata": config } });
			await Bun.write(filePath, definition);
			const outcome = await authorize(
				config,
				options.challenge
					? [`Bearer resource_metadata="${fixture.origin}/untrusted-metadata" scope="write:evidence"`]
					: undefined,
			);

			expect(outcome.persisted).toBe(false);
			expect(outcome.oauth.issuerUrl).toBe(`${fixture.origin}/auth0-proxy`);
			expect(fixture.registrations).toEqual([
				expect.objectContaining({ client_name: "Coreforge", ...(options.scope ? { scope: options.scope } : {}) }),
			]);
			expect(fixture.registrations[0]?.scope).toBe(options.scope || undefined);
			expect(fixture.authorizations.map(url => url.searchParams.get("scope"))).toEqual([options.scope || null]);
			expect(fixture.tokens.map(params => params.get("resource"))).toEqual([fixture.origin]);
			expect(fixture.requests).not.toContain("/untrusted-metadata");
			expect(fixture.requests).not.toContain("/unadvertised/authorize");
			expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.serverUrl))).toMatchObject({
				type: "oauth",
				access: "synthetic-access",
				refresh: "synthetic-refresh",
				issuerUrl: `${fixture.origin}/auth0-proxy`,
				resource: fixture.origin,
				clientId: "synthetic-dcr-client",
			});
			expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.origin))).toBeUndefined();
			expect(await Bun.file(filePath).text()).toBe(definition);
		},
		15_000,
	);

	test("persists a required reauth update without replacing a user metadata environment reference", async () => {
		fixture = oauthFixture();
		const envName = "OMP_TEST_MCP_PERSISTED_METADATA_URL";
		const previous = Bun.env[envName];
		Bun.env[envName] = fixture.metadataUrl;
		process.env[envName] = fixture.metadataUrl;
		try {
			const metadataReference = `\${OMP_TEST_MCP_PERSISTED_METADATA_URL}`;
			const config: MCPHttpServerConfig = {
				type: "http",
				url: fixture.serverUrl,
				auth: { type: "oauth", credentialId: "synthetic-stale-pointer" },
				oauth: {
					resourceMetadataUrl: metadataReference,
					clientName: "Coreforge",
					callbackPort: 0,
					scope: READ_SCOPE,
				},
			};
			await Bun.write(filePath, JSON.stringify({ mcpServers: { "synthetic-drata": config } }));

			const outcome = await authorize(config);

			expect(outcome.persisted).toBe(true);
			const saved = (await readMCPConfigFile(filePath)).mcpServers?.["synthetic-drata"];
			expect(saved?.oauth?.resourceMetadataUrl).toBe(metadataReference);
			expect(saved?.auth?.credentialId).toBe(mcpOAuthCredentialId(fixture.serverUrl));
			expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.serverUrl))).toMatchObject({
				type: "oauth",
				access: "synthetic-access",
				resource: fixture.origin,
			});
		} finally {
			if (previous === undefined) {
				delete Bun.env[envName];
				delete process.env[envName];
			} else {
				Bun.env[envName] = previous;
				process.env[envName] = previous;
			}
		}
	}, 15_000);

	test.each(["mismatched", "unavailable"] as const)(
		"rejects an %s advertised issuer without origin-root auth fallback",
		async issuer => {
			fixture = oauthFixture({ issuer, handshake: "json-endpoints" });
			const config: MCPHttpServerConfig = {
				type: "http",
				url: fixture.serverUrl,
				oauth: { resourceMetadataUrl: fixture.metadataUrl, scope: READ_SCOPE },
			};
			await expect(authorize(config)).rejects.toBeInstanceOf(OAuthIssuerMismatchError);
			expect(presentedAuthorizations).toEqual([]);
			expect(fixture.registrations).toEqual([]);
			expect(fixture.authorizations).toEqual([]);
			expect(fixture.requests).not.toContain("/unadvertised/authorize");
			expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.serverUrl))).toBeUndefined();
		},
	);

	test.each([
		{ metadata: "unavailable", handshake: "bare" },
		{ metadata: "without-issuers", handshake: "bare" },
		{ metadata: "unavailable", handshake: "anonymous" },
	] as const)(
		"rejects $metadata configured metadata after a $handshake handshake without header issuer fallback",
		async options => {
			fixture = oauthFixture(options);
			const config: MCPHttpServerConfig = {
				type: "http",
				url: fixture.serverUrl,
				oauth: { resourceMetadataUrl: fixture.metadataUrl, clientId: "synthetic-client", callbackPort: 0 },
			};
			await expect(
				authorize(
					config,
					options.handshake === "bare"
						? ['Bearer realm="drata-mcp"', `Mcp-Auth-Server: ${fixture.origin}`]
						: undefined,
				),
			).rejects.toThrow("Could not discover OAuth endpoints");
			expect(fixture.requests).not.toContain("/.well-known/oauth-authorization-server");
			expect(fixture.requests).not.toContain("/unadvertised/authorize");
			expect(authStorage.credentials.get(mcpOAuthCredentialId(fixture.serverUrl))).toBeUndefined();
		},
	);

	test.each([
		"",
		"/relative",
		"not-a-url",
		"file:///tmp/metadata.json",
		"https://user:password@example.test/metadata",
		"https://user@example.test/metadata",
		42,
		null,
	])("rejects unsafe configured metadata %j before connecting or persisting a server", async resourceMetadataUrl => {
		fixture = oauthFixture();
		const config = {
			type: "http",
			url: fixture.serverUrl,
			oauth: { resourceMetadataUrl },
		} as MCPHttpServerConfig;
		await expect(addMCPServer(filePath, "synthetic-drata", config)).rejects.toThrow("oauth.resourceMetadataUrl");
		await expect(authorize(config)).rejects.toThrow("oauth.resourceMetadataUrl");
		await Bun.write(filePath, JSON.stringify({ mcpServers: { "synthetic-drata": config } }));
		const discovered = await loadCapability<MCPServer>(mcpCapability.id, { cwd: directory, providers: ["mcp-json"] });
		expect(discovered.items).toEqual([]);
		expect(fixture.requests).toEqual([]);
	});
});
