import { beforeAll, describe, expect, it } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { SessionInfoOverlay } from "@oh-my-pi/pi-tui/overlays/session-info-overlay";
import { UsageDashboardComponent } from "@oh-my-pi/pi-tui/overlays/usage-dashboard";
import { createUsageRowBlock } from "@oh-my-pi/pi-tui/overlays/usage-row";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";

const cx = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };
/** An older terminal without the data-first kinds. */
const plainCx = { ...cx, supports: (kind: string) => !["meter", "chart", "agent"].includes(kind) };

function isNode(child: NativeChild | undefined): child is NativeNode {
	return child !== undefined && typeof child === "object" && "k" in child && typeof child.k === "string";
}

function findAll(root: NativeNode, pred: (n: NativeNode) => boolean): NativeNode[] {
	const out: NativeNode[] = [];
	const walk = (n: NativeNode): void => {
		if (pred(n)) out.push(n);
		for (const child of n.c ?? []) if (isNode(child)) walk(child);
	};
	walk(root);
	return out;
}

function report(provider: string, email: string, limits: UsageReport["limits"]): UsageReport {
	return { provider, fetchedAt: Date.now(), limits, metadata: { email } };
}

function limit(
	provider: string,
	windowId: string,
	label: string,
	usedFraction: number,
	status: "ok" | "warning" | "exhausted",
): UsageReport["limits"][number] {
	return {
		id: `${provider}:${windowId}:${label}`,
		label,
		scope: { provider, windowId },
		window: { id: windowId, label: windowId },
		amount: { usedFraction, unit: "percent" },
		status,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("UsageDashboardComponent.describe", () => {
	function plain(n: NativeNode): string {
		const p = n.p as { text?: string; spans?: readonly { t: string }[] } | undefined;
		return p?.text ?? p?.spans?.map(s => s.t).join("") ?? "";
	}
	function dashboard(
		reports: UsageReport[],
		refresh?: () => Promise<UsageReport[] | null>,
		activity: { day: string; cost: number; requests: number }[] = [],
		requestRender: () => void = () => {},
	): UsageDashboardComponent {
		return new UsageDashboardComponent({
			reports,
			renderDetail: () => "",
			// Pushes synchronously, so the activity is in place once constructed.
			loadActivity: async push => push(activity),
			refresh,
			requestRender: () => requestRender(),
			onClose: () => {},
		});
	}

	it("draws quota windows as meters of the used fraction, clamped on overage, and progress bars without `meter`", () => {
		const reports = [
			report("anthropic", "a@test", [
				limit("anthropic", "5h", "Claude 5h", 0.9, "warning"),
				limit("anthropic", "7d", "Claude Weekly", 1.4, "exhausted"),
			]),
		];
		const meters = findAll(dashboard(reports).describe(cx), n => n.k === "meter").map(n => n.p);
		expect(meters).toEqual([
			expect.objectContaining({ value: 0.9, style: "bar", tone: "warning" }),
			expect.objectContaining({ value: 1, style: "bar", tone: "error" }),
		]);
		const fallback = dashboard(reports).describe(plainCx);
		expect(findAll(fallback, n => n.k === "meter" || n.k === "chart")).toEqual([]);
		expect(findAll(fallback, n => n.k === "progress").map(n => n.p)).toEqual([
			expect.objectContaining({ value: 0.9, tone: "warning" }),
			expect.objectContaining({ value: 1, tone: "error" }),
		]);
	});

	it("labels an exhausted bar-less quota with no amount as Exhausted in the error tone", () => {
		// Antigravity reports a spent quota as an unknown-unit limit with no
		// measurable amount; without a label it would read as a red "No data".
		const reports = [
			report("google-antigravity", "a@test", [
				{
					id: "agy:quota",
					label: "Gemini quota",
					scope: { provider: "google-antigravity", windowId: "quota" },
					amount: { remaining: 0, unit: "unknown" },
					status: "exhausted",
				},
			]),
		];
		const amounts = findAll(dashboard(reports).describe(cx), n => n.p?.role === "omp.usage.amount").map(n =>
			n.k === "text" ? n.p?.spans : undefined,
		);
		expect(amounts).toEqual([[{ t: "Exhausted", s: "error" }]]);
	});

	it("switches to the per-account detail table when the Details tab is selected", () => {
		const component = dashboard([
			report("anthropic", "a@test", [limit("anthropic", "5h", "Claude 5h", 0.25, "ok")]),
			report("anthropic", "b@test", [limit("anthropic", "5h", "Claude 5h", 0.75, "warning")]),
		]);
		const overview = component.describe(cx);
		component.handleNativeEvent({ type: "select", key: "head/tabs", item: "detail" });
		const detail = component.describe(cx);
		expect(detail).not.toBe(overview);
		const tabs = findAll(detail, n => n.k === "tabs")[0];
		expect(tabs?.p).toEqual(expect.objectContaining({ active: "detail" }));
		// One row per account in the detail table, not the bucket mean.
		const table = findAll(detail, n => n.k === "table")[0];
		const left =
			table?.k === "table"
				? table.p?.rows.map(row => {
						const value = row.cells.left;
						return Number.parseFloat(typeof value === "string" ? value : (value ?? []).map(s => s.t).join(""));
					})
				: undefined;
		expect(left).toEqual([75, 25]);
	});

	it("leads with the tightest quota and the activity's headline figures", () => {
		const now = new Date();
		const iso = (back: number): string => {
			const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
			return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		};
		const component = dashboard(
			[
				report("anthropic", "a@test", [
					limit("anthropic", "5h", "Claude 5h", 0.2, "ok"),
					limit("anthropic", "7d", "Claude Weekly", 0.9, "warning"),
				]),
			],
			undefined,
			[
				{ day: iso(0), cost: 12.5, requests: 40 },
				{ day: iso(1), cost: 30, requests: 90 },
				{ day: iso(2), cost: 4, requests: 10 },
				{ day: iso(100), cost: 200, requests: 600 },
			],
		);
		const root = component.describe(cx);
		const tiles = findAll(root, n => n.p?.role === "omp.usage.stat").map(tile =>
			findAll(tile, n => n.k === "text").map(plain),
		);
		expect(tiles.map(tile => tile[1])).toEqual(["10% left", "$247", "$46.50", "$200"]);
		expect(tiles[0]?.[2]).toContain("Claude Weekly");
		expect(tiles.slice(1).map(tile => Number.parseInt(/(\d+) requests/.exec(tile[2] ?? "")?.[1] ?? "", 10))).toEqual([
			740, 140, 600,
		]);
	});

	it("shows one empty state when nothing is used anywhere", () => {
		const root = dashboard([report("zai", "z@test", [limit("zai", "5h", "Usage", 0, "ok")])]).describe(cx);
		const empty = findAll(root, n => n.p?.role === "omp.usage.empty")[0];
		expect(empty).toBeDefined();
		expect(findAll(root, n => n.p?.role === "omp.usage.stats" || n.k === "chart")).toEqual([]);
	});

	it("keeps a failed sync visible instead of the empty state when the painted history is empty", async () => {
		const settled = Promise.withResolvers<void>();
		let renders = 0;
		const component = new UsageDashboardComponent({
			reports: [],
			renderDetail: () => "",
			loadActivity: async push => {
				push([]);
				throw new Error("database is locked");
			},
			// The push renders once; the settled load renders again.
			requestRender: () => {
				if (++renders === 2) settled.resolve();
			},
			onClose: () => {},
		});
		await settled.promise;
		const root = component.describe(cx);
		expect(findAll(root, n => n.p?.role === "omp.usage.empty")).toEqual([]);
		expect(findAll(root, n => n.p?.role === "omp.usage.section.meta").map(plain)).toContain(
			"not synced (database is locked)",
		);
	});

	it("re-fetches reports from the Refresh button like the r key", async () => {
		const fresh = [report("openai", "c@test", [limit("openai", "5h", "Codex 5h", 0.5, "ok")])];
		let calls = 0;
		let fetched = Promise.withResolvers<UsageReport[] | null>();
		let onRender = (): void => {};
		const component = dashboard(
			[report("anthropic", "a@test", [limit("anthropic", "5h", "Claude 5h", 0.25, "ok")])],
			() => {
				calls++;
				return fetched.promise;
			},
			[],
			() => onRender(),
		);
		component.handleNativeEvent({ type: "action", key: "head/refresh", act: "refresh", mods: [] });
		expect(calls).toBe(1);
		const providers = (): (string | undefined)[] =>
			findAll(component.describe(cx), n => n.p?.role === "omp.usage.provider").map(n => n.key);
		const refreshed = Promise.withResolvers<void>();
		onRender = () => {
			if (providers()[0] === "openai") refreshed.resolve();
		};
		fetched.resolve(fresh);
		await refreshed.promise;
		expect(providers()).toEqual(["openai"]);
		fetched = Promise.withResolvers();
		component.handleInput("r");
		expect(calls).toBe(2);
	});

	it("charts a year of activity with per-day tooltips, blank after today", () => {
		const now = new Date();
		const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		const component = dashboard([], undefined, [{ day: today, cost: 0.13, requests: 2 }]);
		const chart = findAll(component.describe(cx), n => n.k === "chart" && n.p?.kind === "heatmap")[0];
		if (chart?.k !== "chart") throw new Error("no chart");
		const weekday = (now.getDay() + 6) % 7;
		const last = chart.p?.cells?.[weekday]?.length ?? 0;
		expect(last).toBe(53);
		expect(chart.p?.cells?.[weekday]?.[52]).toBe(1);
		expect(chart.p?.tips?.[weekday]?.[52]).toMatch(/^\w{3} \d{1,2} \w{3} · \$0\.13 · 2 requests$/);
		if (weekday < 6) expect(chart.p?.cells?.[6]?.[52]).toBeNull();
		expect(chart.p?.summary).toBe("$0.13 · 2 requests · last 53 weeks");
	});
});

describe("SessionInfoOverlay.describe", () => {
	const dim = (key: string): string => theme.fg("dim", `${key}:`);
	// Built per test: the theme initializes in `beforeAll`, after this block is collected.
	const fullReport = (): string =>
		`${dim("File")} /tmp/s.jsonl\n${dim("ID")} abc-123\n${dim("Local")} /tmp/s/local\n` +
		`\n${theme.bold("Provider")}\n${dim("Model")} claude-sonnet-4-5\n` +
		`\n${theme.bold("Messages")}\n${dim("User")} 6\n${dim("Tool Calls")} 23\n${dim("Total")} 29\n\n` +
		`${dim("Append-Only")} ${theme.fg("success", "active")} (setting: auto)\n` +
		`${theme.bold("Tokens")}\n${dim("Input")} 182,440\n${dim("Total")} 182,440\n` +
		`\n${theme.bold("Cost")}\n${dim("Total")} 0.4127\n` +
		`\n${theme.bold("MCP Servers")}\n` +
		`${dim("github")} ${theme.fg("success", "connected")} ${theme.fg("dim", "(4 tools)")}\n`;
	const kvItems = (root: NativeNode, role: string) =>
		findAll(root, n => n.p?.role === role)
			.flatMap(n => (n.k === "kv" ? (n.p?.items ?? []) : []))
			.map(item => ({
				k: typeof item.k === "string" ? item.k : item.k.map(s => s.t).join(""),
				v: typeof item.v === "string" ? item.v : item.v.map(s => s.t).join(""),
			}));

	it("leads with the session id, then the file and local directory, each copying its own value", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {});
		const root = overlay.describe(cx);
		const copies = findAll(root, n => n.p?.role === "omp.info.copy");
		expect(
			copies.map(n =>
				findAll(n, child => child.k === "text")
					.map(child =>
						child.k === "text" ? (child.p?.text ?? child.p?.spans?.map(s => s.t).join("") ?? "") : "",
					)
					.join(""),
			),
		).toEqual(["abc-123", "/tmp/s.jsonl", "/tmp/s/local"]);
		expect(JSON.stringify(root)).not.toContain("\x1b");
	});

	it("does not offer to copy an in-memory session's file", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, `${dim("File")} In-memory\n`, () => {});
		const root = overlay.describe(cx);
		expect(findAll(root, n => n.p?.role === "omp.info.copy")).toEqual([]);
	});

	it("keeps message, token, cost, model and MCP facts assigned to their own sections", () => {
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {});
		const root = overlay.describe(cx);
		expect(kvItems(root, "omp.info.nums")).toEqual([
			{ k: "User", v: "6" },
			{ k: "Tool calls", v: "23" },
			{ k: "Input", v: "182,440" },
			{ k: "Total", v: "$0.4127" },
		]);
		expect(kvItems(root, "omp.info.total").map(item => item.v)).toEqual(["29", "182,440"]);
		const provider = kvItems(root, "omp.info.kv");
		expect(provider.find(item => item.k === "Model")?.v).toBe("claude-sonnet-4-5");
		expect(provider.find(item => item.k === "Append-only")?.v).toContain("active");
		expect(kvItems(root, "omp.info.names").map(item => item.k)).toEqual(["github"]);
	});

	it("shows the context window as a figure over a meter, or a progress bar without meters", () => {
		const context = { tokens: 41_200, contextWindow: 200_000, percent: 20.6 };
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {}, context);
		const root = overlay.describe(cx);
		const [meter] = findAll(root, n => n.k === "meter");
		if (meter?.k !== "meter") throw new Error("no context meter");
		expect(meter?.p?.value).toBeCloseTo(0.206);
		const plain = new SessionInfoOverlay({ terminal: { rows: 20 } }, fullReport(), () => {}, context).describe(
			plainCx,
		);
		expect(findAll(plain, n => n.k === "meter")).toEqual([]);
		expect(findAll(plain, n => n.k === "progress")).toHaveLength(1);
	});

	it("closes from the Close button like Esc", () => {
		let closed = 0;
		const overlay = new SessionInfoOverlay({ terminal: { rows: 20 } }, "", () => closed++);
		overlay.handleNativeEvent({ type: "action", key: "actions/close", act: "close", mods: [] });
		expect(closed).toBe(1);
	});
});

