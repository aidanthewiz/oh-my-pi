import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { mcpOAuthCredentialId, type MCPStoredOAuthCredential } from "../src/mcp/oauth-flow";
import type { MCPHttpServerConfig } from "../src/mcp/types";

const commandPath = path.resolve(import.meta.dir, "../src/commands/mcp.ts");
const parserPath = path.resolve(import.meta.dir, "../../utils/src/cli.ts");
const managerPath = path.resolve(import.meta.dir, "../src/mcp/manager.ts");
const loaderPath = path.resolve(import.meta.dir, "../src/mcp/config.ts");
const storagePath = path.resolve(import.meta.dir, "../src/sdk.ts");
const settingsPath = path.resolve(import.meta.dir, "../src/config/settings.ts");

type FixtureOptions = {
	anonymous?: boolean;
	permissionDenied?: boolean;
	rejectRefresh?: boolean;
	transientRefresh?: boolean;
	toolsDenied?: boolean;
};

interface OAuthFixture {
	server: Bun.Server<undefined>;
	url: string;
	authorizations: URL[];
	tokenRequests: URLSearchParams[];
	handshakes: string[];
	config: MCPHttpServerConfig;
}

function oauthServer(options: FixtureOptions = {}): OAuthFixture {
	const authorizations: URL[] = [];
	const tokenRequests: URLSearchParams[] = [];
	const handshakes: string[] = [];
	let access = "native-access";
	let grant: URL | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const serverUrl = `${url.origin}/mcp`;
			if (url.pathname === "/mcp") {
				if (request.method === "DELETE") return new Response(null, { status: 204 });
				if (request.method !== "POST") return new Response(null, { status: 405 });
				if (options.permissionDenied)
					return new Response("\x1b]52;c;dHJ1c3Q=\x07tenant permission denied\x1b[31m", { status: 403 });
				const authorization = request.headers.get("authorization") ?? "";
				if (!options.anonymous && authorization !== `Bearer ${access}`) {
					return Response.json(
						{ error: "unauthorized" },
						{
							status: 401,
							headers: {
								"WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp.read"`,
							},
						},
					);
				}
				const rpc = (await request.json()) as { id?: number | string; method: string };
				if (rpc.id === undefined) return new Response(null, { status: 202 });
				if (rpc.method === "initialize") {
					handshakes.push(authorization);
					return Response.json({
						jsonrpc: "2.0",
						id: rpc.id,
						result: {
							protocolVersion: "2025-11-25",
							capabilities: { tools: {} },
							serverInfo: { name: "native-auth-fixture", version: "1" },
						},
					});
				}
				if (rpc.method === "tools/list") {
					if (options.toolsDenied) return new Response("tool catalog permission denied", { status: 403 });
					return Response.json({
						jsonrpc: "2.0",
						id: rpc.id,
						result: { tools: [{ name: "identity", inputSchema: { type: "object" } }] },
					});
				}
				if (rpc.method === "tools/call") {
					return Response.json({
						jsonrpc: "2.0",
						id: rpc.id,
						result: { content: [{ type: "text", text: access }] },
					});
				}
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} });
			}
			if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
				return Response.json({
					resource: serverUrl,
					authorization_servers: [url.origin],
					scopes_supported: ["mcp.read", "mcp.write"],
				});
			}
			if (url.pathname === "/.well-known/oauth-authorization-server") {
				return Response.json({
					issuer: url.origin,
					authorization_endpoint: `${url.origin}/authorize`,
					token_endpoint: `${url.origin}/token`,
					client_id: "native-client",
				});
			}
			if (url.pathname === "/authorize") {
				authorizations.push(url);
				if (
					url.searchParams.get("scope") !== "mcp.read" ||
					url.searchParams.get("resource") !== serverUrl ||
					url.searchParams.get("client_id") !== "native-client" ||
					url.searchParams.get("code_challenge_method") !== "S256"
				) {
					return new Response("invalid authorization request", { status: 400 });
				}
				grant = url;
				const redirect = new URL(url.searchParams.get("redirect_uri")!);
				redirect.searchParams.set("state", url.searchParams.get("state")!);
				redirect.searchParams.set("code", "native-code");
				return Response.redirect(redirect.href);
			}
			if (url.pathname === "/token" && request.method === "POST") {
				const params = new URLSearchParams(await request.text());
				tokenRequests.push(params);
				if (params.get("grant_type") === "refresh_token") {
					if (options.transientRefresh)
						return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
					if (options.rejectRefresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
					if (params.get("refresh_token") !== "native-refresh" || params.get("client_id") !== "native-client") {
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					}
					access = "native-refreshed";
				} else {
					const challenge = createHash("sha256")
						.update(params.get("code_verifier") ?? "")
						.digest("base64url");
					if (
						!grant ||
						params.get("code") !== "native-code" ||
						params.get("client_id") !== "native-client" ||
						params.get("redirect_uri") !== grant.searchParams.get("redirect_uri") ||
						challenge !== grant.searchParams.get("code_challenge") ||
						params.get("resource") !== serverUrl
					) {
						return Response.json({ error: "invalid_grant" }, { status: 400 });
					}
					grant = undefined;
					access = `native-grant-${authorizations.length}`;
				}
				return Response.json({
					access_token: access,
					refresh_token: "native-refresh",
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
		url: `${origin}/mcp`,
		authorizations,
		tokenRequests,
		handshakes,
		config: {
			type: "http",
			url: `${origin}/mcp`,
			oauth: {
				resourceMetadataUrl: `${origin}/.well-known/oauth-protected-resource/mcp`,
				clientId: "native-client",
				callbackPort: 0,
				scope: "mcp.read",
			},
		},
	};
}

// The synthetic browser uses executable scripts rather than Windows ShellExecute.
describe.skipIf(process.platform === "win32")("native MCP auth command", () => {
	let root: string;
	let agentDir: string;
	let project: string;
	let browserLog: string;
	let fixture: OAuthFixture | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-mcp-auth-"));
		agentDir = path.join(root, "agent");
		project = path.join(root, "project");
		browserLog = path.join(root, "browser.log");
		await Promise.all([agentDir, project, path.join(root, "home"), path.join(root, "bin")].map(dir => fs.mkdir(dir)));
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			"mcp:\n  discoveryProviders: [native, mcp-managed, mcp-json, coreforge]\n  enableProjectConfig: false\n",
		);
		const browser = `#!${process.execPath}\nawait Bun.write(Bun.env.MCP_BROWSER_LOG, process.argv.at(-1));\nif (Bun.env.MCP_BROWSER_CANCEL === '1') process.kill(process.ppid, 'SIGINT');\nelse { const response = await fetch(process.argv.at(-1)); await response.text(); if (!response.ok) process.exitCode = 1; }\n`;
		for (const name of ["open", "xdg-open", "wslview"]) {
			const file = path.join(root, "bin", name);
			await fs.writeFile(file, browser, { mode: 0o755 });
		}
	});

	afterEach(async () => {
		fixture?.server.stop(true);
		fixture = undefined;
		await fs.rm(root, { recursive: true, force: true });
	});

	async function configure(body: unknown) {
		await fs.writeFile(path.join(agentDir, "mcp.json"), JSON.stringify(body));
	}

	async function credential(value?: MCPStoredOAuthCredential, profile = "default") {
		const storage = await AuthStorage.create(path.join(agentDir, "agent.db"));
		try {
			await storage.credentials.reload();
			const id = mcpOAuthCredentialId(fixture!.url, profile);
			if (value) await storage.credentials.set(id, value);
			return storage.credentials.get(id) as MCPStoredOAuthCredential | undefined;
		} finally {
			await storage.close();
		}
	}

	function grant(overrides: Partial<MCPStoredOAuthCredential> = {}): MCPStoredOAuthCredential {
		return {
			type: "oauth",
			access: "native-access",
			refresh: "native-refresh",
			expires: Date.now() + 3_600_000,
			tokenUrl: fixture!.url.replace("/mcp", "/token"),
			clientId: "native-client",
			resource: fixture!.url,
			...overrides,
		};
	}

	async function run(
		argv: string[],
		options: {
			tty?: boolean;
			cancel?: boolean;
			freshManager?: boolean;
			approveProject?: boolean;
			env?: Record<string, string>;
		} = {},
	) {
		const code = `
			import Mcp from ${JSON.stringify(commandPath)};
			import { run } from ${JSON.stringify(parserPath)};
			import { MCPManager } from ${JSON.stringify(managerPath)};
			import { loadAllMCPConfigs } from ${JSON.stringify(loaderPath)};
			import { discoverAuthStorage } from ${JSON.stringify(storagePath)};
			import { Settings } from ${JSON.stringify(settingsPath)};
			if (${Boolean(options.tty)}) {
				Object.defineProperty(process.stdin, 'isTTY', { value: true });
				Object.defineProperty(process.stdout, 'isTTY', { value: true });
			}
			if (${Boolean(options.approveProject)}) {
				await loadAllMCPConfigs(process.cwd(), {
					enableProjectConfig: false, discoveryProviders: ['coreforge'],
					requestProjectTrust: async () => true,
				});
			}
			await run({ bin: 'cf', version: 'test', argv: ['mcp', ...${JSON.stringify(argv)}],
				commands: [{ name: 'mcp', load: async () => Mcp }] });
			if (${Boolean(options.freshManager)} && process.exitCode === 0) {
				const settings = await Settings.loadReadOnly({ cwd: process.cwd() });
				const storage = await discoverAuthStorage(undefined, { settings });
				const manager = new MCPManager(process.cwd());
				manager.setAuthStorage(storage);
				try {
					const { configs, sources } = await loadAllMCPConfigs(process.cwd(), {
						enableProjectConfig: false, discoveryProviders: ['native', 'mcp-managed', 'coreforge'] });
					await manager.connectServers(configs, sources, undefined, 0);
					await manager.waitForStartup(0);
					const result = await manager.callTool('synthetic', 'identity');
					console.log('FRESH_CONNECTION=' + JSON.stringify(result.content));
				} finally { await manager.disconnectAll(); await storage.close(); }
			}
		`;
		const child = Bun.spawn([process.execPath, "--eval", code], {
			cwd: project,
			env: {
				HOME: path.join(root, "home"),
				PI_CODING_AGENT_DIR: agentDir,
				PI_CONFIG_DIR: ".omp",
				PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
				NO_COLOR: "1",
				MCP_BROWSER_LOG: browserLog,
				MCP_BROWSER_CANCEL: options.cancel ? "1" : "0",
				OMP_MCP_TIMEOUT_MS: "3000",
				...options.env,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		// Bound the external CLI; its event loop cannot use this process's fake clock.
		const timer = setTimeout(() => child.kill(), 20_000);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			return { stdout: Bun.stripANSI(stdout), stderr: Bun.stripANSI(stderr), exitCode };
		} finally {
			clearTimeout(timer);
			child.stdin.end();
		}
	}

	test("saves an exact URL/profile grant and a fresh manager uses it", async () => {
		fixture = oauthServer();
		await configure({ mcpServers: { synthetic: fixture.config } });
		await credential(grant({ access: "other-profile-access" }), "other-profile");
		const result = await run(["auth", "synthetic"], { tty: true, freshManager: true });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("connection-verified");
		expect(result.stdout).toContain('FRESH_CONNECTION=[{"type":"text","text":"native-grant-1"}]');
		expect(fixture.authorizations.map(url => url.searchParams.get("scope"))).toEqual(["mcp.read"]);
		expect(await credential()).toMatchObject({
			access: "native-grant-1",
			resource: fixture.url,
			clientId: "native-client",
			tokenUrl: fixture.url.replace("/mcp", "/token"),
		});
		expect(await credential(undefined, "other-profile")).toMatchObject({ access: "other-profile-access" });
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"))).toEqual({
			mcpServers: { synthetic: fixture.config },
		});
	}, 30_000);

	test("healthy grants are idempotent and explicit reauth starts a new grant", async () => {
		fixture = oauthServer();
		await configure({ mcpServers: { synthetic: fixture.config } });
		await credential(grant());
		expect((await run(["auth", "synthetic"], { tty: true })).exitCode).toBe(0);
		expect(fixture.authorizations).toEqual([]);
		expect(fixture.tokenRequests).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
		expect((await run(["reauth", "synthetic"], { tty: true })).exitCode).toBe(0);
		expect(fixture.tokenRequests.map(params => params.get("grant_type"))).toEqual(["authorization_code"]);
		expect(await credential()).toMatchObject({ access: "native-grant-1" });
	}, 30_000);

	test.each(["auth", "reauth"] as const)(
		"%s infers HTTP for URL-only definitions without rewriting raw settings",
		async action => {
			fixture = oauthServer();
			const raw = {
				url: `\${MCP_NATIVE_AUTH_URL}`,
				enabled: false,
				timeout: 3000,
				oauth: {
					...fixture.config.oauth,
					resourceMetadataUrl: `\${MCP_NATIVE_AUTH_METADATA_URL}`,
				},
				...(action === "reauth"
					? {
							auth: {
								type: "oauth",
								credentialId: mcpOAuthCredentialId(fixture.url, "default"),
								tokenUrl: fixture.url.replace("/mcp", "/token"),
								clientId: "native-client",
								resource: fixture.url,
							},
						}
					: {}),
			};
			const body = { mcpServers: { synthetic: raw }, enabledServers: ["synthetic"] };
			await configure(body);
			if (action === "reauth") await credential(grant());
			const result = await run([action, "synthetic"], {
				tty: true,
				freshManager: true,
				env: {
					MCP_NATIVE_AUTH_URL: fixture.url,
					MCP_NATIVE_AUTH_METADATA_URL: fixture.config.oauth!.resourceMetadataUrl!,
				},
			});
			expect(result.exitCode, result.stderr + result.stdout).toBe(0);
			expect(result.stdout).toContain('FRESH_CONNECTION=[{"type":"text","text":"native-grant-1"}]');
			expect(fixture.handshakes).toContain("Bearer native-grant-1");
			expect(fixture.tokenRequests.map(params => params.get("grant_type"))).toEqual(["authorization_code"]);
			expect(await credential()).toMatchObject({ access: "native-grant-1", resource: fixture.url });
			const saved = JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"));
			expect(saved.mcpServers).toEqual(body.mcpServers);
			expect(saved.enabledServers).toEqual(body.enabledServers);
		},
		30_000,
	);

	test.each(["expiring", "rejected"] as const)(
		"refreshes a %s grant without opening a browser",
		async condition => {
			fixture = oauthServer();
			await configure({ mcpServers: { synthetic: fixture.config } });
			await credential(
				grant(condition === "expiring" ? { expires: Date.now() - 10_000 } : { access: "rejected-access" }),
			);
			const result = await run(["auth", "synthetic", "--check"], { tty: true });
			expect(result.exitCode).toBe(0);
			expect(await credential()).toMatchObject({ access: "native-refreshed" });
			expect(fixture.tokenRequests.map(params => params.get("grant_type"))).toEqual(["refresh_token"]);
			expect(fixture.authorizations).toEqual([]);
			expect(await Bun.file(browserLog).exists()).toBe(false);
		},
		30_000,
	);

	test.each([true, false])(
		"missing grant is actionable and passive with check=%s",
		async check => {
			fixture = oauthServer();
			await configure({ mcpServers: { synthetic: fixture.config } });
			const result = await run(["auth", "synthetic", ...(check ? ["--check"] : [])], { tty: check });
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("authentication-required");
			expect(result.stderr).toContain('mcp auth "synthetic"');
			expect(fixture.tokenRequests).toEqual([]);
			expect(fixture.authorizations).toEqual([]);
			expect(await Bun.file(browserLog).exists()).toBe(false);
		},
		30_000,
	);

	test("a revoked refresh grant requires authentication without interactive side effects", async () => {
		fixture = oauthServer({ rejectRefresh: true });
		await configure({ mcpServers: { synthetic: fixture.config } });
		await credential(grant({ access: "rejected-access" }));
		const result = await run(["auth", "synthetic", "--check"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("authentication-required");
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("a definitively rejected refresh falls back to fresh interactive authentication", async () => {
		fixture = oauthServer({ rejectRefresh: true });
		await configure({ mcpServers: { synthetic: fixture.config } });
		await credential(grant({ access: "rejected-access" }));
		const result = await run(["auth", "synthetic"], { tty: true, freshManager: true });
		expect(result.exitCode).toBe(0);
		expect(fixture.tokenRequests.map(params => params.get("grant_type"))).toEqual([
			"refresh_token",
			"authorization_code",
		]);
		expect(await credential()).toMatchObject({ access: "native-grant-1" });
		expect(result.stdout).toContain("FRESH_CONNECTION=");
	}, 30_000);

	test("explicit reauth requires interaction without contacting the server in non-TTY use", async () => {
		fixture = oauthServer();
		await configure({ mcpServers: { synthetic: fixture.config } });
		const result = await run(["reauth", "synthetic"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("interaction-required");
		expect(fixture.handshakes).toEqual([]);
		expect(fixture.authorizations).toEqual([]);
		expect(fixture.tokenRequests).toEqual([]);
		expect(await Bun.file(path.join(agentDir, "agent.db")).exists()).toBe(false);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("transient refresh failure retains the grant and never starts consent", async () => {
		fixture = oauthServer({ transientRefresh: true });
		await configure({ mcpServers: { synthetic: fixture.config } });
		await credential(grant({ access: "rejected-access" }));
		const result = await run(["auth", "synthetic"], { tty: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("OAuth refresh temporarily failed");
		expect(await credential()).toMatchObject({ access: "rejected-access" });
		expect(fixture.tokenRequests.map(params => params.get("grant_type"))).toEqual(["refresh_token"]);
		expect(fixture.authorizations).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("an anonymous server verifies without creating an OAuth grant", async () => {
		fixture = oauthServer({ anonymous: true });
		await configure({ mcpServers: { synthetic: { type: "http", url: fixture.url } } });
		const result = await run(["auth", "synthetic"], { tty: true });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("connection-verified");
		expect(await credential()).toBeUndefined();
		expect(fixture.authorizations).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("permission failures do not trigger consent", async () => {
		fixture = oauthServer({ permissionDenied: true });
		await configure({ mcpServers: { synthetic: fixture.config } });
		const result = await run(["auth", "synthetic"], { tty: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("connection-failed");
		expect(result.stderr).toContain("403");
		expect(result.stderr).toContain("tenant permission denied");
		expect(result.stderr).not.toContain("\x1b");
		expect(result.stderr).not.toContain("\x07");
		expect(fixture.authorizations).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("a saved grant does not imply a verified connection", async () => {
		fixture = oauthServer({ toolsDenied: true });
		await configure({ mcpServers: { synthetic: fixture.config } });
		const result = await run(["auth", "synthetic"], { tty: true });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("grant-saved; connection-unverified");
		expect(await credential()).toMatchObject({ access: "native-grant-1" });
	}, 30_000);

	test.skipIf(process.platform === "win32")(
		"cancellation returns nonzero and stores no grant",
		async () => {
			fixture = oauthServer();
			await configure({ mcpServers: { synthetic: fixture.config } });
			const result = await run(["auth", "synthetic"], { tty: true, cancel: true });
			expect(result.exitCode).toBe(130);
			expect(result.stderr).toContain("cancelled");
			expect(await credential()).toBeUndefined();
		},
		30_000,
	);

	test("force-enabled raw definitions retain their source and denylist wins", async () => {
		fixture = oauthServer();
		const raw = { ...fixture.config, enabled: false };
		await configure({ mcpServers: { synthetic: raw }, enabledServers: ["synthetic"] });
		const result = await run(["auth", "synthetic"], { tty: true, freshManager: true });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain('FRESH_CONNECTION=[{"type":"text","text":"native-grant-1"}]');
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"))).toEqual({
			mcpServers: { synthetic: raw },
			enabledServers: ["synthetic"],
		});
		await configure({
			mcpServers: { synthetic: raw },
			enabledServers: ["synthetic"],
			disabledServers: ["synthetic"],
		});
		const handshakes = [...fixture.handshakes];
		expect((await run(["auth", "synthetic"], { tty: true })).exitCode).toBe(2);
		expect(fixture.handshakes).toEqual(handshakes);
	}, 30_000);

	test("validates every named target before contacting a selected server", async () => {
		fixture = oauthServer({ anonymous: true });
		await configure({ mcpServers: { synthetic: fixture.config, disabled: { ...fixture.config, enabled: false } } });
		for (const name of ["unknown", "disabled"]) {
			expect((await run(["auth", "synthetic", name], { tty: true })).exitCode).toBe(2);
		}
		expect(fixture.handshakes).toEqual([]);
		expect(await Bun.file(path.join(agentDir, "agent.db")).exists()).toBe(false);
	}, 30_000);

	test("managed definitions own collisions and unselected integrations remain untouched", async () => {
		fixture = oauthServer({ anonymous: true });
		await fs.writeFile(
			path.join(agentDir, "mcp.managed.json"),
			JSON.stringify({
				mcpServers: {
					synthetic: fixture.config,
					optional: { ...fixture.config, enabled: false },
				},
			}),
		);
		await configure({ mcpServers: { synthetic: { type: "http", url: "http://127.0.0.1:1/wrong-owner" } } });
		expect((await run(["auth", "--check"])).exitCode).toBe(0);
		expect(fixture.handshakes).toEqual([""]);
		expect((await run(["auth", "optional", "--check"])).exitCode).toBe(2);
		expect(fixture.handshakes).toEqual([""]);
	}, 30_000);

	test.each(["auth", "reauth"] as const)(
		"%s preserves exact project trust when replacing stale client authentication",
		async action => {
			fixture = oauthServer();
			const projectPath = path.join(project, ".coreforge", "mcp.json");
			await fs.mkdir(path.dirname(projectPath));
			const projectText = JSON.stringify({
				mcpServers: {
					synthetic: {
						...fixture.config,
						enabled: false,
						auth: {
							type: "oauth",
							credentialId: mcpOAuthCredentialId(fixture.url, "default"),
							tokenUrl: fixture.url.replace("/mcp", "/token"),
							clientId: "native-client",
							resource: fixture.url,
						},
					},
				},
			});
			await fs.writeFile(projectPath, projectText);
			await configure({ enabledServers: ["synthetic"] });
			const result = await run([action, "synthetic"], {
				tty: true,
				approveProject: true,
				freshManager: true,
			});
			expect(result.exitCode, result.stderr + result.stdout).toBe(0);
			expect(result.stdout).toContain('FRESH_CONNECTION=[{"type":"text","text":"native-grant-1"}]');
			expect(await fs.readFile(projectPath, "utf8")).toBe(projectText);
			expect(fixture.handshakes).toContain("Bearer native-grant-1");
			expect(await credential()).toMatchObject({ access: "native-grant-1" });
		},
		30_000,
	);

	test.each(["auth", "reauth"] as const)(
		"%s does not replace immutable project authorization with an unusable grant",
		async action => {
			fixture = oauthServer();
			const projectPath = path.join(project, ".coreforge", "mcp.json");
			await fs.mkdir(path.dirname(projectPath));
			const projectText = JSON.stringify({
				mcpServers: {
					synthetic: {
						...fixture.config,
						headers: { Authorization: "synthetic-project-authorization" },
					},
				},
			});
			await fs.writeFile(projectPath, projectText);
			await configure({ enabledServers: ["synthetic"] });
			const result = await run([action, "synthetic"], { tty: true, approveProject: true });
			expect(result.exitCode, result.stderr + result.stdout).toBe(1);
			expect(fixture.authorizations).toEqual([]);
			expect(fixture.tokenRequests).toEqual([]);
			expect(await credential()).toBeUndefined();
			expect(await fs.readFile(projectPath, "utf8")).toBe(projectText);
			expect(await Bun.file(browserLog).exists()).toBe(false);
		},
		30_000,
	);

	test("does not bypass project trust or discovery exclusions", async () => {
		fixture = oauthServer({ anonymous: true });
		await configure({ mcpServers: {} });
		await fs.mkdir(path.join(project, ".coreforge"));
		await fs.writeFile(
			path.join(project, ".coreforge", "mcp.json"),
			JSON.stringify({ mcpServers: { synthetic: fixture.config } }),
		);
		expect((await run(["auth", "synthetic"], { tty: true })).exitCode).toBe(2);
		expect(fixture.handshakes).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 30_000);

	test("configure is selection-only and invalid syntax/help never opens storage", async () => {
		fixture = oauthServer();
		await fs.writeFile(
			path.join(agentDir, "mcp.managed.json"),
			JSON.stringify({ mcpServers: { synthetic: { ...fixture.config, enabled: false } } }),
		);
		expect((await run(["configure", "synthetic=enabled"], { tty: true })).exitCode).toBe(0);
		expect(JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"))).toMatchObject({
			enabledServers: ["synthetic"],
		});
		const original = await fs.readFile(path.join(agentDir, "mcp.json"), "utf8");
		for (const argv of [
			["configure"],
			["configure", "synthetic=enabled", "bad=invalid"],
			["configure", "synthetic=enabled", "--check"],
			["auth", "synthetic", "--unknown"],
			["reauth"],
			["reauth", "synthetic", "extra"],
			["reauth", "synthetic", "--check"],
		]) {
			expect((await run(argv, { tty: true })).exitCode).toBe(2);
		}
		expect((await run(["auth", "--help"], { tty: true })).exitCode).toBe(0);
		expect(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8")).toBe(original);
		expect(await Bun.file(path.join(agentDir, "agent.db")).exists()).toBe(false);
		expect(fixture.tokenRequests).toEqual([]);
		expect(await Bun.file(browserLog).exists()).toBe(false);
	}, 60_000);

	test("named stdio is unsupported and default hosted auth never spawns it", async () => {
		const marker = path.join(root, "stdio-spawned");
		await configure({
			mcpServers: {
				external: {
					command: process.execPath,
					args: ["--eval", `await Bun.write(${JSON.stringify(marker)}, 'spawned')`],
				},
			},
		});
		expect((await run(["auth", "external"])).exitCode).toBe(2);
		expect((await run(["auth"])).exitCode).toBe(0);
		expect(await Bun.file(marker).exists()).toBe(false);
		expect(await Bun.file(path.join(agentDir, "agent.db")).exists()).toBe(false);
	}, 30_000);
});
