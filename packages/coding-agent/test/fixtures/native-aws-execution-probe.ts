import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { AwsTool, awsSessionAuthGroups, listTrustedAwsProfiles } from "../../src/tools/aws";
import { WriteTool } from "../../src/tools/write";
import type { XdevState } from "../../src/tools/xdev";
import { DeferredMCPTool, MCPTool } from "../../src/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "../../src/mcp/types";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { AgentTool, AgentToolContext, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import {
	getOperationalAwsLaunchMetadata,
	isCoreforgeManagedLaunch,
	isRecord,
	reserveManagedAwsProfile,
} from "@oh-my-pi/pi-utils";
import { ensureCoreforgeAwsSso } from "../../src/identity/aws-sso";
import { restoreCoreforgeOperationalAwsEnvironment } from "../../src/identity/runtime";
import { resolveAwsCredentials } from "@oh-my-pi/pi-ai/providers/aws-credentials";
import { ExtensionToolWrapper } from "../../src/extensibility/extensions/wrapper";
import type { ExtensionRunner } from "../../src/extensibility/extensions";
import { disposeVmContextsByOwner } from "../../src/eval/js/context-manager";
import { executeJs } from "../../src/eval/js/executor";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { SessionTools, type SessionToolsHost } from "../../src/session/session-tools";
import type { ToolSession } from "../../src/tools";

const root = process.env.HOME!;
const repository = path.join(root, "repository");
const cwd = path.join(repository, "nested");
await fs.mkdir(cwd, { recursive: true });
await fs.mkdir(path.join(repository, ".git"), { recursive: true });
await fs.writeFile(path.join(cwd, "aws"), "repository interception must never execute");
let artifact = 0;
const settings = Settings.isolated();
let activeContext: AgentToolContext | undefined = undefined;
const toolSession = {
	cwd,
	hasUI: true,
	getSessionFile: () => null,
	getSessionSpawns: () => null,
	settings,
	getToolContext: () => activeContext,
	allocateOutputArtifact: async () => ({ id: `aws-${++artifact}`, path: path.join(root, `artifact-${artifact}.txt`) }),
};
const tool = new AwsTool(toolSession);
const calls = async () =>
	(await fs.readFile(path.join(root, "aws.calls"), "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line));
const text = (result: AgentToolResult<unknown>) =>
	result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
const read = { profile: "commercial", service: "s3api", operation: "list-buckets" };
if (process.env.NATIVE_AWS_EXPECT_NO_CLI) {
	const before = (await calls()).length;
	await assert.rejects(
		() => tool.execute("missing-cli", read),
		error => error instanceof ToolError && error.context?.code === "AWS_CLI_UNAVAILABLE",
	);
	assert.equal((await calls()).length, before);
	process.exit(0);
}
const action = (Name: string, IsWrite = false) => ({
	Name,
	Annotations: {
		Properties: { IsList: false, IsPermissionManagement: false, IsTaggingOnly: false, IsWrite },
	},
});
const operation = (Name: string, sdk: string, Method: string, ...permissions: [string, string][]) => ({
	Name,
	SDK: [{ Package: "Boto3", Name: sdk, Method }],
	AuthorizedActions: permissions.map(([Service, name]) => ({ Service, Name: name })),
});
const references: Record<string, unknown> = {
	"mapping.json": {
		SDK: {
			Python: {
				Boto3: {
					...Object.fromEntries(
						["s3", "ecr", "ce", "logs", "ec2", "rds", "sqs", "sagemaker", "bedrock", "signin"].map(service => [
							service,
							{ service },
						]),
					),
					"sagemaker-runtime": { service: "sagemaker" },
					"bedrock-agent-runtime": { service: "bedrock" },
				},
			},
		},
	},
	"s3/s3.json": {
		Name: "s3",
		Actions: [action("ListAllMyBuckets"), action("DeleteBucket", true)],
		Operations: [
			operation("ListBuckets", "s3", "list_buckets", ["s3", "ListAllMyBuckets"]),
			operation("DeleteBucket", "s3", "delete_bucket", ["s3", "DeleteBucket"]),
		],
	},
	"ecr/ecr.json": {
		Name: "ecr",
		Actions: [action("DescribeRepositories")],
		Operations: [operation("DescribeRepositories", "ecr", "describe_repositories", ["ecr", "DescribeRepositories"])],
	},
	"sqs/sqs.json": {
		Name: "sqs",
		Actions: [action("ReceiveMessage"), action("GetQueueAttributes")],
		Operations: [
			operation("ReceiveMessage", "sqs", "receive_message", ["sqs", "ReceiveMessage"]),
			operation("GetQueueAttributes", "sqs", "get_queue_attributes", ["sqs", "GetQueueAttributes"]),
		],
	},
	"sagemaker/sagemaker.json": {
		Name: "sagemaker",
		Actions: [action("ListEndpoints"), action("InvokeEndpoint"), action("InvokeEndpointAsync")],
		Operations: [
			operation("ListEndpoints", "sagemaker", "list_endpoints", ["sagemaker", "ListEndpoints"]),
			operation("InvokeEndpoint", "sagemaker-runtime", "invoke_endpoint", ["sagemaker", "InvokeEndpoint"]),
			operation("InvokeEndpointAsync", "sagemaker-runtime", "invoke_endpoint_async", [
				"sagemaker",
				"InvokeEndpointAsync",
			]),
		],
	},
	"bedrock/bedrock.json": {
		Name: "bedrock",
		Actions: [action("InvokeAgent"), action("InvokeFlow"), action("InvokeInlineAgent")],
		Operations: [
			operation("InvokeAgent", "bedrock-agent-runtime", "invoke_agent", ["bedrock", "InvokeAgent"]),
			operation("InvokeFlow", "bedrock-agent-runtime", "invoke_flow", ["bedrock", "InvokeFlow"]),
			operation("InvokeInlineAgent", "bedrock-agent-runtime", "invoke_inline_agent", [
				"bedrock",
				"InvokeInlineAgent",
			]),
		],
	},
	"signin/signin.json": {
		Name: "signin",
		Actions: [action("CreateOAuth2Token")],
		Operations: [operation("CreateOAuth2Token", "signin", "create_oauth2_token", ["signin", "CreateOAuth2Token"])],
	},
	"ce/ce.json": {
		Name: "ce",
		Actions: [action("GetCostAndUsage")],
		Operations: [
			operation(
				"GetCostAndUsage",
				"ce",
				"get_cost_and_usage",
				["ce", "GetCostAndUsage"],
				["aws-portal", "ViewBilling"],
			),
		],
	},
	"aws-portal/aws-portal.json": {
		Name: "aws-portal",
		Actions: [action("ViewBilling")],
	},
	"logs/logs.json": {
		Name: "logs",
		Actions: [action("StartQuery"), action("FilterLogEvents")],
		Operations: [
			operation("StartQuery", "logs", "start_query", ["logs", "StartQuery"], ["logs", "FilterLogEvents"]),
			operation("FilterLogEvents", "logs", "filter_log_events", ["logs", "FilterLogEvents"]),
		],
	},
	"rds/rds.json": {
		Name: "rds",
		Actions: [action("DescribeDBClusters")],
		Operations: [operation("DescribeDBClusters", "rds", "describe_db_clusters", ["rds", "DescribeDBClusters"])],
	},
	"ec2/ec2.json": {
		Name: "ec2",
		Actions: [action("TerminateInstances", true), action("DescribeInstances")],
		Operations: [
			operation("TerminateInstances", "ec2", "terminate_instances", ["ec2", "TerminateInstances"]),
			operation("DescribeInstances", "ec2", "describe_instances", ["ec2", "DescribeInstances"]),
		],
	},
};
const nativeFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	async (input: string | URL | Request) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://servicereference.us-east-1.amazonaws.com");
		const reference = references[url.pathname.slice("/v1/".length)];
		return reference === undefined ? new Response("not found", { status: 404 }) : Response.json(reference);
	},
	{ preconnect: nativeFetch.preconnect },
);
if (process.env.NATIVE_AWS_EXPECT_NO_PLUGIN) {
	const before = (await calls()).length;
	await assert.rejects(
		() => tool.execute("missing-plugin", { profile: "government", service: "ecs", operation: "execute-command" }),
		error => error instanceof ToolError && error.context?.code === "AWS_SESSION_MANAGER_UNAVAILABLE",
	);
	assert.equal((await calls()).length, before);
	process.exit(0);
}
const modelEnvironment: Record<string, string | undefined> = {};
restoreCoreforgeOperationalAwsEnvironment(modelEnvironment);
assert.equal(modelEnvironment.OMP_MODEL_AWS_PROFILE, undefined);
assert.equal(modelEnvironment.OMP_MODEL_AWS_REGION, undefined);
const first = await tool.execute("commercial", read);
assert.notEqual(first.isError, true, JSON.stringify({ first, calls: await calls() }));
assert.match(text(first), /commercial/);
assert.ok(!text(first).includes("fixture-secret"));
assert.ok(!text(first).includes("fixture-token"));
await tool.execute("government", { ...read, profile: "government" });
const initial = await calls();
assert.equal(initial.length, 2);
assert.equal(initial[1].argv[initial[1].argv.indexOf("--region") + 1], "us-gov-west-1");
for (const call of initial) {
	assert.notEqual(call.cwd, cwd);
	for (const key of [
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OMP_MODEL_AWS_PROFILE",
		"OMP_MODEL_AWS_REGION",
		"OMP_OPERATIONAL_AWS_EXECUTABLE",
		"AWS_ENDPOINT_URL",
	])
		assert.equal(call.env[key], undefined, key);
	assert.equal(call.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS, "true");
	assert.equal(call.env.AWS_SHARED_CREDENTIALS_FILE, path.join(root, "credentials"));
}
for (const args of [
	{ ...read, profile: "missing" },
	{ ...read, profile: "coreforge" },
	{ ...read, profile: "managed-alias" },
	{ ...read, profile: "partition-conflict" },
	{ ...read, profile: "role-conflict" },
	{ ...read, region: "us-gov-west-1" },
	{ ...read, parameters: { endpoint: "https://invalid.test" } },
	{ ...read, parameters: { Payload: "file:///private" } },
])
	await assert.rejects(
		() => tool.execute("reject", args),
		/PROFILE_NOT_FOUND|WRONG_PARTITION|INVALID_OPERATION|AUTH_REQUIRED/,
	);
