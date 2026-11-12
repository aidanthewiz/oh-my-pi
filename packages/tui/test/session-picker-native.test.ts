import { beforeAll, describe, expect, it } from "bun:test";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { OverlayPanel } from "../src/chrome/overlay-box";
import { TextFormField } from "../src/components/form";
import type { DescribeContext, NativeNode } from "../src/native/node";
import { type HistorySearchEntry, HistorySearchComponent } from "../src/overlays/history-search";
import { type SessionSelectorEntry, SessionSelectorComponent } from "../src/overlays/session-selector";
import { initTheme } from "../src/theme";

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

const HOUR = 3_600_000;

function session(id: string, title: string, ageMs: number, cwd = "/work/app"): SessionSelectorEntry {
	return {
		path: `${cwd}/.omp/${id}.jsonl`,
		id,
		cwd,
		title,
		modified: new Date(Date.now() - ageMs),
		size: 5_600,
		firstMessage: `${title} prompt`,
		allMessagesText: `${title} prompt ${title} answer`,
		status: "complete",
	};
}

function props(root: NativeNode): TspPickerProps {
	expect(root.k).toBe("picker");
	return root.p as TspPickerProps;
}

function type(component: { handleInput(data: string): void }, text: string): void {
	for (const char of text) component.handleInput(char);
}

/** Resolves on the first render request after which the picker props satisfy `ready`. */
function renderedWhen(selector: SessionSelectorComponent, ready: (p: TspPickerProps) => boolean): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	selector.setOnRequestRender(() => {
		const root = selector.describe(withPicker);
		if (root.k === "picker" && ready(props(root))) resolve();
	});
	return promise;
}

