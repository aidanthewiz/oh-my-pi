import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Org-managed models overlay (`models.managed.yml`) — mirrors the Settings
 * `config.managed.yml` layer for model metadata. Verifies the overlay is
 * deep-merged ABOVE the user `models.yml` (managed wins), never clobbers the
 * user file, and tolerates a malformed overlay without bricking model loading.
 */
describe("ModelRegistry managed models overlay", () => {
	let tempDir: TempDir;
	let modelsPath: string;
	let managedPath: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@model-registry-managed-");
		modelsPath = path.join(tempDir.path(), "models.yml");
		managedPath = path.join(tempDir.path(), "models.managed.yml");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		authStorage.close();
		await tempDir.remove().catch(() => {});
	});

	function registry(): ModelRegistry {
		return new ModelRegistry(authStorage, modelsPath);
	}

	test("managed overlay pins contextPromotionTarget with no user models.yml", () => {
		// The coreforge profile ships ONLY the managed overlay (no user file).
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		const model = registry().find("openai-codex", "gpt-5.6-sol");
		expect(model).toBeDefined();
		expect(model?.contextPromotionTarget).toBe("anthropic-aws/claude-fable-5");
	});

	test("managed override wins over the user models.yml on conflict", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: openai-codex/gpt-5.6-terra",
			].join("\n"),
		);
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		expect(registry().find("openai-codex", "gpt-5.6-sol")?.contextPromotionTarget).toBe(
			"anthropic-aws/claude-fable-5",
		);
	});

	test("managed overlay merges by field, preserving the user's sibling overrides", () => {
		// User pins a name; managed pins a promotion target on the SAME model.
		// A field-level merge must keep both, not drop the user's name.
		fs.writeFileSync(
			modelsPath,
			["providers:", "  openai-codex:", "    modelOverrides:", "      gpt-5.6-sol:", "        name: My Sol"].join(
				"\n",
			),
		);
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		const model = registry().find("openai-codex", "gpt-5.6-sol");
		expect(model?.name).toBe("My Sol");
		expect(model?.contextPromotionTarget).toBe("anthropic-aws/claude-fable-5");
	});

	test("user provider absent from the overlay is preserved verbatim", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-proxy:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKey: TEST_KEY",
				"    api: openai-responses",
				"    models:",
				"      - id: gpt-5.4",
			].join("\n"),
		);
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		const reg = registry();
		// The user's custom provider survived the managed merge.
		expect(reg.find("my-proxy", "gpt-5.4")).toBeDefined();
		// And the managed pin still applied.
		expect(reg.find("openai-codex", "gpt-5.6-sol")?.contextPromotionTarget).toBe("anthropic-aws/claude-fable-5");
	});

	test("malformed managed overlay is ignored, user config still loads", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  my-proxy:",
				"    baseUrl: https://proxy.example.com/v1",
				"    apiKey: TEST_KEY",
				"    api: openai-responses",
				"    models:",
				"      - id: gpt-5.4",
			].join("\n"),
		);
		// Invalid: providers must be a map, not a scalar.
		fs.writeFileSync(managedPath, "providers: not-a-map\n");
		const reg = registry();
		expect(reg.getError()).toBeUndefined();
		expect(reg.find("my-proxy", "gpt-5.4")).toBeDefined();
	});

	test("absent overlay = upstream behaviour (no managed file)", () => {
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: openai-codex/gpt-5.6-terra",
			].join("\n"),
		);
		expect(fs.existsSync(managedPath)).toBe(false);
		expect(registry().find("openai-codex", "gpt-5.6-sol")?.contextPromotionTarget).toBe("openai-codex/gpt-5.6-terra");
	});

	test("a broken USER models.yml still surfaces as an error", () => {
		fs.writeFileSync(modelsPath, "providers: not-a-map\n");
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		// Managed overlay must NOT paper over a user file we couldn't parse.
		expect(registry().getError()).toBeDefined();
	});

	test("managed-only edit invalidates the reload fast-path", async () => {
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-fable-5",
			].join("\n"),
		);
		const reg = registry();
		expect(reg.find("openai-codex", "gpt-5.6-sol")?.contextPromotionTarget).toBe("anthropic-aws/claude-fable-5");

		// Rewrite ONLY the managed overlay, then refresh: the composite mtime
		// signature must detect the change and re-merge (different target).
		// Force a strictly-later mtime so the assertion never depends on
		// filesystem mtime granularity (coarse-resolution FS + same-tick writes
		// would otherwise collide the signature and skip the reload).
		fs.writeFileSync(
			managedPath,
			[
				"providers:",
				"  openai-codex:",
				"    modelOverrides:",
				"      gpt-5.6-sol:",
				"        contextPromotionTarget: anthropic-aws/claude-sonnet-5",
			].join("\n"),
		);
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(managedPath, future, future);
		await reg.refresh("offline");
		expect(reg.find("openai-codex", "gpt-5.6-sol")?.contextPromotionTarget).toBe("anthropic-aws/claude-sonnet-5");
	});
});
