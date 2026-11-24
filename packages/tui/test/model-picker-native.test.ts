import { afterEach, beforeAll, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { stripVTControlCharacters } from "node:util";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { TspPickerGroup, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { ModelHubComponent, type ModelHubRegistry, type ModelHubSource } from "../src/overlays/model-hub";
import { providerMark } from "../src/overlays/model-browser";
import { ModelPickerComponent, type ModelPickerOptions } from "../src/overlays/model-picker";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const withPicker: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};
const withoutPicker: DescribeContext = { ...withPicker, supports: kind => kind !== "picker" };

beforeAll(async () => {
	await initTheme(false);
});

function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

const MODELS = [
	model("anthropic", "claude-sonnet-5-5", { int: 60 }),
	model("anthropic", "claude-opus-5"),
	model("demo", "demo"),
	model("openai", "gpt-5.6"),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
];

function source(roles: Record<string, string>, mru: string[]): ModelHubSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: mru,
		modelPerf: new Map(),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: role => roles[role],
		disabledProviders: [],
		fallbackChains: { default: ["openai/gpt-5.6"] },
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => roles[role],
		getModelRoleSource: () => "global",
	};
}

function registry(models: Model[]): ModelHubRegistry {
	return {
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		authStorage: { keys: { source: () => "env" } },
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		find: (provider: string, id: string) =>
			models.find(candidate => candidate.provider === provider && candidate.id === id),
		refresh: async () => {},
		refreshProvider: async () => {},
	} as unknown as ModelHubRegistry;
}

const ui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
const hubs: ModelHubComponent[] = [];
afterEach(() => {
	for (const hub of hubs.splice(0)) hub.dispose();
});

function openHub(calls: { assign: string[]; cancel: number }, models: Model[] = MODELS): ModelHubComponent {
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		registry(models),
		// A `--models` scope skips the background online refresh.
		models.map(entry => ({ model: entry })),
		{
			onAssign: (_model, role, _level, selector) => {
				calls.assign.push(`${role}=${selector}`);
			},
			onUnassign: () => {},
			onCancel: () => {
				calls.cancel++;
			},
		},
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	return hub;
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function groups(p: TspPickerProps): string[] {
	return (p.order ?? [])
		.filter((entry): entry is TspPickerGroup => typeof entry !== "string")
		.map(g => String(g.label));
}

/** A described child's prop, when the child is a node carrying it. */
function prop(child: NativeChild, name: string): unknown {
	return "k" in child && child.p ? Reflect.get(child.p, name) : undefined;
}

function titleOf(children: readonly NativeChild[] | undefined): unknown {
	const title = children?.find(child => prop(child, "role") === "omp.picker.title");
	return title ? prop(title, "text") : undefined;
}

test("provider scopes retain model identity and cannot reveal models excluded by host policy", () => {
	const allowed = MODELS[0]!;
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ default: "anthropic/claude-sonnet-5-5" }, []),
			scopeModels: models => models.filter(model => model.id === allowed.id),
		},
		registry(MODELS),
		MODELS.map(model => ({ model })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
	);
	hubs.push(hub);
	const all = props(hub.describe(withPicker));
	expect(all.items?.map(item => item.id)).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(all.items?.[0]?.mark).toEqual({ text: "An", seed: "anthropic", icon: "provider:anthropic" });
	expect(all.scopes?.find(scope => scope.id === "provider:anthropic")?.mark).toEqual(all.items?.[0]?.mark);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "provider:anthropic", mods: [] });
	expect(props(hub.describe(withPicker)).items?.map(item => item.id)).toEqual(["anthropic/claude-sonnet-5-5"]);
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(props(hub.describe(withPicker)).selected).not.toBe("openai/gpt-5.6");
});

test("Factory Droid rows carry the base credit rate and a credit-only model is never free", () => {
	const priced = { ...model("factory-droid", "claude-opus-5"), factoryDroidCredits: 2 };
	const creditOnly = {
		...model("factory-droid", "preview-credit-model", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
		factoryDroidCredits: 0.5,
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, priced, creditOnly]);
	const items = props(hub.describe(withPicker)).items ?? [];
	const row = (id: string) => items.find(entry => entry.id === `factory-droid/${id}`);
	expect(row("claude-opus-5")?.facts?.price).toBe("$3·15 2×");
	expect(row("preview-credit-model")?.facts?.price).toBe("0.5×");
	expect(row("preview-credit-model")?.badges ?? []).not.toContainEqual({ text: "free", tone: "success" });
});