describe("session selector picker", () => {
	it("refreshes cached picker, list and preview labels without replacing the entry", () => {
		const entry = session("portable", "Plain title", 0);
		let display = "🧪 TITLE: Plain title";
		entry.titlePresentation = () => display;
		const selector = new SessionSelectorComponent(
			[entry],
			() => {},
			() => {},
			() => {},
			{ onDelete: async () => true },
		);
		try {
			for (const label of ["🧪 TITLE: Plain title", "Plain title", "🧪 TITLE: Plain title"]) {
				display = label;
				const picker = selector.describe(withPicker);
				expect(props(picker).items?.find(item => item.id === entry.path)?.label).toBe(label);
				expect((picker.c as NativeNode[])[0]).toMatchObject({
					k: "text",
					p: { text: label, role: "omp.picker.title" },
				});
				const list = selector.describe(withoutPicker);
				expect(JSON.stringify(list)).toContain(`"label":"${label}"`);
				expect(selector.render(100).join("\n")).toContain(label);
			}
			expect(entry.title).toBe("Plain title");
			type(selector, "Plain title");
			expect(props(selector.describe(withPicker)).selected).toBe(entry.path);
			selector.handleNativeEvent({ type: "action", key: "", act: "delete", mods: [] });
			expect(props(selector.describe(withPicker)).confirm?.text).toContain("🧪 TITLE: Plain title");
		} finally {
			selector.dispose();
		}
	});

	it("refreshes a fork's cached parent badge and preview when only its parent presentation changes", () => {
		const parent = session("parent", "Parent title", 1);
		const child = session("child", "Child title", 0);
		child.parentSessionPath = parent.path;
		let label = "🧪 PARENT: Parent title";
		parent.titlePresentation = () => label;
		const selector = new SessionSelectorComponent(
			[child, parent],
			() => {},
			() => {},
			() => {},
			{
				currentSessionPath: child.path,
			},
		);
		try {
			selector.describe(withPicker);
			label = "Parent title";
			const root = selector.describe(withPicker);
			expect(props(root).items?.find(item => item.id === child.path)?.badges).toContainEqual({
				text: "fork",
				title: "Forked from “Parent title”",
			});
			expect(JSON.stringify(root.c)).not.toContain("🧪 PARENT:");
			expect(JSON.stringify(root.c)).toContain("Parent title");
		} finally {
			selector.dispose();
		}
	});

	it("finds and ranks a displayed card code after presentation changes", () => {
		const titled = session("title-match", "Repair cache", 0);
		const transcript = session("transcript-match", "Investigate writes", 0);
		titled.modified = new Date("2025-06-01T12:00:00.000Z");
		transcript.modified = new Date("2025-06-01T12:00:01.000Z");
		transcript.allMessagesText = "RCODE appears in the transcript";
		let display = "🧪 RCODE: Repair cache";
		titled.titlePresentation = () => display;
		const selector = new SessionSelectorComponent(
			[transcript, titled],
			() => {},
			() => {},
			() => {},
		);
		try {
			type(selector, "RCODE");
			expect(props(selector.describe(withPicker)).order).toEqual([titled.path, transcript.path]);
			display = "Repair cache";
			selector.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
			type(selector, "RCODE");
			expect(props(selector.describe(withPicker)).order).toEqual([transcript.path]);
			display = "🧪 RCODE: Repair cache";
			selector.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
			type(selector, "RCODE");
			expect(props(selector.describe(withPicker)).order).toEqual([titled.path, transcript.path]);
		} finally {
			selector.dispose();
		}
	});

	const today = session("a", "Alpha", 0);
	const todayToo = session("b", "Beta", 1);
	const old = session("c", "Gamma", 40 * 24 * HOUR);
	const others = session("d", "Delta", 3 * 24 * HOUR, "/work/other");

	function make(opts: { deleted?: string[]; resumed?: string[]; standalone?: boolean } = {}) {
		return new SessionSelectorComponent(
			[today, todayToo, old],
			s => opts.resumed?.push(s.id),
			() => {},
			() => {},
			{
				onDelete: async s => {
					opts.deleted?.push(s.id);
					return true;
				},
				loadAllSessions: async () => ({ sessions: [today, todayToo, others, old] }),
				currentSessionPath: todayToo.path,
				standalone: opts.standalone,
			},
		);
	}

	it("describes a grouped cards picker with a preview when the terminal has the kind, else the card", () => {
		const selector = make();
		expect(selector.nativeSheet(withPicker)).toBe(true);
		const root = selector.describe(withPicker);
		const p = props(root);
		expect(p.layout).toBe("cards");
		expect(p.order).toEqual([
			{ group: "today-0", label: "Today", count: 2 },
			today.path,
			todayToo.path,
			{ group: "earlier-2", label: "Earlier", count: 1 },
			old.path,
		]);
		expect(p.selected).toBe(todayToo.path);
		expect(p.current).toEqual([todayToo.path]);
		const beta = p.items?.find(item => item.id === todayToo.path);
		expect(beta?.badges?.map(b => b.text)).toEqual(["current"]);
		expect(beta?.dot).toBe("success");
		const preview = root.c as NativeNode[];
		expect(preview[0]).toMatchObject({ k: "text", p: { text: "Beta", role: "omp.picker.title" } });
		expect(preview.find(child => child.k === "section")?.p).toEqual({ head: "Conversation" });

		expect(selector.nativeSheet(withoutPicker)).toBe(false);
		expect(selector.describe(withoutPicker).k).toBe("card");
	});

	it("fills the screen surface in the standalone app", () => {
		const selector = make({ standalone: true });
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(props(selector.describe(withPicker)).size).toBe("screen");
	});

	it("keeps the catalogue while typing: only order, hits and selection follow the query", () => {
		const selector = make();
		const before = props(selector.describe(withPicker));
		type(selector, "gam");
		const after = props(selector.describe(withPicker));
		expect(after.items).toBe(before.items);
		expect(after.query).toBe("gam");
		expect(after.order).toEqual([old.path]);
		expect(after.hits).toEqual({ [old.path]: [[0, 3]] });
		expect(after.selected).toBe(old.path);
	});

	it("runs pointer events down the keys' paths", async () => {
		const resumed: string[] = [];
		const deleted: string[] = [];
		const selector = make({ resumed, deleted });

		selector.handleNativeEvent({ type: "select", key: "", item: old.path });
		expect(props(selector.describe(withPicker)).selected).toBe(old.path);
		selector.handleNativeEvent({ type: "action", key: "", act: "resume", mods: [] });
		expect(resumed).toEqual(["c"]);

		selector.handleNativeEvent({ type: "action", key: "", act: "delete", mods: [] });
		expect(props(selector.describe(withPicker)).confirm?.act).toBe("delete-confirm");
		selector.handleNativeEvent({ type: "action", key: "", act: "cancel", mods: [] });
		expect(props(selector.describe(withPicker)).confirm).toBeNull();

		// Backspace on an empty query opens the same confirm strip.
		selector.handleInput("\x7f");
		const closed = renderedWhen(selector, p => p.confirm === null);
		selector.handleNativeEvent({ type: "action", key: "", act: "delete-confirm", mods: [] });
		await closed;
		expect(deleted).toEqual(["c"]);
		expect(props(selector.describe(withPicker)).order).not.toContain(old.path);

		const loaded = renderedWhen(
			selector,
			p => p.state === "ready" && p.items?.some(item => item.id === others.path) === true,
		);
		selector.handleNativeEvent({ type: "action", key: "", act: "scope", mods: [] });
		expect(props(selector.describe(withPicker)).state).toBe("loading");
		await loaded;
		const all = props(selector.describe(withPicker));
		expect(all.items?.find(item => item.id === others.path)?.detail).toEqual([
			{ t: "/work/", s: "path dim" },
			{ t: "other", s: "path" },
		]);
	});
});

