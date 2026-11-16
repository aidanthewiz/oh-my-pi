import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentTool, type AgentToolContext, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { callSessionTool } from "../../src/eval/js/tool-bridge";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ExtensionUIContext } from "../../src/extensibility/extensions/types";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { BUILTIN_TOOLS, type ToolSession } from "../../src/tools";
import { AwsTool, type AwsSecretInputDependencies } from "../../src/tools/aws";
import {
	AWS_SECRET_INPUT_CAPABILITY,
	AWS_SECRET_INPUT_PROTOCOL,
	type AwsSecretInputRequest,
	assertAwsSecretInputCapability,
	normalizeAwsSecretInputRequest,
} from "../../src/tools/aws-secret-input-contract";
import { runAwsSecretInputScope } from "../../src/tools/aws-secret-input-scope";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const emit = process.stdout.write.bind(process.stdout);
const APPROVED_OUTPUT = "carrier-input-approved\n";
const SYNTHETIC_INPUT = "carrier-fixture-private-input";
const COPIED_AWS_PATH = "[xd://aws#ABCD]";
let stage = "setup";

function proof(value: unknown): asserts value {
	if (!value) throw new Error("AWS_SECRET_INPUT_CARRIER_PROOF_FAILED");
}

function response(result: AgentToolResult<unknown>): Record<string, unknown> | undefined {
	if (!isRecord(result.details)) return undefined;
	const details =
		isRecord(result.details.xdev) && isRecord(result.details.xdev.inner) ? result.details.xdev.inner : result.details;
	return isRecord(details.response) ? details.response : undefined;
}

function incompatible(value: unknown): boolean {
	if (value instanceof Error) return /\bCAPABILITY_INCOMPATIBLE\b/u.test(value.message);
	if (!isRecord(value) || (value.isError !== true && value.hasError !== true)) return false;
	if (typeof value.text === "string") return /\bCAPABILITY_INCOMPATIBLE\b/u.test(value.text);
	if (!Array.isArray(value.content)) return false;
	return value.content.some(
		part =>
			isRecord(part) &&
			part.type === "text" &&
			typeof part.text === "string" &&
			/\bCAPABILITY_INCOMPATIBLE\b/u.test(part.text),
	);
}

function evalCode(language: "js" | "py", carrier: "aws" | "write" | "copied-write", args: unknown): string {
	const tool = carrier === "aws" ? "aws" : "write";
	const input =
		carrier === "aws"
			? args
			: { path: carrier === "copied-write" ? COPIED_AWS_PATH : "xd://aws", content: JSON.stringify(args) };
	if (language === "js") {
		return [
			`const result = await tool.${tool}(${JSON.stringify(input)});`,
			"if (result?.hasError) throw new Error(result.text);",
			"return result;",
		].join("\n");
	}
	return [
		"import json",
		`result = await tool.${tool}(json.loads(${JSON.stringify(JSON.stringify(input))}))`,
		"if isinstance(result, dict) and result.get('hasError'):",
		"    raise RuntimeError(result['text'])",
		"result",
	].join("\n");
}

interface HeldCleanup {
	entered: PromiseWithResolvers<void>;
	release: PromiseWithResolvers<void>;
	aborted: PromiseWithResolvers<void>;
	home?: string;
}

interface CarrierResultHook {
	root: "aws" | "write";
	args: unknown;
	entered: number;
	completed: number;
	failed: boolean;
	check(): Promise<void>;
}

