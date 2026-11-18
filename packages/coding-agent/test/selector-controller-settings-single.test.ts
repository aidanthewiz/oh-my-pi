import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@oh-my-pi/pi-tui";
import { AgentsHubComponent } from "@oh-my-pi/pi-tui/overlays/agents-hub";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-tui/overlays/agent-hub";
import { ModelHubComponent } from "@oh-my-pi/pi-tui/overlays/model-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { SessionSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-selector";
import * as activityClient from "@oh-my-pi/pi-coding-agent/stats/activity-client";
import * as sessionPins from "@oh-my-pi/pi-coding-agent/session/session-pins";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type { PickerListing, SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { createInteractiveModeContext } from "./helpers/interactive-mode-context";

/** The overlay members of `ui` the single-instance guard reads and drives. */
interface OverlayUi {
	overlayStack: TUI["overlayStack"];
	setFocus: (component: Component | null) => void;
	showOverlay: (component: Component, options?: OverlayOptions) => OverlayHandle;
}

/** A `ui` whose overlays live on `overlayStack` as TUI's do: shown on top, removed on hide. */
function overlayUi(): {
	ui: OverlayUi;
	shown: Component[];
	setFocus: OverlayUi["setFocus"];
	overlayStack: TUI["overlayStack"];
	getFocused: () => Component | null;
} {
	const overlayStack: TUI["overlayStack"] = [];
	const shown: Component[] = [];
	let focused: Component | null = null;
	const setFocus = vi.fn((component: Component | null) => {
		focused = component;
	});
	const showOverlay = (component: Component, options?: OverlayOptions): OverlayHandle => {
		const entry = { component, options, preFocus: null, hidden: false, released: false };
		overlayStack.push(entry);
		shown.push(component);
		return {
			hide: () => {
				const at = overlayStack.indexOf(entry);
				if (at >= 0) overlayStack.splice(at, 1);
			},
			setHidden: hidden => {
				entry.hidden = hidden;
			},
			isHidden: () => entry.hidden,
		};
	};
	return { shown, setFocus, overlayStack, getFocused: () => focused, ui: { overlayStack, setFocus, showOverlay } };
}

function pickerContext(ui: OverlayUi, models: Model[] = [], model?: Model, settings = Settings.isolated()) {
	return createInteractiveModeContext({
		settings,
		session: {
			model,
			scopedModels: [],
			getContextUsage: () => undefined,
			effectiveServiceTier: () => undefined,
			getRoleModelCycle: () => undefined,
			resolveTemporaryModelThinkingLevel: () => "off",
			setModelTemporary: vi.fn(async () => {}),
			applyRoleModel: vi.fn(async () => {}),
			modelRegistry: {
				getError: () => undefined,
				getAvailable: () => models,
				getAll: () => models,
				refreshIfStale: async () => false,
				getDiscoverableProviders: () => [],
				refresh: async () => {},
			},
		},
		ui,
		keybindings: { getKeys: () => [], getDisplayString: () => "" },
	});
}

describe("single-instance menus", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		await themeModule.initTheme(false);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// Regression: a second /settings (typed while theme discovery was pending, or
	// from Tern's native composer while the menu was open) stacked another
	// fullscreen settings menu on top of the first.
	it("focuses the open menu instead of stacking a second one", async () => {
		const themes = Promise.resolve(["dark"]);
		spyOn(themeModule, "getAvailableThemes").mockReturnValue(themes);
		const overlays: Component[] = [];
		const setFocus = vi.fn<(component: Component | null) => void>();
		const ctx = createInteractiveModeContext({
			session: { getAvailableThinkingLevels: () => [], getAvailableModels: () => [] },
			ui: {
				showOverlay: (component: Component, _options?: OverlayOptions): OverlayHandle => {
					overlays.push(component);
					return { hide: () => {}, setHidden: () => {}, isHidden: () => false };
				},
				setFocus,
			},
		});
		const controller = new SelectorController(ctx);

		controller.showSettingsSelector();
		controller.showSettingsSelector();
		// The controller's continuation was queued first, so the menu is mounted.
		await themes;
		expect(overlays).toHaveLength(1);
		controller.showSettingsSelector();
		expect(overlays).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(overlays[0]);
	});

	// Regression: clicking Tern's composer model chip again while the picker was
	// still opening (or already open) stacked another picker per click.
	it("opens one model picker per close, focusing it on repeat requests", () => {
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));

		controller.showModelSelector({ temporaryOnly: true });
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
	});

	it("replaces an ordinary picker with selection-only and ignores stale picker input", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "selection-target" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const ctx = pickerContext(ui, [model], hostModel, Settings.isolated());
		cfgTaskAgentModelOverrides.override(ctx.settings, { task: "kept/task-model" });
		const taskDefaults = structuredClone(cfgTaskAgentModelOverrides.get(ctx.settings));
		const selected = vi.fn();
		const controller = new SelectorController(ctx);

		controller.showModelSelector({ temporaryOnly: true });
		const ordinaryPicker = shown[0]!;
		controller.showModelSelector({
			selectOnly: {
				currentSelector: `${model.provider}/${model.id}`,
				onSelect: selected,
			},
		});
		const selectionPicker = shown[1]!;
		expect(ui.overlayStack).toHaveLength(1);
		expect(ui.overlayStack.at(-1)?.component).toBe(selectionPicker);

		ordinaryPicker.handleInput?.("\r");
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		selectionPicker.handleInput?.("\r");

		expect(selected).toHaveBeenCalledWith(`${model.provider}/${model.id}`);
		expect(ctx.session.setModelTemporary).not.toHaveBeenCalled();
		expect(ctx.session.applyRoleModel).not.toHaveBeenCalled();
		expect(cfgTaskAgentModelOverrides.get(ctx.settings)).toEqual(taskDefaults);

		controller.showModelSelector({
			selectOnly: { currentSelector: `${model.provider}/${model.id}`, onSelect: selected },
		});
		shown[2]?.handleInput?.("\x1b");
		expect(selected).toHaveBeenCalledTimes(1);
	});

	it("replaces selection-only with an ordinary session model picker", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "session-target" }).model;
		const hostModel = createMockModel({ provider: "anthropic", id: "host-model" }).model;
		const ctx = pickerContext(ui, [model], hostModel);
		let appliedModel: Model = hostModel;
		ctx.session.setModelTemporary = async next => {
			appliedModel = next;
		};
		const selected = vi.fn();
		const controller = new SelectorController(ctx);

		controller.showModelSelector({
			selectOnly: {
				currentSelector: `${model.provider}/${model.id}`,
				onSelect: selected,
			},
		});
		const selectionPicker = shown[0]!;
		controller.showModelSelector({ temporaryOnly: true });
		expect(shown).toHaveLength(2);
		expect(ui.overlayStack).toHaveLength(1);

		selectionPicker.handleInput?.("\r");
		expect(selected).not.toHaveBeenCalled();
		shown[1]?.handleInput?.("\r");

		expect(selected).not.toHaveBeenCalled();
		expect(appliedModel.provider).toBe("openai");
		expect(appliedModel.id).toBe("session-target");
	});

	it("uses only the newest callbacks for repeated selection-only picker requests", () => {
		const { ui, shown } = overlayUi();
		const model = createMockModel({ provider: "openai", id: "selection-target" }).model;
		const selector = `${model.provider}/${model.id}`;
		const controller = new SelectorController(pickerContext(ui, [model]));
		const oldSelect = vi.fn();
		const latestSelect = vi.fn();

		controller.showModelSelector({ selectOnly: { currentSelector: selector, onSelect: oldSelect } });
		const oldPicker = shown[0]!;
		controller.showModelSelector({ selectOnly: { currentSelector: selector, onSelect: latestSelect } });
		expect(ui.overlayStack).toHaveLength(1);

		oldPicker.handleInput?.("\r");
		expect(oldSelect).not.toHaveBeenCalled();
		expect(latestSelect).not.toHaveBeenCalled();
		shown[1]?.handleInput?.("\r");
		expect(oldSelect).not.toHaveBeenCalled();
		expect(latestSelect).toHaveBeenCalledWith(selector);

		controller.showModelSelector({
			selectOnly: { currentSelector: selector, onSelect: vi.fn() },
		});
		const stalePicker = shown[2]!;
		controller.showModelSelector({
			selectOnly: { currentSelector: selector, onSelect: vi.fn() },
		});
		stalePicker.handleInput?.("\x1b");
		expect(ui.overlayStack).toHaveLength(1);
		shown[3]?.handleInput?.("\x1b");
		expect(ui.overlayStack).toHaveLength(0);
	});
	it("raises an open model picker another overlay covers instead of focusing it hidden", () => {
		const { ui, overlayStack } = overlayUi();
		const controller = new SelectorController(pickerContext(ui));
		controller.showModelSelector({ temporaryOnly: true });
		const picker = overlayStack[0]?.component;
		ui.showOverlay({ render: () => [], invalidate: () => {} });

		controller.showModelSelector({ temporaryOnly: true });
		expect(overlayStack).toHaveLength(2);
		expect(overlayStack.at(-1)?.component).toBe(picker);
	});

	it("keeps a model hub search when a repeat request raises it, then releases it on cancel", async () => {
		const { ui, overlayStack, setFocus } = overlayUi();
		const ctx = pickerContext(ui);
		const controller = new SelectorController(ctx);
		controller.showModelSelector();
		const hub = overlayStack[0]?.component;
		if (!(hub instanceof ModelHubComponent)) throw new Error("model hub was not mounted");
		for (const character of "haiku") hub.handleInput(character);
		const cover: Component = { render: () => [], invalidate: () => {} };
		ui.showOverlay(cover);

		controller.showModelSelector();
		expect(overlayStack.map(entry => entry.component)).toEqual([cover, hub]);
		expect(setFocus).toHaveBeenLastCalledWith(hub);
		const view = hub.describe({
			cols: 120,
			dark: true,
			reduceMotion: false,
			supports: () => true,
			feature: () => true,
		});
		if (view.k !== "picker") throw new Error("model hub picker view was not described");
		expect(view.p?.query).toBe("haiku");

		hub.handleInput("\x1b");
		hub.handleInput("\x1b");
		expect(overlayStack.some(entry => entry.component === hub)).toBe(false);
		controller.showModelSelector();
		const reopened = overlayStack.at(-1)?.component;
		expect(reopened).not.toBe(hub);
		reopened?.handleInput?.("\x1b");
		await Promise.resolve();
	});

	it("reuses the agent hub for deep links without losing its roster view", () => {
		const { ui, overlayStack, setFocus } = overlayUi();
		const ctx = createInteractiveModeContext({
			ui,
			settings: Settings.isolated(),
			collabGuest: { agentRegistry: new AgentRegistry() },
			keybindings: { getKeys: () => [] },
		});
		const controller = new SelectorController(ctx);
		const observers = new SessionObserverRegistry();
		controller.showAgentHub(observers);
		const hub = overlayStack[0]?.component;
		if (!(hub instanceof AgentHubOverlayComponent)) throw new Error("agent hub was not mounted");
		const describe = () => {
			const view = hub.describe({
				cols: 120,
				dark: true,
				reduceMotion: false,
				supports: () => true,
				feature: () => true,
			});
			if (view.k !== "picker" || !view.p) throw new Error("agent hub picker view was not described");
			return view.p;
		};
		try {
			hub.handleInput("t");
			expect(describe().layout).toBe("tree");
			ui.showOverlay({ render: () => [], invalidate: () => {} });

			controller.showAgentHub(observers, { initialSection: "activity" });
			expect(overlayStack.at(-1)?.component).toBe(hub);
			expect(setFocus).toHaveBeenLastCalledWith(hub);
			expect(describe().tab).toBe("activity");
			controller.showAgentHub(observers, { initialSection: "agents" });
			expect(overlayStack.filter(entry => entry.component === hub)).toHaveLength(1);
			expect(describe().tab).toBe("agents");
			expect(describe().layout).toBe("tree");
		} finally {
			hub.handleInput("\x1b");
		}
		expect(overlayStack.some(entry => entry.component === hub)).toBe(false);
	});

	it("opens one agents dashboard while it loads, and opens again after a failed load", async () => {
		const { ui, shown } = overlayUi();
		const controller = new SelectorController(createInteractiveModeContext({ ui }));
		const failed = Promise.withResolvers<AgentsHubComponent>();
		const create = spyOn(AgentsHubComponent, "create").mockReturnValue(failed.promise);

		const first = controller.showAgentsDashboard();
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(1);
		failed.reject(new Error("discovery failed"));
		await expect(first).rejects.toThrow("discovery failed");

		create.mockResolvedValue(Object.create(AgentsHubComponent.prototype));
		await controller.showAgentsDashboard();
		expect(create).toHaveBeenCalledTimes(2);
		expect(shown).toHaveLength(1);
	});

	// Regression: a second /usage (or status-line cost click) while the dashboard
	// was open stacked another fullscreen dashboard on top of the first.
	it("opens one usage dashboard per close, focusing it on repeat requests", () => {
		spyOn(activityClient, "loadDailyActivity").mockResolvedValue(undefined);
		const { ui, shown, setFocus } = overlayUi();
		const controller = new SelectorController(
			createInteractiveModeContext({
				session: {
					model: undefined,
					getUsageReportingModelSelectors: () => [],
					fetchUsageReports: async () => null,
					modelRegistry: {
						authStorage: {
							credentials: { all: () => ({}) },
							usage: { providerFor: () => undefined },
							oauth: { identity: () => undefined },
						},
					},
				},
				ui,
			}),
		);
		const reports = [{ provider: "anthropic", fetchedAt: Date.now(), limits: [] }];

		controller.showUsageDashboard(reports);
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(1);
		expect(setFocus).toHaveBeenLastCalledWith(shown[0]);

		shown[0]?.handleInput?.("\x1b");
		controller.showUsageDashboard(reports);
		expect(shown).toHaveLength(2);
	});

	it("selects a seance source without resuming", async () => {
		const session: SessionInfo = {
			path: "/repo/.omp/sessions/source.jsonl",
			id: "source",
			cwd: "/repo",
			created: new Date(1),
			modified: new Date(2),
			messageCount: 1,
			size: 16,
			firstMessage: "Inspect the old session",
			allMessagesText: "Inspect the old session",
		};
		const listed = [session];
		spyOn(SessionManager, "listForPicker").mockResolvedValue({ sessions: listed, complete: Promise.resolve(listed) });
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());
		const { ui, shown, overlayStack } = overlayUi();
		const ctx = createInteractiveModeContext({
			ui: { ...ui, terminal: { rows: 24 } },
			session: { switchSession: vi.fn(async () => true) },
			sessionManager: {
				getCwd: () => "/repo",
				getSessionDir: () => "/repo/.omp/sessions",
				getSessionFile: () => undefined,
			},
		});
		const controller = new SelectorController(ctx);
		const resume = spyOn(controller, "handleResumeSession").mockResolvedValue(true);
		const overlayCountAtSelection: number[] = [];
		const selected = vi.fn(async (_session: SessionInfo) => {
			overlayCountAtSelection.push(overlayStack.length);
		});

		await controller.showSessionSelector(undefined, selected);

		const selector = shown[0] as SessionSelectorComponent<SessionInfo>;
		selector.handleInput("\r");
		await Promise.resolve();
		await Promise.resolve();

		expect(selected).toHaveBeenCalledWith(session);
		expect(overlayCountAtSelection).toEqual([0]);
		expect(resume).not.toHaveBeenCalled();
		expect(ctx.session.switchSession).not.toHaveBeenCalled();
	});

	it("does not let an older session listing replace the current selection-only picker", async () => {
		const first = Promise.withResolvers<PickerListing>();
		spyOn(SessionManager, "listForPicker")
			.mockReturnValueOnce(first.promise)
			.mockResolvedValue({ sessions: [], complete: Promise.resolve([]) });
		spyOn(sessionPins, "loadPinnedSessionIds").mockResolvedValue(new Set());
		const { ui, shown, overlayStack, getFocused } = overlayUi();
		const ctx = createInteractiveModeContext({
			ui: { ...ui, terminal: { rows: 24 } },
			sessionManager: {
				getCwd: () => "/repo",
				getSessionDir: () => "/repo/.omp/sessions",
				getSessionFile: () => undefined,
			},
		});
		const controller = new SelectorController(ctx);
		const oldRequest = controller.showSessionSelector(undefined, () => {});
		await controller.showSessionSelector(undefined, () => {});
		const current = overlayStack.at(-1)?.component;
		if (!(current instanceof SessionSelectorComponent)) throw new Error("Expected current session picker");
		expect(getFocused()).toBe(current);
		first.resolve({ sessions: [], complete: Promise.resolve([]) });
		await oldRequest;
		expect(shown).toHaveLength(1);
		expect(overlayStack.at(-1)?.component).toBe(current);
		expect(getFocused()).toBe(current);
		current?.handleInput?.("\x1b");
		expect(overlayStack).toEqual([]);
	});
});
