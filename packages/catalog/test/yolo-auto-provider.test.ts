import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createModelManager } from "@oh-my-pi/pi-catalog/model-manager";
import * as modelsModule from "@oh-my-pi/pi-catalog/models";
import { yoloAutoModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/**
 * Fixture mirrors the live `https://yolo-auto.com/v1/models` surface: an
 * OpenAI-style `data` array of public model ids.
 */
function yoloAutoModelsFetch(): { calls: string[]; authorizations: (string | null)[]; fetch: FetchImpl } {
	const calls: string[] = [];
	const authorizations: (string | null)[] = [];
	const fetch: FetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(String(input));
		authorizations.push(new Headers(init?.headers).get("authorization"));
		return new Response(
			JSON.stringify({
				data: [{ id: "qwen3.8-27b", object: "model", created: 0, owned_by: "yolo-auto" }],
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { calls, authorizations, fetch };
}

describe("Yolo-Auto provider discovery", () => {
	test("discovers /v1/models with the bundled reference's reasoning, vision, and compat", async () => {
		const { calls, authorizations, fetch } = yoloAutoModelsFetch();
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();

		expect(calls).toEqual(["https://yolo-auto.com/v1/models"]);
		expect(authorizations).toEqual(["Bearer yolo-test-key"]);

		const qwen = models?.find(model => model.id === "qwen3.8-27b");
		expect(qwen).toMatchObject({
			provider: "yolo-auto",
			api: "openai-completions",
			baseUrl: "https://yolo-auto.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		// The documented wire surface flows from the bundled reference into
		// discovered models: Qwen chat-template thinking, effort steering, and
		// no developer role / store param.
		expect(qwen?.compat).toMatchObject({
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
			thinkingFormat: "qwen-chat-template",
		});
	});

	test("inherits reasoning and context for models other providers already bundle", async () => {
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "qwen3.8-27b", object: "model" },
						{ id: "deepseek-v4-pro", object: "model" },
					],
				}),
				{ status: 200 },
			);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		const flash = models?.find(model => model.id === "deepseek-v4-pro");

		expect(flash).toMatchObject({
			provider: "yolo-auto",
			baseUrl: "https://yolo-auto.com/v1",
			reasoning: true,
			contextWindow: 1048576,
		});
		expect(flash?.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("overlays flat-rate cost and no-store surface on foreign references", async () => {
		// gpt-4o has no yolo-auto bundled reference, so the global index
		// supplies OpenAI's token pricing and store-capable surface. The
		// provider-wide constraints must win: Yolo is flat-rate and its
		// documented surface rejects the `store` param.
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "qwen3.8-27b", object: "model" },
						{ id: "gpt-4o", object: "model" },
					],
				}),
				{ status: 200 },
			);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		const gpt4o = models?.find(model => model.id === "gpt-4o");

		expect(gpt4o).toMatchObject({
			provider: "yolo-auto",
			api: "openai-completions",
			baseUrl: "https://yolo-auto.com/v1",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});

	test("returns null when /v1/models rejects the key", async () => {
		const fetch: FetchImpl = async () => new Response("Unauthorized", { status: 401 });
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-bogus", fetch }).fetchDynamicModels?.();
		expect(models).toBeNull();
	});

	test("serves no dynamic models without an API key", () => {
		expect(yoloAutoModelManagerOptions().fetchDynamicModels).toBeUndefined();
	});

	test("prunes the bundled id when a live catalog omits it", async () => {
		// Regression: a provider-side retirement of a bundled id must not leave
		// the bundled seed selectable. With the authoritative option the
		// production manager replaces the static rows with the wire catalog.
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: "live-only", object: "model" }] }), { status: 200 });
		const manager = createModelManager(yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }));
		const { models } = await manager.refresh("online");

		expect(models.map(model => model.id)).toEqual(["live-only"]);
		// Even a reference-less wire id keeps the provider-wide flat-rate cost
		// and no-store surface — the generic compat defaults would otherwise
		// resolve `supportsStore: true` and the endpoint rejects the field.
		expect(models[0]).toMatchObject({
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: { supportsStore: false, supportsDeveloperRole: false },
		});
	});

	test("prefers curated metadata over a stale previous bundle", async () => {
		// A credentialed `gen:models` run bakes live discovery into
		// models.json; that previous bundle row must not shadow later
		// corrections to the yolo-auto seed. Simulate a stale bundle row
		// (1M context, no template dialect) and require the curated surface.
		const originalGetBundledModels = modelsModule.getBundledModels;
		vi.spyOn(modelsModule, "getBundledModels").mockImplementation((provider => {
			if (provider === "yolo-auto") {
				return [
					buildModel({
						id: "qwen3.8-27b",
						name: "Qwen3.8-27B (stale bundle)",
						api: "openai-completions",
						provider: "yolo-auto",
						baseUrl: "https://yolo-auto.com/v1",
						reasoning: true,
						input: ["text", "image"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 1_000_000,
						maxTokens: null,
					}),
				];
			}
			return originalGetBundledModels(provider);
		}) as typeof modelsModule.getBundledModels);
		try {
			const fetch: FetchImpl = async () =>
				new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b", object: "model" }] }), { status: 200 });
			const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
			const qwen = models?.find(model => model.id === "qwen3.8-27b");

			expect(qwen).toMatchObject({
				contextWindow: 262144,
				compat: { thinkingFormat: "qwen-chat-template" },
			});
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("discovers qwen3.8-27b and yolo at the documented 256K deployment cap", async () => {
		// The flat-rate /v1/models response carries bare ids with no limit
		// fields. Without provider-local seeds the bare qwen3.8-27b slug
		// resolves through the global reference index, which prefers the
		// largest bundled window (1M) and misreports the deployment cap.
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b" }, { id: "yolo" }] }), { status: 200 });
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();

		for (const id of ["qwen3.8-27b", "yolo"]) {
			const spec = models?.find(candidate => candidate.id === id);
			if (!spec) throw new Error(`yolo-auto/${id} missing from discovery`);
			const model = buildModel(spec);
			expect(model).toMatchObject({
				provider: "yolo-auto",
				contextWindow: 262144,
				maxTokens: 131072,
				identity: { class: "qwen", revision: "3.8.0" },
				compat: {
					supportsReasoningEffort: true,
					thinkingFormat: "qwen-chat-template",
					supportsStore: false,
					supportsDeveloperRole: false,
				},
			});
			// The opaque `yolo` alias must carry the same tokenizer as the
			// explicit Qwen3.8-27B row or context accounting falls back to estimates.
			expect(model.tokenizer).toBe("qwen3");
		}
	});

	test("takes each model's effort ladder from the live `thinking` field", async () => {
		// Live /v1/models advertises minimal..xhigh for the Qwen3.8 rows; the
		// seed ladder previously stopped at high, hiding xhigh from the picker.
		const ladder = ["minimal", "low", "medium", "high", "xhigh"];
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					object: "list",
					data: [
						{ id: "yolo", context_length: 262144, thinking: ladder },
						{ id: "qwen3.8-27b", context_length: 262144, thinking: [...ladder, "turbo"] },
						{ id: "yolo-small", context_length: 262144 },
						{ id: "yolo-128k", context_length: 131072 },
					],
				}),
				{ status: 200 },
			);
		const models = await yoloAutoModelManagerOptions({ apiKey: "yolo-test-key", fetch }).fetchDynamicModels?.();
		const built = (id: string) => {
			const spec = models?.find(candidate => candidate.id === id);
			if (!spec) throw new Error(`yolo-auto/${id} missing from discovery`);
			return buildModel(spec);
		};

		const expected = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];
		for (const id of ["yolo", "qwen3.8-27b"]) {
			const model = built(id);
			expect(model.reasoning).toBe(true);
			// Unknown wire values ("turbo") are dropped, not surfaced as levels.
			expect(model.thinking?.efforts).toEqual(expected);
		}
		for (const [id, contextWindow] of [
			["yolo-small", 262144],
			["yolo-128k", 131072],
		] as const) {
			const small = built(id);
			expect(small.reasoning).toBe(false);
			expect(small.thinking).toBeUndefined();
			expect(small.input).toEqual(["text"]);
			expect(small.contextWindow).toBe(contextWindow);
		}
	});

	test("distinguishes offline and rejected discovery from authoritative retirement of old seeds", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yolo-catalog-transition-"));
		try {
			let status = 401;
			let roster: string[] = [];
			const requests: Array<{ url: string; authorization: string | null }> = [];
			const fetch: FetchImpl = async (input, init) => {
				requests.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
				return new Response(
					JSON.stringify(status === 200 ? { data: roster.map(id => ({ id })) } : { error: "Unauthorized" }),
					{
						status,
					},
				);
			};
			const manager = createModelManager({
				...yoloAutoModelManagerOptions({
					apiKey: "synthetic-current-owner-key",
					baseUrl: "https://deployment.example/v1",
					fetch,
				}),
				cacheDbPath: path.join(tempDir, "models.db"),
				staticModels: ["deepseek-flash-v4", "qwen3.8-flash"].map(id =>
					buildModel({
						id,
						name: id,
						provider: "yolo-auto",
						api: "openai-completions",
						baseUrl: "https://deployment.example/v1",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 8192,
					}),
				),
			});
			const offline = await manager.refresh("offline");
			expect(offline.models.map(model => model.id).sort()).toEqual(["deepseek-flash-v4", "qwen3.8-flash"]);
			expect(requests).toEqual([]);
			const rejected = await manager.refresh("online");
			expect(rejected.models.map(model => model.id).sort()).toEqual(["deepseek-flash-v4", "qwen3.8-flash"]);
			status = 200;
			roster = ["qwen3.8-27b"];
			const current = await manager.refresh("online");
			expect(current.models.map(model => model.id)).toEqual(["qwen3.8-27b"]);
			expect(current.models[0]).toMatchObject({
				provider: "yolo-auto",
				api: "openai-completions",
				baseUrl: "https://deployment.example/v1",
				contextWindow: 262144,
				maxTokens: 131072,
			});
			roster = [];
			expect((await manager.refresh("online")).models).toEqual([]);
			expect(requests).toEqual(
				Array.from({ length: 3 }, () => ({
					url: "https://deployment.example/v1/models",
					authorization: `Bearer ${"synthetic-current-owner-key"}`,
				})),
			);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});