assert.equal((await calls()).length, 2);
await assert.rejects(
	() => tool.execute("dcg-denial", { ...read, operation: "delete-bucket", parameters: { Bucket: "protected" } }),
	/fixture\.aws/,
);
assert.equal((await calls()).length, 2);
assert.match(await fs.readFile(path.join(root, "dcg.calls"), "utf8"), /'s3api' 'delete-bucket' '--bucket=protected'/);
const optionValue = await tool.execute("flag-value", { ...read, parameters: { Prefix: "--profile=coreforge" } });
assert.match(text(optionValue), /commercial/);
assert.ok((await calls()).at(-1).argv.includes("--prefix=--profile=coreforge"));
const identity = { ...read, service: "sts", operation: "get-caller-identity" };
assert.equal(tool.approval(identity), "read");
assert.equal(await tool.prepareRuntimeApproval("identity", identity), undefined);
await tool.execute("identity", identity);
for (const [id, args] of [
	["cost", { ...read, service: "ce", operation: "get-cost-and-usage" }],
	["logs-filter", { ...read, profile: "government", service: "logs", operation: "filter-log-events" }],
	["logs-query", { ...read, profile: "government", service: "logs", operation: "start-query" }],
	["rds-acronym", { ...read, profile: "government", service: "rds", operation: "describe-db-clusters" }],
] as const) {
	assert.equal(await tool.prepareRuntimeApproval(id, args), undefined, id);
	assert.equal(tool.approval(args), "read", id);
	await tool.execute(id, args);
}
const unmapped = { ...read, service: "logs", operation: "describe-unmapped" };
assert.equal(tool.approval(unmapped), "exec");
assert.match((await tool.prepareRuntimeApproval("unmapped", unmapped))!.prompt, /Account: 123456789012/);
await assert.rejects(() => tool.execute("unmapped", unmapped), /approval/);
assert.equal((await calls()).filter(call => call.argv.includes("describe-unmapped")).length, 0);
tool.denyRuntimeApproval("unmapped", unmapped);
const referenceFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async () => new Response("unavailable", { status: 503 }), {
	preconnect: referenceFetch.preconnect,
});
try {
	const offline = new AwsTool(toolSession);
	const cost = { ...read, service: "ce", operation: "get-cost-and-usage" };
	assert.equal(offline.approval(cost), "exec");
	assert.match((await offline.prepareRuntimeApproval("offline", cost))!.prompt, /Account: 123456789012/);
	await assert.rejects(() => offline.execute("offline", cost), /approval/);
	assert.equal((await calls()).filter(call => call.argv.includes("get-cost-and-usage")).length, 1);
} finally {
	globalThis.fetch = referenceFetch;
}
const referenceStarted = Promise.withResolvers<void>();
const releaseReference = Promise.withResolvers<void>();
globalThis.fetch = Object.assign(
	async () => {
		referenceStarted.resolve();
		await releaseReference.promise;
		return new Response("unavailable", { status: 503 });
	},
	{ preconnect: referenceFetch.preconnect },
);
let cancelledReference: Promise<string> | undefined;
try {
	const controller = new AbortController();
	cancelledReference = new AwsTool(toolSession)
		.prepareRuntimeApproval("cancelled-reference", { ...read, service: "logs" }, controller.signal)
		.then(
			() => "completed",
			error => (error instanceof Error ? error.name : String(error)),
		);
	await referenceStarted.promise;
	controller.abort();
	assert.equal(await Promise.race([cancelledReference, Bun.sleep(500).then(() => "late")]), "AbortError");
} finally {
	releaseReference.resolve();
	await cancelledReference;
	globalThis.fetch = referenceFetch;
}
const firstReadTool = new AwsTool(toolSession);
const xdev: XdevState = {
	tools: new Map([["aws", firstReadTool]]),
	mountedNames: new Set(["aws"]),
	builtInNames: new Set(["aws"]),
	isActive: () => false,
};
const wrappedWrite = new ExtensionToolWrapper(
	new WriteTool({ ...toolSession, xdev }) as unknown as AgentTool,
	{
		consumeToolCallEmitted: () => false,
		hasHandlers: () => false,
		hasUI: () => false,
		hasSessionApproval: () => false,
		grantSessionApproval: () => assert.fail("Headless approval cannot grant session permission"),
		runScoped: <T>(fn: () => T): T => fn(),
	} as unknown as ExtensionRunner,
);
const writeContext = { settings: Settings.isolated({ "tools.approvalMode": "write" }) } as AgentToolContext;
const firstRead = { ...read, service: "ce", operation: "get-cost-and-usage" };
const firstReadArgs = { path: "xd://aws", content: JSON.stringify(firstRead) };
const beforeFirstRead = (await calls()).filter(call => call.argv.includes("get-cost-and-usage")).length;
assert.equal(firstReadTool.approval(firstRead), "exec");
const dispatchedRead = await wrappedWrite.execute(
	"first-mapped-read",
	firstReadArgs,
	undefined,
	undefined,
	writeContext,
);
assert.notEqual(dispatchedRead.isError, true);
assert.equal((dispatchedRead.details as { xdev?: { tier?: string } } | undefined)?.xdev?.tier, "read");
assert.equal((await calls()).filter(call => call.argv.includes("get-cost-and-usage")).length, beforeFirstRead + 1);
await assert.rejects(
	() =>
		wrappedWrite.execute(
			"first-mutation",
			{
				path: "xd://aws",
				content: JSON.stringify({
					...read,
					service: "ec2",
					operation: "terminate-instances",
					parameters: { InstanceIds: ["i-fixture"] },
				}),
			},
			undefined,
			undefined,
			writeContext,
		),
	/requires approval but no interactive UI/,
);
const queueUrl = "https://sqs.us-east-1.amazonaws.com/123456789012/fixture";
const queueAttributes = {
	...read,
	service: "sqs",
	operation: "get-queue-attributes",
	parameters: { QueueUrl: queueUrl, AttributeNames: ["All"] },
};
assert.equal(await tool.prepareRuntimeApproval("queue-attributes", queueAttributes), undefined);
assert.equal(tool.approval(queueAttributes), "read");
await tool.execute("queue-attributes", queueAttributes);
const queueReceive = {
	...read,
	service: "sqs",
	operation: "receive-message",
	parameters: { QueueUrl: queueUrl },
};
const beforeReceive = (await calls()).filter(call => call.argv.includes("receive-message")).length;
assert.match((await tool.prepareRuntimeApproval("queue-receive", queueReceive))!.prompt, /Account: 123456789012/);
assert.equal(tool.approval(queueReceive), "exec");
await assert.rejects(() => tool.execute("queue-receive", queueReceive), /approval/);
await assert.rejects(
	() =>
		wrappedWrite.execute(
			"first-queue-receive",
			{ path: "xd://aws", content: JSON.stringify(queueReceive) },
			undefined,
			undefined,
			writeContext,
		),
	/requires approval but no interactive UI/,
);
assert.equal((await calls()).filter(call => call.argv.includes("receive-message")).length, beforeReceive);
const listedEndpoints = { ...read, service: "sagemaker", operation: "list-endpoints" };
assert.equal(await tool.prepareRuntimeApproval("list-endpoints", listedEndpoints), undefined);
assert.equal(tool.approval(listedEndpoints), "read");
for (const [service, operationName] of [
	["sagemaker-runtime", "invoke-endpoint"],
	["sagemaker-runtime", "invoke-endpoint-async"],
	["bedrock-agent-runtime", "invoke-agent"],
	["bedrock-agent-runtime", "invoke-flow"],
	["bedrock-agent-runtime", "invoke-inline-agent"],
	["signin", "create-oauth2-token"],
] as const) {
	const args = { ...read, service, operation: operationName };
	assert.match((await tool.prepareRuntimeApproval(operationName, args))!.prompt, /Account: 123456789012/);
	assert.equal(tool.approval(args), "exec");
	await assert.rejects(() => tool.execute(operationName, args), /approval/);
	assert.equal((await calls()).filter(call => call.argv.includes(operationName)).length, 0);
}
const mutation = {
	...read,
	service: "ec2",
	operation: "terminate-instances",
	parameters: { InstanceIds: ["i-fixture"] },
};
const approval = await tool.prepareRuntimeApproval("mutation", mutation);
assert.match(approval!.prompt, /123456789012/);
assert.match(approval!.prompt, /arn:aws:iam::123456789012:user\/fixture/);
await assert.rejects(() => tool.execute("mutation", mutation), /approval/);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 0);
await tool.prepareRuntimeApproval("changed", mutation);
tool.approveRuntimeApproval("changed", mutation);
await fs.writeFile(path.join(root, "changed-identity"), "yes");
await assert.rejects(() => tool.execute("changed", mutation), /identity changed/);
await fs.unlink(path.join(root, "changed-identity"));
await tool.prepareRuntimeApproval("approved", mutation);
tool.approveRuntimeApproval("approved", mutation);
await tool.execute("approved", mutation);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 1);
await assert.rejects(
	() => tool.prepareRuntimeApproval("mismatch", { ...mutation, profile: "mismatched" }),
	/WRONG_PARTITION/,
);
const expired = await tool.execute("expired", { ...read, profile: "expired" });
assert.equal(expired.isError, true);
assert.match(text(expired), /AUTH_REQUIRED/);
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 0);
const login = { profile: "expired", service: "sso", operation: "login" };
await tool.prepareRuntimeApproval("login", login);
tool.approveRuntimeApproval("login", login);
await tool.execute("login", login);
await tool.execute("retry", { ...read, profile: "expired" });
await tool.execute("shared", { ...read, profile: "expired-peer" });
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 1);
for (const [profile, failure] of [
	["declined", "selector"],
	["resolution-declined", "resolution"],
] as const) {
	const declined = { ...login, profile };
	const wrapped = new ExtensionToolWrapper(
		tool as unknown as AgentTool,
		{
			hasHandlers: (event: string) => failure === "resolution" && event === "tool_approval_resolved",
			hasUI: () => true,
			hasSessionApproval: () => false,
			grantSessionApproval: () => assert.fail("Interrupted approval cannot grant session permission"),
			consumeToolCallEmitted: () => false,
			runScoped: <T>(fn: () => T): T => fn(),
			getUIContext: () => ({
				select: async () => {
					if (failure === "selector") throw new Error("approval interrupted");
					return "Approve once";
				},
			}),
			emit: async (event: { type: string }) => {
				if (event.type === "tool_approval_resolved") throw new Error("approval interrupted");
			},
		} as unknown as ExtensionRunner,
	);
	await assert.rejects(
		() => wrapped.execute(profile, declined, undefined, undefined, { settings } as AgentToolContext),
		/approval interrupted/,
	);
	tool.approveRuntimeApproval(profile, declined);
	await assert.rejects(
		() => tool.execute(profile, declined),
		/approval|declined/i,
		`${profile} reused an interrupted approval`,
	);
	await tool.prepareRuntimeApproval(`${profile}-again`, declined);
	tool.denyRuntimeApproval(`${profile}-again`, declined);
}
assert.equal((await calls()).filter(call => call.argv.includes("login")).length, 1);
await fs.unlink(path.join(root, "authenticated-expired"));
await tool.prepareRuntimeApproval("explicit-expired-renewal", login);
tool.approveRuntimeApproval("explicit-expired-renewal", login);
assert.notEqual((await tool.execute("explicit-expired-renewal", login)).isError, true);
assert.notEqual((await tool.execute("explicit-expired-read", { ...read, profile: "expired" })).isError, true);
assert.equal((await calls()).filter(call => call.argv.includes("expired") && call.argv.includes("login")).length, 2);
let confirmations = 0;
const context = {
	hasUI: true,
	settings,
	sessionManager: { getCwd: () => cwd },
	ui: {
		confirm: async () => {
			confirmations++;
			await Bun.sleep(25);
			return true;
		},
		select: async () => {
			confirmations++;
			await Bun.sleep(25);
			return "Approve once";
		},
		notify: (message: string) => {
			if (message.includes("https://fixture.invalid/device") && message.includes("FAKE-CODE")) {
				void Bun.write(path.join(root, "device-instructions-shown"), "shown");
			}
		},
	},
} as unknown as AgentToolContext;
const automatic = await tool.execute("automatic", { ...read, profile: "automatic" }, undefined, undefined, context);
assert.notEqual(automatic.isError, true);
assert.equal(confirmations, 1);
assert.equal(
	(await calls()).filter(call => call.argv.includes("automatic") && call.argv.includes("list-buckets")).length,
	2,
);
assert.equal((await calls()).filter(call => call.argv.includes("automatic") && call.argv.includes("login")).length, 1);
const managedRequests: string[] = [];
let delayedManagedExpiry: { ready(): void; complete: Promise<void> } | undefined;
const connection = {
	name: "coreforge-aws-agent-toolkit",
	config: { command: "unused" },
	transport: {
		request: async (_method: string, params: { arguments: { aws_profile: string } }) => {
			managedRequests.push(params.arguments.aws_profile);
			if (delayedManagedExpiry) {
				const delayed = delayedManagedExpiry;
				delayedManagedExpiry = undefined;
				delayed.ready();
				await delayed.complete;
				return {
					isError: true,
					content: [{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." }],
				};
			}
			return (await Bun.file(path.join(root, "authenticated-parallel")).exists())
				? { content: [{ type: "text", text: "managed read completed" }] }
				: {
						isError: true,
						content: [{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." }],
					};
		},
	},
} as unknown as MCPServerConnection;
const managedRead = new MCPTool(connection, {
	name: "aws___get_tasks",
	annotations: { readOnlyHint: true },
	inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["parallel-peer"] } } },
});
const [nativeShared, managedShared] = await (async () => {
	const ui = context.ui;
	assert(ui, "AWS approval fixture requires its real UI");
	const approvalEntered = Promise.withResolvers<void>();
	const nativeRecoveryEntered = Promise.withResolvers<void>();
	const releaseApproval = Promise.withResolvers<void>();
	const recoverOnce = awsSessionAuthGroups.recoverOnce;
	let waitingForNative = false;
	awsSessionAuthGroups.recoverOnce = (group, recover) => {
		const pending = recoverOnce.call(awsSessionAuthGroups, group, recover);
		if (waitingForNative) nativeRecoveryEntered.resolve();
		return pending;
	};
	const managedContext: AgentToolContext = {
		...context,
		ui: {
			...ui,
			confirm: async (title, message, options) => {
				approvalEntered.resolve();
				await releaseApproval.promise;
				return ui.confirm(title, message, options);
			},
		},
	};
	const managedPending = managedRead.execute(
		"parallel-managed",
		{ aws_profile: "parallel-peer" },
		undefined,
		managedContext,
	);
	let nativeDrain: Promise<unknown> | undefined;
	try {
		await Promise.race([approvalEntered.promise, managedPending]);
		waitingForNative = true;
		const nativePending = tool.execute(
			"parallel-native",
			{ ...read, profile: "parallel" },
			undefined,
			undefined,
			context,
		);
		nativeDrain = nativePending;
		await Promise.race([
			nativeRecoveryEntered.promise,
			nativePending.then(result => {
				if (!result.isError) throw new Error("Native call completed before joining pending authentication");
			}),
		]);
		releaseApproval.resolve();
		return await Promise.all([nativePending, managedPending]);
	} finally {
		releaseApproval.resolve();
		await Promise.allSettled([managedPending, ...(nativeDrain ? [nativeDrain] : [])]);
		awsSessionAuthGroups.recoverOnce = recoverOnce;
	}
})();
assert.notEqual(nativeShared.isError, true, text(nativeShared));
assert.notEqual(managedShared.isError, true, text(managedShared));
assert.equal(confirmations, 2);
assert.deepEqual(managedRequests, ["parallel-peer", "parallel-peer"]);
assert.equal(
	(await calls()).filter(
		call =>
			call.argv.includes("login") && call.argv.some((arg: string) => arg === "parallel" || arg === "parallel-peer"),
	).length,
	1,
);
let deniedRequests = 0;
const deniedConnection = {
	...connection,
	transport: {
		request: async () => {
			deniedRequests++;
			return {
				isError: true,
				content: [{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." }],
			};
		},
	},
} as unknown as MCPServerConnection;
const deniedRead = new MCPTool(deniedConnection, {
	name: "aws___get_tasks",
	annotations: { readOnlyHint: true },
	inputSchema: {
		type: "object",
		properties: { aws_profile: { type: "string", enum: ["automatic", "partition-conflict", "role-conflict"] } },
	},
});
const deniedResult = await deniedRead.execute(
	"valid-credentials-denied",
	{ aws_profile: "automatic" },
	undefined,
	context,
);
assert.equal(deniedResult.isError, true);
assert.equal(confirmations, 2);
assert.match(text(deniedResult), /expired or invalid AWS credentials/);
for (const profile of ["partition-conflict", "role-conflict"]) {
	const rejected = await deniedRead.execute("partition-conflict", { aws_profile: profile }, undefined, context);
	assert.equal(rejected.isError, true);
	assert.match(text(rejected), /WRONG_PARTITION/);
}
assert.equal(deniedRequests, 1);
const declinedContext = {
	...context,
	ui: {
		confirm: async () => {
			confirmations++;
			return false;
		},
		select: async () => {
			confirmations++;
			return "Deny";
		},
	},
} as unknown as AgentToolContext;
const firstDecline = await tool.execute(
	"firstuse-declined",
	{ ...read, profile: "firstuse-declined" },
	undefined,
	undefined,
	declinedContext,
);
const repeatedDecline = await tool.execute(
	"firstuse-declined-again",
	{ ...read, profile: "firstuse-declined" },
	undefined,
	undefined,
	context,
);
assert.equal(firstDecline.isError, true);
assert.equal(repeatedDecline.isError, true);
assert.equal(confirmations, 3);
assert.equal(
	(await calls()).filter(call => call.argv.includes("firstuse-declined") && call.argv.includes("login")).length,
	0,
);
await assert.rejects(
	() => tool.execute("failed-login", { ...read, profile: "failed-login" }, undefined, undefined, context),
	/AUTH_REQUIRED/,
);
const failedAgain = await tool.execute(
	"failed-login-again",
	{ ...read, profile: "failed-login" },
	undefined,
	undefined,
	context,
);
assert.equal(failedAgain.isError, true);
assert.equal(confirmations, 4);
assert.equal(
	(await calls()).filter(call => call.argv.includes("failed-login") && call.argv.includes("login")).length,
	1,
);
const stillExpired = await tool.execute(
	"still-expired",
	{ ...read, profile: "still-expired" },
	undefined,
	undefined,
	context,
);
assert.equal(stillExpired.isError, true);
assert.equal(
	(await calls()).filter(call => call.argv.includes("still-expired") && call.argv.includes("list-buckets")).length,
	2,
);
await tool.execute("still-expired-again", { ...read, profile: "still-expired" }, undefined, undefined, context);
assert.equal(confirmations, 5);
const governmentLogin = await tool.execute(
	"government-expired",
	{ ...read, profile: "government-expired" },
	undefined,
	undefined,
	context,
);
assert.notEqual(governmentLogin.isError, true);
assert.equal(confirmations, 6);
assert.equal((await listTrustedAwsProfiles()).find(profile => profile.name === "automatic")?.lastValidation, "valid");
activeContext = context;
const expiredMutation = { ...mutation, profile: "mutating-expired" };
const recoveredApproval = await tool.prepareRuntimeApproval("expired-mutation", expiredMutation);
assert.match(recoveredApproval!.prompt, /arn:aws:iam::123456789012:user\/fixture/);
tool.approveRuntimeApproval("expired-mutation", expiredMutation);
await tool.execute("expired-mutation", expiredMutation);
const changedMutation = { ...mutation, profile: "mutating-changed" };
await tool.prepareRuntimeApproval("expired-changed", changedMutation);
tool.approveRuntimeApproval("expired-changed", changedMutation);
await fs.writeFile(path.join(root, "expire-mutation"), "yes");
await assert.rejects(() => tool.execute("expired-changed", changedMutation), /identity changed/);
await fs.unlink(path.join(root, "changed-identity"));
assert.equal(confirmations, 8);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, 2);
const beforeRenewal = confirmations;
await fs.unlink(path.join(root, "authenticated-automatic"));
const renewed = await tool.execute(
	"automatic-renewal",
	{ ...read, profile: "automatic" },
	undefined,
	undefined,
	context,
);
assert.notEqual(renewed.isError, true);
assert.equal(confirmations, beforeRenewal + 1);
assert.equal((await calls()).filter(call => call.argv.includes("automatic") && call.argv.includes("login")).length, 2);
await fs.unlink(path.join(root, "authenticated-parallel"));
const beforeSharedRenewal = confirmations;
const [nativeRenewal, peerRenewal] = await Promise.all([
	tool.execute("parallel-renewal", { ...read, profile: "parallel" }, undefined, undefined, context),
	tool.execute("parallel-peer-renewal", { ...read, profile: "parallel-peer" }, undefined, undefined, context),
]);
assert.notEqual(nativeRenewal.isError, true);
assert.notEqual(peerRenewal.isError, true);
assert.equal(confirmations, beforeSharedRenewal + 1);
assert.equal(
	(await calls()).filter(
		call =>
			call.argv.includes("login") && call.argv.some((arg: string) => arg === "parallel" || arg === "parallel-peer"),
	).length,
	2,
);
await fs.unlink(path.join(root, "authenticated-parallel"));
for (const deferred of [false, true]) {
	for (const failure of ["result", "exception"] as const) {
		const id = `unsafe-managed-${deferred ? "deferred" : "direct"}-${failure}`;
		const effects = path.join(root, `${id}.effects`);
		const definition: MCPToolDefinition = {
			name: "aws___run_script",
			inputSchema: {
				type: "object",
				properties: {
					aws_profile: { type: "string", enum: ["parallel-peer"] },
					code: { type: "string" },
				},
				required: ["aws_profile", "code"],
			},
		};
		const unsafeConnection = {
			...connection,
			serverInfo: { name: "unsafe-auth-fixture", version: "0.0.0" },
			capabilities: { tools: {} },
			transport: {
				connected: true,
				request: async (method: string) => {
					if (method === "tools/list") return { tools: [definition] };
					await fs.appendFile(effects, "paid action accepted\n");
					const message = "Tool call failed due to expired or invalid AWS credentials.";
					if (failure === "exception") throw new Error(message);
					return { isError: true, content: [{ type: "text", text: message }] };
				},
			},
		} as unknown as MCPServerConnection;
		const unsafe = deferred
			? new DeferredMCPTool(connection.name, definition, async () => unsafeConnection)
			: new MCPTool(unsafeConnection, definition);
		const beforePrompts: number = confirmations;
		const beforeLogins = (await calls()).filter(call => call.argv.includes("login")).length;
		const failed = await unsafe.execute(
			id,
			{
				aws_profile: "parallel-peer",
				code: "response = await call_boto3('bedrock-runtime', 'InvokeModel', {'modelId': 'fixture-paid', 'body': '{}'})\nresponse",
			},
			undefined,
			context,
		);
		assert.equal(failed.isError, true);
		assert.match(text(failed), /expired or invalid AWS credentials/);
		assert.equal(await fs.readFile(effects, "utf8"), "paid action accepted\n");
		assert.equal(confirmations, beforePrompts);
		assert.equal((await calls()).filter(call => call.argv.includes("login")).length, beforeLogins);
		assert.equal(await Bun.file(path.join(root, "authenticated-parallel")).exists(), false);
	}
}
const beforeMixedRenewal = confirmations;
const { promise: managedRequestReady, resolve: managedRequestStarted } = Promise.withResolvers<void>();
const { promise: mixedRenewalComplete, resolve: finishMixedRenewal } = Promise.withResolvers<void>();
delayedManagedExpiry = {
	ready: managedRequestStarted,
	complete: mixedRenewalComplete,
};
const managedRenewal = managedRead.execute(
	"managed-second-expiry",
	{ aws_profile: "parallel-peer" },
	undefined,
	context,
);
await managedRequestReady;
const nativeMixedRenewal = tool
	.execute("native-second-expiry", { ...read, profile: "parallel" }, undefined, undefined, context)
	.finally(finishMixedRenewal);
const [nativeMixedResult, managedRenewalResult] = await Promise.all([nativeMixedRenewal, managedRenewal]);
assert.notEqual(nativeMixedResult.isError, true);
assert.notEqual(managedRenewalResult.isError, true);
assert.equal(confirmations, beforeMixedRenewal + 1);
assert.equal(
	(await calls()).filter(
		call =>
			call.argv.includes("login") && call.argv.some((arg: string) => arg === "parallel" || arg === "parallel-peer"),
	).length,
	3,
);
for (const profile of ["firstuse-declined", "declined", "resolution-declined"]) {
	const explicitRetry = { ...login, profile };
	await tool.prepareRuntimeApproval(`${profile}-explicit-retry`, explicitRetry);
	tool.approveRuntimeApproval(`${profile}-explicit-retry`, explicitRetry);
	assert.notEqual((await tool.execute(`${profile}-explicit-retry`, explicitRetry)).isError, true);
	assert.equal((await calls()).filter(call => call.argv.includes(profile) && call.argv.includes("login")).length, 1);
}
assert.notEqual(
	(
		await tool.execute(
			"after-explicit-retry",
			{ ...read, profile: "firstuse-declined" },
			undefined,
			undefined,
			context,
		)
	).isError,
	true,
);
const beforeBoundedMutation = confirmations;
const boundedMutation = { ...mutation, profile: "mutation-reexpires" };
await tool.prepareRuntimeApproval("mutation-reexpires", boundedMutation);
tool.approveRuntimeApproval("mutation-reexpires", boundedMutation);
const boundedResult = await tool.execute("mutation-reexpires", boundedMutation);
assert.equal(boundedResult.isError, true);
assert.match(text(boundedResult), /AUTH_REQUIRED/);
assert.equal(confirmations, beforeBoundedMutation + 1);
await tool.execute(
	"mutation-reexpires-again",
	{ ...read, profile: "mutation-reexpires" },
	undefined,
	undefined,
	context,
);
assert.equal(confirmations, beforeBoundedMutation + 1);
assert.equal(
	(await calls()).filter(call => call.argv.includes("mutation-reexpires") && call.argv.includes("login")).length,
	1,
);
for (const deferred of [false, true]) {
	for (const phase of ["preflight", "reconnect"]) {
		const profile = `expired-managed-${deferred ? "deferred" : "direct"}-${phase}`;
		const token = path.join(root, `authenticated-${profile}`);
		if (phase === "reconnect") await Bun.write(token, "yes");
		const definition: MCPToolDefinition = {
			name: "aws___get_tasks",
			annotations: { readOnlyHint: true },
			inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: [profile] } } },
		};
		let requests = 0;
		let reconnects = 0;
		const managedConnection = {
			name: "coreforge-aws-agent-toolkit",
			config: { command: "unused" },
			capabilities: { tools: {} },
			awsPreferredProfile: profile,
			transport: {
				connected: true,
				request: async (method: string) => {
					if (method === "tools/list") return { tools: [definition] };
					requests++;
					if (phase === "reconnect" && requests === 2) throw new Error("Transport closed");
					await fs.rm(token, { force: true });
					return { isError: true, content: [{ type: "text", text: "AUTH_REQUIRED: SSO token expired" }] };
				},
			},
		} as unknown as MCPServerConnection;
		const reconnect = async () => {
			reconnects++;
			return { ...managedConnection };
		};
		const bounded = deferred
			? new DeferredMCPTool(managedConnection.name, definition, async () => managedConnection, undefined, reconnect)
			: new MCPTool(managedConnection, definition, reconnect);
		const before: number = confirmations;
		const result = await bounded.execute(profile, { aws_profile: profile }, undefined, context);
		assert.equal(result.isError, true);
		assert.match(text(result), /AUTH_REQUIRED/);
		assert.equal(confirmations, before + 1);
		assert.equal(reconnects, phase === "reconnect" ? 1 : 0);
		assert.equal(
			(await calls()).filter(call => call.argv.includes(profile) && call.argv.includes("login")).length,
			1,
		);
		await bounded.execute(`${profile}-again`, { aws_profile: profile }, undefined, context);
		assert.equal(confirmations, before + 1);
	}
}