async function run(root: string, language: "js" | "py") {
	proof(path.isAbsolute(root));
	const counts = {
		ui: 0,
		probeWorker: 0,
		launch: 0,
		runWorker: 0,
		providerFiles: 0,
		providerClients: 0,
		providerRequests: 0,
		providerDestroyed: 0,
		receiver: 0,
		cleanupComplete: 0,
	};
	const events: string[] = [];
	const denied: string[] = [];
	const results = new Map<string, AgentToolResult<unknown>>();
	const active = new Set<Promise<void>>();
	const authStorage = createInMemoryAuthStorage();
	const model = getBundledModel("openai", "gpt-4o-mini");
	proof(model);
	authStorage.keys.setRuntime(model.provider, "carrier-fixture-synthetic-model-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const sessionManager = SessionManager.create(root, path.join(root, "sessions"));
	const settings = Settings.isolated({
		"async.enabled": false,
		"advisor.enabled": false,
		"autolearn.enabled": false,
		"browser.enabled": false,
		"computer.enabled": false,
		"compaction.enabled": false,
		"retry.enabled": false,
		"plan.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"eval.js": true,
		"eval.py": language === "py",
		"eval.autoProvision": false,
		"eval.autoBackground.enabled": false,
		"python.interpreter": process.env.CARRIER_PYTHON ?? "",
		"tools.xdev": true,
		"edit.mode": "hashline",
		"tools.approvalMode": "yolo",
		"approval.notify": "off",
		"tools.approval": { aws: "allow", bash: "allow" },
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const launch = {
		homeDir: root,
		configFile: path.join(root, "synthetic-config-not-written"),
		sharedCredentialsFile: path.join(root, "synthetic-credentials-not-written"),
		reservedProfiles: ["coreforge"],
		runtimeDirectory: root,
	};
	const normalized = normalizeAwsSecretInputRequest({
		profile: "fixture",
		region: "us-east-1",
		service: "secretsmanager",
		operation: "get-secret-value",
		parameters: {
			SecretId: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture/carrier-AbCd12",
			VersionId: "01234567-89ab-cdef-0123-456789abcdef",
		},
		timeout: 30,
		secretInput: {
			protocol: AWS_SECRET_INPUT_PROTOCOL,
			capability: AWS_SECRET_INPUT_CAPABILITY.capability,
			expectedIdentity: {
				account: "123456789012",
				arn: "arn:aws:sts::123456789012:assumed-role/FixtureRole/carrier",
				partition: "aws",
			},
			consumer: {
				argv: [
					process.execPath,
					"--no-env-file",
					"--no-install",
					path.join(import.meta.dir, "aws-secret-input-carrier-receiver.ts"),
					new Bun.CryptoHasher("sha256").update(SYNTHETIC_INPUT).digest("hex"),
				],
				cwd: root,
			},
		},
	});
	proof(!("action" in normalized));
	const request: AwsSecretInputRequest = normalized;
	const capabilityRequest = { action: "secret-input-capabilities", protocol: AWS_SECRET_INPUT_PROTOCOL } as const;
	let session: AgentSession | undefined;
	let toolSession: ToolSession | undefined;
	let native: AwsTool | undefined;
	let hold: HeldCleanup | undefined;
	let captureStale: (() => Promise<void>) | undefined;
	let stale: { release(): void; settled: Promise<void> } | undefined;
	let unsubscribe: (() => void) | undefined;
	let restoreUI: (() => void) | undefined;
	let resultHook: CarrierResultHook | undefined;
	let sequence = 0;
	const synthetic = createMockModel({ provider: model.provider, id: model.id, handler: { content: ["complete"] } });
	const originalFactory = BUILTIN_TOOLS.aws;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = new Proxy(originalFetch, {
		apply(target, receiver, args: Parameters<typeof fetch>) {
			const input = args[0];
			const url = new URL(input instanceof Request ? input.url : String(input));
			proof(url.protocol === "http:" && url.hostname === "127.0.0.1");
			return Reflect.apply(target, receiver, args);
		},
	});
	const dependencies: AwsSecretInputDependencies = {
		launch: () => {
			counts.launch++;
			events.push("launch");
			return launch;
		},
		probeWorker: async () => {
			counts.probeWorker++;
			events.push("probeWorker");
			return AWS_SECRET_INPUT_CAPABILITY;
		},
		runWorker: async (approved, files, authorize, signal, admitConsumer) => {
			counts.runWorker++;
			events.push("runWorker");
			const ownedHold = hold;
			const onAbort = () => {
				events.push("worker-aborted");
				ownedHold?.aborted.resolve();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (captureStale) {
				const check = captureStale;
				captureStale = undefined;
				const deferred = Promise.withResolvers<void>();
				const settled = (async () => {
					await deferred.promise;
					await check();
				})();
				void settled.catch(() => {});
				stale = { release: deferred.resolve, settled };
			}
			try {
				const result = await runAwsSecretInputScope(approved, files, authorize, signal, admitConsumer, {
					readFile: async filename => {
						counts.providerFiles++;
						events.push("provider-file");
						if (filename === launch.configFile) return Buffer.from("[profile fixture]\nregion = us-east-1\n");
						proof(filename === launch.sharedCredentialsFile);
						return Buffer.from(
							"[fixture]\naws_access_key_id = carrier-synthetic-key\naws_secret_access_key = carrier-synthetic-secret\n",
						);
					},
					createClient: service => {
						counts.providerClients++;
						return {
							send: async () => {
								counts.providerRequests++;
								events.push(`provider-${service}`);
								if (service === "sts")
									return {
										Account: request.secretInput.expectedIdentity.account,
										Arn: request.secretInput.expectedIdentity.arn,
									};
								proof(service === "secretsmanager");
								return {
									ARN: request.parameters.SecretId,
									VersionId: request.parameters.VersionId,
									SecretString: SYNTHETIC_INPUT,
								};
							},
							destroy: () => {
								counts.providerDestroyed++;
							},
						};
					},
					executeConsumer: async (argv, options) => {
						counts.receiver++;
						events.push("receiver");
						const output = await ptree.exec(argv, options);
						proof(output.exitCode === 0 && output.stdout === APPROVED_OUTPUT && output.stderr === "");
						if (ownedHold) {
							proof(typeof options?.env?.HOME === "string");
							ownedHold.home = options.env.HOME;
							events.push("cleanup-held");
							ownedHold.entered.resolve();
							await ownedHold.release.promise;
							events.push("cleanup-released");
						}
						return output;
					},
				});
				return { ...result, teardown: { ...result.teardown, workerReaped: true } };
			} finally {
				signal.removeEventListener("abort", onAbort);
				counts.cleanupComplete++;
				events.push("cleanup-complete");
			}
		},
	};
	try {
		stage = "sdk-construction";
		BUILTIN_TOOLS.aws = owner => {
			if (owner.getAgentId?.() === "advisor") return originalFactory(owner);
			toolSession = owner;
			native = new AwsTool(owner, undefined, dependencies);
			return native;
		};
		try {
			const created = await createAgentSession({
				cwd: root,
				agentDir: root,
				authStorage,
				modelRegistry,
				agentRegistry: new AgentRegistry(),
				sessionManager,
				settings,
				model: { ...model, baseUrl: "https://carrier-model.invalid" },
				cacheWarming: false,
				autoTitle: false,
				bindProcessState: false,
				disableExtensionDiscovery: true,
				extensions: [
					pi => {
						pi.on("tool_result", async event => {
							const hook = resultHook;
							if (!hook || event.toolName !== hook.root) return;
							resultHook = undefined;
							hook.entered++;
							try {
								proof(event.isError === false && Bun.deepEquals(event.input, hook.args));
								await hook.check();
								hook.completed++;
							} catch {
								hook.failed = true;
							}
						});
					},
				],
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
				skipPythonPreflight: true,
				toolNames: ["aws", "edit", "eval", "read", "write"],
				mountedToolNames: ["aws"],
				requireYieldTool: false,
				preloadedCustomToolPaths: [],
				skills: [],
				contextFiles: [],
				noContextFiles: true,
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			});
			session = created.session;
		} finally {
			BUILTIN_TOOLS.aws = originalFactory;
		}
		proof(native && toolSession);
		const owner = toolSession;
		const raw = native;
		const live = session;
		const canonicalAws = live.getToolByName("aws");
		const canonicalWrite = live.getToolByName("write");
		proof(canonicalAws && canonicalWrite && live.getToolForEvalBridge("aws"));
		proof(
			live.agent.state.tools.some(tool => tool.name === "write") &&
				!live.agent.state.tools.some(tool => tool.name === "aws"),
		);
		const runner = live.extensionRunner;
		proof(runner);
		const getUIContext = runner.getUIContext;
		const hasUI = runner.hasUI;
		const ui: ExtensionUIContext = {
			...getUIContext.call(runner),
			select: async (_title, options) => {
				counts.ui++;
				events.push("ui");
				proof(Bun.deepEquals(options, ["Deny", "Approve once"]));
				return "Approve once";
			},
		};
		runner.getUIContext = () => ui;
		runner.hasUI = () => true;
		restoreUI = () => {
			runner.getUIContext = getUIContext;
			runner.hasUI = hasUI;
		};
		live.agent.streamFn = synthetic.stream;
		unsubscribe = live.agent.subscribe(event => {
			if (event.type === "tool_execution_end")
				results.set(event.toolCallId, { ...event.result, isError: event.isError === true });
		});
		const writeArgs = (args: unknown, destination = "xd://aws") => ({
			path: destination,
			content: JSON.stringify(args),
		});
		const execute = (tool: AgentTool, args: unknown) =>
			tool.execute(
				`outside-${++sequence}`,
				args,
				undefined,
				undefined,
				owner.getToolContext?.() as AgentToolContext | undefined,
			);
		const reject = async (name: string, invoke: () => Promise<unknown>) => {
			stage = name;
			const before = { ...counts };
			let outcome: unknown;
			try {
				outcome = await invoke();
			} catch (error) {
				outcome = error;
			}
			proof(incompatible(outcome));
			proof(Bun.deepEquals(counts, before));
			denied.push(name);
		};
		const dispatch = (name: string, args: Record<string, unknown>) => {
			const id = `dispatch-${++sequence}`;
			synthetic.push({ content: [{ type: "toolCall", id, name, arguments: args }] });
			const pending = live.agent.prompt("Execute the synthetic carrier fixture.");
			active.add(pending);
			void pending.finally(() => active.delete(pending)).catch(() => {});
			return { id, pending };
		};
		const capabilityRoutes: {
			stage: string;
			capability: typeof AWS_SECRET_INPUT_CAPABILITY | null;
			protectedActivity: Omit<typeof counts, "probeWorker">;
		}[] = [];
		const probeCapability = async (name: string, tool: string, args: Record<string, unknown>) => {
			stage = name;
			const before = { ...counts };
			let discovered: typeof AWS_SECRET_INPUT_CAPABILITY | null = null;
			try {
				const turn = dispatch(tool, args);
				await turn.pending;
				const result = results.get(turn.id);
				proof(result && result.isError !== true);
				const value = response(result);
				assertAwsSecretInputCapability(value);
				discovered = value;
			} catch {}
			capabilityRoutes.push({
				stage: name,
				capability: discovered,
				protectedActivity: {
					ui: counts.ui - before.ui,
					launch: counts.launch - before.launch,
					runWorker: counts.runWorker - before.runWorker,
					providerFiles: counts.providerFiles - before.providerFiles,
					providerClients: counts.providerClients - before.providerClients,
					providerRequests: counts.providerRequests - before.providerRequests,
					providerDestroyed: counts.providerDestroyed - before.providerDestroyed,
					receiver: counts.receiver - before.receiver,
					cleanupComplete: counts.cleanupComplete - before.cleanupComplete,
				},
			});
		};
		for (const [kind, args] of [
			["transfer", request],
			["capability", capabilityRequest],
		] as const) {
			if (language === "js") {
				await reject(`sdk-raw-aws-${kind}`, () => raw.execute(`raw-${++sequence}`, args));
				await reject(`sdk-canonical-aws-${kind}`, () => execute(canonicalAws, args));
				await reject(`sdk-canonical-write-${kind}`, () => execute(canonicalWrite, writeArgs(args)));
				await reject(`sdk-copied-write-${kind}`, () => execute(canonicalWrite, writeArgs(args, COPIED_AWS_PATH)));
				await reject(`sdk-bridge-aws-${kind}`, () => callSessionTool("aws", args, { session: owner }));
				await reject(`sdk-bridge-write-${kind}`, () =>
					callSessionTool("write", writeArgs(args), { session: owner }),
				);
			}
			for (const carrier of ["aws", "write", "copied-write"] as const) {
				await reject(`${language}-eval-${carrier}-${kind}`, async () => {
					const turn = dispatch("eval", { language, code: evalCode(language, carrier, args), timeout: 30 });
					await turn.pending;
					return results.get(turn.id);
				});
			}
		}
		if (language === "py")
			return {
				schema: "aws-secret-input-carrier-host/v1",
				language,
				denied,
				counts,
				native: null,
				syntheticModelCalls: synthetic.calls.length,
			};

		const rejectPreflight = async (carrier: "aws" | "write") => {
			const args = carrier === "aws" ? request : writeArgs(request, COPIED_AWS_PATH);
			const beforeToolCall = live.agent.beforeToolCall;
			let entered = 0;
			live.agent.beforeToolCall = async context => {
				proof(context.tool.name === carrier && Bun.deepEquals(context.args, args));
				entered++;
				await reject(`preflight-${carrier}-canonical-aws`, () => execute(canonicalAws, request));
				await reject(`preflight-${carrier}-canonical-write`, () => execute(canonicalWrite, writeArgs(request)));
				if (carrier === "write") {
					await reject("preflight-write-nested-native-dispatch", async () => {
						proof(context.tool === live.agent.state.tools.find(tool => tool.name === "write"));
						const nestedId = `nested-preflight-${++sequence}`;
						const nestedModel = createMockModel({
							responses: [
								{ content: [{ type: "toolCall", id: nestedId, name: "write", arguments: context.args }] },
								{ content: ["Nested carrier fixture complete"] },
							],
						});
						const nested = new Agent({
							initialState: { model: nestedModel.model, tools: [context.tool] },
							streamFn: nestedModel.stream,
							getApiKey: () => "carrier-fixture-synthetic-model-key",
							getToolContext: () => owner.getToolContext?.(),
						});
						let nestedResult: AgentToolResult<unknown> | undefined;
						const stopObserving = nested.subscribe(event => {
							if (event.type === "tool_execution_end" && event.toolCallId === nestedId)
								nestedResult = { ...event.result, isError: event.isError === true };
						});
						try {
							await nested.prompt("Execute the synthetic nested carrier fixture.");
							return nestedResult;
						} finally {
							nested.abort();
							await nested.waitForIdle();
							stopObserving();
						}
					});
				}
				return { block: true, reason: "Synthetic preflight refusal complete" };
			};
			try {
				const turn = dispatch(carrier, args);
				await turn.pending;
				proof(entered === 1 && results.get(turn.id)?.isError === true);
			} finally {
				live.agent.beforeToolCall = beforeToolCall;
			}
		};
		await rejectPreflight("write");

		stage = "native-copied-write-capability";
		const beforeCapability = { ...counts };
		const capability = dispatch("write", writeArgs(capabilityRequest, COPIED_AWS_PATH));
		await capability.pending;
		const capabilityResult = results.get(capability.id);
		proof(capabilityResult && capabilityResult.isError !== true);
		const discoveredCapability = response(capabilityResult);
		assertAwsSecretInputCapability(discoveredCapability);
		proof(Bun.deepEquals(counts, { ...beforeCapability, probeWorker: counts.probeWorker }));
		await probeCapability("native-hashline-content-capability", "write", {
			path: "xd://aws",
			content: JSON.stringify(capabilityRequest, null, 2)
				.split("\n")
				.map((line, index) => `${index + 1}:${line}`)
				.join("\n"),
		});
		await probeCapability(
			"native-inner-intent-capability",
			"write",
			writeArgs({ ...capabilityRequest, i: "Checking synthetic AWS capability" }),
		);
		await probeCapability("native-mounted-aws-capability", "aws", capabilityRequest);

		stage = "native-approved-result";
		captureStale = async () => {
			await reject("stale-canonical-aws", () => execute(canonicalAws, request));
			await reject("stale-canonical-write", () => execute(canonicalWrite, writeArgs(request)));
		};
		const writeResultHook: CarrierResultHook = {
			root: "write",
			args: writeArgs(request, COPIED_AWS_PATH),
			entered: 0,
			completed: 0,
			failed: false,
			check: async () => {
				proof(live.agent.state.isStreaming && !results.has(successful.id));
				await reject("result-write-canonical-aws", () => execute(canonicalAws, request));
				await reject("result-write-canonical-write", () => execute(canonicalWrite, writeArgs(request)));
			},
		};
		resultHook = writeResultHook;
		const successStart = events.length;
		const successful = dispatch("write", writeArgs(request, COPIED_AWS_PATH));
		await successful.pending;
		proof(writeResultHook.entered === 1 && writeResultHook.completed === 1 && !writeResultHook.failed);
		const approved = results.get(successful.id);
		proof(approved && approved.isError !== true);
		const approvedResponse = response(approved);
		proof(approvedResponse?.ok === true && isRecord(approvedResponse.result));
		proof(
			approvedResponse.result.stdout === APPROVED_OUTPUT &&
				approvedResponse.result.exitCode === 0 &&
				approvedResponse.result.cancelled === false,
		);
		const successOrder = events.slice(successStart);
		proof(successOrder.indexOf("probeWorker") < successOrder.indexOf("ui"));
		proof(successOrder.indexOf("ui") < successOrder.indexOf("runWorker"));
		proof(successOrder.indexOf("runWorker") < successOrder.indexOf("provider-file"));
		proof(successOrder.indexOf("provider-sts") < successOrder.indexOf("provider-secretsmanager"));
		proof(successOrder.indexOf("provider-secretsmanager") < successOrder.indexOf("receiver"));
		proof(successOrder.indexOf("receiver") < successOrder.indexOf("cleanup-complete"));
		proof(stale);
		stale.release();
		await stale.settled;

		stage = "native-held-cleanup";
		hold = {
			entered: Promise.withResolvers<void>(),
			release: Promise.withResolvers<void>(),
			aborted: Promise.withResolvers<void>(),
		};
		const held = hold;
		const heldStart = events.length;
		const cancelled = dispatch("write", writeArgs(request, COPIED_AWS_PATH));
		let promptSettled = false;
		void cancelled.pending.then(
			() => {
				promptSettled = true;
			},
			() => {},
		);
		await Promise.race([
			held.entered.promise,
			cancelled.pending.then(() => {
				throw new Error("AWS_SECRET_INPUT_CARRIER_PROOF_FAILED");
			}),
		]);
		proof(held.home && (await fs.stat(held.home)).isDirectory());
		await reject("held-canonical-write", () => execute(canonicalWrite, writeArgs(request)));
		await reject("held-bridge-aws", () => callSessionTool("aws", request, { session: owner }));
		stage = "native-abort-barrier";
		let abortSettled = false;
		const aborted = live.abort({ reason: "Synthetic carrier cancellation" }).then(() => {
			abortSettled = true;
		});
		await Promise.race([
			held.aborted.promise,
			aborted.then(() => {
				throw new Error("AWS_SECRET_INPUT_CARRIER_PROOF_FAILED");
			}),
		]);
		const observedAbort = Promise.withResolvers<void>();
		setImmediate(observedAbort.resolve);
		await observedAbort.promise;
		proof(!promptSettled && !abortSettled && !results.has(cancelled.id));
		proof((await fs.stat(held.home)).isDirectory());
		held.release.resolve();
		await Promise.all([cancelled.pending, aborted]);
		const cancellation = results.get(cancelled.id);
		proof(cancellation?.isError === true);
		const cancelledResponse = response(cancellation);
		proof(cancelledResponse?.ok === true && isRecord(cancelledResponse.result));
		proof(cancelledResponse.result.cancelled === true && cancelledResponse.result.completion === "uncertain");
		let removed = false;
		try {
			await fs.stat(held.home);
		} catch (error) {
			removed = isRecord(error) && error.code === "ENOENT";
		}
		proof(removed);
		const cancellationOrder = events.slice(heldStart);
		proof(cancellationOrder.indexOf("cleanup-held") < cancellationOrder.indexOf("worker-aborted"));
		proof(cancellationOrder.indexOf("worker-aborted") < cancellationOrder.indexOf("cleanup-released"));
		proof(cancellationOrder.indexOf("cleanup-released") < cancellationOrder.indexOf("cleanup-complete"));
		hold = undefined;

		stage = "native-direct-presentation";
		await live.setActiveToolPresentation(["aws", "edit", "eval", "read", "write"], []);
		proof(live.agent.state.tools.some(tool => tool.name === "aws"));
		await probeCapability("native-top-level-write-capability", "write", writeArgs(capabilityRequest));
		await rejectPreflight("aws");
		stage = "native-direct-approved-result";
		const directResultHook: CarrierResultHook = {
			root: "aws",
			args: request,
			entered: 0,
			completed: 0,
			failed: false,
			check: async () => {
				proof(live.agent.state.isStreaming && !results.has(direct.id));
				await reject("result-aws-canonical-aws", () => execute(canonicalAws, request));
				await reject("result-aws-canonical-write", () => execute(canonicalWrite, writeArgs(request)));
			},
		};
		resultHook = directResultHook;
		const directStart = events.length;
		const direct = dispatch("aws", request);
		await direct.pending;
		proof(directResultHook.entered === 1 && directResultHook.completed === 1 && !directResultHook.failed);
		const directResult = results.get(direct.id);
		proof(directResult && directResult.isError !== true);
		const directResponse = response(directResult);
		proof(directResponse?.ok === true && isRecord(directResponse.result));
		proof(
			directResponse.result.stdout === APPROVED_OUTPUT &&
				directResponse.result.exitCode === 0 &&
				directResponse.result.cancelled === false,
		);
		const directOrder = events.slice(directStart);
		proof(directOrder.indexOf("probeWorker") < directOrder.indexOf("ui"));
		proof(directOrder.indexOf("ui") < directOrder.indexOf("runWorker"));
		proof(directOrder.indexOf("provider-sts") < directOrder.indexOf("provider-secretsmanager"));
		proof(directOrder.indexOf("provider-secretsmanager") < directOrder.indexOf("receiver"));
		proof(directOrder.indexOf("receiver") < directOrder.indexOf("cleanup-complete"));
		proof(counts.ui === 3 && counts.runWorker === 3 && counts.launch === 3);
		proof(
			counts.providerFiles === 6 &&
				counts.providerRequests === 6 &&
				counts.providerClients === 6 &&
				counts.providerDestroyed === 6,
		);
		proof(counts.receiver === 3 && counts.cleanupComplete === 3);
		return {
			schema: "aws-secret-input-carrier-host/v1",
			language,
			denied,
			counts,
			native: {
				capability: discoveredCapability,
				capabilityRoutes,
				stdout: approvedResponse.result.stdout,
				directStdout: directResponse.result.stdout,
				resultHandlers: { write: writeResultHook.completed, aws: directResultHook.completed },
				cancelled: cancelledResponse.result.cancelled,
				successOrder,
				directOrder,
				cancellationOrder,
				cleanupRemoved: removed,
			},
			syntheticModelCalls: synthetic.calls.length,
		};
	} finally {
		BUILTIN_TOOLS.aws = originalFactory;
		hold?.release.resolve();
		stale?.release();
		session?.agent.abort();
		await Promise.allSettled(active);
		await stale?.settled.catch(() => {});
		restoreUI?.();
		unsubscribe?.();
		try {
			await session?.dispose();
		} finally {
			await disposePyToolBridge();
		}
		await authStorage.close();
		await sessionManager.close();
		globalThis.fetch = originalFetch;
	}
}

if (import.meta.main) {
	try {
		const language = process.argv[3];
		proof(language === "js" || language === "py");
		const receipt = await run(process.argv[2]!, language);
		emit(`${JSON.stringify(receipt)}\n`);
	} catch {
		emit(`${JSON.stringify({ schema: "aws-secret-input-carrier-host-failure/v1", passed: false, stage })}\n`);
		process.exitCode = 42;
	}
}
