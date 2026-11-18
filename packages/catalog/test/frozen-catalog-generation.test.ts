import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import * as authDiscovery from "@oh-my-pi/pi-ai/auth-broker/discover";
import { TempDir } from "@oh-my-pi/pi-utils";
import { generateModels } from "../scripts/generate-models";
import { buildModel } from "../src/build";
import {
	encodeModelCatalog,
	getCatalogProvider,
	getCatalogProviders,
	openModelCatalog,
} from "../src/model-catalog-format";
import type { Model, ModelSpec } from "../src/types";

function frozenModel(provider: string, id: string, overrides: Partial<ModelSpec> = {}): Model {
	return buildModel({
		id,
		name: id,
		provider,
		api: "openai-responses",
		baseUrl: "https://frozen.example/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 9, output: 11, cacheRead: 1, cacheWrite: 2 },
		contextWindow: 8192,
		maxTokens: 1024,
		...overrides,
	});
}

describe("frozen catalog generation", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-frozen-catalog-");
		const denyNetwork = (): never => {
			throw new Error("Frozen generation must not use the network");
		};
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(async () => denyNetwork(), { preconnect: denyNetwork }),
		);
		vi.spyOn(authDiscovery, "discoverAuthStorage").mockImplementation(async () => {
			throw new Error("Frozen generation must not open credential storage");
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await tempDir.remove();
	});

	test("preserves frozen metadata and seed precedence without discovering accounts or providers", async () => {
		const inputPath = path.join(tempDir.path(), "input.json");
		const outputPath = path.join(tempDir.path(), "output.json");
		const awsSourceIds = [
			"claude-fable-5",
			"claude-haiku-4-5",
			"claude-opus-4-5",
			"claude-opus-4-6",
			"claude-opus-4-7",
			"claude-opus-4-8",
			"claude-sonnet-4-5",
			"claude-sonnet-4-6",
			"claude-sonnet-5",
		];
		const input = {
			anthropic: Object.fromEntries(
				awsSourceIds.map(id => [id, frozenModel("anthropic", id, { api: "anthropic-messages" })]),
			),
			meta: {
				"muse-spark-1.1": frozenModel("meta", "muse-spark-1.1", {
					cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 },
				}),
			},
			"frozen-fixture": { "snapshot-only": frozenModel("frozen-fixture", "snapshot-only") },
			devin: { "swe-1-6-fast": frozenModel("devin", "swe-1-6-fast") },
			ollama: { "private-host": frozenModel("ollama", "private-host") },
			modal: { "private-deployment": frozenModel("modal", "private-deployment") },
			bifrost: { "private-upstream": frozenModel("bifrost", "private-upstream") },
			local: { kokoro: frozenModel("local", "kokoro", { api: "local-inference", baseUrl: "local://inference" }) },
		};
		await Bun.write(inputPath, encodeModelCatalog(input));

		await generateModels({ frozenInput: inputPath, outputPath });

		const output = openModelCatalog(await Bun.file(outputPath).json());
		expect(getCatalogProvider(output, "frozen-fixture")?.["snapshot-only"]).toMatchObject({
			baseUrl: "https://frozen.example/v1",
			cost: { input: 9, output: 11, cacheRead: 1, cacheWrite: 2 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		expect(getCatalogProvider(output, "anthropic")?.["claude-opus-4-8"].cost.input).toBe(9);
		expect(getCatalogProvider(output, "meta")?.["muse-spark-1.1"]).toMatchObject({
			cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1_048_576,
		});
		const aws = getCatalogProvider(output, "anthropic-aws");
		expect(Object.keys(aws ?? {}).sort()).toEqual([...awsSourceIds, "claude-opus-5"].sort());
		expect(aws?.["claude-opus-5"]).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://aws-external-anthropic.us-east-1.api.aws",
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 1_000_000,
			maxTokens: 128_000,
		});
		expect(getCatalogProvider(output, "openai-codex")?.["gpt-image-2"].kind).toBe("image");
		expect(getCatalogProvider(output, "openai")?.["gpt-6-luna-decisions"]).toMatchObject({
			api: "openai-decisions",
			kind: "judge",
			requestModelId: "gpt-6-luna",
		});
		expect(getCatalogProvider(output, "local")?.["phonon-31m"]).toMatchObject({
			api: "local-inference",
			kind: "tts",
		});
		expect(getCatalogProvider(output, "local")?.kokoro).toBeUndefined();
		expect(getCatalogProvider(output, "devin")?.["swe-1-6-fast"]).toBeUndefined();
		expect(getCatalogProviders(output)).not.toContain("ollama");
		expect(getCatalogProviders(output)).not.toContain("modal");
		expect(getCatalogProviders(output)).not.toContain("bifrost");
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(authDiscovery.discoverAuthStorage).not.toHaveBeenCalled();
	});

	test.each(["missing", "malformed"])(
		"does not replace output or fall back to discovery for a %s input",
		async kind => {
			const inputPath = path.join(tempDir.path(), "input.json");
			const outputPath = path.join(tempDir.path(), "output.json");
			if (kind === "malformed") await Bun.write(inputPath, "{ invalid JSON");
			await Bun.write(outputPath, "existing frozen output");

			await expect(generateModels({ frozenInput: inputPath, outputPath })).rejects.toThrow();

			expect(await Bun.file(outputPath).text()).toBe("existing frozen output");
			expect(globalThis.fetch).not.toHaveBeenCalled();
			expect(authDiscovery.discoverAuthStorage).not.toHaveBeenCalled();
		},
	);
});