const raceToken = path.join(root, "authenticated-expired");
const raceLoginCount = async () =>
	(await calls()).filter(call => call.argv.includes("expired") && call.argv.includes("login")).length;
const explicitRaceLogin = async (id: string) => {
	await tool.prepareRuntimeApproval(id, login);
	tool.approveRuntimeApproval(id, login);
	assert.notEqual((await tool.execute(id, login)).isError, true);
};
const waitForAuthBarrier = async (barrier: string) => {
	const deadline = Date.now() + 10_000;
	while (!(await Bun.file(`${barrier}.started`).exists())) {
		assert.ok(Date.now() < deadline, "Authentication race did not reach its barrier");
		await Bun.sleep(10);
	}
};
for (const stage of ["operation", "identity", "exhausted-budget"] as const) {
	const id = `native-generation-${stage}`;
	await explicitRaceLogin(`${id}-initial`);
	const before = await raceLoginCount();
	const beforePrompts: number = confirmations;
	await fs.rm(raceToken);
	const raceMutation = { ...mutation, profile: "expired" };
	const operation =
		stage === "identity"
			? "sts-get-caller-identity"
			: stage === "operation"
				? "s3api-list-buckets"
				: "ec2-terminate-instances";
	const barrier = path.join(root, `auth-race-expired-${operation}`);
	await fs.rm(`${barrier}.started`, { force: true });
	await fs.rm(`${barrier}.release`, { force: true });
	await Bun.write(`${barrier}.armed`, "yes");
	let failed: Promise<boolean>;
	if (stage === "identity") {
		failed = tool.prepareRuntimeApproval(id, raceMutation, undefined, context).then(
			() => false,
			error => error instanceof ToolError && error.context?.code === "AUTH_REQUIRED",
		);
	} else {
		if (stage === "exhausted-budget") {
			await tool.prepareRuntimeApproval(id, raceMutation, undefined, context);
			tool.approveRuntimeApproval(id, raceMutation);
		}
		failed = tool
			.execute(
				id,
				stage === "operation" ? { ...read, profile: "expired" } : raceMutation,
				undefined,
				undefined,
				context,
			)
			.then(result => result.isError === true && /AUTH_REQUIRED/.test(text(result)));
	}
	await waitForAuthBarrier(barrier);
	assert.equal(await raceLoginCount(), before + 1, `${stage} did not renew before its retry`);
	await explicitRaceLogin(`${id}-newer-login`);
	await Bun.write(`${barrier}.release`, "yes");
	assert.equal(await failed, true, `${stage} did not surface the old authentication failure`);
	await fs.rm(raceToken);
	const afterExpiry = await tool.execute(
		`${id}-real-expiry`,
		{ ...read, profile: "expired" },
		undefined,
		undefined,
		context,
	);
	assert.notEqual(afterExpiry.isError, true, text(afterExpiry));
	assert.equal(await raceLoginCount(), before + 3, `${stage} suppressed or repeated the next renewal`);
	assert.equal(confirmations, beforePrompts + 2);
	await fs.rm(`${barrier}.started`);
	await fs.rm(`${barrier}.release`);
}
for (const deferred of [false, true]) {
	for (const failure of ["result", "exception", "probe"] as const) {
		const id = `managed-generation-${deferred ? "deferred" : "direct"}-${failure}`;
		await explicitRaceLogin(`${id}-initial`);
		const before = await raceLoginCount();
		const beforePrompts: number = confirmations;
		const retryStarted = Promise.withResolvers<void>();
		const releaseRetry = Promise.withResolvers<void>();
		const probeBarrier = path.join(root, "auth-race-expired-sts-get-caller-identity");
		let requests = 0;
		const definition: MCPToolDefinition = {
			name: "aws___get_tasks",
			annotations: { readOnlyHint: true },
			inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["expired"] } } },
		};
		const raceConnection = {
			name: "coreforge-aws-agent-toolkit",
			config: { command: "unused" },
			capabilities: { tools: {} },
			awsPreferredProfile: "expired",
			transport: {
				request: async (method: string) => {
					if (method === "tools/list") return { tools: [definition] };
					requests++;
					if (requests === 1) {
						await fs.rm(raceToken);
						return { isError: true, content: [{ type: "text", text: "AUTH_REQUIRED: SSO token expired" }] };
					}
					if (requests === 2) {
						retryStarted.resolve();
						if (failure === "probe") {
							await Bun.write(`${probeBarrier}.armed`, "yes");
							return {
								isError: true,
								content: [
									{ type: "text", text: "Tool call failed due to expired or invalid AWS credentials." },
								],
							};
						}
						await releaseRetry.promise;
						if (failure === "exception") throw new Error("AUTH_REQUIRED: SSO token expired");
						return { isError: true, content: [{ type: "text", text: "AUTH_REQUIRED: SSO token expired" }] };
					}
					if (!(await Bun.file(raceToken).exists()))
						return { isError: true, content: [{ type: "text", text: "AUTH_REQUIRED: SSO token expired" }] };
					return { content: [{ type: "text", text: "managed operation completed after real expiry" }] };
				},
			},
		} as unknown as MCPServerConnection;
		const raceManaged = deferred
			? new DeferredMCPTool(raceConnection.name, definition, async () => raceConnection)
			: new MCPTool(raceConnection, definition);
		const pending = raceManaged.execute(id, { aws_profile: "expired" }, undefined, context);
		await retryStarted.promise;
		if (failure === "probe") await waitForAuthBarrier(probeBarrier);
		assert.equal(await raceLoginCount(), before + 1);
		await explicitRaceLogin(`${id}-newer-login`);
		if (failure === "probe") await Bun.write(`${probeBarrier}.release`, "yes");
		else releaseRetry.resolve();
		const oldFailure = await pending;
		assert.equal(oldFailure.isError, true);
		assert.match(text(oldFailure), /AUTH_REQUIRED/);
		await fs.rm(raceToken);
		const afterExpiry = await raceManaged.execute(
			`${id}-real-expiry`,
			{ aws_profile: "expired" },
			undefined,
			context,
		);
		assert.notEqual(afterExpiry.isError, true, text(afterExpiry));
		assert.match(text(afterExpiry), /managed operation completed after real expiry/);
		assert.equal(await raceLoginCount(), before + 3);
		assert.equal(confirmations, beforePrompts + 2);
		assert.equal(requests, 4);
		if (failure === "probe") {
			await fs.rm(`${probeBarrier}.started`);
			await fs.rm(`${probeBarrier}.release`);
		}
	}
}
for (const approved of [false, true]) {
	for (const route of [
		"native",
		"native-exhausted",
		"managed-direct-result",
		"managed-deferred-result",
		"managed-direct-exception",
		"managed-deferred-exception",
	]) {
		const id = `pending-${approved ? "approved" : "offered"}-${route}`;
		await explicitRaceLogin(`${id}-initial`);
		const before = await raceLoginCount();
		const beforePrompts: number = confirmations;
		await fs.rm(raceToken);
		await tool.prepareRuntimeApproval(`${id}-login`, login);
		if (approved) tool.approveRuntimeApproval(`${id}-login`, login);
		const definition: MCPToolDefinition = {
			name: "aws___get_tasks",
			annotations: { readOnlyHint: true },
			inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["expired"] } } },
		};
		let requests = 0;
		const pendingConnection = {
			name: "coreforge-aws-agent-toolkit",
			config: { command: "unused" },
			capabilities: { tools: {} },
			transport: {
				request: async (method: string) => {
					if (method === "tools/list") return { tools: [definition] };
					requests++;
					if (!(await Bun.file(raceToken).exists())) {
						if (route.endsWith("exception")) throw new Error("AUTH_REQUIRED: SSO token expired");
						return { isError: true, content: [{ type: "text", text: "AUTH_REQUIRED: SSO token expired" }] };
					}
					return { content: [{ type: "text", text: "managed operation completed after pending sign-in" }] };
				},
			},
		} as unknown as MCPServerConnection;
		const pendingManaged = route.includes("deferred")
			? new DeferredMCPTool(pendingConnection.name, definition, async () => pendingConnection)
			: new MCPTool(pendingConnection, definition);
		const requestTool = route === "native-exhausted" ? new AwsTool(toolSession, { attempted: true }) : tool;
		const failure = route.startsWith("native")
			? await requestTool.execute(id, { ...read, profile: "expired" }, undefined, undefined, context)
			: await pendingManaged.execute(id, { aws_profile: "expired" }, undefined, context);
		assert.equal(failure.isError, true, `${id} did not surface its authentication failure`);
		assert.match(text(failure), /AUTH_REQUIRED/);
		assert.equal(await raceLoginCount(), before, `${id} ran an unapproved or duplicate login`);
		assert.equal(confirmations, beforePrompts, `${id} replaced the original approval`);
		if (!route.startsWith("native")) assert.equal(requests, 1, `${id} did not reach the managed request`);
		if (!approved) tool.approveRuntimeApproval(`${id}-login`, login);
		assert.notEqual((await tool.execute(`${id}-login`, login)).isError, true, `${id} revoked its owner's approval`);
		assert.equal(await raceLoginCount(), before + 1, `${id} did not run exactly one approved login`);
		await fs.rm(raceToken);
		const renewed = route.startsWith("native")
			? await tool.execute(`${id}-real-expiry`, { ...read, profile: "expired" }, undefined, undefined, context)
			: await pendingManaged.execute(`${id}-real-expiry`, { aws_profile: "expired" }, undefined, context);
		assert.notEqual(renewed.isError, true, text(renewed));
		assert.equal(await raceLoginCount(), before + 2, `${id} suppressed or repeated genuine expiry renewal`);
		assert.equal(confirmations, beforePrompts + 1);
		if (!route.startsWith("native")) {
			assert.match(text(renewed), /managed operation completed after pending sign-in/);
			assert.equal(requests, 3);
		}
	}
}

