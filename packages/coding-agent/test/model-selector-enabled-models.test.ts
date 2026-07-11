import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelSelectorComponent } from "@oh-my-pi/pi-coding-agent/modes/components/model-selector";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function normalizeRenderedText(text: string): string {
	return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		baseUrl: "https://example.com",
		reasoning: false,
		provider,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

let testTheme = await getThemeByName("dark");

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load dark theme for ModelSelector tests");
	}
	setThemeInstance(testTheme);
}

function createSelector(models: Model[], settings: Settings): { selector: ModelSelectorComponent; backgroundRefresh: Promise<void> } {
	const refreshGate = Promise.withResolvers<void>();
	const modelRegistry = {
		getAll: () => models,
		refresh: vi.fn(() => refreshGate.promise),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => models,
		getDiscoverableProviders: () => [],
	} as unknown as ModelRegistry;
	const ui = {
		requestRender: vi.fn(),
	} as unknown as TUI;

	const selector = new ModelSelectorComponent(
		ui,
		undefined,
		settings,
		modelRegistry,
		[],
		() => {},
		() => {},
		{ temporaryOnly: true },
	);
	refreshGate.resolve();
	const backgroundRefresh = refreshGate.promise
		.then(() => Promise.resolve())
		.then(() => Promise.resolve())
		.then(() => Promise.resolve());
	return { selector, backgroundRefresh };
}

// The org-config allowlist (`enabledModels`) must bind every model surface.
// `session.getAvailableModels()` already filters; the picker used to read the
// registry directly and offered models the allowlist scoped out whenever a
// matching credential existed in the environment (e.g. a stray
// ANTHROPIC_API_KEY exposing first-party anthropic/* beside anthropic-aws/*).
describe("ModelSelector honors the enabledModels allowlist", () => {
	beforeAll(async () => {
		testTheme = await getThemeByName("dark");
		if (!testTheme) {
			throw new Error("Failed to load dark theme for ModelSelector tests");
		}
	});

	test("models outside enabledModels never render in the picker", async () => {
		installTestTheme();
		const allowed = makeModel("anthropic-aws", "claude-opus-4-8");
		const scopedOut = makeModel("anthropic", "claude-opus-4-8");
		const settings = Settings.isolated({ enabledModels: ["anthropic-aws/*"] });

		const { selector, backgroundRefresh } = createSelector([allowed, scopedOut], settings);
		await backgroundRefresh;
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("anthropic-aws/claude-opus-4-8");
		// Safe: "anthropic-aws/claude-opus-4-8" does not contain "anthropic/claude-opus-4-8".
		expect(rendered).not.toContain("anthropic/claude-opus-4-8");
		// Provider tab bar must not offer the scoped-out provider either: the
		// anthropic-aws tab renders as "ANTHROPIC AWS", a bare first-party
		// anthropic tab would render as "ANTHROPIC" (word-bounded, not AWS).
		expect(rendered).not.toMatch(/ANTHROPIC(?! AWS)\b/);
	});

	test("empty enabledModels leaves the picker unfiltered (upstream default)", async () => {
		installTestTheme();
		const a = makeModel("anthropic-aws", "claude-opus-4-8");
		const b = makeModel("openai", "gpt-5.2");
		const settings = Settings.isolated({});

		const { selector, backgroundRefresh } = createSelector([a, b], settings);
		await backgroundRefresh;
		installTestTheme();

		const rendered = normalizeRenderedText(selector.render(220).join("\n"));
		expect(rendered).toContain("anthropic-aws/claude-opus-4-8");
		expect(rendered).toContain("openai/gpt-5.2");
	});
});