test("a dated Factory Droid credit rate keeps the narrow price column to the rate alone", () => {
	const promoted = {
		...model("factory-droid", "gpt-5.6-sol"),
		factoryDroidCredits: 2,
		factoryDroidCreditCards: [
			{ effectiveFrom: Date.now() - 86_400_000, input: 1.6 },
			{ effectiveFrom: Date.parse("2099-11-22T00:00:00Z"), input: 2 },
		],
	};
	const hub = openHub({ assign: [], cancel: 0 }, [...MODELS, promoted]);
	const items = props(hub.describe(withPicker)).items ?? [];
	expect(items.find(entry => entry.id === "factory-droid/gpt-5.6-sol")?.facts?.price).toBe("$3·15 1.6×");
});

test("typing changes the order, hits, counts and head total but never the catalogue", () => {
	const hub = openHub({ assign: [], cancel: 0 });
	const before = props(hub.describe(withPicker));
	for (const ch of "sonnet") hub.handleInput(ch);
	const after = props(hub.describe(withPicker));
	expect(after.items).toBe(before.items);
	expect(after.query).toBe("sonnet");
	expect(after.order).toEqual(["anthropic/claude-sonnet-5-5"]);
	expect(after.hits?.["anthropic/claude-sonnet-5-5"]).toEqual([[17, 23]]);
	expect(after.total).toBe(5);
	expect(after.scopes?.find(scope => scope.id === "all")?.count).toBe(1);
	expect(after.scopes?.find(scope => scope.id === "provider:openai")?.count).toBe(0);
	expect(after.selected).toBe("anthropic/claude-sonnet-5-5");
});

test("a re-sync that moves a role patches the catalogue instead of resending it", () => {
	const models = [...MODELS, ...Array.from({ length: 30 }, (_, i) => model("bulk", `m-${i}`))];
	const roles: Record<string, string> = { default: "demo/demo" };
	const hub = new ModelHubComponent(
		ui,
		source(roles, []),
		registry(models),
		models.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
		},
	);
	hubs.push(hub);
	const first = props(hub.describe(withPicker));
	expect(first.itemsAdd).toBeUndefined();

	roles.default = "openai/gpt-5.6";
	hub.refreshAfterExternalMutation();
	const moved = props(hub.describe(withPicker));
	expect(moved.items).toBe(first.items);
	expect(moved.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", undefined],
		["openai/gpt-5.6", ["default"]],
	]);

	// Back to the original: the terminal kept the patch, so the reverted rows are still sent.
	roles.default = "demo/demo";
	hub.refreshAfterExternalMutation();
	const reverted = props(hub.describe(withPicker));
	expect(reverted.items).toBe(first.items);
	expect(reverted.itemsAdd?.map(row => [row.id, row.chips?.map(chip => chip.text)]).sort()).toEqual([
		["demo/demo", ["default"]],
		["openai/gpt-5.6", undefined],
	]);
});

test("pointer events drive the hub through the same paths as its keys", () => {
	const calls = { assign: [] as string[], cancel: 0 };
	const hub = openHub(calls);
	const act = (act: string, value?: string) =>
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });

	hub.handleNativeEvent({ type: "select", key: "", item: "openai/gpt-5.6" });
	let p = props(hub.describe(withPicker));
	expect(p.selected).toBe("openai/gpt-5.6");
	expect(p.focus).toBe("list");
	expect(titleOf(hub.describe(withPicker).c)).toBe("gpt-5.6");

	// Activate = Enter: the role-assignment strip opens and takes the focus.
	hub.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	p = props(hub.describe(withPicker));
	expect(p.focus).toBe("strip");
	expect(p.strip?.items.map(chip => chip.label).slice(0, 2)).toEqual(["default", "smol"]);
	act("strip", "1");
	expect(calls.assign).toEqual(["smol=openai/gpt-5.6"]);

	// The kind tab and scope clicks land where alt+→ and the sidebar do.
	act("close");
	act("tab", "image");
	expect(props(hub.describe(withPicker)).tab).toBe("image");
	act("tab", "all");
	act("scope", "provider:openai");
	p = props(hub.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(p.order?.filter(entry => typeof entry === "string")).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.actions?.map(action => action.id)).toContain("refresh");

	// Roles scope: roles with their fallback chain one level deep.
	act("scope", "roles");
	p = props(hub.describe(withPicker));
	expect(p.items?.find(entry => entry.id === "fallback:default:0")).toMatchObject({
		label: "openai/gpt-5.6",
		depth: 1,
	});
	expect(p.items?.find(entry => entry.id === "role:default")?.facts).toEqual({ model: "demo/demo", thinking: "off" });
	expect(groups(p)).toContain("Model fallback chains");
	// The head's total counts the rows Tern counts as shown (fallbacks, chains, "New …" rows), so All reads no "N of M".
	expect(p.total).toBe(p.order?.filter(entry => typeof entry === "string").length);

	// Esc ladder: close leaves the hub only when nothing else is open.
	act("scope", "all");
	hub.handleInput("x");
	act("close");
	expect(props(hub.describe(withPicker)).query).toBe("");
	expect(calls.cancel).toBe(0);
	act("close");
	expect(calls.cancel).toBe(1);
});