const sessionLabel = "Allow for the rest of this session";
const sessionSettings = Settings.isolated({
	"tools.approvalMode": "always-ask",
	"tools.approval": { aws: "prompt" },
});
let sessionId = "native-approval-owner";
const approvalSession = { ...toolSession, settings: sessionSettings, getSessionId: () => sessionId };
const sessionTool = new AwsTool(approvalSession);
const sessionContext = {
	...context,
	settings: sessionSettings,
	sessionManager: { getCwd: () => cwd, getSessionId: () => sessionId, getSessionName: () => undefined },
} as AgentToolContext;
const selections: string[][] = [];
const selectionTitles: string[] = [];
let choice: string | undefined = sessionLabel;
let selectionFailure: Error | undefined;
let selectionAbort: AbortController | undefined;
const sessionRunner = {
	hasHandlers: () => false,
	hasUI: () => true,
	hasSessionApproval: () => false,
	grantSessionApproval: () => assert.fail("AWS approval must not grant general tool permission"),
	consumeToolCallEmitted: () => false,
	runScoped: <T>(fn: () => T): T => fn(),
	getUIContext: () => ({
		select: async (title: string, options: string[]) => {
			selectionTitles.push(title);
			selections.push(options);
			if (selectionFailure) throw selectionFailure;
			selectionAbort?.abort(new Error("fixture approval cancelled"));
			return choice;
		},
	}),
} as unknown as ExtensionRunner;
const sessionWrapper = new ExtensionToolWrapper(sessionTool as unknown as AgentTool, sessionRunner);
const ordinaryMutation = { ...read, service: "rds", operation: "modify-db-cluster" };
const batchRegistry = new Map<string, AgentTool>([["aws", sessionWrapper]]);
const batchXdev: XdevState = {
	tools: batchRegistry,
	mountedNames: new Set(["aws"]),
	builtInNames: new Set(["aws", "write"]),
	isActive: () => false,
};
let batchContext = sessionContext;
const batchSession: ToolSession = {
	...approvalSession,
	xdev: batchXdev,
	getToolContext: () => batchContext,
	getToolForEvalBridge: name => batchTools.getToolForEvalBridge(name),
};
const batchWrite = new ExtensionToolWrapper(new WriteTool(batchSession) as unknown as AgentTool, sessionRunner);
batchRegistry.set("write", batchWrite);
const batchTools = new SessionTools(
	{
		agent: { state: { tools: [...batchRegistry.values()], messages: [] } },
		settings: sessionSettings,
		clientBridge: () => undefined,
		model: () => undefined,
		evalPreludes: () => [],
		sessionAgents: () => [],
	} as unknown as SessionToolsHost,
	{ toolRegistry: batchRegistry, xdev: batchXdev, baseSystemPrompt: [] },
);
const batchBefore = (await calls()).filter(call => call.argv.includes("ecr")).length;
const batchOwner = "native-aws-batch";
async function runBatch(start: number): Promise<void> {
	const result = await executeJs(
		`
		let completed = 0;
		for (let index = ${start}; index < ${start + 120}; index++) {
			const params = {
				profile: (index >> 1) % 2 ? "government" : "commercial",
				service: "ecr",
				operation: index % 2 ? "describe-repositories" : "batch-get-image",
				parameters: index % 2
					? { RepositoryNames: ["fixture-" + index] }
					: { RepositoryName: "fixture-" + index, ImageIds: Array.from({ length: 60 }, (_, tag) => ({ imageTag: "fixture-image-" + tag })) },
			};
			const value = (index >> 2) % 2
				? await tool.write({ path: "xd://aws", content: JSON.stringify(params) })
				: await tool.aws(params);
			if (typeof value === "object" && value?.hasError) throw new Error(JSON.stringify(value));
			completed++;
		}
		return String(completed);
		`,
		{ sessionId: batchOwner, kernelOwnerId: batchOwner, session: batchSession, cwd, timeoutMs: 90_000 },
	);
	assert.equal(result.exitCode, 0, result.output);
	assert.equal(result.output.trim(), "120");
}
try {
	await runBatch(0);
	assert.equal(selections.length, 1);
	choice = "Deny";
	const replacement = new AwsTool({ ...approvalSession });
	batchRegistry.set("aws", new ExtensionToolWrapper(replacement as unknown as AgentTool, sessionRunner));
	await runBatch(120);
} finally {
	await disposeVmContextsByOwner(batchOwner);
}
assert.equal((await calls()).filter(call => call.argv.includes("ecr")).length, batchBefore + 240);
const batchPrompt = selectionTitles[0];
const [batchHeading, ...batchDetailLines] = batchPrompt.split("\n");
const batchDetails = batchDetailLines.join("\n");
assert.ok(!batchHeading.includes("--image-ids"));
assert.ok(batchDetails.includes("fixture-image-59"), "approval omitted the final image in the exact command");
const firstBatchArgv: string[] = (await calls()).find(call => call.argv.includes("ecr")).argv;
const shownCommand = batchDetailLines.find(line => line.startsWith("AWS command: "))?.slice("AWS command: ".length);
assert.equal(
	shownCommand,
	[getOperationalAwsLaunchMetadata()!.executable!, ...firstBatchArgv]
		.map(value => `'${value.replace(/'/gu, "'\\''")}'`)
		.join(" "),
);
assert.match(batchDetails, /Account: 123456789012/);
assert.match(batchDetails, /ARN: arn:aws:iam::123456789012:user\/fixture/);
assert.match(batchDetails, /Region: us-east-1/);
assert.match(batchDetails, /Partition: aws/);
assert.equal(selections.length, 1);
choice = "Deny";
const reconstructed = new AwsTool({ ...approvalSession });
const reconstructedWrapper = new ExtensionToolWrapper(reconstructed as unknown as AgentTool, sessionRunner);
assert.notEqual(
	(
		await reconstructedWrapper.execute(
			"different-profile",
			{ ...queueReceive, profile: "government" },
			undefined,
			undefined,
			sessionContext,
		)
	).isError,
	true,
);
const beforeGrantedRead = (await calls()).filter(call => call.argv.includes("get-caller-identity")).length;
await reconstructedWrapper.execute("granted-read", read, undefined, undefined, sessionContext);
assert.equal((await calls()).filter(call => call.argv.includes("get-caller-identity")).length, beforeGrantedRead);
const beforeSessionRenewal = confirmations;
await Promise.all(
	["expired-session", "expired-session-other"].map(profile =>
		sessionWrapper.execute(profile, { ...read, profile }, undefined, undefined, sessionContext),
	),
);
await fs.unlink(path.join(root, "authenticated-expired-session"));
const sessionRenewal = await sessionWrapper.execute(
	"granted-renewal",
	{ ...ordinaryMutation, profile: "expired-session" },
	undefined,
	undefined,
	sessionContext,
);
assert.notEqual(sessionRenewal.isError, true);
assert.equal(confirmations, beforeSessionRenewal);
assert.equal(selections.length, 1);
assert.equal(
	(await calls()).filter(call => call.argv.includes("expired-session") && call.argv.includes("login")).length,
	2,
);
const beforeGuardAsk = (await calls()).filter(call => call.argv.includes("terminate-instances")).length;
choice = sessionLabel;
await assert.rejects(
	() => sessionWrapper.execute("session-guard-forged", mutation, undefined, undefined, sessionContext),
	/denied by user/,
);
assert.ok(!selections.at(-1)!.includes(sessionLabel));
choice = "Approve once";
await sessionWrapper.execute("session-guard-once", mutation, undefined, undefined, sessionContext);
choice = "Deny";
await assert.rejects(
	() => sessionWrapper.execute("session-guard-again", mutation, undefined, undefined, sessionContext),
	/denied by user/,
);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, beforeGuardAsk + 1);
await sessionTool.prepareRuntimeApproval("session-guard-fingerprint", mutation);
sessionTool.approveRuntimeApproval("session-guard-fingerprint", mutation);
await assert.rejects(
	() => sessionTool.execute("session-guard-fingerprint", { ...mutation, parameters: { InstanceIds: ["i-changed"] } }),
	/approval/,
);
await assert.rejects(
	() =>
		sessionWrapper.execute(
			"session-guard-deny",
			{ ...read, operation: "delete-bucket" },
			undefined,
			undefined,
			sessionContext,
		),
	/fixture\.aws/,
);
const beforePolicyDeny = (await calls()).length;
await assert.rejects(
	() =>
		sessionWrapper.execute("session-policy-deny", ordinaryMutation, undefined, undefined, {
			...sessionContext,
			settings: Settings.isolated({ "tools.approval": { aws: "deny" } }),
		}),
	/blocked by user policy/,
);
assert.equal((await calls()).length, beforePolicyDeny);
await sessionTool.prepareRuntimeApproval("session-identity-change", ordinaryMutation);
await fs.writeFile(path.join(root, "changed-identity"), "yes");
await assert.rejects(() => sessionTool.execute("session-identity-change", ordinaryMutation), /identity changed/);
await fs.unlink(path.join(root, "changed-identity"));
await assert.rejects(
	() => sessionTool.prepareRuntimeApproval("session-partition-change", { ...ordinaryMutation, profile: "mismatched" }),
	/WRONG_PARTITION/,
);
sessionId = "different-native-session";
const beforeNewSession = (await calls()).filter(call => call.argv.includes("modify-db-cluster")).length;
await assert.rejects(
	() => sessionWrapper.execute("new-session", ordinaryMutation, undefined, undefined, sessionContext),
	/denied by user/,
);
assert.equal((await calls()).filter(call => call.argv.includes("modify-db-cluster")).length, beforeNewSession);
sessionId = "native-approval-owner-advisor";
await assert.rejects(
	() => reconstructedWrapper.execute("advisor-session", ordinaryMutation, undefined, undefined, sessionContext),
	/denied by user/,
);
sessionId = "native-approval-owner";
const freshSettingsTool = new AwsTool({ ...approvalSession, settings: Settings.isolated() });
await assert.rejects(() => freshSettingsTool.execute("fresh-settings", ordinaryMutation), /approval/);
const anonymousTool = new AwsTool({ ...toolSession });
await assert.rejects(() => anonymousTool.execute("anonymous-session", ordinaryMutation), /approval/);
const loginSessionTool = new AwsTool({
	...approvalSession,
	getSessionId: () => "login-session-owner",
});
const loginWrapper = new ExtensionToolWrapper(loginSessionTool as unknown as AgentTool, sessionRunner);
choice = sessionLabel;
await loginWrapper.execute(
	"session-login-grant",
	{ ...login, profile: "expired-session-login" },
	undefined,
	undefined,
	sessionContext,
);
choice = "Deny";
assert.notEqual(
	(await loginWrapper.execute("session-login-later", ordinaryMutation, undefined, undefined, sessionContext)).isError,
	true,
);
const automaticSessionTool = new AwsTool({ ...approvalSession, getSessionId: () => "automatic-session-owner" });
const automaticSessionWrapper = new ExtensionToolWrapper(automaticSessionTool as unknown as AgentTool, sessionRunner);
let automaticSelections = 0;
const automaticSessionContext = {
	...sessionContext,
	settings: Settings.isolated({ "tools.approvalMode": "always-ask" }),
	ui: {
		...sessionContext.ui,
		select: async (title: string, options: string[]) => {
			const [heading, ...details] = title.split("\n");
			assert.ok(!heading.includes("expired-session-first"));
			assert.ok(details.join("\n").includes("'sso' 'login'"));
			assert.ok(details.join("\n").includes("expired-session-first"));
			assert.ok(details.join("\n").includes("Source:"));
			automaticSelections++;
			return options.includes(sessionLabel) ? sessionLabel : "Deny";
		},
	},
} as AgentToolContext;
assert.notEqual(
	(
		await automaticSessionWrapper.execute(
			"automatic-session-grant",
			{ ...read, profile: "expired-session-first" },
			undefined,
			undefined,
			automaticSessionContext,
		)
	).isError,
	true,
);
await fs.unlink(path.join(root, "authenticated-expired-session-first"));
assert.notEqual(
	(
		await automaticSessionWrapper.execute(
			"automatic-session-renewal",
			{ ...ordinaryMutation, profile: "expired-session-first" },
			undefined,
			undefined,
			automaticSessionContext,
		)
	).isError,
	true,
);
assert.equal(automaticSelections, 1);
assert.equal(confirmations, beforeSessionRenewal);
const beforeManagedGrant = selections.length;
const beforeManagedDenial = deniedRequests;
const unsafeForApproval = new MCPTool(deniedConnection, {
	name: "aws___run_script",
	inputSchema: { type: "object", properties: { aws_profile: { type: "string", enum: ["automatic"] } } },
});
const managedWrapper = new ExtensionToolWrapper(unsafeForApproval as unknown as AgentTool, sessionRunner);
await assert.rejects(
	() =>
		managedWrapper.execute("managed-not-granted", { aws_profile: "automatic" }, undefined, undefined, sessionContext),
	/denied by user/,
);
assert.equal(selections.length, beforeManagedGrant + 1);
assert.ok(!selections.at(-1)!.includes(sessionLabel));
assert.equal(deniedRequests, beforeManagedDenial);

