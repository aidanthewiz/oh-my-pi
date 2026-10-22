import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { NativeJudge } from "@oh-my-pi/pi-ai/judgment";
import { buildGatewayApiKeyResolver } from "@oh-my-pi/pi-ai/auth-gateway/dispatch";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const REQUEST = {
	state: "Help! My payouts have been failing for 3 days.",
	questions: { urgent: { type: "noul", instructions: { question: "Does this convey urgency?", scope: "billing" } } },
};

const UPSTREAM_ANSWER = {
	model: "jev-1.13.0",
	answers: { urgent: { type: "noul", noul: 0.92 } },
	usage: { input_tokens: 300, output_tokens: 20 },
};

interface Harness {
	url: string;
	upstream: { url: string; init: RequestInit | undefined }[];
	storage: AuthStorage;
	close: () => Promise<void>;
}

async function boot(respond: (init: RequestInit | undefined) => Response): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-systemone-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.keys.setRuntime("typesafe", "ts-secret");
	const jev = getBundledModel("typesafe", "jev-latest");
	if (!jev) throw new Error("expected bundled typesafe/jev-latest");
	const chat = createMockModel({ provider: "openrouter", id: "chat-only" });
	// Self-hosted OpenJEV: the catalog caps its `questions` map at 16.
	const openjev = buildModel({
		id: "openjev-4b",
		name: "openjev-4b",
		api: "typesafe",
		provider: "typesafe",
		baseUrl: "http://localhost:8000",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 0,
	});
	const upstream: Harness["upstream"] = [];
	const fetchStub: FetchImpl = async (input, init) => {
		upstream.push({ url: String(input), init });
		return respond(init);
	};
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["gw-token"],
		storage,
		resolveModel: id =>
			id === "jev-latest" || id === "typesafe/jev-latest"
				? jev
				: id === "chat-only"
					? chat
					: id === "openjev-4b"
						? openjev
						: undefined,
		version: "test",
		fetch: fetchStub,
	});
	return {
		url: handle.url,
		upstream,
		storage,
		close: async () => {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

function post(url: string, pathname: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${url}${pathname}`, {
		method: "POST",
		headers: { Authorization: "Bearer gw-token", "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

describe("auth-gateway POST /v1/systemone", () => {
	let harness: Harness | undefined;
	afterEach(async () => {
		await harness?.close();
		harness = undefined;
	});

	it("forwards the judgment with the broker credential and re-encodes TypeSafe's answer", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));

		const response = await post(
			harness.url,
			"/v1/systemone",
			{ model: "typesafe/jev-latest", ...REQUEST },
			{
				"x-omp-app": "robomp",
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			model: "jev-1.13.0",
			answers: { urgent: { type: "noul", noul: 0.92 } },
			usage: { input_tokens: 300, output_tokens: 20 },
		});
		// Client never saw the real key; upstream got it, at the model's base URL,
		// with structured instructions forwarded verbatim and the catalog id.
		expect(harness.upstream).toHaveLength(1);
		expect(harness.upstream[0].url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(new Headers(harness.upstream[0].init?.headers).get("authorization")).toBe("Bearer ts-secret");
		expect(JSON.parse(String(harness.upstream[0].init?.body))).toEqual({ ...REQUEST, model: "jev-latest" });
		const cost = Number(response.headers.get("x-litellm-response-cost"));
		expect(cost).toBeGreaterThan(0);
	});

	it("serves the OpenRouter Decisions path with the same handler", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const response = await post(harness.url, "/alpha/decisions", { model: "jev-latest", ...REQUEST });
		expect(response.status).toBe(200);
		expect(harness.upstream).toHaveLength(1);
	});

	it("rejects malformed bodies with 422 before touching upstream", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const missingModel = await post(harness.url, "/v1/systemone", REQUEST);
		expect(missingModel.status).toBe(422);
		const badQuestion = await post(harness.url, "/v1/systemone", {
			model: "jev-latest",
			state: "x",
			questions: { q: { type: "essay", instructions: "write" } },
		});
		expect(badQuestion.status).toBe(422);
		expect(harness.upstream).toHaveLength(0);
	});

	it("refuses models that do not answer judgments and chat routes refuse judge models", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const chatModel = await post(harness.url, "/v1/systemone", { model: "chat-only", ...REQUEST });
		expect(chatModel.status).toBe(422);
		const unknown = await post(harness.url, "/v1/systemone", { model: "nope", ...REQUEST });
		expect(unknown.status).toBe(404);
		const judgeOnChat = await post(harness.url, "/v1/chat/completions", {
			model: "jev-latest",
			messages: [{ role: "user", content: "hi" }],
		});
		expect(judgeOnChat.status).toBe(400);
		expect(await judgeOnChat.json()).toMatchObject({ error: { message: expect.stringContaining("/v1/systemone") } });
		expect(harness.upstream).toHaveLength(0);
	});

	it("splits judgments above the routed model's catalog question cap", async () => {
		harness = await boot(init => {
			const ids = Object.keys(JSON.parse(String(init?.body)).questions);
			if (ids.length > 16) return new Response("too many questions", { status: 422 });
			return Response.json({
				model: "openjev-4b",
				answers: Object.fromEntries(ids.map(id => [id, { type: "noul", noul: 0.5 }])),
				usage: { input_tokens: 10, output_tokens: 1 },
			});
		});
		const questions = Object.fromEntries(
			Array.from({ length: 20 }, (_, i) => [`q${i}`, { type: "noul", instructions: `Question ${i}?` }]),
		);
		const response = await post(harness.url, "/v1/systemone", { model: "openjev-4b", state: "s", questions });
		expect(response.status).toBe(200);
		const body = (await response.json()) as { answers: Record<string, unknown> };
		expect(Object.keys(body.answers).sort()).toEqual(Object.keys(questions).sort());
		const sizes = harness.upstream.map(call => Object.keys(JSON.parse(String(call.init?.body)).questions).length);
		expect(sizes.sort((a, b) => b - a)).toEqual([16, 4]);
	});

	it("keeps a rotated sibling credential when a delayed chunk rejects its original key", async () => {
		harness = await boot(() => Response.json(UPSTREAM_ANSWER));
		const storage = harness.storage;
		storage.keys.removeRuntime("typesafe");
		await storage.credentials.set("typesafe", [
			{ type: "api_key", key: "synthetic-a" },
			{ type: "api_key", key: "synthetic-b" },
		]);
		const model = getBundledModel("typesafe", "jev-latest");
		if (!model) throw new Error("expected bundled typesafe/jev-latest");
		const initial = await storage.keys.getWithCredential("typesafe", "rotation-session");
		if (!initial) throw new Error("expected synthetic credential");
		const rotated = Promise.withResolvers<void>();
		const sent: string[] = [];
		const resolver = buildGatewayApiKeyResolver(
			storage,
			model,
			"rotation-session",
			initial,
			new AbortController().signal,
			"systemone",
			"synthetic",
		);
		const judge = new NativeJudge({
			maxQuestions: 1,
			apiKey: resolver,
			fetch: async (_url, init) => {
				const key = new Headers(init?.headers).get("authorization")!;
				const questions = JSON.parse(String(init?.body)).questions;
				sent.push(key);
				if (key === `Bearer ${initial.apiKey}`) {
					if ("late" in questions) {
						const signal = init?.signal;
						if (!signal) throw new Error("Expected the native request abort signal");
						await new Promise<void>((resolve, reject) => {
							const abort = () => {
								signal.removeEventListener("abort", abort);
								reject(signal.reason);
							};
							if (signal.aborted) return abort();
							signal.addEventListener("abort", abort, { once: true });
							void rotated.promise.then(() => {
								signal.removeEventListener("abort", abort);
								resolve();
							});
						});
					}
					return new Response("forbidden", { status: 403 });
				}
				rotated.resolve();
				return Response.json({
					answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: "noul", noul: 0.7 }])),
					usage: { input_tokens: 3 },
				});
			},
		});
		const result = await judge.judge({
			state: "synthetic",
			questions: {
				first: { type: "noul", instructions: "First?" },
				late: { type: "noul", instructions: "Late?" },
			},
		});
		expect(result.answers).toEqual({ first: { type: "noul", noul: 0.7 }, late: { type: "noul", noul: 0.7 } });
		expect(result.usage.input).toBe(6);
		const current = await storage.keys.getWithCredential("typesafe", "rotation-session");
		expect(current?.apiKey).not.toBe(initial.apiKey);
		expect(sent.filter(key => key !== `Bearer ${initial.apiKey}`)).toHaveLength(2);
	});

	it("maps upstream failures onto TypeSafe's status codes", async () => {
		harness = await boot(() => new Response(JSON.stringify({ error: "overloaded" }), { status: 529 }));
		const response = await post(harness.url, "/v1/systemone", { model: "jev-latest", ...REQUEST });
		expect(response.status).toBe(529);
		// 529 is transient: the client retried before giving up.
		expect(harness.upstream.length).toBeGreaterThan(1);
	});
});