describe("createUsageRowBlock describe", () => {
	it("declares throughput as a rate and omits it for sub-100ms requests", () => {
		const usage = {
			input: 100,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const fast = createUsageRowBlock(usage, 50).describe?.(cx);
		const slow = createUsageRowBlock(usage, 2000).describe?.(cx);
		if (!fast || !slow) throw new Error("usage row did not describe");
		expect(findAll(fast, n => n.k === "rate")).toEqual([]);
		expect(findAll(slow, n => n.k === "rate").map(n => n.p)).toEqual([{ value: 250, unit: "tok/s" }]);
	});

	it("shows the turn's time on the terminal's clock, re-describing when it changes", () => {
		const usage = {
			input: 100,
			output: 500,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 600,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const timestamp = new Date(2026, 0, 1, 18, 5, 9);
		const block = createUsageRowBlock(usage, 2000, undefined, timestamp.getTime());
		const shown = (hour12: boolean | undefined) => {
			const described = block.describe?.({ ...cx, hour12 });
			if (!described) throw new Error("usage row did not describe");
			const [line] = findAll(described, n => n.k === "text");
			return { line: JSON.stringify(line), title: String(described.p?.title) };
		};
		// No clock from the terminal keeps the log-style stamp.
		expect(shown(undefined).line).toContain('"18:05 · ');
		expect(shown(undefined).title).toBe("2026-01-01 18:05:09");
		const twelve = shown(true);
		const clock = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: true });
		const clockWithSeconds = new Intl.DateTimeFormat(undefined, {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: true,
		});
		expect(twelve.line).toContain(`"${clock.format(timestamp)} · `);
		expect(twelve.title).toBe(`2026-01-01 ${clockWithSeconds.format(timestamp)}`);
		const twentyFour = shown(false);
		expect(twentyFour.line).toContain('"18:05 · ');
		expect(twentyFour.title).toBe("2026-01-01 18:05:09");
		expect(shown(undefined).title).toBe("2026-01-01 18:05:09");
	});
});