test("preset cycling updates native and text role rows and preselects the assigned model", () => {
	const presets = { names: ["fast", "slow"], active: "fast" as string | undefined };
	const models = [MODELS[2]!, MODELS[3]!];
	const roles: Record<string, string> = { default: "demo/demo" };
	let revision = 0;
	let thinking = "low";
	const base = source(roles, []);
	const hub = new ModelHubComponent(
		ui,
		{
			...base,
			get revision() {
				return revision;
			},
			get defaultThinkingLevel() {
				return thinking;
			},
			getModelPresets: () => presets,
		},
		registry(models),
		models.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onSwitchPreset: name => {
				roles.default = name === "fast" ? "demo/demo" : "openai/gpt-5.6";
				thinking = name === "fast" ? "low" : "medium";
				presets.active = name;
				revision++;
			},
		},
	);
	hubs.push(hub);
	const checkRoles = (name: string, selector: string, level: string) => {
		const p = props(hub.describe(withPicker));
		const subtitle = p.subtitle;
		const text = Array.isArray(subtitle) ? subtitle.map(part => part.t).join("") : subtitle;
		expect(text).toContain(name);
		expect(p.items?.find(entry => entry.id === "role:default")?.facts).toEqual({ model: selector, thinking: level });
		const rendered = stripVTControlCharacters(hub.render(220).join("\n"));
		expect(rendered).toContain(name);
		expect(rendered).toContain(selector);
		expect(rendered).toContain(level);
	};
	hub.handleInput("\x1b[A");
	checkRoles("fast", "demo/demo", "low");
	hub.handleInput("\x1b[1;5C");
	checkRoles("slow", "openai/gpt-5.6", "medium");
	hub.handleInput("\x1b[1;5D");
	checkRoles("fast", "demo/demo", "low");
	hub.handleInput("\n");
	hub.handleInput("p");
	checkRoles("slow", "openai/gpt-5.6", "medium");
	hub.handleInput("P");
	checkRoles("fast", "demo/demo", "low");

	hub.handleNativeEvent({ type: "activate", key: "", item: "role:default" });
	let p = props(hub.describe(withPicker));
	expect(p.focus).toBe("list");
	expect(p.selected).toBe("demo/demo");
	hub.handleInput("\x1b[B");
	p = props(hub.describe(withPicker));
	expect(p.focus).toBe("list");
	expect(p.selected).toBe("openai/gpt-5.6");
	hub.handleInput("\x1b[D");
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "provider:openai", mods: [] });
	hub.handleInput("\x1b[C");
	p = props(hub.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(p.focus).toBe("list");
	expect(p.selected).toBe("openai/gpt-5.6");
	expect(p.order?.filter(entry => typeof entry === "string")).toEqual(["openai/gpt-5.6"]);
});

const QUICK_MODELS = [
	...MODELS,
	model("demo", "demo-lite", { thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium] } }),
	model("local", "tiny", { reasoning: false }),
];

function openQuickPicker(picked: string[], options: ModelPickerOptions = {}): ModelPickerComponent {
	return new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(QUICK_MODELS), refreshIfStale: async () => false },
		QUICK_MODELS.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector, meta) =>
				picked.push(`session:${selector}${meta.thinkingLevel ? `:${meta.thinkingLevel}` : ""}`),
			onPickTask: (_model, selector) => picked.push(`task:${selector}`),
			onKeepThinking: level => picked.push(`keep:${level}`),
			onCancel: () => picked.push("cancel"),
		},
		{ currentSelector: "demo/demo", taskModeKeys: ["alt+p"], thinkingLevelFor: () => Effort.High, ...options },
	);
}

