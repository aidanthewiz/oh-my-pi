import { expect, test } from "bun:test";
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
console.log(JSON.stringify({ rejected, afterRejections, requests, authResult, reconnects, boundCalls, legacyMissing, legacyWrong, legacyAllowed, legacyChanged, legacySchema }));
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
		expect(result.authResult.content[0].text).toContain("AUTH_REQUIRED");
		expect(result.authResult.content[0].text).toContain("commercial");
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
		expect(result.legacySchema.properties.aws_profile).toMatchObject({
			type: "string",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
