import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TextTap } from "../../src/job-widgets/text-tap";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../src/async/job-manager";
import type { AgentSession } from "../../src/session/agent-session";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const SPEC = {
	title: "backup throughput",
	rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
	blocks: [{ kind: "spark", field: "rps", label: "rps" }],
	headline: { field: "rps", agg: "last" },
};

describe("admitted job widget fallback", () => {
	it.each(["answered", "failed", "disabled"] as const)(
		"keeps fallback requests and usage under session authority: %s",
		async outcome => {
			using temp = TempDir.createSync("@widget-chain-");
			const authStorage = createInMemoryAuthStorage();
			const provider = "widget-chain-synthetic";
			const source = "widget-chain-test";
			const settings = Settings.isolated({
				"async.widgets": true,
				"async.widgetRemoteAuthoring": true,
				modelRoles: { widget: `${provider}/primary` },
				"retry.fallbackChains": { widget: [`${provider}/backup`] },
				...(outcome === "disabled" ? { enabledModels: [`${provider}/primary`] } : {}),
			});
			const registry = new ModelRegistry(authStorage, path.join(temp.path(), "models.yml"), { settings });
			const sent: string[] = [];
			registry.registerProvider(
				provider,
				{
					baseUrl: "https://synthetic.invalid",
					apiKey: "synthetic-widget-key",
					api: "widget-chain-api",
					models: ["primary", "backup"].map(id => ({
						id,
						name: id,
						reasoning: false,
						input: ["text" as const],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 32000,
						maxTokens: 3000,
					})),
					streamSimple: (selected, _context, options) => {
						const stream = createAssistantMessageEventStream();
						void (async () => {
							let message: AssistantMessage = {
								...createAssistantMessage(JSON.stringify(SPEC)),
								api: selected.api,
								provider: selected.provider,
								model: selected.id,
							};
							try {
								await resolveApiKeyOnce(options?.apiKey, options?.signal);
								await options?.onPayload?.({ widget: true }, selected, options?.signal);
								sent.push(selected.id);
								message.usage = { ...message.usage, input: 2, output: 1, totalTokens: 3 };
								if (selected.id === "primary" || outcome === "failed") {
									message = {
										...message,
										content: [],
										stopReason: "error",
										errorMessage: `${selected.id} route down`,
									};
									stream.push({ type: "error", reason: "error", error: message });
								} else {
									stream.push({ type: "start", partial: message });
									stream.push({ type: "done", reason: "stop", message });
								}
							} catch (error) {
								stream.push({
									type: "error",
									reason: "error",
									error: {
										...message,
										content: [],
										stopReason: "error",
										errorMessage: String(error),
									},
								});
							}
						})();
						return stream;
					},
				},
				source,
			);
			let session: AgentSession | undefined;
			let job: AsyncJob | undefined;
			const completion = Promise.withResolvers<void>();
			try {
				const model = registry.find(provider, "primary");
				if (!model) throw new Error("Missing synthetic primary model");
				({ session } = await createAgentSession({
					cwd: temp.path(),
					agentDir: temp.path(),
					authStorage,
					modelRegistry: registry,
					settings,
					model,
					sessionManager: SessionManager.create(temp.path(), temp.path()),
					agentId: "WidgetChain",
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					rules: [],
					preloadedCustomToolPaths: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					toolNames: [],
					restrictToolNames: true,
				}));
				const widgets = session.asyncJobManager?.widgets;
				if (!widgets) throw new Error("Missing session widget registry");
				const tap = new TextTap("out", "out");
				tap.append("rps=1\nrps=2\nrps=3\n");
				job = {
					id: "widget-chain",
					type: "bash",
					label: "make",
					startTime: 0,
					status: "running",
					abortController: new AbortController(),
					promise: completion.promise,
					widgetInputs: {
						canAuthor: () => true,
						sources: () => [tap],
						brief: () => ({ kind: "bash", command: "make" }),
					},
				};
				widgets.view(job);
				await widgets.drain();
				expect(sent).toEqual(outcome === "disabled" ? ["primary"] : ["primary", "backup"]);
				expect(session.sessionManager.getUsageStatistics().totalTokens).toBe(outcome === "disabled" ? 3 : 6);
				const view = widgets.view(job);
				if (outcome === "answered") {
					expect(view?.state).toBe("live");
					expect(view?.headline?.text).toBe("3");
				} else {
					expect(view).toMatchObject({
						blocks: [
							{
								kind: "stat",
								items: expect.arrayContaining([{ label: "lines", text: "3" }]),
							},
						],
					});
				}
			} finally {
				if (job) job.status = "completed";
				completion.resolve();
				await session?.dispose();
				registry.clearSourceRegistrations(source);
				await authStorage.close();
			}
		},
		60_000,
	);
});