function quickAct(picker: ModelPickerComponent, act: string, value?: string): void {
	picker.handleNativeEvent({ type: "action", key: "", act, mods: [], ...(value !== undefined ? { value } : {}) });
}

/** Item ids the picker lists, group heads dropped. */
function rowIds(p: TspPickerProps): string[] {
	return (p.order ?? []).filter((entry): entry is string => typeof entry === "string");
}

test("the quick picker is a composer drop-up with a provider rail, a thinking slider and a task-model toggle", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);
	expect(picker.describe(withoutPicker).k).not.toBe("picker");
	let root = picker.describe(withPicker);
	let p = props(root);
	expect(p).toMatchObject({
		size: "md",
		anchor: "composer",
		search: "list",
		density: "snug",
		preview: "none",
		scopeStyle: "rail",
		scope: "all",
		placeholder: "Search, @ for roles…",
		selected: "demo/demo",
	});
	expect(p.title).toBeUndefined();
	expect(p.subtitle).toBeUndefined();
	expect(root.c ?? []).toEqual([]);
	// The rail lists providers only: none active is all models.
	expect(p.scopes).toEqual([
		{ id: "provider:anthropic", label: "anthropic", mark: providerMark("anthropic"), count: 2 },
		{ id: "provider:demo", label: "demo", mark: providerMark("demo"), count: 2 },
		{ id: "provider:local", label: "local", mark: providerMark("local"), count: 1 },
		{ id: "provider:openai", label: "openai", mark: providerMark("openai"), count: 2 },
	]);
	expect(groups(p)).toEqual(["Recent", "All"]);
	// No action bar: only the Task / Main toggle, drawn atop the rail.
	expect(p.actions).toEqual([
		{ id: "task", label: "Task / Main", keys: ["alt", "p"], on: false, head: true, icon: "users" },
	]);
	expect(p.level).toEqual({
		label: "Thinking",
		steps: [
			{ id: "auto", label: "Auto" },
			{ id: "off", label: "Off" },
			{ id: "minimal", label: "Min" },
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Med" },
			{ id: "high", label: "High" },
			{ id: "xhigh", label: "XHigh" },
		],
		value: "high",
		detail: "demo",
		icon: "brain",
		keys: ["left", "right"],
	});

	// A model without reasoning freezes the slider at Off.
	picker.handleNativeEvent({ type: "select", key: "", item: "local/tiny" });
	expect(props(picker.describe(withPicker)).level).toMatchObject({
		steps: ["off", "minimal", "low", "medium", "high"].map(id => expect.objectContaining({ id })),
		value: "off",
		detail: "local",
		disabled: "tiny does not reason",
	});

	quickAct(picker, "task");
	root = picker.describe(withPicker);
	p = props(root);
	expect(p.placeholder).toBe("Search Task models…");
	expect(p.actions).toEqual([
		{ id: "task", label: "Task / Main", keys: ["alt", "p"], on: true, head: true, icon: "users" },
	]);
	picker.handleNativeEvent({ type: "activate", key: "", item: "openai/gpt-5.6" });
	expect(picked).toEqual(["task:openai/gpt-5.6"]);
});

test("a select-only picker never marks models over the live context window", () => {
	const small = model("demo", "tiny", { contextWindow: 1_000 });
	const models = [...MODELS, small];
	const picks: { selector: string; overContext: boolean }[] = [];
	const picker = new ModelPickerComponent(
		ui,
		source({ default: "demo/demo" }, ["demo/demo"]),
		{ ...registry(models), refreshIfStale: async () => false },
		models.map(entry => ({ model: entry })),
		{
			onPick: (_model, selector, meta) => picks.push({ selector, overContext: meta.overContext }),
			onCancel: () => {},
		},
		{ currentSelector: "demo/tiny", currentContextTokens: 50_000, selectOnly: true },
	);
	picker.handleNativeEvent({ type: "activate", key: "", item: "demo/tiny" });
	expect(picks).toEqual([{ selector: "demo/tiny", overContext: false }]);
});

