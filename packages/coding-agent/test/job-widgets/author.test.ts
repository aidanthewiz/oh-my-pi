import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, createAssistantMessageEventStream, type Model } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import {
	buildPromptSources,
	createModelJobWidgetAuthor,
	type JobWidgetAuthorRequest,
	JobWidgets,
	redactWidgetSample,
	renderJobWidgetPrompt,
	TextTap,
} from "../../src/job-widgets";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const TOKEN = "ghp_Abcdefghijklmnopqrstuvwxyz0123456789AB";

describe("job widget author prompt", () => {
	it("never sends a credential in the brief or the samples to the author model", () => {
		const text = renderJobWidgetPrompt(
			{
				jobId: "bg_1",
				brief: { kind: "bash", command: `GH_TOKEN=${TOKEN} ./bench.sh | tail -5` },
				sources: [
					{
						id: "pipe:1",
						label: "./bench.sh → tail -5",
						size: 120,
						lines: 2,
						head: [`auth ${TOKEN}`, "req 1 rps=40"],
						tail: [],
					},
				],
			},
			line => redactWidgetSample(line),
		);
		expect(text).not.toContain(TOKEN);
		expect(text).toContain("req 1 rps=40");
	});

	it("keeps three lines of each shape in the head and the tail, so repeated progress lines do not crowd out the rest", () => {
		const progress = (from: number, count: number) =>
			Array.from(
				{ length: count },
				(_, index) => `step ${from + index}/1000 | loss ${(2 / (from + index)).toFixed(4)}`,
			);
		const [source] = buildPromptSources(
			[
				{
					id: "out",
					label: "out",
					size: 1,
					lines: 400,
					head: ["loading model", ...progress(1, 29)],
					tail: [...progress(300, 30), "[eval] step 330 val_loss 0.2100", ...progress(331, 29)],
				},
			],
			line => line,
		);
		expect(source.head).toEqual(["loading model", ...progress(1, 3)]);
		// The tail keeps the newest of each shape, oldest first, and the one-off eval line.
		expect(source.tail).toEqual(["[eval] step 330 val_loss 0.2100", ...progress(357, 3)]);
		expect(source.omitted).toBe(400 - 4 - 4);
	});

	it("caps samples at 12 KB, sharing the budget across sources and keeping each source's newest lines", () => {
		const long = (prefix: string, count: number) =>
			Array.from({ length: count }, (_, index) => `${prefix} ${index} ${"x".repeat(400)}`);
		const sources = buildPromptSources(
			[
				{ id: "out", label: "out", size: 1, lines: 500, head: long("head", 30), tail: long("tail", 60) },
				{ id: "pipe:1", label: "p", size: 1, lines: 3, head: ["a", "b", "c"], tail: [] },
			],
			line => line,
		);
		const bytes = sources
			.flatMap(source => [...source.head, ...source.tail])
			.reduce((sum, line) => sum + line.length + 1, 0);
		expect(bytes).toBeLessThanOrEqual(12 * 1024);
		// Lines are cut at 300 chars.
		expect(Math.max(...sources[0].head.map(line => line.length))).toBe(300);
		// The busy source's share ends on its newest line; the quiet source still gets all of its lines.
		expect(sources[0].tail.at(-1)?.startsWith("tail 59 ")).toBe(true);
		expect(sources[1].head).toEqual(["a", "b", "c"]);
	});

	it("redacts every outbound field, including drift reasons, previous specs and validation errors", () => {
		const secret = "synthetic-widget-session-secret";
		const redact = (text: string) => redactWidgetSample(text, value => value.replaceAll(secret, "[secret]"));
		const text = renderJobWidgetPrompt(
			{
				jobId: secret,
				brief: { kind: "task", command: secret, task: secret, intent: secret, watch: secret, stage: secret },
				sources: [{ id: secret, label: secret, size: 100, lines: 2, head: [secret], tail: [secret] }],
				previous: {
					reason: `watch changed: ${secret} ${TOKEN}`,
					spec: {
						title: secret,
						rules: [{ from: "*", match: secret }],
						blocks: [{ kind: "text", field: secret }],
					},
				},
				rejected: { answer: `${secret} ${TOKEN}`, errors: [`invalid pattern ${secret} ${TOKEN}`] },
			},
			redact,
		);
		expect(text).not.toContain(secret);
		expect(text).not.toContain(TOKEN);
		expect(text).toContain("[secret]");
	});

	it("bounds UTF-8 sampling, metadata, source count and the complete retry prompt", () => {
		const sources = Array.from({ length: 100 }, (_, index) => ({
			id: `pipe:${index}`,
			label: "界".repeat(2000),
			size: 1_000_000,
			lines: 90,
			head: Array.from({ length: 30 }, (_, n) => `${String.fromCharCode(65 + n)}${"界".repeat(400)}`),
			tail: Array.from({ length: 60 }, (_, n) => `${String.fromCharCode(128 + n)}${"界".repeat(400)}`),
		}));
		const samples = buildPromptSources(sources, text => text);
		expect(samples).toHaveLength(16);
		expect(
			samples
				.flatMap(source => [...source.head, ...source.tail])
				.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0),
		).toBeLessThanOrEqual(12 * 1024);
		expect(samples.every(source => source.label.length <= 160)).toBe(true);
		expect(
			samples
				.flatMap(source => [...source.head, ...source.tail])
				.every(line => Buffer.byteLength(line) <= 300 && !line.includes("\uFFFD")),
		).toBe(true);
		const text = renderJobWidgetPrompt(
			{
				jobId: "bounded",
				brief: { kind: "task", task: "界".repeat(20_000), watch: "界".repeat(20_000) },
				sources,
				previous: {
					reason: "界".repeat(20_000),
					spec: {
						title: "界".repeat(20_000),
						rules: [],
						blocks: [],
					},
				},
				rejected: { answer: "界".repeat(20_000), errors: Array.from({ length: 100 }, () => "界".repeat(20_000)) },
			},
			value => value,
		);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024);
		expect(text).not.toContain("\uFFFD");
	});
});

