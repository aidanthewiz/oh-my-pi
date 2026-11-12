import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Launch provenance is captured at module import, so the bridge runs in a separate process.
test("managed AWS validates deferred legacy schemas against live profile bindings", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-routing-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			"[profile commercial]\nregion = us-east-1\nsso_session = shared\n[sso-session shared]\nsso_start_url = https://example.invalid/start\nsso_region = us-east-1\n[profile other]\nregion = eu-central-1\n[profile government]\nregion = us-gov-west-1\n[profile coreforge]\nregion = us-east-1\n",
		);
		const bridge = path.resolve(import.meta.dir, "../src/mcp/tool-bridge.ts");
		const script = `
import { MCPTool, DeferredMCPTool } from ${JSON.stringify(bridge)};
const requests = [];
let connects = 0;
let reconnects = 0;
let expired = false;
const definition = { name: "aws___run_script", inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["commercial", "other", "government", "coreforge"] }, code: { type: "string" } } } };
const connection = {
 name: "coreforge-aws-agent-toolkit", config: { command: "unused" }, capabilities: { tools: {} },
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [definition] };
  requests.push(params.arguments?.aws_profile ?? "knowledge");
  if (expired) return { isError: true, content: [{ type: "text", text: "SSO token expired: login required" }] };
  return { content: [{ type: "text", text: JSON.stringify({ profile: params.arguments?.aws_profile }) }] };
 } },
};
const deferred = new DeferredMCPTool(connection.name, definition, async () => { connects++; return connection; }, undefined, async () => { reconnects++; return connection; });
const context = {};
const rejected = [];
for (const selected of [undefined, "government", "coreforge", "missing"]) {
 const args = { code: "result = {}\\nresult", ...(selected ? { aws_profile: selected } : {}) };
 const result = await deferred.execute("reject", args, undefined, context);
 rejected.push({ error: result.isError, text: result.content[0].text });
}
const afterRejections = { connects, reconnects, requests: requests.length };
const direct = new MCPTool(connection, definition);
await direct.execute("one", { aws_profile: "commercial", code: "result = {}\\nresult" }, undefined, context);
await direct.execute("two", { aws_profile: "other", code: "result = {}\\nresult" }, undefined, context);
const knowledge = new MCPTool(connection, { name: "aws___list_regions", inputSchema: { type: "object", properties: {} } });
await knowledge.execute("knowledge", {}, undefined, context);
expired = true;
const authResult = await direct.execute("expired", { aws_profile: "commercial", code: "result = {}\\nresult" }, undefined, context);
const boundCalls = [];
const legacyCachedDefinition = {
 name: "aws___run_script",
 inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
};
const boundConnection = {
 name: connection.name, config: connection.config, capabilities: { tools: {} }, operationalAwsProfiles: ["commercial"],
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [legacyCachedDefinition] };
  if ("aws_profile" in params.arguments) throw new Error("Upstream single-profile schema rejects aws_profile");
  boundCalls.push(params.arguments.code);
  return { content: [{ type: "text", text: "bound-commercial identity" }] };
 } },
};
const legacyTool = new DeferredMCPTool(connection.name, legacyCachedDefinition, async () => boundConnection);
const legacySchema = legacyTool.parameters;
const legacyMissing = await legacyTool.execute("legacy-missing", { code: "read" }, undefined, context);
const legacyAllowed = await legacyTool.execute("legacy-allowed", { aws_profile: "commercial", code: "read" }, undefined, context);
const legacyWrong = await legacyTool.execute("legacy-wrong", { aws_profile: "other", code: "read" }, undefined, context);
boundConnection.awsProfileBindings?.set("aws___run_script", "other");
const legacyChanged = await legacyTool.execute("legacy-changed", { aws_profile: "commercial", code: "read" }, undefined, context);
let staleConnects = 0;
const staleDefinition = {
 name: "aws___run_script",
 inputSchema: { type: "object", properties: { code: { type: "string" }, aws_profile: { type: "string", enum: ["commercial"] } }, required: ["code", "aws_profile"] },
};
const freshConnection = {
 name: connection.name, config: connection.config, capabilities: { tools: {} }, operationalAwsProfiles: ["other"],
 transport: { request: async (method, params) => {
  if (method === "tools/list") return { tools: [{ name: "aws___run_script", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } }] };
  if ("aws_profile" in params.arguments) throw new Error("Single-profile proxy rejected aws_profile");
  return { content: [{ type: "text", text: "current-other identity" }] };
 } },
};
const staleTool = new DeferredMCPTool(connection.name, staleDefinition, async () => { staleConnects++; return freshConnection; });
const staleAllowed = await staleTool.execute("stale", { aws_profile: "other", code: "read" }, undefined, context);
const staleResult = { connects: staleConnects, error: staleAllowed.isError, text: staleAllowed.content[0].text };
console.log(JSON.stringify({ rejected, afterRejections, requests, authResult, reconnects, boundCalls, legacyMissing, legacyWrong, legacyAllowed, legacyChanged, legacySchema, staleResult }));
`;
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			cwd: root,
			signal: AbortSignal.timeout(20_000),
			env: {
				HOME: root,
				PATH: process.env.PATH ?? "",
				OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
				OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
				OMP_OPERATIONAL_AWS_EXECUTABLE: process.execPath,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, stderr).toBe(0);
		const result = JSON.parse(stdout);
		expect(result.afterRejections).toEqual({
			connects: 0,
			reconnects: 0,
			requests: 0,
		});
		expect(result.rejected.map((entry: { error: boolean }) => entry.error)).toEqual([true, true, true, true]);
		expect(result.rejected[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.rejected[1].text).toContain("WRONG_PARTITION");
		expect(result.requests).toEqual(["commercial", "other", "knowledge", "commercial"]);
		expect(result.authResult.isError).toBe(true);
		expect(result.reconnects).toBe(0);
		expect(result.legacyMissing.isError).toBe(true);
		expect(result.legacyWrong.isError).toBe(true);
		expect(result.legacyAllowed.isError, result.legacyAllowed.content[0].text).not.toBe(true);
		expect(result.legacyAllowed.content[0].text).toContain("bound-commercial identity");
		expect(result.legacyChanged.isError).toBe(true);
		expect(result.legacyWrong.content[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.boundCalls).toEqual(["read"]);
		expect(result.legacyChanged.content[0].text).toContain("PROFILE_NOT_FOUND");
		expect(result.legacySchema.required).toContain("aws_profile");
		expect(result.staleResult).toEqual({ connects: 1, text: "current-other identity" });
		expect(result.legacySchema.properties.aws_profile).toMatchObject({
			type: "string",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);

test("managed AWS discovers anonymously and signs with the selected profile on first use", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-first-use-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(
			config,
			"[profile expired]\nregion = us-east-1\nsso_session = first\n[sso-session first]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n[profile healthy]\nregion = us-east-1\n[profile still-expired]\nregion = us-east-1\n[profile coreforge]\nregion = us-east-1\n",
		);
		const aws = path.join(root, process.platform === "win32" ? "aws.exe" : "aws");
		const fixture = path.resolve(import.meta.dir, "fixtures/recording-aws.ts");
		if (process.platform === "win32") {
			const build = Bun.spawn([process.execPath, "build", "--compile", fixture, "--outfile", aws], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [error, exit] = await Promise.all([new Response(build.stderr).text(), build.exited]);
			expect(exit, error).toBe(0);
		} else {
			await fs.writeFile(aws, `#!${process.execPath}\n${await fs.readFile(fixture, "utf8")}`, { mode: 0o755 });
		}
		const proxy = path.join(root, "proxy.ts");
		await fs.writeFile(
			proxy,
			`import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const profiles = (Bun.env.OMP_OPERATIONAL_AWS_PROFILES ?? "").split("\\n").filter(Boolean);
appendFileSync(join(Bun.env.HOME!, "proxy.starts"), JSON.stringify(profiles) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
 const request = JSON.parse(line);
 if (!request.id) continue;
 let result;
 let error;
 if (request.method === "initialize") {
  if (profiles[0] === "expired" && !existsSync(join(Bun.env.HOME!, "authenticated-expired")))
   error = { code: -32000, message: "SSOTokenLoadError: first profile expired" };
  else result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake-aws", version: "1" } };
 } else if (request.method === "tools/list") {
  result = { tools: [
   { name: "aws___list_regions", inputSchema: { type: "object", properties: {} } },
   { name: "aws___run_script", inputSchema: { type: "object",
     properties: { code: { type: "string" }, ...(profiles.length > 1 ? { aws_profile: { type: "string", enum: profiles } } : {}) },
     required: ["code"] } },
   { name: "aws___describe_resources", annotations: { readOnlyHint: true }, inputSchema: { type: "object",
     properties: { code: { type: "string" }, ...(profiles.length > 1 ? { aws_profile: { type: "string", enum: profiles } } : {}) },
     required: ["code"] } },
  ] };
 } else if (request.method === "tools/call") {
  appendFileSync(join(Bun.env.HOME!, "proxy.calls"), JSON.stringify(request.params.arguments) + "\\n");
  if (request.params.arguments?.code === "challenge" && !existsSync(join(Bun.env.HOME!, "challenge-seen"))) {
   writeFileSync(join(Bun.env.HOME!, "challenge-seen"), "yes");
   result = { isError: true, content: [{ type: "text", text: "challenge" }], _meta: { "mcp/www_authenticate": ["Bearer realm=\\"fixture\\""] } };
  } else result = { content: [{ type: "text", text: JSON.stringify({ profiles, args: request.params.arguments }) }] };
 } else result = {};
 console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }));
}`,
		);
		const script = `
import { strict as assert } from "node:assert";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { connectToServer, disconnectServer, listTools } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/client.ts"))};
import { MCPTool } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/tool-bridge.ts"))};
import { Settings } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/settings.ts"))};
import { MCPManager } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/manager.ts"))};
import { recoverTrustedAwsAuthentication } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/tools/aws.ts"))};
import { getAgentDir } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
const config = { command: process.execPath, args: ["--no-env-file", ${JSON.stringify(proxy)}] };
const options = { preserveOperationalAws: true, awsAnonymousBootstrap: true };
let connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
const tools = await listTools(connection);
assert.deepEqual(connection.operationalAwsProfiles, []);
assert.deepEqual(tools.find(t => t.name === "aws___run_script").inputSchema.properties.aws_profile.enum, ["expired", "healthy", "still-expired"]);
assert.equal(readFileSync(join(process.env.HOME, "proxy.starts"), "utf8").trim(), "[]");
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim(), "");
const awsCalls = () => readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
const proxyCalls = () => readFileSync(join(process.env.HOME, "proxy.calls"), "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse);
const context = { hasUI: true, settings: Settings.isolated(), sessionManager: { getCwd: () => process.env.HOME },
 ui: { confirm: async () => true, notify: () => {} } };
const reconnect = async ({ awsProfile } = {}) => {
 await disconnectServer(connection);
 connection = await connectToServer("coreforge-aws-agent-toolkit", config, { preserveOperationalAws: true, awsPreferredProfile: awsProfile });
 return connection;
};
const knowledge = new MCPTool(connection, tools.find(t => t.name === "aws___list_regions"));
const knowledgeResult = await knowledge.execute("knowledge", {}, undefined, context);
assert.notEqual(knowledgeResult.isError, true, knowledgeResult.content[0]?.text);
const run = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnect);
const healthy = await run.execute("healthy", { aws_profile: "healthy", code: "result = 1" }, undefined, context);
assert.notEqual(healthy.isError, true, healthy.content[0]?.text);
assert.deepEqual(JSON.parse(healthy.content[0].text).profiles, ["healthy", "expired", "still-expired"]);
assert.equal(JSON.parse(healthy.content[0].text).args.aws_profile, "healthy");
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim().split("\\n").length, 1);
const firstCalls = awsCalls().length;
const repeated = await run.execute("repeat", { aws_profile: "healthy", code: "result = 1" }, undefined, context);
assert.notEqual(repeated.isError, true, repeated.content[0]?.text);
assert.equal(awsCalls().length, firstCalls);
const beforeBlocked = proxyCalls().length;
const blocked = await run.execute("blocked", { aws_profile: "still-expired", code: "result = 2" }, undefined, { ...context, hasUI: false });
assert.equal(blocked.isError, true);
assert.match(blocked.content[0].text, /AUTH_REQUIRED/);
assert.equal(proxyCalls().length, beforeBlocked);
assert.equal(awsCalls().at(-1).argv.includes("still-expired"), true);
const selected = await run.execute("selected", { aws_profile: "expired", code: "result = 3" }, undefined, context);
assert.notEqual(selected.isError, true, selected.content[0]?.text);
assert.equal(JSON.parse(selected.content[0].text).args.aws_profile, "expired");
assert.equal(proxyCalls().length, beforeBlocked + 1);
const afterSelected = awsCalls().length;
const selectedAgain = await run.execute("selected-again", { aws_profile: "expired", code: "result = 3" }, undefined, context);
assert.notEqual(selectedAgain.isError, true, selectedAgain.content[0]?.text);
assert.equal(awsCalls().length, afterSelected);
await disconnectServer(connection);
const afterDrop = await run.execute("reconnect", { aws_profile: "healthy", code: "result = 4" }, undefined, context);
assert.notEqual(afterDrop.isError, true, afterDrop.content[0]?.text);
assert.deepEqual(JSON.parse(afterDrop.content[0].text).profiles, ["healthy", "expired", "still-expired"]);
assert.equal(awsCalls().length, afterSelected + 1);
const safeRead = new MCPTool(connection, (await listTools(connection)).find(t => t.name === "aws___describe_resources"), reconnect);
const beforeChallenge = awsCalls().length;
const beforeChallengeForward = proxyCalls().length;
const retried = await safeRead.execute("challenge", { aws_profile: "expired", code: "challenge" }, undefined, context);
assert.notEqual(retried.isError, true, retried.content[0]?.text);
assert.equal(JSON.parse(retried.content[0].text).args.aws_profile, "expired");
assert.equal(awsCalls().length, beforeChallenge + 2);
assert.equal(proxyCalls().length, beforeChallengeForward + 2);
const afterChallenge = awsCalls().length;
const retriedAgain = await safeRead.execute("after-challenge", { aws_profile: "expired", code: "result = 3" }, undefined, context);
assert.notEqual(retriedAgain.isError, true, retriedAgain.content[0]?.text);
assert.equal(awsCalls().length, afterChallenge);
await disconnectServer(connection);
connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
const expiredRun = new MCPTool(connection, (await listTools(connection)).find(t => t.name === "aws___run_script"), reconnect);
const recovered = await expiredRun.execute("expired", { aws_profile: "expired", code: "result = 2" }, undefined, context);
assert.notEqual(recovered.isError, true, recovered.content[0]?.text);
assert.deepEqual(JSON.parse(recovered.content[0].text).profiles, ["expired", "healthy", "still-expired"]);
assert.equal(readFileSync(join(process.env.HOME, "aws.calls"), "utf8").trim().split("\\n").filter(x => x.includes('"login"')).length, 1);
await disconnectServer(connection);
connection = await connectToServer("coreforge-aws-agent-toolkit", config, options);
let sharedReconnect;
const reconnectTogether = async () => sharedReconnect ??= (async () => {
 await disconnectServer(connection);
 connection = await connectToServer("coreforge-aws-agent-toolkit", config, { preserveOperationalAws: true, awsPreferredProfile: "healthy" });
 return connection;
})();
const firstCaller = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnectTogether);
const secondCaller = new MCPTool(connection, tools.find(t => t.name === "aws___run_script"), reconnectTogether);
const [firstResult, secondResult] = await Promise.all([
 firstCaller.execute("first", { aws_profile: "healthy", code: "result = 5" }, undefined, context),
 secondCaller.execute("second", { aws_profile: "expired", code: "result = 6" }, undefined, context),
]);
assert.notEqual(firstResult.isError, true, firstResult.content[0]?.text);
assert.equal(secondResult.isError, true);
assert.match(secondResult.content[0].text, /PROFILE_CONFLICT/);
await disconnectServer(connection);
const singleConfig = { ...config, env: { AWS_MCP_PROXY_PROFILES: "healthy" } };
let single = await connectToServer("coreforge-aws-agent-toolkit", singleConfig, options);
const singleTools = await listTools(single);
assert.deepEqual(singleTools.find(t => t.name === "aws___run_script").inputSchema.properties.aws_profile.enum, ["healthy"]);
const singleRun = new MCPTool(single, singleTools.find(t => t.name === "aws___run_script"), async ({ awsProfile } = {}) => {
 await disconnectServer(single);
 single = await connectToServer("coreforge-aws-agent-toolkit", singleConfig, { preserveOperationalAws: true, awsPreferredProfile: awsProfile });
 return single;
});
const only = await singleRun.execute("single", { aws_profile: "healthy", code: "result = 3" }, undefined, context);
assert.notEqual(only.isError, true, only.content[0]?.text);
assert.deepEqual(JSON.parse(only.content[0].text).profiles, ["healthy"]);
assert.equal(JSON.parse(only.content[0].text).args.aws_profile, undefined);
await disconnectServer(single);
const empty = await connectToServer("coreforge-aws-agent-toolkit", { ...config, env: { AWS_MCP_PROXY_PROFILES: "" } }, options);
assert.deepEqual((await listTools(empty)).map(t => t.name), ["aws___list_regions"]);
await disconnectServer(empty);
const managerConfig = { ...config, type: "stdio", cwd: process.env.HOME };
Bun.env.OMP_MANAGED_AWS_MCP_COMMAND = process.execPath;
Bun.env.OMP_MANAGED_MCP_CWD = process.env.HOME;
const manager = new MCPManager(process.env.HOME);
try {
 const serverName = "coreforge-aws-agent-toolkit";
 await manager.connectServers({ [serverName]: managerConfig }, {
  [serverName]: { provider: "mcp-managed", providerName: "Coreforge Managed",
   path: join(getAgentDir(), "mcp.managed.json"), level: "user" },
 });
 await manager.waitForPendingConnections();
 const beforeNative = proxyCalls().length;
 const beforeNativeIdentity = awsCalls().length;
 for (const selected of [undefined, "missing", "coreforge"]) {
  await assert.rejects(
   manager.callTool(serverName, "aws___run_script", { code: "never dispatch", ...(selected ? { aws_profile: selected } : {}) }, { retry: "never" }),
   /PROFILE_NOT_FOUND/,
  );
 }
 assert.equal(proxyCalls().length, beforeNative);
 assert.equal(awsCalls().length, beforeNativeIdentity);
 const native = await manager.callTool(serverName, "aws___run_script", { aws_profile: "healthy", code: "native first use" }, { retry: "never" });
 assert.notEqual(native.isError, true);
 assert.deepEqual(JSON.parse(native.content[0].text).profiles, ["healthy", "expired", "still-expired"]);
 assert.equal(JSON.parse(native.content[0].text).args.aws_profile, "healthy");
 const beforeInvalid = proxyCalls().length;
 await assert.rejects(manager.callTool(serverName, "aws___run_script", { aws_profile: "still-expired", code: "no fallback" }, { retry: "never" }), /AUTH_REQUIRED/);
 assert.equal(proxyCalls().length, beforeInvalid);
 assert.equal(awsCalls().at(-1).argv.includes("still-expired"), true);
 const nativeController = new AbortController();
 nativeController.abort();
 await assert.rejects(manager.callTool(serverName, "aws___run_script", { aws_profile: "healthy", code: "cancelled" }, { retry: "never", signal: nativeController.signal }));
 assert.equal(proxyCalls().length, beforeInvalid);
 const managerConnection = manager.getConnection(serverName);
 const { promise: refreshed, resolve: resolveRefreshed } = Promise.withResolvers();
 assert.ok(managerConnection?.transport.onNotification);
 const unsubscribe = manager.addNotificationListener((name, method) => {
  if (name === serverName && method === "notifications/tools/list_changed") {
   unsubscribe();
   resolveRefreshed();
  }
 });
 managerConnection.transport.onNotification("notifications/tools/list_changed", {});
 await refreshed;
 const refreshedRun = manager.getTools().find(tool => tool.mcpToolName === "aws___run_script");
 assert.ok(refreshedRun);
 const selectedAfterRefresh = await refreshedRun.execute(
  "selected-after-notification", { aws_profile: "healthy", code: "result = 7" }, undefined, context,
 );
 assert.notEqual(selectedAfterRefresh.isError, true, selectedAfterRefresh.content[0]?.text);
 assert.deepEqual(JSON.parse(selectedAfterRefresh.content[0].text).profiles, ["healthy", "expired", "still-expired"]);
 assert.equal(JSON.parse(selectedAfterRefresh.content[0].text).args.aws_profile, "healthy");
} finally {
 await manager.disconnectAll();
 delete Bun.env.OMP_MANAGED_AWS_MCP_COMMAND;
 delete Bun.env.OMP_MANAGED_MCP_CWD;
}
const beforeTransportIdentity = awsCalls().length;
let uncertainDispatches = 0;
const authEffects = [];
const transportFixture = Bun.serve({
 port: 0, hostname: "127.0.0.1",
 async fetch(request) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const rpc = await request.json();
  if (rpc.id === undefined) return new Response(null, { status: 202 });
  if (rpc.method === "tools/call") {
   uncertainDispatches++;
   const code = rpc.params?.arguments?.code;
   if (code?.startsWith("auth-result")) {
    authEffects.push(code);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {
     isError: true, content: [{ type: "text", text: "AUTH_REQUIRED after partial processing" }],
     structuredContent: { applied: true, receipt: code }, _meta: { receipt: code },
    } });
   }
   if (code?.startsWith("auth-protocol")) {
    authEffects.push(code);
    return Response.json({ jsonrpc: "2.0", id: rpc.id, error: {
     code: -32077, message: "SSO token expired after partial processing", data: { receipt: code },
    } });
   }
   return new Response("SSO token expired; login required", { status: 503 });
  }
  const result = rpc.method === "initialize"
   ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
   : rpc.method === "tools/list"
    ? { tools: [{ name: "aws___run_script", inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["healthy"] } } } }] }
    : {};
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
 },
});
const transportManager = new MCPManager(process.env.HOME);
try {
 await transportManager.connectServers({ "coreforge-aws-agent-toolkit": { type: "http", url: transportFixture.url.href } }, {}, undefined, 0);
 await transportManager.waitForStartup(0);
 await assert.rejects(
  transportManager.callTool("coreforge-aws-agent-toolkit", "aws___run_script", { aws_profile: "healthy", code: "uncertain write" }, { retry: "never" }),
  error => error.name === "MCPTransportError" && error.failure === "http_status",
 );
 assert.equal(uncertainDispatches, 1);
 assert.equal(awsCalls().length, beforeTransportIdentity);
 for (const retry of ["never", undefined]) {
  const resultCode = "auth-result-" + (retry ?? "default");
  const result = await transportManager.callTool(
   "coreforge-aws-agent-toolkit", "aws___run_script", { aws_profile: "healthy", code: resultCode }, { retry },
  );
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, { applied: true, receipt: resultCode });
  assert.equal(result._meta.receipt, resultCode);
  const protocolCode = "auth-protocol-" + (retry ?? "default");
  await assert.rejects(
   transportManager.callTool("coreforge-aws-agent-toolkit", "aws___run_script", { aws_profile: "healthy", code: protocolCode }, { retry }),
   error => error.name === "MCPTransportError" && error.failure === "json_rpc" && error.code === -32077 && error.data.includes(protocolCode),
  );
 }
 assert.deepEqual(authEffects, ["auth-result-never", "auth-protocol-never", "auth-result-default", "auth-protocol-default"]);
 assert.equal(awsCalls().length, beforeTransportIdentity);
} finally {
 await transportManager.disconnectAll();
 transportFixture.stop(true);
}
unlinkSync(join(process.env.HOME, "authenticated-expired"));
const loginsBeforeRetirement = awsCalls().filter(call => call.argv.includes("login")).length;
let recoveryOwnerCurrent = true;
const [retiredRecovery] = await Promise.allSettled([
 recoverTrustedAwsAuthentication("expired", "synthetic retired MCP owner", {
  ...context,
  mcpOwnerCurrent: () => recoveryOwnerCurrent,
  ui: { ...context.ui, confirm: async () => { recoveryOwnerCurrent = false; return true; } },
 }),
]);
assert.equal(retiredRecovery.status, "rejected");
if (retiredRecovery.status === "rejected") {
 assert.equal(retiredRecovery.reason.name, "ToolAbortError");
 assert.equal(retiredRecovery.reason.message, "MCP call owner changed");
}
assert.equal(awsCalls().filter(call => call.argv.includes("login")).length, loginsBeforeRetirement);
console.log("first-use routing passed");
`;
		await fs.writeFile(path.join(root, "aws.calls"), "");
		await fs.writeFile(path.join(root, "proxy.calls"), "");
		const policy = path.join(root, "dcg-policy");
		await fs.writeFile(policy, "fixture");
		const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
			cwd: root,
			signal: AbortSignal.timeout(35_000),
			env: {
				HOME: root,
				USERPROFILE: root,
				PATH: process.env.PATH ?? "",
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
				OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
				OMP_OPERATIONAL_AWS_EXECUTABLE: aws,
				OMP_DCG_PATH: aws,
				OMP_DCG_VERSION: "fixture",
				OMP_DCG_BINARY_SHA256: createHash("sha256")
					.update(await fs.readFile(aws))
					.digest("hex"),
				OMP_DCG_CONFIG: policy,
				OMP_DCG_CONFIG_SHA256: createHash("sha256").update("fixture").digest("hex"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, `${stdout}\n${stderr}`).toBe(0);
		expect(stdout).toContain("first-use routing passed");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 45_000);

test("managed AWS fences expired-credential probes with the worker owner after asynchronous preparation", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-aws-probe-owner-"));
	try {
		const config = path.join(root, "config");
		await fs.writeFile(config, "[profile commercial]\nregion = us-east-1\n");
		await fs.writeFile(path.join(root, "aws.calls"), "");
		const aws = path.join(root, process.platform === "win32" ? "aws.exe" : "aws");
		const recordingAws = path.resolve(import.meta.dir, "fixtures/recording-aws.ts");
		if (process.platform === "win32") {
			const build = Bun.spawn([process.execPath, "build", "--compile", recordingAws, "--outfile", aws], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [error, exit] = await Promise.all([new Response(build.stderr).text(), build.exited]);
			expect(exit, error).toBe(0);
		} else {
			await fs.writeFile(aws, `#!${process.execPath}\n${await fs.readFile(recordingAws, "utf8")}`, { mode: 0o755 });
		}
		const probe = path.join(root, "mcp-aws-owner.test.ts");
		await fs.writeFile(
			probe,
			`import { Database } from "bun:sqlite";
import { spyOn, test } from "bun:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/model-registry.ts"))};
import { Settings } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/config/settings.ts"))};
import { MCPManager } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/mcp/manager.ts"))};
import { AgentRegistry } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/registry/agent-registry.ts"))};
import { AuthStorage, SqliteAuthCredentialStore } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/session/auth-storage.ts"))};
import { agentsThreadService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/thread/services/agents.ts"))};
import { authService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/thread/services/auth.ts"))};
import { identityThreadService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/thread/services/identity.ts"))};
import { integrationsThreadService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/thread/services/integrations.ts"))};
import { settingsThreadService } from ${JSON.stringify(path.resolve(import.meta.dir, "../src/thread/services/settings.ts"))};
import { startServiceWorker } from ${JSON.stringify(path.resolve(import.meta.dir, "helpers/service-worker.ts"))};

test("worker-owned expired AWS credential probe admission", async () => {
 const root = process.env.HOME;
 const aws = process.env.OMP_OPERATIONAL_AWS_EXECUTABLE;
 for (const retired of [false, true]) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let holdPreparation = false;
  const stat = fs.stat;
  const preparation = spyOn(fs, "stat").mockImplementation(async (...args) => {
   if (holdPreparation && args[0] === aws) {
    holdPreparation = false;
    entered.resolve();
    await release.promise;
   }
   return stat(...args);
  });
  const dispatched = [];
  const server = Bun.serve({
   port: 0, hostname: "127.0.0.1",
   async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const rpc = await request.json();
    if (rpc.id === undefined) return new Response(null, { status: 202 });
    let result;
    if (rpc.method === "initialize") {
     result = { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "synthetic-aws-probe", version: "1" } };
    } else if (rpc.method === "tools/list") {
     result = { tools: [{
      name: "aws___run_script", annotations: { readOnlyHint: true },
      inputSchema: { type: "object", properties: {
       code: { type: "string" }, aws_profile: { type: "string", enum: ["commercial"] },
      }, required: ["code", "aws_profile"] },
     }] };
    } else if (rpc.method === "tools/call") {
     dispatched.push(rpc.params.arguments.code);
     if (rpc.params.arguments.code === "admitted") {
      result = { content: [{ type: "text", text: "synthetic inventory" }], structuredContent: { receipt: "admitted-read" } };
     } else {
      holdPreparation = true;
      result = { isError: true, content: [{ type: "text", text: "expired or invalid AWS credentials" }], structuredContent: { receipt: "expired-read" } };
     }
    } else result = {};
    return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
   },
  });
  const manager = new MCPManager(root);
  const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
  let worker;
  let child;
  const id = retired ? "retired-aws-probe-owner" : "current-aws-probe-owner";
  try {
   await manager.connectServers({ "coreforge-aws-agent-toolkit": { type: "http", url: server.url.href, exposeTools: false } }, {}, undefined, 0);
   await manager.waitForStartup(0);
   worker = await startServiceWorker(
    new URL(${JSON.stringify(new URL("./fixtures/mcp-extension-worker.ts", import.meta.url).href)}),
    [identityThreadService, settingsThreadService, authService, agentsThreadService, integrationsThreadService],
   );
   child = await worker.probe.open(
    manager, new ModelRegistry(auth, join(root, "models.yml")),
    Settings.isolated({ "tools.approvalMode": "yolo" }), root, id,
   );
   const admitted = await child.call(
    "coreforge-aws-agent-toolkit", "aws___run_script", { aws_profile: "commercial", code: "admitted" }, { retry: "read" },
   );
   assert.deepEqual(admitted.structuredContent, { receipt: "admitted-read" });
   const before = await fs.readFile(join(root, "aws.calls"), "utf8");
   const outcome = child.call(
    "coreforge-aws-agent-toolkit", "aws___run_script", { aws_profile: "commercial", code: "expired" }, { retry: "read" },
   ).catch(error => error);
   await entered.promise;
   if (retired) {
    const ref = AgentRegistry.global().get(id);
    assert.ok(ref && ref.session === child.owner);
    AgentRegistry.global().unregister(id, ref);
   }
   release.resolve();
   const result = await outcome;
   const appended = (await fs.readFile(join(root, "aws.calls"), "utf8")).slice(before.length);
   const probes = appended.trim().split("\\n").filter(Boolean).map(line => JSON.parse(line).argv.slice(-2));
   assert.deepEqual(probes, retired ? [] : [["sts", "get-caller-identity"]]);
   assert.deepEqual(dispatched, ["admitted", "expired"]);
   if (retired) assert.ok(result instanceof Error);
   else {
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, { receipt: "expired-read" });
   }
  } finally {
   release.resolve();
   preparation.mockRestore();
   if (child && !worker.peer.link.closed) await child.dispose();
   const ref = AgentRegistry.global().get(id);
   if (ref && (ref.session === child?.owner || ref.session === null)) AgentRegistry.global().unregister(id, ref);
   await worker?.stop();
   await manager.disconnectAll();
   await auth.close();
   MCPManager.resetForTests();
   server.stop(true);
  }
 }
}, 25_000);
`,
		);
		const policy = path.join(root, "dcg-policy");
		await fs.writeFile(policy, "fixture");
		const child = Bun.spawn([process.execPath, "--no-env-file", "test", probe], {
			cwd: root,
			signal: AbortSignal.timeout(35_000),
			env: {
				HOME: root,
				USERPROFILE: root,
				PATH: process.env.PATH ?? "",
				...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
				OMP_OPERATIONAL_AWS_CONFIG_FILE: config,
				OMP_OPERATIONAL_AWS_SHARED_CREDENTIALS_FILE: path.join(root, "credentials"),
				OMP_OPERATIONAL_AWS_EXECUTABLE: aws,
				OMP_DCG_PATH: aws,
				OMP_DCG_VERSION: "fixture",
				OMP_DCG_BINARY_SHA256: createHash("sha256")
					.update(await fs.readFile(aws))
					.digest("hex"),
				OMP_DCG_CONFIG: policy,
				OMP_DCG_CONFIG_SHA256: createHash("sha256").update("fixture").digest("hex"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, `${stdout}\n${stderr}`).toBe(0);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 45_000);