test("a provider scope lists only its models, Tab cycles scopes, and the active provider again restores all", () => {
	const picker = openQuickPicker([]);
	const all = rowIds(props(picker.describe(withPicker)));
	expect(all).toHaveLength(QUICK_MODELS.length);

	quickAct(picker, "scope", "provider:openai");
	let p = props(picker.describe(withPicker));
	expect(p.scope).toBe("provider:openai");
	expect(rowIds(p).toSorted()).toEqual(["openai/gpt-5.6", "openai/gpt-5.6-mini"]);
	expect(p.total).toBe(2);

	// Search applies within the scope.
	for (const char of "mini") picker.handleInput(char);
	const searched = props(picker.describe(withPicker));
	expect(rowIds(searched)).toEqual(["openai/gpt-5.6-mini"]);
	// The row shows the model id alone (its provider in the tooltip); the hit marks the id.
	const label = "gpt-5.6-mini";
	const row = searched.items?.find(item => item.id === "openai/gpt-5.6-mini");
	expect(row?.label).toBe(label);
	expect(row?.title?.startsWith("openai")).toBe(true);
	const [[from, to]] = searched.hits?.["openai/gpt-5.6-mini"] ?? [[0, 0]];
	expect(label.slice(from, to)).toBe("mini");
	quickAct(picker, "clear");

	quickAct(picker, "scope", "provider:openai");
	p = props(picker.describe(withPicker));
	expect(p.scope).toBe("all");
	expect(rowIds(p).toSorted()).toEqual(all.toSorted());

	picker.handleInput("\t");
	expect(props(picker.describe(withPicker)).scope).toBe("provider:anthropic");
	picker.handleInput("\x1b[Z");
	picker.handleInput("\x1b[Z");
	expect(props(picker.describe(withPicker)).scope).toBe("provider:openai");

	// `@` quick roles drop the scopes and come back to All.
	picker.handleInput("@");
	expect(props(picker.describe(withPicker)).scopes).toBeUndefined();
	picker.handleInput("\x7f");
	expect(props(picker.describe(withPicker)).scope).toBe("all");
});

test("←/→ and the slider set the thinking level a pick applies, clamped to the picked model", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);
	const level = () => props(picker.describe(withPicker)).level;

	// Untouched, a pick leaves the level to the host.
	picker.handleInput("\r");
	expect(picked).toEqual(["session:demo/demo"]);

	picker.handleInput("\x1b[C"); // →
	expect(level()?.value).toBe("xhigh");
	picker.handleInput("\x1b[C"); // stops at the top step
	expect(level()?.value).toBe("xhigh");
	picker.handleInput("\x1b[D"); // ←
	picker.handleInput("\x1b[D");
	expect(level()?.value).toBe("medium");
	quickAct(picker, "level", "low");
	expect(level()?.value).toBe("low");
	quickAct(picker, "level", "bogus");
	expect(level()?.value).toBe("low");
	picker.handleInput("\r");
	expect(picked.at(-1)).toBe("session:demo/demo:low");

	// The pending level clamps to the highlighted model's ladder.
	quickAct(picker, "level", "xhigh");
	picker.handleNativeEvent({ type: "select", key: "", item: "demo/demo-lite" });
	expect(level()?.value).toBe("medium");
	picker.handleNativeEvent({ type: "activate", key: "", item: "demo/demo-lite" });
	expect(picked.at(-1)).toBe("session:demo/demo-lite:medium");

	// A model without reasoning gets no level.
	picker.handleNativeEvent({ type: "activate", key: "", item: "local/tiny" });
	expect(picked.at(-1)).toBe("session:local/tiny");
});

test("Esc keeps a level moved on the current model's row and drops one moved elsewhere", () => {
	const picked: string[] = [];
	const picker = openQuickPicker(picked);

	// Untouched: Esc only closes.
	picker.handleInput("\x1b");
	expect(picked).toEqual(["cancel"]);

	picker.handleInput("\x1b[D"); // ← on demo/demo (current)
	picker.handleInput("\x1b");
	expect(picked.slice(1)).toEqual(["keep:medium", "cancel"]);

	// Moved while another model is highlighted: Esc leaves the session's level alone.
	const other = openQuickPicker(picked);
	picked.length = 0;
	other.handleNativeEvent({ type: "select", key: "", item: "demo/demo-lite" });
	quickAct(other, "level", "low");
	other.handleInput("\x1b");
	expect(picked).toEqual(["cancel"]);
});