describe("session selector rename", () => {
	interface RenameCall {
		id: string;
		title: string;
	}

	function makeRename(renamed?: { calls: RenameCall[]; result?: string | null }) {
		// Fresh entries per test: rename mutates the shared entry in place.
		const entries = [session("a", "Alpha", 0), session("b", "Beta", 1), session("c", "Gamma", 40 * 24 * HOUR)];
		const selector = new SessionSelectorComponent(
			entries,
			() => {},
			() => {},
			() => {},
			{
				...(renamed
					? {
							onRename: async (s, title) => {
								renamed.calls.push({ id: s.id, title });
								return renamed.result === undefined ? title : renamed.result;
							},
						}
					: {}),
				currentSessionPath: entries[1]!.path,
			},
		);
		return { selector, beta: entries[1]! };
	}

	/** The open rename dialog and its field, via the ANSI card (the native picker props have no text-input affordance). */
	function renameDialogOf(selector: SessionSelectorComponent) {
		const card = selector.describe(withoutPicker);
		const dialog = (card.c ?? []).find(
			(child): child is OverlayPanel => child instanceof OverlayPanel && child.title === "Rename Session",
		);
		if (!dialog) return undefined;
		const field = dialog.children.find((child): child is TextFormField => child instanceof TextFormField);
		if (!field) return undefined;
		return { dialog, field };
	}

	it("shows the rename action only when onRename is set", () => {
		const withHook = makeRename({ calls: [] });
		expect(props(withHook.selector.describe(withPicker)).actions?.find(a => a.id === "rename")?.label).toBe("Rename");
		const withoutHook = makeRename();
		expect(props(withoutHook.selector.describe(withPicker)).actions?.some(a => a.id === "rename")).toBe(false);
	});

	it("opens the rename dialog prefilled with the current title on F2", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x1bOQ");
		const opened = renameDialogOf(selector);
		expect(opened).toBeDefined();
		expect(opened!.field.getValue()).toBe(beta.title ?? "");
	});
	it("opens the rename dialog on a Kitty F2 press instead of forwarding it to search", () => {
		const { selector, beta } = makeRename({ calls: [] });
		selector.handleInput("\x1b[Q");
		const opened = renameDialogOf(selector);
		expect(opened?.field.getValue()).toBe(beta.title);
	});

	it("commits on Enter via onRename and updates the row in place", async () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		selector.handleInput("\x1bOQ");
		type(selector, " Prime");
		const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Beta Prime");
		selector.handleInput("\r");
		await updated;
		expect(renamed.calls).toEqual([{ id: "b", title: "Beta Prime" }]);
		const after = props(selector.describe(withPicker));
		expect(after.selected).toBe(beta.path);
		expect(renameDialogOf(selector)).toBeUndefined();
	});

	it("cancels on Esc without changes", () => {
		const renamed = { calls: [] as RenameCall[] };
		const { selector, beta } = makeRename(renamed);
		selector.handleInput("\x1bOQ");
		expect(renameDialogOf(selector)).toBeDefined();
		type(selector, " Prime");
		selector.handleInput("\x1b");
		expect(renameDialogOf(selector)).toBeUndefined();
		const after = props(selector.describe(withPicker));
		expect(after.items?.find(item => item.id === beta.path)?.label).toBe("Beta");
		expect(after.selected).toBe(beta.path);
	});

	it("renders the rename editor instead of the picker while it is open", () => {
		const { selector } = makeRename({ calls: [] });
		// The picker kind has no text-input affordance: while renaming, the
		// component must describe the card path so the field is visible.
		expect(selector.describe(withPicker).k).toBe("picker");
		selector.handleInput("\x1bOQ");
		expect(selector.describe(withPicker).k).toBe("card");
		expect(selector.nativeSheet(withPicker)).toBe(false);
		expect(renameDialogOf(selector)).toBeDefined();
	});

	it.each(["keyboard", "native"] as const)(
		"resumes the same selected path after rename changes filtered ranking (%s)",
		async action => {
			const alpha = { ...session("a", "Alpha", 0), allMessagesText: "needle" };
			const beta = { ...session("b", "Beta", 0), allMessagesText: "needle" };
			alpha.modified = new Date("2025-06-01T12:00:01.000Z");
			beta.modified = new Date("2025-06-01T12:00:00.000Z");
			const resumed: string[] = [];
			const selector = new SessionSelectorComponent(
				[alpha, beta],
				selected => resumed.push(selected.path),
				() => {},
				() => {},
				{ onRename: async () => "needle" },
			);
			try {
				type(selector, "needle");
				expect(props(selector.describe(withPicker)).order).toEqual([alpha.path, beta.path]);
				selector.handleInput("\x1b[B");
				expect(props(selector.describe(withPicker)).selected).toBe(beta.path);
				if (action === "keyboard") selector.handleInput("\x1bOQ");
				else selector.handleNativeEvent({ type: "action", key: "", act: "rename", mods: [] });
				for (let index = 0; index < 4; index++) selector.handleInput("\x7f");
				type(selector, "needle");
				const updated = renderedWhen(selector, p => p.order?.[0] === beta.path);
				selector.handleInput("\r");
				await updated;
				const after = props(selector.describe(withPicker));
				expect(after.order).toEqual([beta.path, alpha.path]);
				expect(after.selected).toBe(beta.path);
				if (action === "keyboard") selector.handleInput("\r");
				else selector.handleNativeEvent({ type: "action", key: "", act: "resume", mods: [] });
				expect(resumed).toEqual([beta.path]);
			} finally {
				selector.dispose();
			}
		},
	);

	it("filters the canonical renamed title rather than its stale cached title", async () => {
		const beta = { ...session("b", "Beta", 0), firstMessage: "shared", allMessagesText: "shared" };
		const selector = new SessionSelectorComponent(
			[beta],
			() => {},
			() => {},
			() => {},
			{ onRename: async () => "Zebra" },
		);
		try {
			type(selector, "Beta");
			expect(props(selector.describe(withPicker)).order).toEqual([beta.path]);
			selector.handleInput("\x1bOQ");
			for (let index = 0; index < 4; index++) selector.handleInput("\x7f");
			type(selector, "Zebra");
			const updated = renderedWhen(selector, p => p.items?.find(item => item.id === beta.path)?.label === "Zebra");
			selector.handleInput("\r");
			await updated;
			expect(props(selector.describe(withPicker)).order).toEqual([]);
			selector.handleNativeEvent({ type: "action", key: "", act: "clear", mods: [] });
			type(selector, "Zebra");
			expect(props(selector.describe(withPicker)).order).toEqual([beta.path]);
		} finally {
			selector.dispose();
		}
	});
});

