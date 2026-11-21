import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { rebuildScopedModels } from "@oh-my-pi/pi-coding-agent/main";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { filterOAuthLoginProviders } from "@oh-my-pi/pi-coding-agent/config/oauth-login-gate";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { Component } from "@oh-my-pi/pi-tui";
import { LogoutAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";
import { OAuthSelectorComponent } from "@oh-my-pi/pi-tui/overlays/oauth-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

beforeAll(async () => {
	await initTheme();
});

const authStorage = {
	credentials: { has: (_providerId: string) => false },
	keys: { source: (_providerId: string) => undefined },
} as unknown as AuthStorage;

describe("OAuthSelectorComponent", () => {
	it("fuzzy-filters overflowing provider lists from typed input", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(10);
		const target =
			providers.find(provider => provider.available && provider.id === "vllm") ??
			providers.find(provider => provider.available) ??
			providers[0];
		expect(target).toBeDefined();
		if (!target) return;

		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"login",
			authStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of target.id) {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain(target.name);
		expect(rendered).toContain(`Search: ${target.id}`);

		component.handleInput("\n");
		expect(selected).toEqual([target.id]);
	});

	it("does not offer env-only providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (_providerId: string) => false },
				keys: {
					source: (providerId: string) =>
						providerId === "opencode-go" || providerId === "opencode-zen"
							? { kind: "api_key", concrete: true }
							: undefined,
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("No stored provider credentials to log out");

		component.handleInput("\n");
		expect(selected).toEqual([]);
	});

	it("offers stored providers as logout targets", () => {
		const selected: string[] = [];
		const component = new OAuthSelectorComponent(
			"logout",
			{
				credentials: { has: (providerId: string) => providerId === "opencode-go" },
				keys: {
					source: (providerId: string) =>
						providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined,
				},
			} as unknown as AuthStorage,
			providerId => selected.push(providerId),
			() => {},
		);

		for (const char of "opencode-go") {
			component.handleInput(char);
		}

		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("OpenCode Go");
		expect(rendered).toContain("logged in");

		component.handleInput("\n");
		expect(selected).toEqual(["opencode-go"]);
	});

	describe("disabledProviders", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides disabled providers from the login list even when searched", async () => {
			const providers = getOAuthProviders();
			const victim =
				providers.find(provider => provider.available && provider.id === "vllm") ??
				providers.find(provider => provider.available) ??
				providers[0];
			expect(victim).toBeDefined();
			if (!victim) return;

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: [victim.id] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of victim.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(victim.name);
		});

		it("hides alias logins whose storeCredentialsAs target is disabled", async () => {
			const alias = getOAuthProviders().find(provider => provider.storeCredentialsAs === "openai-codex");
			expect(alias).toBeDefined();
			if (!alias) return;
			expect(alias.id).not.toBe("openai-codex");

			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["openai-codex"] } });

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of alias.id) {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain(alias.name);
		});

		it("keeps disabled providers as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { disabledProviders: ["opencode-go"] } });

			const selected: string[] = [];
			const component = new OAuthSelectorComponent(
				"logout",
				{
					credentials: { has: (providerId: string) => providerId === "opencode-go" },
					keys: {
						source: (providerId: string) =>
							providerId === "opencode-go" ? { kind: "api_key", concrete: true } : undefined,
					},
				} as unknown as AuthStorage,
				providerId => selected.push(providerId),
				() => {},
				{ disabledProviders: cfgDisabledProviders.get(settings) },
			);
			for (const char of "opencode-go") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("OpenCode Go");
		});
	});

	describe("enabledModels login gate", () => {
		afterEach(() => {
			resetSettingsForTest();
		});

		it("hides off-allowlist model providers from the login list even when searched", async () => {
			resetSettingsForTest();
			const sessionSettings = await Settings.init({
				inMemory: true,
				overrides: { enabledModels: ["anthropic-aws/*", "bedrock-mantle/*"] },
			});

			const component = new OAuthSelectorComponent(
				"login",
				authStorage,
				() => {},
				() => {},
				{ providers: filterOAuthLoginProviders(getOAuthProviders(), sessionSettings) },
			);
			for (const char of "anthropic") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).not.toContain("Anthropic");
		});

		it("keeps off-allowlist providers with stored credentials as logout targets", async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { enabledModels: ["anthropic-aws/*", "bedrock-mantle/*"] } });

			const component = new OAuthSelectorComponent(
				"logout",
				{
					credentials: { has: (providerId: string) => providerId === "anthropic" },
					keys: { source: (_providerId: string) => undefined },
				} as unknown as AuthStorage,
				() => {},
				() => {},
			);
			for (const char of "anthropic") {
				component.handleInput(char);
			}
			const rendered = component
				.render(80)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(rendered).toContain("Anthropic");
		});

		it("removes an excluded stored credential through the real logout controller without validating it", async () => {
			using directory = TempDir.createSync("@omp-excluded-logout-");
			const sessionSettings = Settings.isolated({
				enabledModels: ["anthropic-aws/*"],
				disabledProviders: ["inception"],
			});
			const store = await AuthStorage.create(directory.join("auth.db"));
			await store.credentials.set("inception", { type: "api_key", key: "synthetic-excluded-key" });
			await store.credentials.set("tavily", { type: "api_key", key: "synthetic-retained-key" });
			const transport = vi.fn(async () => {
				throw new Error("Unexpected provider transport");
			});
			const registry = new ModelRegistry(store, directory.join("models.yml"), {
				settings: sessionSettings,
				cacheDbPath: directory.join("models.db"),
				fetch: transport,
			});
			const manager = SessionManager.inMemory(directory.path());
			const session = new AgentSession({
				agent: new Agent(),
				sessionManager: manager,
				settings: sessionSettings,
				modelRegistry: registry,
			});
			session.setScopedModelsRefresher(async () => {
				await rebuildScopedModels(session, parseArgs([]), registry, sessionSettings);
			});
			const getApiKey = vi.spyOn(registry, "getApiKeyForProvider");
			const login = vi.spyOn(store.oauth, "login");
			const accountReady = Promise.withResolvers<LogoutAccountSelectorComponent | undefined>();
			const finished = Promise.withResolvers<string | undefined>();
			let focused: Component | null = null;
			const ctx = createInteractiveModeContext({
				settings: sessionSettings,
				session,
				sessionManager: manager,
				ui: {
					getFocused: () => focused,
					setFocus: component => {
						focused = component;
						if (component instanceof LogoutAccountSelectorComponent) accountReady.resolve(component);
					},
				},
				present: () => finished.resolve(undefined),
				showError: message => {
					accountReady.resolve(undefined);
					finished.resolve(message);
				},
			});
			try {
				await new SelectorController(ctx).showOAuthSelector("logout");
				const providers = ctx.editorContainer.children.find(child => child instanceof OAuthSelectorComponent);
				if (!(providers instanceof OAuthSelectorComponent)) throw new Error("Logout providers did not open");
				for (const char of "inception") providers.handleInput(char);
				expect(Bun.stripANSI(providers.render(80).join("\n"))).toContain("Inception");
				providers.handleInput("\n");
				const accounts = await accountReady.promise;
				if (!accounts) throw new Error(await finished.promise);
				accounts.handleInput("\n");
				expect(await finished.promise).toBeUndefined();
				expect(store.credentials.list("inception")).toEqual([]);
				expect(store.credentials.list("tavily")).toMatchObject([
					{ credential: { type: "api_key", key: "synthetic-retained-key" } },
				]);
				expect(getApiKey).not.toHaveBeenCalled();
				expect(login).not.toHaveBeenCalled();
				expect(transport).not.toHaveBeenCalled();
			} finally {
				getApiKey.mockRestore();
				login.mockRestore();
				await session.dispose();
				await store.close();
			}
		});
	});
});