test("the thinking slider is session-only: none in task mode or among quick roles", () => {
	const picker = openQuickPicker([]);
	expect(props(picker.describe(withPicker)).level).not.toBeNull();
	quickAct(picker, "task");
	expect(props(picker.describe(withPicker)).level).toBeNull();
	quickAct(picker, "task");
	picker.handleInput("@");
	const p = props(picker.describe(withPicker));
	expect(p.level).toBeNull();
	expect(p.scopes).toBeUndefined();
	expect(p.actions).toEqual([]);
});

test("shows a non-default service tier's own speed aggregate", () => {
	const perf = new Map([
		["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
		["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
		["anthropic/claude-opus-5", { samples: 3, tps: 40, ttftMs: 300 }],
		["openai/gpt-5.6-mini@priority", { samples: 1, tps: 90, ttftMs: 200 }],
	]);
	const hub = new ModelHubComponent(
		ui,
		{
			...source({ default: "demo/demo" }, ["demo/demo"]),
			modelPerf: perf,
			serviceTierFor: model => (model.provider === "openai" ? "ultrafast" : undefined),
		},
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	const items = props(hub.describe(withPicker)).items ?? [];
	const speed = (id: string) => items.find(entry => entry.id === id)?.facts?.speed;
	// The tier the host would send wins over the standard aggregate.
	expect(speed("openai/gpt-5.6")).toBe("300 ultrafast");
	// No tier configured for the family: the standard aggregate, unlabeled.
	expect(speed("anthropic/claude-opus-5")).toBe("40");
	// Only a tier aggregate exists: show it rather than nothing.
	expect(speed("openai/gpt-5.6-mini")).toBe("90 priority");
});

test("a rejected compaction edit remains editable in the model hub until corrected or cancelled", () => {
	let rejected = true;
	const hub = new ModelHubComponent(
		ui,
		source({ default: "demo/demo" }, []),
		registry(MODELS),
		MODELS.map(entry => ({ model: entry })),
		{
			onAssign: () => {},
			onUnassign: () => {},
			onCancel: () => {},
			onCompactionPointChange: () => (rejected ? { kind: "error", message: "synthetic project shadow" } : undefined),
		},
	);
	hubs.push(hub);
	const act = (act: string, value?: string) =>
		hub.handleNativeEvent({ type: "action", key: "", act, value, mods: [] });
	act("scope", "roles");
	hub.handleNativeEvent({ type: "select", key: "", item: "role:default" });
	act("roles:compaction");
	hub.handleInput("90k");
	act("compactionPoint");
	expect(props(hub.describe(withPicker)).focus).toBe("strip");
	const rejectedText = stripVTControlCharacters(hub.render(120).join("\n"));
	expect(rejectedText).toContain("90k");

	rejected = false;
	hub.handleInput("\r");
	expect(props(hub.describe(withPicker)).focus).toBe("list");
	expect(props(hub.describe(withPicker)).selected).toBe("role:default");
	act("roles:compaction");
	act("cancel");
	expect(props(hub.describe(withPicker)).focus).toBe("list");
	expect(props(hub.describe(withPicker)).selected).toBe("role:default");
});

test("classic model previews track compaction trigger changes", () => {
	let tokens = 90_000;
	let revision = 0;
	const settings = {
		...source({ default: "demo/demo" }, []),
		get revision() {
			return revision;
		},
		compactionPointFor: () => ({ tokens, source: "global", draft: String(tokens) }),
	};
	const selected = MODELS[2]!;
	const hub = new ModelHubComponent(
		ui,
		settings,
		registry([selected]),
		[{ model: selected }],
		{ onAssign: () => {}, onUnassign: () => {}, onCancel: () => {} },
		{ currentSelector: "demo/demo" },
	);
	hubs.push(hub);
	hub.handleNativeEvent({ type: "action", key: "", act: "scope", value: "all", mods: [] });
	hub.handleNativeEvent({ type: "select", key: "", item: "demo/demo" });
	const rendered = () => stripVTControlCharacters(hub.render(240).join("\n"));
	expect(rendered()).toMatch(/\b(?:90,?000|90(?:\.0)?k)\b/i);

	tokens = 160_000;
	revision++;
	expect(rendered()).toMatch(/\b(?:160,?000|160(?:\.0)?k)\b/i);
	expect(rendered()).not.toMatch(/\b(?:90,?000|90(?:\.0)?k)\b/i);
});