describe("history search picker", () => {
	const now = Math.floor(Date.now() / 1000);
	const entries: HistorySearchEntry[] = [
		{ prompt: "deploy the release\nwith notes", created_at: now - 60, cwd: "/work/app" },
		{ prompt: "routine status", created_at: now - 7200 },
	];
	const source = {
		getRecent: (limit: number) => entries.slice(0, limit),
		search: (query: string) => entries.filter(e => e.prompt.includes(query)),
	};

	it("hoists a keyed md picker from the dock and inserts on activate", () => {
		const inserted: string[] = [];
		const search = new HistorySearchComponent(
			source,
			prompt => inserted.push(prompt),
			() => {},
		);
		type(search, "deploy");
		const root = search.describe(withPicker);
		expect(root.k).toBe("col");
		const sheet = (root.c as NativeNode[])[0]!;
		expect(sheet.key).toBe("picker");
		const p = props(sheet);
		expect(p.size).toBe("md");
		expect(p.items).toHaveLength(1);
		expect(p.items?.[0]).toMatchObject({ label: "deploy the release", hits: [[0, 6]], detail: "/work/app" });

		search.handleNativeEvent({ type: "activate", key: "^picker", item: p.items![0]!.id });
		expect(inserted).toEqual(["deploy the release\nwith notes"]);
		expect(search.describe(withoutPicker).k).toBe("card");
	});
});