const nestedOrdinary = { path: "xd://aws", content: JSON.stringify(ordinaryMutation) };
for (const deniedTool of ["write", "aws"]) {
	batchContext = {
		...sessionContext,
		settings: Settings.isolated({ "tools.approval": { [deniedTool]: "deny" } }),
	};
	const before = (await calls()).length;
	await assert.rejects(
		() => callSessionTool("write", nestedOrdinary, { session: batchSession }),
		/blocked by user policy/,
		`native session grant must not bypass explicit ${deniedTool} deny through xd://aws`,
	);
	assert.equal((await calls()).length, before);
}
batchContext = sessionContext;
const unrelatedPath = path.join(cwd, "unrelated-write.txt");
const beforeUnrelated = selections.length;
await assert.rejects(
	() =>
		callSessionTool("write", { path: unrelatedPath, content: "must remain unapproved" }, { session: batchSession }),
	/denied by user/,
	"native AWS session grant must not approve an unrelated filesystem write",
);
assert.equal(await Bun.file(unrelatedPath).exists(), false);
assert.equal(selections.length, beforeUnrelated + 1);
assert.ok(!selections.at(-1)!.includes(sessionLabel));
const beforeNestedGuard = (await calls()).filter(call => call.argv.includes("terminate-instances")).length;
choice = sessionLabel;
function assertNestedFailure(value: unknown, reason: RegExp, contract: string): void {
	assert.ok(isRecord(value), contract);
	assert.equal(value.hasError, true, contract);
	assert.equal(typeof value.text, "string", contract);
	assert.match(String(value.text), reason, contract);
}
assertNestedFailure(
	await callSessionTool("write", { path: "xd://aws", content: JSON.stringify(mutation) }, { session: batchSession }),
	/denied by user/,
	"mandatory DCG ask must reject an ineligible session-grant selection through xd://aws",
);
assert.ok(!selections.at(-1)!.includes(sessionLabel));
assert.ok(selectionTitles.at(-1)!.includes("fixture guard policy"));
choice = "Approve once";
await callSessionTool("write", { path: "xd://aws", content: JSON.stringify(mutation) }, { session: batchSession });
choice = "Deny";
assertNestedFailure(
	await callSessionTool("write", { path: "xd://aws", content: JSON.stringify(mutation) }, { session: batchSession }),
	/denied by user/,
	"mandatory DCG ask must prompt again after one-call approval through xd://aws",
);
assert.equal((await calls()).filter(call => call.argv.includes("terminate-instances")).length, beforeNestedGuard + 1);
assertNestedFailure(
	await callSessionTool(
		"write",
		{ path: "xd://aws", content: JSON.stringify({ ...read, operation: "delete-bucket" }) },
		{ session: batchSession },
	),
	/fixture\.aws/,
	"mandatory DCG deny must surface an error through xd://aws despite the native session grant",
);
const safetyMessage = "fixture provider safety ".repeat(40) + "final safety condition";
batchContext = {
	...sessionContext,
	toolCall: {
		batchId: "fixture-provider-safety",
		total: 1,
		index: 0,
		toolCalls: [],
		providerMetadata: {
			type: "computer",
			providerItemId: "fixture-computer-call",
			actions: [],
			pendingSafetyChecks: [{ id: "fixture-provider-check", message: safetyMessage }],
		},
	},
} as AgentToolContext;
const beforeSafety = (await calls()).filter(call => call.argv.includes("modify-db-cluster")).length;
await assert.rejects(
	() => callSessionTool("aws", ordinaryMutation, { session: batchSession }),
	/denied by user/,
	"native session grant must not bypass provider safety approval",
);
assert.ok(!selections.at(-1)!.includes(sessionLabel));
assert.ok(selectionTitles.at(-1)!.includes(safetyMessage));
assert.equal((await calls()).filter(call => call.argv.includes("modify-db-cluster")).length, beforeSafety);
batchContext = sessionContext;
for (const outcome of ["once", "deny", "failed", "cancelled"] as const) {
	sessionId = `ungranted-${outcome}`;
	const beforePrompts: number = selections.length;
	const before = (await calls()).filter(call => call.argv.includes("modify-db-cluster")).length;
	choice = outcome === "once" ? "Approve once" : outcome === "deny" ? undefined : sessionLabel;
	selectionFailure = outcome === "failed" ? new Error("fixture selection failed") : undefined;
	selectionAbort = outcome === "cancelled" ? new AbortController() : undefined;
	if (outcome === "once") {
		await callSessionTool("aws", ordinaryMutation, { session: batchSession });
	} else {
		await assert.rejects(
			() => callSessionTool("aws", ordinaryMutation, { session: batchSession, signal: selectionAbort?.signal }),
			outcome === "failed" ? /fixture selection failed/ : outcome === "cancelled" ? /cancelled/ : /denied by user/,
			`${outcome} ordinary AWS selection must reject without executing`,
		);
	}
	selectionFailure = undefined;
	selectionAbort = undefined;
	choice = "Deny";
	await assert.rejects(
		() => callSessionTool("aws", ordinaryMutation, { session: batchSession }),
		/denied by user/,
		`${outcome} ordinary AWS selection must not grant later session access`,
	);
	assert.equal(selections.length, beforePrompts + 2);
	assert.equal(
		(await calls()).filter(call => call.argv.includes("modify-db-cluster")).length,
		before + (outcome === "once" ? 1 : 0),
	);
}
sessionId = "native-approval-owner";

