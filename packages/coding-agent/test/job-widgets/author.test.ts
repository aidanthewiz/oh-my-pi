import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { resolveApiKeyOnce } from "@oh-my-pi/pi-ai/auth-retry";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../../src/async/job-manager";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { buildPromptSources, redactWidgetSample, renderJobWidgetPrompt, TextTap } from "../../src/job-widgets";
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
	const spec = {
		title: "throughput",
		rules: [{ from: "out", match: String.raw`rps=(?P<rps>\d+)` }],
		blocks: [{ kind: "spark", field: "rps", label: "rps" }],
		headline: { field: "rps", agg: "last" },
	};

	it.each([
		{ enabled: false, transition: false, creditDenied: false, bound: true, invalidated: false },
		{ enabled: true, transition: false, creditDenied: false, bound: true, invalidated: false },
		{ enabled: true, transition: true, creditDenied: false, bound: true, invalidated: false },
		{ enabled: true, transition: false, creditDenied: true, bound: true, invalidated: false },
		{ enabled: true, transition: false, creditDenied: false, bound: false, invalidated: false },
		{ enabled: true, transition: false, creditDenied: false, bound: true, invalidated: true },
	])(
		"uses default SDK admission and originating journal drain: %j",
		async ({ enabled, transition, creditDenied, bound, invalidated }) => {
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
						void (async () => {
							try {
								await resolveApiKeyOnce(options?.apiKey, options?.signal);
								await options?.onPayload?.({ widget: true }, selected, options?.signal);
								calls++;
								payload = JSON.stringify(context);
								started.resolve();
								if (transition || invalidated) await release.promise;
								stream.push({ type: "start", partial: message });
								stream.push({ type: "done", reason: "stop", message });
							} catch (error) {
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
				tap.append(`rps=1\nrps=2\nrps=3\n${TOKEN}${"\0".repeat(20_000)}\n`);
				job = {
					id: "sdk-widget",
					type: "bash",
					label: "bench",
					startTime: 0,
					status: "running",
					abortController: new AbortController(),
					promise: completion.promise,
					widgetInputs: {
						canAuthor: bound ? () => true : undefined,
						sources: () => [tap],
						brief: () => ({
							kind: "bash" as const,
							command: `bench ${TOKEN}`,
							watch: TOKEN,
							stage: TOKEN,
						}),
					},
				};
				const initial = widgets.view(job);
				if (!enabled) expect(initial?.state).toBe("fallback");
				if (transition || invalidated) {
					await Promise.race([
						started.promise,
						widgets.drain().then(() => {
							throw new Error("Widget completed before its provider response gate");
						}),
					]);
				}
				if (invalidated) {
					widgets.invalidate();
					release.resolve();
					await widgets.drain();
					job.status = "completed";
					expect(calls).toBe(1);
					expect(session.sessionManager.getUsageStatistics().totalTokens).toBe(14);
					expect(widgets.view(job)?.state).not.toBe("live");
					return;
				}
				if (transition) {
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
				const admitted = enabled && !creditDenied && bound;
				expect(calls).toBe(admitted ? 1 : 0);
				expect(widgets.view(job)?.state).toBe(admitted ? "live" : "fallback");
				if (admitted) {
					expect(widgets.view(job)?.headline?.text).toBe("3");
					expect(payload).not.toContain(TOKEN);
					expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(64 * 1024);
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
