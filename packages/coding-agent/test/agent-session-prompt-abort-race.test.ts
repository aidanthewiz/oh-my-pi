/**
 * abort() can land while prompt() is still normalizing images or building the
 * vision-model description for a text-only model — both run before
 * PromptOptions.onPromptAdmitted fires. The prompt must be dropped (handed to
 * setPromptDropped) instead of starting a turn or entering a queue afterward,
 * and abort() must cancel an in-flight vision description rather than wait on it.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ImageContent, Model, SimpleStreamOptions, TextContent } from "@oh-my-pi/pi-ai";
import { AnthropicConnectionError } from "@oh-my-pi/pi-ai/error";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageVisionFallback from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { AskTool } from "@oh-my-pi/pi-coding-agent/tools/ask";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
};

describe("AgentSession prompt admission racing abort", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let temporary: TempDir | undefined;
	const restores: Array<() => void> = [];
	const releases: Array<() => void> = [];

	function deferredGate() {
		const gate = Promise.withResolvers<void>();
		releases.push(() => gate.resolve());
		return gate;
	}

	function observe<T>(operation: Promise<T>): Promise<{ value: T } | { error: unknown }> {
		return operation.then(
			value => ({ value }),
			error => ({ error }),
		);
	}

	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		try {
			await session?.dispose();
			await authStorage?.close();
			await temporary?.remove();
		} finally {
			for (const restore of restores.splice(0)) restore();
			session = undefined;
			authStorage = undefined;
			temporary = undefined;
		}
	});

	async function createSession(
		responses: Array<() => MockResponse | Promise<MockResponse>>,
		textOnly = false,
		options: {
			modelRegistry?: Pick<ModelRegistry, "getApiKey">;
			clientBridge?: unknown;
			extensionRunner?: unknown;
			persist?: boolean;
			providerSessionId?: string;
			onPayload?: SimpleStreamOptions["onPayload"];
			settings?: Record<string, unknown>;
		} = {},
	) {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const model: Model = textOnly ? { ...bundled, input: ["text"] } : bundled;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const modelRegistry = new ModelRegistry(authStorage);
		if (options.modelRegistry) {
			const keySpy = spyOn(modelRegistry, "getApiKey").mockImplementation(options.modelRegistry.getApiKey);
			restores.push(() => keySpy.mockRestore());
		}
		if (options.persist) temporary = TempDir.createSync("@pi-image-owner-");
		session = new AgentSession({
			agent,
			sessionManager: options.persist
				? SessionManager.create(temporary!.path(), `${temporary!.path()}/sessions`)
				: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false, ...options.settings }),
			modelRegistry,
			...(options.extensionRunner ? { extensionRunner: options.extensionRunner as never } : {}),
			onPayload: options.onPayload,
			providerSessionId: options.providerSessionId,
		});
		if (options.clientBridge) {
			session.setClientBridge(options.clientBridge as never);
		}
		const dropped: string[] = [];
		const droppedInputs: Array<{ text: string; images?: ImageContent[] }> = [];
		session.setPromptDropped(prompt => {
			dropped.push(prompt.text);
			droppedInputs.push(prompt);
		});
		return { session, dropped, droppedInputs, modelRegistry };
	}

	/** Holds image normalization for image-bearing calls until released. */
	function holdImageNormalization() {
		const started = Promise.withResolvers<void>();
		const release = deferredGate();
		const spy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images?.length) return images;
			started.resolve();
			await release.promise;
			return images;
		});
		restores.push(() => spy.mockRestore());
		return { started: started.promise, release: () => release.resolve() };
	}

	function installVisionTransport(
		complete: NonNullable<imageVisionFallback.DescribeAttachedImagesDeps["completeImpl"]>,
	) {
		const describeImages = imageVisionFallback.describeAttachedImagesForTextModel;
		const spy = spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation(
			(images, deps, signal) => describeImages(images, { ...deps, completeImpl: complete }, signal),
		);
		restores.push(() => spy.mockRestore());
	}

	function visionResponse(model: Model): AssistantMessage {
		return {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "text", text: "A synthetic image description." }],
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 17,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 22,
				cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		};
	}

	async function holdDeferredImageReadiness() {
		let mainRequests = 0;
		let imageRequests = 0;
		let readinessSettled = false;
		const { session, modelRegistry } = await createSession(
			[
				() => {
					mainRequests++;
					return { content: ["unexpected main dispatch"] };
				},
			],
			true,
			{ persist: true },
		);
		const credentials = spyOn(modelRegistry, "getApiKey");
		const saves = spyOn(Bun, "write");
		restores.push(
			() => credentials.mockRestore(),
			() => saves.mockRestore(),
		);
		installVisionTransport(async model => {
			imageRequests++;
			return visionResponse(model);
		});
		const loading = Promise.withResolvers<void>();
		const finish = deferredGate();
		session.setDeferredExtensionLoader(async () => {
			loading.resolve();
			try {
				await finish.promise;
			} finally {
				readinessSettled = true;
			}
		});
		return {
			session,
			loading: loading.promise,
			finish,
			isReadinessSettled: () => readinessSettled,
			assertNoSpending: () => {
				expect(mainRequests).toBe(0);
				expect(imageRequests).toBe(0);
				expect(credentials).not.toHaveBeenCalled();
				expect(
					saves.mock.calls.some(([target]) => typeof target === "string" && /\/image-[^/]+$/.test(target)),
				).toBe(false);
				expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
				expect(session.messages.filter(message => message.role === "user")).toEqual([]);
				expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
			},
		};
	}

	it.each([
		["model", "dispatch"],
		["account", "dispatch"],
		["model", "queue"],
		["account", "queue"],
	] as const)(
		"retains original input when %s changes during image description before %s",
		async (replacement, path) => {
			let mainRequests = 0;
			const rivalStarted = Promise.withResolvers<void>();
			const finishRival = deferredGate();
			const { session, dropped, droppedInputs } = await createSession(
				[
					async () => {
						mainRequests++;
						rivalStarted.resolve();
						await finishRival.promise;
						return { content: ["rival turn only"] };
					},
				],
				true,
				{ persist: true, providerSessionId: "synthetic-image-provider-session" },
			);
			let account = 0;
			session.setSideRequestOwnerCapture(
				() => {
					const original = account;
					return () => account === original;
				},
				() => () => false,
			);
			const accepted = Promise.withResolvers<void>();
			const finish = deferredGate();
			installVisionTransport(async model => {
				accepted.resolve();
				await finish.promise;
				return visionResponse(model);
			});
			let admitted = false;
			const input = session.prompt("retain this original attachment input", {
				images: [IMAGE],
				throwOnDrop: true,
				streamingBehavior: "followUp",
				onPromptAdmitted: () => {
					admitted = true;
				},
			});
			const refused = observe(input);
			await withTimeout(accepted.promise, 2_000, "Session admission boundary timed out");
			const rival = path === "queue" ? observe(session.prompt("rival input")) : undefined;
			if (rival) await withTimeout(rivalStarted.promise, 2_000, "Session admission boundary timed out");
			if (replacement === "model") session.agent.setModel({ ...session.model!, id: "replacement-model" });
			else account++;
			finish.resolve();
			expect(await refused).toMatchObject({ error: expect.any(Error) });
			expect(mainRequests).toBe(path === "queue" ? 1 : 0);
			expect(admitted).toBe(false);
			expect(dropped).toEqual(["retain this original attachment input"]);
			expect(droppedInputs).toEqual([{ text: "retain this original attachment input", images: [IMAGE] }]);
			expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
			expect(
				session.messages.some(
					message =>
						message.role === "user" &&
						JSON.stringify(message.content).includes("retain this original attachment input"),
				),
			).toBe(false);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toMatchObject([
				{ purpose: "image-attachment-describe", usage: { input: 17, output: 5 } },
			]);
			finishRival.resolve();
			if (rival) expect(await rival).toEqual({ value: true });
		},
	);

	it.each(["steer", "followUp", "describe"] as const)(
		"holds direct %s image spending behind deferred readiness and its installed credit hook",
		async method => {
			let ready = false;
			let paid = 0;
			let admitted = 0;
			const { session } = await createSession([], true, {
				persist: true,
				onPayload: () => {
					if (!ready) throw new Error("credit hooks not bound");
					admitted++;
				},
			});
			installVisionTransport(async (model, _context, options) => {
				await options?.onPayload?.({}, model, options.signal);
				paid++;
				return visionResponse(model);
			});
			const loading = Promise.withResolvers<void>();
			const finish = deferredGate();
			session.setDeferredExtensionLoader(async () => {
				loading.resolve();
				await finish.promise;
				ready = true;
			});
			const pending =
				method === "describe" ? session.describeAttachedImages([IMAGE]) : session[method]("image input", [IMAGE]);
			await withTimeout(loading.promise, 2_000, "Session admission boundary timed out");
			expect(paid).toBe(0);
			expect(admitted).toBe(0);
			finish.resolve();
			await pending;
			expect(paid).toBe(1);
			expect(admitted).toBe(1);
		},
	);

	it.each(["steer", "followUp", "describe"] as const)(
		"keeps direct %s image spending closed after deferred readiness fails",
		async method => {
			let paid = 0;
			const { session } = await createSession([], true, { persist: true });
			installVisionTransport(async model => {
				paid++;
				return visionResponse(model);
			});
			session.setDeferredExtensionLoader(async () => {
				throw new Error("credit extension unavailable");
			});
			for (let attempt = 0; attempt < 2; attempt++) {
				const pending =
					method === "describe"
						? session.describeAttachedImages([IMAGE])
						: session[method]("retained image input", [IMAGE]);
				await expect(pending).rejects.toThrow("credit extension unavailable");
			}
			expect(paid).toBe(0);
			expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
		},
	);

	it("returns caller cancellation before readiness settles and retains its later permanent rejection", async () => {
		const held = await holdDeferredImageReadiness();
		const controller = new AbortController();
		const description = held.session.describeAttachedImages([IMAGE], controller.signal);
		const rejected = observe(description);
		try {
			await withTimeout(held.loading, 2_000, "Session admission boundary timed out");
			controller.abort(new Error("caller image cancelled"));
			expect(await withTimeout(rejected, 2_000, "Session admission boundary timed out")).toMatchObject({
				error: { name: "AbortError", cause: controller.signal.reason },
			});
			expect(held.isReadinessSettled()).toBe(false);
			held.assertNoSpending();
		} finally {
			held.finish.reject(new Error("late readiness failure"));
			await expect(held.session.loadDeferredExtensions()).rejects.toThrow("late readiness failure");
		}
		await expect(held.session.describeAttachedImages([IMAGE])).rejects.toThrow("late readiness failure");
		held.assertNoSpending();
	});

	it.each([
		["abort", "steer"],
		["abort", "followUp"],
		["abort", "describe"],
		["dispose", "steer"],
		["dispose", "followUp"],
		["dispose", "describe"],
	] as const)(
		"settles %s during direct %s image readiness without waiting for its factory",
		async (action, method) => {
			const held = await holdDeferredImageReadiness();
			const pending =
				method === "describe"
					? held.session.describeAttachedImages([IMAGE])
					: held.session[method]("cancelled readiness attachment", [IMAGE]);
			const rejected = observe<void | TextContent[]>(pending);
			try {
				await withTimeout(held.loading, 2_000, "Session admission boundary timed out");
				const stopping = action === "dispose" ? held.session.dispose() : held.session.abort();
				const [result] = await withTimeout(
					Promise.all([rejected, stopping]),
					2_000,
					"Session admission boundary timed out",
				);
				expect(result).toMatchObject({ error: { name: "AbortError" } });
				expect(held.isReadinessSettled()).toBe(false);
				held.assertNoSpending();
				if (action === "abort") {
					await withTimeout(held.session.dispose(), 2_000, "Session admission boundary timed out");
					expect(held.isReadinessSettled()).toBe(false);
				}
			} finally {
				held.finish.resolve();
				await Promise.allSettled([held.session.loadDeferredExtensions()]);
			}
			held.assertNoSpending();
		},
	);

	it("expires image readiness at the original 20-second deadline without releasing its factory", async () => {
		const held = await holdDeferredImageReadiness();
		const readiness = observe(held.session.loadDeferredExtensions());
		await withTimeout(held.loading, 2_000, "Session admission boundary timed out");
		const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
		let deadlineTimer: Timer | undefined;
		vi.useFakeTimers();
		const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
			if (ms !== 20_000) return nativeTimeout(ms);
			const controller = new AbortController();
			deadlineTimer = setTimeout(
				() => controller.abort(new DOMException("Image admission expired", "TimeoutError")),
				ms,
			);
			return controller.signal;
		});
		let settled = false;
		const description = held.session.describeAttachedImages([IMAGE]);
		const rejected = observe(description);
		void description.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			vi.advanceTimersByTime(19_999);
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(held.isReadinessSettled()).toBe(false);
			held.assertNoSpending();
			vi.advanceTimersByTime(1);
			vi.useRealTimers();
			expect(await withTimeout(rejected, 2_000, "Session admission boundary timed out")).toMatchObject({
				error: { name: "AbortError", cause: { name: "TimeoutError" } },
			});
			expect(held.isReadinessSettled()).toBe(false);
			await withTimeout(held.session.dispose(), 2_000, "Session admission boundary timed out");
			expect(held.isReadinessSettled()).toBe(false);
			held.assertNoSpending();
		} finally {
			clearTimeout(deadlineTimer);
			timeout.mockRestore();
			vi.useRealTimers();
			held.finish.resolve();
			await readiness;
		}
		held.assertNoSpending();
	});

	it.each([
		["model", "describe"],
		["account", "describe"],
		["model", "prompt"],
		["account", "prompt"],
	] as const)(
		"captures the original image %s authority before deferred readiness for %s",
		async (replacement, method) => {
			let paid = 0;
			let account = 0;
			const { session, droppedInputs } = await createSession([], true, { persist: true });
			session.setSideRequestOwnerCapture(
				() => {
					const original = account;
					return () => account === original;
				},
				() => () => false,
			);
			installVisionTransport(async model => {
				paid++;
				return visionResponse(model);
			});
			const loading = Promise.withResolvers<void>();
			const finish = deferredGate();
			session.setDeferredExtensionLoader(async () => {
				loading.resolve();
				await finish.promise;
			});
			const description = observe<TextContent[] | boolean>(
				method === "describe"
					? session.describeAttachedImages([IMAGE])
					: session.prompt("original readiness attachment", { images: [IMAGE], throwOnDrop: true }),
			);
			await withTimeout(loading.promise, 2_000, "Session admission boundary timed out");
			if (replacement === "model") session.agent.setModel({ ...session.model!, id: "replacement-model" });
			else account++;
			finish.resolve();
			if (method === "describe") expect(await description).toEqual({ value: [] });
			else {
				expect(await description).toMatchObject({ error: expect.any(Error) });
				expect(droppedInputs).toEqual([{ text: "original readiness attachment", images: [IMAGE] }]);
			}
			expect(paid).toBe(0);
			expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
		},
	);

	it("refuses factory image spending but permits fully-bound same-session replay", async () => {
		let paid = 0;
		const { session } = await createSession([], true, { persist: true });
		installVisionTransport(async model => {
			paid++;
			return visionResponse(model);
		});
		let replay: TextContent[] = [];
		session.setDeferredExtensionLoader(async (_isCurrent, allowReentrantMessages) => {
			await expect(session.describeAttachedImages([IMAGE])).rejects.toThrow();
			expect(paid).toBe(0);
			allowReentrantMessages();
			replay = await session.describeAttachedImages([IMAGE]);
		});
		await withTimeout(session.loadDeferredExtensions(), 2_000, "Session admission boundary timed out");
		expect(paid).toBe(1);
		expect(replay).toMatchObject([{ type: "text", text: expect.stringContaining("A synthetic image description.") }]);
	});

	it.each(["new", "dispose"] as const)(
		"drains every accepted image request before %s replaces or seals its original journal",
		async transition => {
			const { session } = await createSession([], true, { persist: true });
			const originalFile = session.sessionManager.getSessionFile()!;
			const originalParent = session.sessionManager.getLeafId();
			const accepted = Promise.withResolvers<void>();
			const finishAccepted = deferredGate();
			const savingSecond = Promise.withResolvers<void>();
			const finishSave = deferredGate();
			installVisionTransport(async model => {
				accepted.resolve();
				await finishAccepted.promise;
				return visionResponse(model);
			});
			const write = Bun.write.bind(Bun);
			let saves = 0;
			const save = spyOn(Bun, "write").mockImplementation((async (...args: Parameters<typeof Bun.write>) => {
				if (typeof args[0] === "string" && /\/image-[^/]+$/.test(args[0]) && ++saves === 2) {
					savingSecond.resolve();
					await finishSave.promise;
				}
				return write(...args);
			}) as typeof Bun.write);
			restores.push(() => save.mockRestore());
			const description = session.describeAttachedImages([IMAGE, { ...IMAGE, mimeType: "image/jpeg" }]);
			await withTimeout(
				Promise.all([accepted.promise, savingSecond.promise]),
				2_000,
				"Session admission boundary timed out",
			);
			let transitioned = false;
			const changing = (transition === "new" ? session.newSession() : session.dispose()).then(() => {
				transitioned = true;
			});
			finishSave.resolve();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(transitioned).toBe(false);
			finishAccepted.resolve();
			await description;
			await changing;
			const persisted = (await Bun.file(originalFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(persisted.filter(entry => entry.type === "model_usage")).toMatchObject([
				{ purpose: "image-attachment-describe", parentId: originalParent, usage: { input: 17, output: 5 } },
			]);
			if (transition === "new") {
				expect(session.sessionManager.getEntries().filter(entry => entry.type === "model_usage")).toEqual([]);
			}
		},
	);

	it("does not move a pending run-A image steer into the same client's physical retry B", async () => {
		const startedA = Promise.withResolvers<void>();
		const failA = deferredGate();
		const startedB = Promise.withResolvers<void>();
		const finishB = deferredGate();
		const { session } = await createSession(
			[
				async () => {
					startedA.resolve();
					await failA.promise;
					return {
						stopReason: "error",
						errorMessage: new AnthropicConnectionError(new Error("ECONNRESET: connection reset by peer")).message,
					};
				},
				async () => {
					startedB.resolve();
					await finishB.promise;
					return { content: ["retry B answer"] };
				},
			],
			false,
			{ settings: { "retry.enabled": true, "retry.baseDelayMs": 1, "retry.modelFallback": false } },
		);
		const client = session.prompt("client prompt with retry");
		await withTimeout(startedA.promise, 2_000, "Session admission boundary timed out");
		const normalization = holdImageNormalization();
		const oldSteer = session.joinActiveTurn("run A only attachment", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Session admission boundary timed out");
		failA.resolve();
		await withTimeout(startedB.promise, 2_000, "Session admission boundary timed out");
		normalization.release();
		expect(await oldSteer).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
		finishB.resolve();
		await withTimeout(client, 2_000, "Session admission boundary timed out");
		expect(
			session.messages.some(
				message => "content" in message && JSON.stringify(message.content).includes("run A only attachment"),
			),
		).toBe(false);
	});

	it("does not move image steering from completed client A into replacement client B", async () => {
		const startedA = Promise.withResolvers<void>();
		const finishA = deferredGate();
		const startedB = Promise.withResolvers<void>();
		const finishB = deferredGate();
		const { session } = await createSession([
			async () => {
				startedA.resolve();
				await finishA.promise;
				return { content: ["reply A"] };
			},
			async () => {
				startedB.resolve();
				await finishB.promise;
				return { content: ["reply B"] };
			},
		]);
		const turnA = session.prompt("client A");
		await withTimeout(startedA.promise, 2_000, "Session admission boundary timed out");
		const normalization = holdImageNormalization();
		const steeringA = session.joinActiveTurn("private input for A", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Session admission boundary timed out");
		finishA.resolve();
		await turnA;
		const turnB = session.prompt("client B");
		await withTimeout(startedB.promise, 2_000, "Session admission boundary timed out");
		normalization.release();
		expect(await steeringA).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
		finishB.resolve();
		await turnB;
		expect(
			session.messages.some(
				message => "content" in message && JSON.stringify(message.content).includes("private input for A"),
			),
		).toBe(false);
	});

	it("reserves deferred startup but rejects a submission aborted before readiness", async () => {
		const { session } = await createSession([]);
		const started = Promise.withResolvers<void>();
		const release = deferredGate();
		session.setDeferredExtensionLoader(async () => {
			started.resolve();
			await release.promise;
		});
		const pending = session.prompt("retained startup input", { throwOnDrop: true });
		const rejected = observe(pending);
		await withTimeout(started.promise, 2_000, "Session admission boundary timed out");
		const steering = session.joinActiveTurn("retained startup steer");
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		release.resolve();
		expect(await rejected).toMatchObject({ error: expect.any(Error) });
		expect(await steering).toBe(false);
		expect(session.messages.filter(message => message.role === "user")).toEqual([]);
		expect(session.getQueuedMessages()).toMatchObject({ steering: [], followUp: [] });
	});

	it.each(["throw", "reject"] as const)(
		"keeps a deferred loader %s failure closed on later submissions",
		async mode => {
			const { session } = await createSession([]);
			session.setDeferredExtensionLoader(() => {
				if (mode === "throw") throw new Error("guard unavailable");
				return Promise.reject(new Error("guard unavailable"));
			});
			await expect(session.prompt("first retained input")).rejects.toThrow();
			await expect(session.prompt("second retained input")).rejects.toThrow();
			expect(session.messages.filter(message => message.role === "user")).toEqual([]);
		},
	);

	it.each(["disposed", "unowned"] as const)("refuses an ask image answer when its request owner is %s", async mode => {
		const { session } = await createSession([], true);
		await initTheme();
		const opened = Promise.withResolvers<void>();
		let current = true;
		const describeImages = vi.fn(async (): Promise<TextContent[]> => []);
		const release = deferredGate();
		const ask = new AskTool({
			settings: session.settings,
			hasUI: false,
			getSessionId: () => session.sessionId,
			getActiveModel: () => session.model,
			isDisposed: () => session.isDisposed,
			captureOwnerCurrent: () => () => current,
			describeAttachedImages: describeImages,
		} as never);
		const pending = ask.execute(
			"ask-image",
			{
				html: '<form><fieldset><legend>Which image?</legend><label><input type="radio" name="image" value="first">first</label></fieldset></form>',
			},
			undefined,
			undefined,
			{
				hasUI: true,
				ui: {
					askDialog: async () => {
						opened.resolve();
						await release.promise;
						return {
							kind: "submit",
							results: [
								{
									id: "image",
									selectedOptions: ["first"],
									note: "See [Image #1]",
									noteImages: [IMAGE],
								},
							],
						};
					},
				},
			} as never,
		);
		const rejected = observe(pending);
		await withTimeout(opened.promise, 2_000, "Session admission boundary timed out");
		if (mode === "disposed") session.beginDispose();
		else current = false;
		release.resolve();
		expect(await rejected).toMatchObject({ error: expect.any(ToolAbortError) });
		expect(describeImages).not.toHaveBeenCalled();
	});

	it("rejects factory-submitted input before deferred guards finish binding", async () => {
		const { session } = await createSession([]);
		session.setDeferredExtensionLoader(async () => {
			await session.prompt("premature factory input");
		});
		await expect(session.loadDeferredExtensions()).rejects.toThrow();
		expect(session.messages.filter(message => message.role === "user")).toEqual([]);
	});

	it("does not borrow another session's deferred-loader admission", async () => {
		const parent = await createSession([]);
		const parentStore = authStorage!;
		const child = await createSession([]);
		try {
			child.session.setDeferredExtensionLoader(async () => {
				throw new Error("child guard unavailable");
			});
			parent.session.setDeferredExtensionLoader(async () => {
				await child.session.prompt("child input");
			});
			await expect(parent.session.loadDeferredExtensions()).rejects.toThrow();
			expect(child.session.messages.filter(message => message.role === "user")).toEqual([]);
		} finally {
			await parent.session.dispose();
			await parentStore.close();
		}
	});

	it("does not retain loader admission in detached work after loader failure", async () => {
		const { session } = await createSession([]);
		const release = deferredGate();
		let lateWork: Promise<boolean> | undefined;
		session.setDeferredExtensionLoader(async () => {
			lateWork = release.promise.then(() => session.prompt("late rejected input"));
			throw new Error("startup guard unavailable");
		});
		await expect(session.loadDeferredExtensions()).rejects.toThrow();
		const rejected = observe(lateWork!);
		release.resolve();
		expect(await rejected).toMatchObject({ error: expect.any(Error) });
		expect(session.messages.filter(message => message.role === "user")).toEqual([]);
	});

	it.each(["denied", "superseded"] as const)(
		"blocks the real vision transport when final admission is %s",
		async mode => {
			const { modelRegistry } = await createSession([]);
			temporary = TempDir.createSync("@vision-admission-");
			const vision = buildModel({
				provider: "vision-fixture",
				id: "vision",
				name: "vision",
				api: "openai-completions",
				baseUrl: "https://vision.invalid/v1",
				reasoning: false,
				input: ["text", "image"],
				contextWindow: 8192,
				maxTokens: 256,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			});
			authStorage!.keys.setRuntime("vision-fixture", "synthetic-key");
			const available = spyOn(modelRegistry as ModelRegistry, "getAvailable").mockReturnValue([vision]);
			restores.push(() => available.mockRestore());
			const settings = Settings.isolated({ modelRoles: { vision: "vision-fixture/vision" } });
			const payloadReady = Promise.withResolvers<void>();
			const releasePayload = deferredGate();
			let current = true;
			const requests: unknown[] = [];
			const describing = imageVisionFallback.describeAttachedImagesForTextModel([IMAGE], {
				activeModel: vision,
				modelRegistry: modelRegistry as ModelRegistry,
				settings,
				localProtocolOptions: { getArtifactsDir: () => temporary!.path() },
				sessionId: "synthetic-vision-owner",
				isCurrent: () => current,
				prepareStreamOptions: () => ({
					onPayload: async () => {
						payloadReady.resolve();
						await releasePayload.promise;
						if (mode === "denied") throw new Error("synthetic credit refusal");
					},
					fetch: async (_input, init) => {
						requests.push(JSON.parse(String(init?.body)));
						return new Response(
							`data: ${JSON.stringify({
								id: "synthetic",
								object: "chat.completion.chunk",
								created: 1,
								model: "vision",
								choices: [{ index: 0, delta: { content: "synthetic description" }, finish_reason: "stop" }],
							})}\n\ndata: [DONE]\n\n`,
							{ headers: { "content-type": "text/event-stream" } },
						);
					},
					maxHttpAttempts: 1,
				}),
			});
			await withTimeout(payloadReady.promise, 2_000, "Session admission boundary timed out");
			if (mode === "superseded") current = false;
			releasePayload.resolve();
			await withTimeout(describing, 2_000, "Session admission boundary timed out");
			expect(requests).toEqual([]);
		},
	);

	it("does not let a dispatch reservation transfer ownership to an already streaming autonomous turn", async () => {
		const wakeStarted = Promise.withResolvers<void>();
		const finishWake = deferredGate();
		const { session } = await createSession([
			async () => {
				wakeStarted.resolve();
				await finishWake.promise;
				return { content: ["autonomous reply"] };
			},
		]);
		const normalization = holdImageNormalization();
		const client = session.prompt("client waiting on images", { images: [IMAGE] });
		const rejected = observe(client);
		await withTimeout(normalization.started, 2_000, "Session admission boundary timed out");
		const wake = session.sendCustomMessage("autonomous wake", { deliverAs: "nextTurn", triggerTurn: true });
		await withTimeout(wakeStarted.promise, 2_000, "Session admission boundary timed out");
		const steering = session.joinActiveTurn("client-only instruction");
		normalization.release();
		expect(await rejected).toMatchObject({ error: expect.any(Error) });
		expect(await steering).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);
		finishWake.resolve();
		await wake;
		expect(
			session.messages.some(
				message => "content" in message && JSON.stringify(message.content).includes("client-only instruction"),
			),
		).toBe(false);
	});

	it("drops an idle prompt instead of dispatching it when abort lands mid-normalization", async () => {
		const streamCalls: string[] = [];
		const { session, dropped } = await createSession([
			() => {
				streamCalls.push("started");
				return { content: ["should not run"] };
			},
		]);
		const normalization = holdImageNormalization();

		let admitted = false;
		const promptPromise = session.prompt("go while normalizing", {
			images: [IMAGE],
			onPromptAdmitted: () => {
				admitted = true;
			},
		});

		await withTimeout(normalization.started, 2_000, "Normalization never started");
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		normalization.release();

		expect(await promptPromise).toBe(true);
		expect(admitted).toBe(false);
		expect(dropped).toEqual(["go while normalizing"]);
		expect(streamCalls).toEqual([]);
	});

	it("drops a streaming prompt instead of queueing it when abort lands mid-normalization", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		let calls = 0;
		const { session, dropped } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
			() => {
				calls++;
				return { content: ["should not run"] };
			},
		]);
		const normalization = holdImageNormalization();

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		let admitted = false;
		const queuedPromise = session.prompt("queue while normalizing", {
			images: [IMAGE],
			streamingBehavior: "followUp",
			onPromptAdmitted: () => {
				admitted = true;
			},
		});
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		releaseTurn.resolve();
		await aborting;
		normalization.release();

		expect(await queuedPromise).toBe(true);
		await running;
		await session.waitForIdle();
		expect(admitted).toBe(false);
		expect(dropped).toEqual(["queue while normalizing"]);
		expect(session.getQueuedMessages()).toEqual({ steering: [], followUp: [], liveSteered: 0 });
		expect(calls).toBe(1);
	});

	it("keeps the next prompt busy when an interrupted setup unwinds late", async () => {
		const { session, modelRegistry } = await createSession([() => ({ content: ["done"] })]);
		const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const release = [deferredGate(), deferredGate()];
		const getApiKey = modelRegistry.getApiKey.bind(modelRegistry);
		let calls = 0;
		const spy = spyOn(modelRegistry, "getApiKey").mockImplementation(async (model, sessionId, options) => {
			const index = calls++;
			if (index < 2) {
				entered[index].resolve();
				await release[index].promise;
			}
			return getApiKey(model, sessionId, options);
		});
		restores.push(() => spy.mockRestore());

		const first = session.prompt("first");
		await withTimeout(entered[0].promise, 2_000, "First prompt did not reach setup");
		await session.abort();

		const second = session.prompt("second");
		await withTimeout(entered[1].promise, 2_000, "Second prompt did not reach setup");
		expect(session.isStreaming).toBe(true);

		release[0].resolve();
		await first;
		expect(session.isStreaming).toBe(true);

		release[1].resolve();
		await second;
		expect(session.isStreaming).toBe(false);
	});

	it("settles a turn begun while abort() was finishing, running a steer queued as it ends", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		const { session } = await createSession([
			async () => {
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["done"] };
			},
			() => ({ content: ["steered"] }),
		]);
		const atAbortEnd = Promise.withResolvers<void>();
		const releaseAbort = deferredGate();
		const onTaskAborted = session.goalRuntime.onTaskAborted.bind(session.goalRuntime);
		session.goalRuntime.onTaskAborted = async (...args) => {
			await onTaskAborted(...args);
			atAbortEnd.resolve();
			await releaseAbort.promise;
		};
		// A steer that lands as the turn ends, after the agent loop's last look at its queue.
		const steered = Promise.withResolvers<void>();
		let agentEnds = 0;
		session.subscribe(event => {
			if (event.type !== "agent_end") return;
			if (++agentEnds === 1) {
				session.agent.steer({ role: "user", content: "tail steer", attribution: "user", timestamp: Date.now() });
			} else {
				steered.resolve();
			}
		});

		const aborting = session.abort();
		await withTimeout(atAbortEnd.promise, 2_000, "abort() never reached its last await");
		const running = session.prompt("go");
		await withTimeout(turnStarted.promise, 2_000, "The prompt's turn never started");
		releaseAbort.resolve();
		await aborting;
		releaseTurn.resolve();
		await running;

		await withTimeout(steered.promise, 2_000, "The steer queued as the turn ended never ran");
		expect({ agentEnds, queued: session.agent.hasQueuedMessages() }).toEqual({ agentEnds: 2, queued: false });
	});

	it("cancels an in-flight vision description on abort and drops the prompt", async () => {
		const streamCalls: string[] = [];
		const { session, dropped } = await createSession(
			[
				() => {
					streamCalls.push("started");
					return { content: ["should not run"] };
				},
			],
			true,
		);
		const describeStarted = Promise.withResolvers<AbortSignal | undefined>();
		const spy = spyOn(imageVisionFallback, "describeAttachedImagesForTextModel").mockImplementation(
			async (_images, _deps, signal) => {
				describeStarted.resolve(signal);
				// Stands in for a provider that never answers: only the signal ends it.
				const { promise, resolve } = deferredGate();
				signal?.addEventListener("abort", () => resolve(), { once: true });
				await promise;
				return [];
			},
		);
		restores.push(() => spy.mockRestore());

		const promptPromise = session.prompt("describe this", { images: [IMAGE] });
		const signal = await withTimeout(describeStarted.promise, 2_000, "Vision description never started");
		expect(signal?.aborted).toBe(false);
		await session.abort({ reason: USER_INTERRUPT_LABEL });

		expect(signal?.aborted).toBe(true);
		expect(await withTimeout(promptPromise, 2_000, "Abort did not release the vision description")).toBe(true);
		expect(dropped).toEqual(["describe this"]);
		expect(streamCalls).toEqual([]);
	});

	it("joinActiveTurn refuses a steer that races abort instead of stranding it behind the cancel", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		// Live run: the steer joins it and stays queued for the boundary poll.
		expect(await session.joinActiveTurn("steer the live run")).toBe(true);

		// A steer racing the abort window must classify as not-admitted:
		// `#abortInProgress` is set synchronously at abort() entry, and a
		// message admitted behind it would ride the post-abort stranded
		// drain — a continuation the cancelled turn no longer owns or
		// forwards. The caller keeps its content instead.
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		expect(await session.joinActiveTurn("steer during abort")).toBe(false);
		releaseTurn.resolve();
		await aborting;
		await running;
		await session.waitForIdle();

		// The refused steer never reached any queue, so nothing from this
		// admission can ride the post-abort drain: the user interrupt
		// withdraws the earlier queued steer (documented interrupt
		// semantics), and no second model call happens.
		const queued = session.getQueuedMessages();
		expect(queued.steering).toEqual([]);
		expect(queued.followUp).toEqual([]);
		expect(calls).toBe(1);
	});

	it("joinActiveTurn refuses an image steer whose normalization outlives the start of abort", async () => {
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");

		// The steer is admitted (turn live) but its image normalization is
		// held; abort() starts while it is still being preprocessed. The
		// post-await admission recheck must refuse via `#abortInProgress` —
		// `isStreaming` alone would still read true until cleanup drains —
		// so the message never reaches the queue the abort will drain.
		const normalization = holdImageNormalization();
		const admitting = session.joinActiveTurn("steer with an image", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const aborting = session.abort({ reason: USER_INTERRUPT_LABEL });
		normalization.release();
		expect(await admitting).toBe(false);

		releaseTurn.resolve();
		await aborting;
		await running;
		await session.waitForIdle();
		const queued = session.getQueuedMessages();
		expect(queued.steering).toEqual([]);
		expect(queued.followUp).toEqual([]);
		expect(calls).toBe(1);
	});

	it("joinActiveTurn parks during a prompt's pre-dispatch window and injects into that turn", async () => {
		const normalization = holdImageNormalization();
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		let calls = 0;
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["first turn"] };
			},
		]);

		// A prompt is admitted but still dispatching (normalization held,
		// `#beginInFlight` not yet reached): the client claim is already
		// reserved, so the steer parks until the owning run goes live — the
		// host never needs to resubmit (whose session/prompt would implicitly
		// cancel the still-dispatching prompt), and the admission injects
		// into the run the steer targeted.
		const dispatching = session.prompt("start", { images: [IMAGE] });
		await withTimeout(normalization.started, 2_000, "Normalization never started");
		const steer = session.joinActiveTurn("steer during dispatch");
		const early = await Promise.race([steer.then(() => "settled"), Bun.sleep(50).then(() => "parked")]);
		expect(early).toBe("parked");

		normalization.release();
		await withTimeout(turnStarted.promise, 2_000, "Held turn never started");
		releaseTurn.resolve();
		expect(await steer).toBe(true);
		await dispatching;
		await session.waitForIdle();
		expect(calls).toBe(1);
		// The admission really enqueued onto the live run: the steer text
		// sits on the steering queue (the turn's single response ended it
		// before the next boundary could deliver).
		// The admission really injected into the owning run: the steer text
		// lands in the run's message history after its first response.
		const messages = session.agent.state.messages;
		const firstResponseIndex = messages.findIndex(
			message => message.role === "assistant" && JSON.stringify(message.content).includes("first turn"),
		);
		const steerIndex = messages.findIndex(
			message => message.role === "user" && JSON.stringify(message.content).includes("steer during dispatch"),
		);
		expect(steerIndex).toBeGreaterThan(firstResponseIndex);
	});

	it("refuses a steer whose owning turn settled while the steer's preprocessing ran", async () => {
		const normalization = holdImageNormalization();
		let calls = 0;
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		const wakeStarted = Promise.withResolvers<void>();
		const releaseWake = deferredGate();
		const { session } = await createSession([
			async () => {
				calls++;
				turnStarted.resolve();
				await releaseTurn.promise;
				return { content: ["turn a"] };
			},
			async () => {
				calls++;
				wakeStarted.resolve();
				await releaseWake.promise;
				return { content: ["wake turn"] };
			},
		]);

		// Client turn A goes live.
		const turnA = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "Turn A never started");

		// An image-bearing steer begins admission while A is live; its image
		// normalization is held, so the post-preprocessing admission check
		// runs only after the release below.
		const steer = session.joinActiveTurn("steer with an image", [IMAGE]);
		await withTimeout(normalization.started, 2_000, "Steer normalization never started");

		// Turn A settles while the steer is mid-preprocessing, and an
		// agent-initiated turn takes the agent: streaming, but not
		// client-owned.
		releaseTurn.resolve();
		await turnA;
		const wake = session.sendCustomMessage("wake up", { deliverAs: "nextTurn", triggerTurn: true });
		await withTimeout(wakeStarted.promise, 2_000, "Wake turn never started");

		// The admission must recheck client ownership after preprocessing:
		// general `isStreaming` is true (the wake) but no client prompt owns
		// it, so the steer is refused and its content stays with the caller
		// instead of injecting into a run with no client forwarder.
		normalization.release();
		expect(await steer).toBe(false);
		expect(session.getQueuedMessages().steering).toEqual([]);

		releaseWake.resolve();
		await wake;
		await session.waitForIdle();
		expect(calls).toBe(2);
	});

	it("refuses a steer whose owning prompt fails in setup, under an ACP client", async () => {
		let calls = 0;
		let apiKeyCalls = 0;
		const apiKeyGate = deferredGate();
		const secondKeyRequested = Promise.withResolvers<void>();
		// First call validates turn one; the second gates turn two's fallible
		// setup and then fails it — the exact window a steer can arrive in
		// (#promptInFlightCount > 0 with no agent loop owning it yet).
		const modelRegistry = {
			getApiKey: async () => {
				apiKeyCalls++;
				if (apiKeyCalls === 1) return "test-key";
				secondKeyRequested.resolve();
				await apiKeyGate.promise;
				return undefined;
			},
		};
		const { session } = await createSession(
			[
				() => {
					calls++;
					return { content: ["first turn"] };
				},
				() => {
					calls++;
					return { content: ["should not stream"] };
				},
			],
			false,
			// deferAgentInitiatedTurns marks the session as ACP-owned: no
			// continuation may run without a client-owned prompt.
			{ modelRegistry, clientBridge: { capabilities: {}, deferAgentInitiatedTurns: true } },
		);

		await session.prompt("turn one");
		expect(calls).toBe(1);

		const failing = session.prompt("turn two");
		void failing.catch(() => undefined);
		await withTimeout(secondKeyRequested.promise, 2_000, "Second prompt never reached key validation");

		// The steer parks on the dispatching prompt; the setup failure wakes
		// it with the run never gone live, so admission is refused and the
		// caller keeps its content (the ACP bridge answers `promptRequired`
		// and the host resubmits through session/prompt).
		const admitted = session.joinActiveTurn("steer the failing turn");
		apiKeyGate.resolve();
		await expect(failing).rejects.toThrow("No API key found");
		expect(await admitted).toBe(false);
		await session.waitForIdle();

		// Nothing ran as an ownerless continuation and nothing was stranded
		// in the queue either: the refusal kept the content with its caller.
		expect(calls).toBe(1);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("refuses the same setup-window steer without an ACP client too", async () => {
		let calls = 0;
		let apiKeyCalls = 0;
		const apiKeyGate = deferredGate();
		const secondKeyRequested = Promise.withResolvers<void>();
		const modelRegistry = {
			getApiKey: async () => {
				apiKeyCalls++;
				if (apiKeyCalls === 1) return "test-key";
				secondKeyRequested.resolve();
				await apiKeyGate.promise;
				return undefined;
			},
		};
		const { session } = await createSession(
			[
				() => {
					calls++;
					return { content: ["first turn"] };
				},
				() => {
					calls++;
					return { content: ["drained steer turn"] };
				},
			],
			false,
			{ modelRegistry },
		);

		await session.prompt("turn one");
		const failing = session.prompt("turn two");
		void failing.catch(() => undefined);
		await withTimeout(secondKeyRequested.promise, 2_000, "Second prompt never reached key validation");

		// The park-until-live contract is client-independent: without a
		// bridge the setup-failing window refuses the steer exactly the
		// same way (the TUI keeps the typed content for the next turn).
		const admitted = session.joinActiveTurn("steer the failing turn");
		apiKeyGate.resolve();
		await expect(failing).rejects.toThrow("No API key found");
		expect(await admitted).toBe(false);
		await session.waitForIdle();

		// Nothing ran and nothing drained: the refusal kept the content.
		expect(calls).toBe(1);
		expect(session.getQueuedMessages().steering).toEqual([]);
	});

	it("joinActiveTurn hands idle slash commands back instead of failing, and still refuses them mid-run", async () => {
		let calls = 0;
		const turnStarted = Promise.withResolvers<void>();
		const releaseTurn = deferredGate();
		const { session } = await createSession(
			[
				async () => {
					calls++;
					turnStarted.resolve();
					await releaseTurn.promise;
					return { content: ["first turn"] };
				},
			],
			false,
			{
				extensionRunner: {
					getCommand: (name: string) => (name === "queued-cmd" ? { name: "queued-cmd" } : undefined),
					emitBeforeAgentStart: async () => undefined,
				},
			},
		);

		// Idle: the command must come back unconsumed (`promptRequired` at
		// the bridge) so the host can resubmit through session/prompt — the
		// only path that can execute it — instead of a `failed` outcome.
		expect(await session.joinActiveTurn("/queued-cmd now")).toBe(false);

		// Mid-run the same command genuinely cannot be queued: refuse it.
		const running = session.prompt("start");
		await withTimeout(turnStarted.promise, 2_000, "First turn never started");
		await expect(session.joinActiveTurn("/queued-cmd now")).rejects.toThrow("cannot be queued");
		releaseTurn.resolve();
		await running;
		await session.waitForIdle();
		expect(calls).toBe(1);
	});
});