const beforeReservation = (await listTrustedAwsProfiles()).map(profile => profile.name);
assert.ok(beforeReservation.includes("adopted-model") && beforeReservation.includes("adopted-alias"));
void tool.parameters;
reserveManagedAwsProfile("adopted-model");
const afterReservation = (await listTrustedAwsProfiles()).map(profile => profile.name);
assert.ok(!afterReservation.includes("adopted-model") && !afterReservation.includes("adopted-alias"));
assert.ok(afterReservation.includes("coreforge-admin"));
assert.throws(() => tool.parameters.assert({ ...read, profile: "adopted-model" }));
const beforeRejectedHelpers = (await calls()).length;
const repositoryHelper = path.join(repository, process.platform === "win32" ? "native-helper.exe" : "native-helper");
await fs.copyFile(process.execPath, repositoryHelper);
const scriptHelper = path.join(root, "external-helper");
await fs.writeFile(scriptHelper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
for (const profile of ["repository-helper", "script-helper"]) {
	await assert.rejects(() => tool.execute(profile, { ...read, profile }), /AUTH_REQUIRED/);
}
await assert.rejects(() => tool.execute("reserved-alias", { ...read, profile: "adopted-alias" }), /PROFILE_NOT_FOUND/);
assert.equal((await calls()).length, beforeRejectedHelpers);
for (const prefix of ["malformed-json", "prefixed-json", "truncated-json"]) {
	const result = await tool.execute(prefix, { ...read, parameters: { Prefix: prefix } });
	const output = text(result);
	const savedOutput = await fs.readFile(path.join(root, `artifact-${artifact}.txt`), "utf8").catch(error => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	});
	assert.ok(!output.includes("fixture-secret-compound"), `${prefix} leaked in result`);
	assert.ok(!savedOutput.includes("fixture-secret-compound"), `${prefix} leaked in artifact`);
	assert.ok(!savedOutput.includes("SecretString"), `${prefix} preserved sensitive JSON`);
	assert.match(output, /withheld/);
}
await tool.execute("large", { ...read, parameters: { Prefix: "large" } });
const artifacts = await fs.readdir(root);
const saved = await Promise.all(
	artifacts.filter(file => file.startsWith("artifact-")).map(file => fs.readFile(path.join(root, file), "utf8")),
);
assert.ok(saved.some(value => value.includes('"rows"')));
assert.ok(saved.every(value => !value.includes("fixture-secret") && !value.includes("fixture-token")));
const originalPath = Bun.env.PATH;
assert.equal(isCoreforgeManagedLaunch(), true);
assert.equal(
	getOperationalAwsLaunchMetadata()?.executable,
	path.join(root, process.platform === "win32" ? "aws.exe" : "aws"),
);
Bun.env.PATH = cwd;
Bun.env.OMP_OPERATIONAL_AWS_EXECUTABLE = path.join(cwd, "aws");
try {
	const managedIdentity = await ensureCoreforgeAwsSso({ profile: "coreforge", region: "us-east-1" });
	assert.match(managedIdentity.roleArn, /user\/fixture$/);
	await fs.mkdir(path.join(root, ".aws"), { recursive: true });
	await fs.writeFile(
		path.join(root, ".aws", "config"),
		"[profile coreforge]\nsso_session = managed\nsso_account_id = 123456789012\nsso_role_name = Model\n[sso-session managed]\nsso_start_url = https://fixture.invalid/start\nsso_region = us-east-1\n",
	);
	Bun.env.OMP_MODEL_AWS_ACCOUNT_ID = managedIdentity.accountId;
	let verifiedAccount = false;
	const modelCredentials = await resolveAwsCredentials({
		signal: AbortSignal.timeout(5000),
		fetch: Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				verifiedAccount = true;
				assert.equal(String(input), "https://sts.us-east-1.amazonaws.com/");
				assert.match(new Headers(init?.headers).get("authorization") ?? "", /Credential=fixture-model-access\//);
				return new Response(
					`<GetCallerIdentityResponse><GetCallerIdentityResult><Account>${managedIdentity.accountId}</Account></GetCallerIdentityResult></GetCallerIdentityResponse>`,
				);
			},
			{ preconnect: fetch.preconnect },
		),
	});
	assert.equal(verifiedAccount, true);
	assert.equal(modelCredentials.accessKeyId, "fixture-model-access");
} finally {
	Bun.env.PATH = originalPath;
	delete Bun.env.OMP_OPERATIONAL_AWS_EXECUTABLE;
}
for (const [service, operation] of [
	["ecs", "execute-command"],
	["ssm", "start-session"],
] as const) {
	const parameters: Record<string, unknown> =
		service === "ecs"
			? {
					Cluster: "synthetic-cluster",
					Task: "synthetic-task",
					Container: "synthetic-container",
					Command: "fixture-complete",
					Interactive: true,
				}
			: { Target: "i-synthetic", DocumentName: "fixture-complete" };
	const args = { profile: "government", service, operation, parameters };
	const modeParameter = service === "ecs" ? "Command" : "DocumentName";
	Bun.env.OMP_OPERATIONAL_AWS_SESSION_MANAGER_PLUGIN = path.join(repository, "untrusted-plugin");
	const approval = await tool.prepareRuntimeApproval(`session-${service}`, args);
	assert.match(approval!.prompt, /Account: 123456789012/);
	await assert.rejects(() => tool.execute(`session-denied-${service}`, args), /approval/);
	tool.approveRuntimeApproval(`session-${service}`, args);
	const result = await tool.execute(`session-${service}`, args);
	assert.notEqual(result.isError, true, text(result));
	assert.match(text(result), /REMOTE_COMMAND_OK/);
	assert.ok(!text(result).includes("fixture-token"));
	const call = (await calls()).findLast(call => call.argv.includes(operation));
	assert.ok(call.env.PATH);
	assert.notEqual(call.env.PATH, originalPath);
	assert.notEqual(call.env.PATH, repository);
	await assert.rejects(() => fs.stat(call.env.PATH), { code: "ENOENT" });
	const failedArgs = { ...args, parameters: { ...parameters, [modeParameter]: "fixture-fail" } };
	const failedId = `session-${service}-fixture-fail`;
	await tool.prepareRuntimeApproval(failedId, failedArgs);
	tool.approveRuntimeApproval(failedId, failedArgs);
	const failed = await tool.execute(failedId, failedArgs);
	assert.equal(failed.isError, true);
	assert.equal(failed.details?.code, "AWS_ERROR");
	assert.equal(failed.details?.exitCode, 23);
	assert.match(text(failed), /fixture helper failure/);
	assert.ok(!text(failed).includes("REMOTE_COMMAND_OK"));

	const logArgs = { ...args, parameters: { ...parameters, [modeParameter]: "fixture-remote-diagnostic" } };
	const logId = `session-${service}-remote-diagnostic`;
	await tool.prepareRuntimeApproval(logId, logArgs);
	tool.approveRuntimeApproval(logId, logArgs);
	const logResult = await tool.execute(logId, logArgs);
	assert.notEqual(logResult.isError, true, text(logResult));
	assert.equal(logResult.details?.exitCode, 0);
	assert.match(text(logResult), /Cannot perform start session: historical application log entry/);
	assert.match(text(logResult), /REMOTE_COMMAND_OK/);

	const zeroArgs = { ...args, parameters: { ...parameters, [modeParameter]: "fixture-zero-error" } };
	const zeroId = `session-${service}-zero-exit-diagnostic`;
	await tool.prepareRuntimeApproval(zeroId, zeroArgs);
	tool.approveRuntimeApproval(zeroId, zeroArgs);
	const zeroResult = await tool.execute(zeroId, zeroArgs);
	assert.notEqual(zeroResult.isError, true, text(zeroResult));
	assert.equal(zeroResult.details?.exitCode, 0);
	assert.match(text(zeroResult), /Cannot perform start session: fixture helper failure/);
	assert.ok(!text(zeroResult).includes("REMOTE_COMMAND_OK"));
	const hangingArgs = { ...args, parameters: { ...parameters, [modeParameter]: "fixture-hang" } };
	const hangingId = `session-${service}-cancel`;
	await tool.prepareRuntimeApproval(hangingId, hangingArgs);
	tool.approveRuntimeApproval(hangingId, hangingArgs);
	const descendantPath = path.join(root, "session-helper-descendant.pid");
	await fs.rm(descendantPath, { force: true });
	const controller = new AbortController();
	const hangingSession = tool.execute(hangingId, hangingArgs, controller.signal);
	try {
		for (let attempt = 0; attempt < 500; attempt++) {
			if (await Bun.file(descendantPath).exists()) break;
			await Bun.sleep(10);
		}
		const helperPid = Number(await Bun.file(path.join(root, "session-helper.pid")).text());
		const descendantPid = Number(await Bun.file(descendantPath).text());
		const helperProcess = Process.fromPid(helperPid);
		const descendantProcess = Process.fromPid(descendantPid);
		assert.equal(helperProcess?.status(), ProcessStatus.Running);
		assert.equal(descendantProcess?.status(), ProcessStatus.Running);
		controller.abort();
		const cancelled = await hangingSession;
		assert.equal(cancelled.isError, true);
		assert.ok(!text(cancelled).includes("REMOTE_COMMAND_OK"));
		assert.equal(helperProcess?.status(), ProcessStatus.Exited);
		assert.equal(descendantProcess?.status(), ProcessStatus.Exited);
	} finally {
		controller.abort();
		await hangingSession.catch(() => {});
	}
}
delete Bun.env.OMP_OPERATIONAL_AWS_SESSION_MANAGER_PLUGIN;
const cancel = new AbortController();
const hanging = tool.execute("cancel", { ...read, parameters: { Prefix: "hang" } }, cancel.signal);
for (let attempt = 0; attempt < 200; attempt++) {
	if (await Bun.file(path.join(root, "descendant.pid")).exists()) break;
	await Bun.sleep(10);
}
const descendant = Number(await fs.readFile(path.join(root, "descendant.pid"), "utf8"));
cancel.abort();
await hanging;
assert.throws(() => process.kill(descendant, 0));
console.log("Native AWS execution, isolation, approval, SSO, artifacts, and cancellation passed");