describe("managed widget author dispatch", () => {
	afterEach(() => vi.restoreAllMocks());
	const model = {
		id: "widget-model",
		name: "Widget model",
		provider: "synthetic",
		api: "openai-completions",
		baseUrl: "https://synthetic.invalid",
		contextWindow: 32000,
		maxTokens: 3000,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as Model<Api>;
	const settings = Settings.isolated({ modelRoles: { widget: "synthetic/widget-model" } });
	const request: JobWidgetAuthorRequest = {
		jobId: "job",
		canAuthor: () => true,
		brief: { kind: "bash", command: "bench" },
		sources: [{ id: "out", label: "out", size: 18, lines: 3, head: ["rps=1", "rps=2", "rps=3"], tail: [] }],
	};
	const spec = {
		title: "throughput",
		rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
		blocks: [{ kind: "spark", field: "rps", label: "rps" }],
		headline: { field: "rps", agg: "last" },
	};

	it("does not resolve credentials or dispatch before explicit admission", async () => {
		const complete = spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async () => {
			throw new Error("forbidden dispatch");
		});
		const registry = { getAvailable: () => [model], getApiKey: vi.fn(), resolver: vi.fn() };
		const withoutAdmission = createModelJobWidgetAuthor({
			settings,
			modelRegistry: registry as unknown as ModelRegistry,
		});
		expect(await withoutAdmission(request, new AbortController().signal)).toBeUndefined();
		const denied = createModelJobWidgetAuthor({
			settings,
			modelRegistry: registry as unknown as ModelRegistry,
			admit: async () => undefined,
		});
		expect(await denied(request, new AbortController().signal)).toBeUndefined();
		const admission = vi.fn(async () => {
			throw new Error("Unbound source must not reach admission");
		});
		const unbound = createModelJobWidgetAuthor({
			settings,
			modelRegistry: registry as unknown as ModelRegistry,
			admit: admission,
		});
		const unboundRequest = { ...request };
		delete unboundRequest.canAuthor;
		expect(await unbound(unboundRequest, new AbortController().signal)).toBeUndefined();
		expect(admission).not.toHaveBeenCalled();
		expect(registry.getApiKey).not.toHaveBeenCalled();
		expect(registry.resolver).not.toHaveBeenCalled();
		expect(complete).not.toHaveBeenCalled();
	});

	it("dispatches admitted specs with a completely redacted payload and no ambient credential probe", async () => {
		const secret = "synthetic-origin-secret";
		let payload = "";
		const usage: AssistantMessage[] = [];
		spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async (_model, context) => {
			payload = JSON.stringify(context);
			return createAssistantMessage(JSON.stringify(spec));
		});
		const author = createModelJobWidgetAuthor({
			settings,
			modelRegistry: { getAvailable: () => [model] } as unknown as ModelRegistry,
			obfuscate: () => value => value.replaceAll(secret, "[secret]"),
			admit: async () => ({
				sessionId: "origin",
				apiKey: "synthetic-key",
				isCurrent: () => true,
				onUsage: message => usage.push(message),
			}),
		});
		const answer = await author(
			{
				...request,
				brief: { kind: "task", task: secret, watch: secret, stage: secret },
				sources: [{ ...request.sources[0]!, label: secret, head: [secret], tail: [secret] }],
				previous: { reason: secret, spec: { title: secret, rules: [{ from: "*", match: secret }], blocks: [] } },
				rejected: {
					answer: `${secret}${"\0".repeat(20_000)}`,
					errors: Array.from({ length: 12 }, () => `${secret}${"\0".repeat(20_000)}`),
				},
			},
			new AbortController().signal,
		);
		expect(answer).toEqual(spec);
		expect(payload).not.toContain(secret);
		expect(payload).toContain("[secret]");
		expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(64 * 1024);
		expect(usage).toHaveLength(1);
	});

	it("drains late originating usage after invalidation without installing or retrying the stale answer", async () => {
		const response = Promise.withResolvers<AssistantMessage>();
		const started = Promise.withResolvers<void>();
		spyOn(agentCore, "instrumentedCompleteSimple").mockImplementation(async () => {
			started.resolve();
			return response.promise;
		});
		const journals = { origin: [] as AssistantMessage[], next: [] as AssistantMessage[] };
		let current = true;
		const origin = journals.origin;
		const author = createModelJobWidgetAuthor({
			settings,
			modelRegistry: { getAvailable: () => [model] } as unknown as ModelRegistry,
			admit: async () => ({
				sessionId: "origin",
				apiKey: "synthetic-key",
				isCurrent: () => current,
				onUsage: message => origin.push(message),
			}),
		});
		const widgets = new JobWidgets({ author, now: () => 15000, minIngestMs: 0 });
		const tap = new TextTap("out", "out");
		tap.append("rps=1\nrps=2\nrps=3\n");
		const completion = Promise.withResolvers<void>();
		const job: AsyncJob = {
			id: "origin-job",
			type: "bash",
			label: "bench",
			startTime: 0,
			status: "running",
			abortController: new AbortController(),
			promise: completion.promise,
			widgetInputs: {
				canAuthor: () => true,
				sources: () => [tap],
				brief: () => ({ kind: "bash" as const, command: "bench" }),
			},
		};
		try {
			widgets.view(job);
			await started.promise;
			current = false;
			widgets.invalidate();
			let drained = false;
			const draining = widgets.drain().then(() => {
				drained = true;
			});
			await Promise.resolve();
			expect(drained).toBe(false);
			response.resolve(createAssistantMessage(JSON.stringify(spec)));
			await draining;
			expect(journals.origin).toHaveLength(1);
			expect(journals.next).toEqual([]);
		} finally {
			response.resolve(createAssistantMessage(JSON.stringify(spec)));
			await widgets.drain();
			widgets.dispose();
			job.status = "completed";
			completion.resolve();
			await job.promise;
		}
		expect(widgets.view(job)).toBeUndefined();
	});

	it.each([
		{ enabled: false, transition: false, creditDenied: false },
		{ enabled: true, transition: false, creditDenied: false },
		{ enabled: true, transition: true, creditDenied: false },
		{ enabled: true, transition: false, creditDenied: true },
	])(
		"uses default SDK admission and originating journal drain: %j",
		async ({ enabled, transition, creditDenied }) => {
			const temp = TempDir.createSync("@widget-sdk-admission-");
			const authStorage = createInMemoryAuthStorage();
			const provider = "widget-author-sdk-synthetic";
			const source = "widget-author-sdk-test";
			const sdkSettings = Settings.isolated({
				"async.widgets": true,
				"async.widgetRemoteAuthoring": enabled,
				modelRoles: { widget: `${provider}/widget-model` },
			});
			const registry = new ModelRegistry(authStorage, path.join(temp.path(), "models.yml"), {
				settings: sdkSettings,
			});
			let calls = 0;
			let payload = "";
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			registry.registerProvider(
				provider,
				{
					baseUrl: "https://synthetic.invalid",
					apiKey: "synthetic-widget-key",
					api: "widget-author-sdk-api",
					models: [
						{
							id: "widget-model",
							name: "Widget",
							reasoning: false,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 32000,
							maxTokens: 3000,
						},
					],
					streamSimple: (selected, context, options) => {
						const stream = createAssistantMessageEventStream();
						const message: AssistantMessage = {
							...createAssistantMessage(JSON.stringify(spec)),
							api: selected.api,
							provider: selected.provider,
							model: selected.id,
						};
						message.usage = { ...message.usage, input: 11, output: 3, totalTokens: 14 };
						void resolveApiKeyOnce(options?.apiKey, options?.signal).then(
							async () => {
								calls++;
								payload = JSON.stringify(context);
								started.resolve();
								if (transition) await release.promise;
								stream.push({ type: "start", partial: message });
								stream.push({ type: "done", reason: "stop", message });
							},
							error => {
								stream.push({
									type: "error",
									reason: "error",
									error: {
										...createAssistantMessage(""),
										api: selected.api,
										provider: selected.provider,
										model: selected.id,
										stopReason: "error",
										errorMessage: String(error),
									},
								});
							},
						);
						return stream;
					},
				},
				source,
			);
			let session: AgentSession | undefined;
			let job: AsyncJob | undefined;
			const completion = Promise.withResolvers<void>();
			try {
				const selected = registry.find(provider, "widget-model");
				if (!selected) throw new Error("Synthetic widget model is missing");
				({ session } = await createAgentSession({
					cwd: temp.path(),
					agentDir: temp.path(),
					authStorage,
					modelRegistry: registry,
					settings: sdkSettings,
					model: selected,
					sessionManager: SessionManager.create(temp.path(), temp.path()),
					agentId: `WidgetSdk${enabled}${transition}`,
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
				if (creditDenied) {
					spyOn(registry, "resolver").mockReturnValue(async () => {
						throw new Error("Synthetic credit admission denied");
					});
				}
				const widgets = session.asyncJobManager?.widgets;
				if (!widgets) throw new Error("Default SDK widget registry is missing");
				const tap = new TextTap("out", "out");
				tap.append("rps=1\nrps=2\nrps=3\n");
				job = {
					id: "sdk-widget",
					type: "bash",
					label: "bench",
					startTime: 0,
					status: "running",
					abortController: new AbortController(),
					promise: completion.promise,
					widgetInputs: {
						canAuthor: () => true,
						sources: () => [tap],
						brief: () => ({ kind: "bash" as const, command: `bench ${TOKEN}` }),
					},
				};
				const initial = widgets.view(job);
				if (!enabled) expect(initial?.state).toBe("fallback");
				if (transition) {
					await started.promise;
					const originFile = session.sessionManager.getSessionFile();
					if (!originFile) throw new Error("Originating widget journal is missing");
					let switched = false;
					const switching = session.newSession().then(() => {
						switched = true;
					});
					await Promise.resolve();
					expect(switched).toBe(false);
					release.resolve();
					await switching;
					expect(calls).toBe(1);
					expect(session.sessionManager.getSessionFile()).not.toBe(originFile);
					expect(session.sessionManager.getUsageStatistics().totalTokens).toBe(0);
					const entries = (await Bun.file(originFile).text())
						.trim()
						.split("\n")
						.map(line => JSON.parse(line));
					expect(
						entries
							.filter(entry => entry.type === "model_usage" && entry.purpose === "job-widget")
							.map(entry => entry.usage.totalTokens),
					).toEqual([14]);
					return;
				}
				await widgets.drain();
				if (creditDenied) {
					for (let round = 0; round < 2; round++) {
						widgets.view(job);
						await widgets.drain();
					}
				}
				const admitted = enabled && !creditDenied;
				expect(calls).toBe(admitted ? 1 : 0);
				expect(widgets.view(job)?.state).toBe(admitted ? "live" : "fallback");
				if (admitted) {
					expect(widgets.view(job)?.headline?.text).toBe("3");
					expect(payload).not.toContain(TOKEN);
					expect(session.sessionManager.getUsageStatistics().totalTokens).toBe(14);
				}
				if (creditDenied) expect(session.sessionManager.getUsageStatistics().totalTokens).toBe(0);
			} finally {
				release.resolve();
				if (job) job.status = "completed";
				completion.resolve();
				await completion.promise;
				await session?.dispose();
				registry.clearSourceRegistrations(source);
				await authStorage.close();
				temp.removeSync();
			}
		},
		60_000,
	);
});
