import { describe, expect, it, spyOn } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { CleanseBoardModel } from "../src/apps/cleanse-board";
import { showGitOverlay } from "../src/apps/git/git-tui";
import type { ChangedFile, GitTuiModel } from "../src/apps/git/state";
import { initTheme } from "../src/theme/theme";
import { TspHarness } from "./native/tsp-harness";
import type { PsBoard } from "../src/apps/ps-data";
import { type PsTopHost, PsTopComponent } from "../src/apps/ps-top";
import type { DescribeContext, NativeChild, NativeNode } from "../src/native/node";
import { type TspKind } from "@oh-my-pi/pi-wire";
import type { ProcSpec, UnitScope, UnitSnapshot } from "../src/tools/daemon";
import { VirtualTerminal } from "./virtual-terminal";

function nodes(children: readonly NativeChild[] | undefined): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of children ?? []) {
		if ("k" in child) out.push(child, ...nodes(child.c));
	}
	return out;
}

const scope: UnitScope = { kind: "project", dir: "/work/app" };

function unit(key: string): UnitSnapshot {
	return {
		id: `u-${key}`,
		kind: "proc",
		scope,
		key,
		label: key,
		generation: "g1",
		state: "running",
		pids: [100],
		createdAt: 0,
		startedAt: Date.now(),
		restartCount: 0,
		outputBytes: 0,
		leases: 1,
		policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
		command: `run ${key}`,
		cwd: "/work/app",
		supervised: true,
	};
}

function fakeHost(described: string[]): PsTopHost {
	const board: PsBoard = {
		daemon: { pid: 42, build: "test", startedAt: 0 },
		reports: [{ scope, units: ["api", "web"].map(unit) }],
	};
	return {
		collectBoard: async () => board,
		watch: () => () => {},
		act: async current => current,
		describe: async current => {
			described.push(current.key);
			const proc: ProcSpec = { application: "run", args: [current.key], env: {}, cwd: "/work/app", pty: false };
			return { unit: current, proc };
		},
		logs: async () => ({ text: "", terminalOutput: "", state: "running" }),
		close: () => {},
	};
}

describe("ps-top native", () => {
	it("mirrors item select into the selection and opens info on activate", async () => {
		const described: string[] = [];
		const tui = new TUI(new VirtualTerminal(80, 24));
		let rendered = Promise.withResolvers<void>();
		spyOn(tui, "requestRender").mockImplementation(() => rendered.resolve());
		const component = new PsTopComponent(tui, { all: false }, fakeHost(described));
		void component.run();
		await rendered.promise;
		try {
			const list = () => nodes([component.describe()]).find(n => n.k === "list");
			const items = nodes(list()?.c).filter(n => n.k === "item");
			expect(items).toHaveLength(2);
			const [api, web] = items;
			expect(list()?.p).toMatchObject({ selected: api.key });

			component.handleNativeEvent({ type: "select", key: "", item: web.key ?? "" });
			expect(list()?.p).toMatchObject({ selected: web.key });

			rendered = Promise.withResolvers<void>();
			component.handleNativeEvent({ type: "activate", key: "", item: web.key ?? "" });
			await rendered.promise;
			expect(described).toEqual(["web"]);
			expect(nodes([component.describe()]).some(n => n.p?.role === "omp.ps.info")).toBe(true);
		} finally {
			component.dispose();
		}
	});
});

describe("git native", () => {
	const file = (path: string, area: ChangedFile["area"]): ChangedFile => ({ path, kind: "modified", area });
	const model: GitTuiModel = {
		cwd: "/repo",
		branch: "main",
		clean: false,
		unstaged: [file("src/a.ts", "unstaged"), file("README.md", "unstaged")],
		staged: [],
		headCommit: null,
		refresh: async () => false,
		loadChangeStats: async () => false,
		loadHeadFiles: async () => false,
		streamContents: async changed => ({
			kind: "text",
			oldText: `// ${changed.path}\nconst a = 1;\n`,
			newText: `// ${changed.path}\nconst a = 2; // ${"context ".repeat(40)}WRAP_TAIL\n`,
			streamResult: undefined as never, // the synchronous differ runs without a streamed result
		}),
		stage: async () => {},
		unstage: async () => {},
		discard: async () => {},
		commit: async () => {},
		applyPatch: async () => {},
	};

	it("wraps visible diff lines, switches the layout, and opens a clicked file", async () => {
		await initTheme();
		const h = await TspHarness.start(undefined, { cols: 150, rows: 40 });
		const settle = async (): Promise<void> => {
			for (let i = 0; i < 4; i++) {
				await Bun.sleep(0); // zero-delay yield: lets the model's async file load settle, no wall-clock wait
				h.tui.requestRender();
				h.flush(10);
			}
		};
		const closed = showGitOverlay(h.tui, {
			model,
			createAvatarSource: () => ({ get: () => null }),
			aiStage: async () => ({ matchedFiles: 0, totalFiles: 0, stagedHunks: 0, totalHunks: 0, wholeFiles: 0 }),
			generateCommitMessage: async () => {
				throw new Error("unused");
			},
		});
		try {
			await settle();
			const sf = h.terminal.surface ?? "";
			const path = () => h.find(n => (n.p as { role?: string } | undefined)?.role === "omp.app.git.path");
			const diffText = (): string => {
				const viewport = h.find(n => n.k === "rows" && n.id.endsWith("/viewport"));
				if (viewport?.k !== "rows") throw new Error("Missing painted diff viewport");
				const lines = viewport.p?.lines;
				if (!Array.isArray(lines)) throw new Error("Missing painted diff viewport");
				return lines.join("\n");
			};

			const wrap = h.find(n => n.id.endsWith("/wrap"));
			if (!wrap) throw new Error("Missing wrap control");
			if (diffText().includes("WRAP_TAIL")) {
				h.event({ ev: "action", sf, id: wrap.id, act: "wrap" });
				await settle();
			}
			expect(diffText()).not.toContain("WRAP_TAIL");
			h.event({ ev: "action", sf, id: wrap.id, act: "wrap" });
			await settle();
			expect(diffText()).toContain("WRAP_TAIL");

			const views = h.find(n => n.k === "tabs" && (n.p as { active?: string }).active === "split");
			h.event({ ev: "select", sf, id: views?.id ?? "", item: "inline" });
			await settle();
			expect(h.find(n => n.k === "tabs")?.p).toMatchObject({ active: "inline" });

			const readme = h.find(n => n.k === "item" && JSON.stringify(n.p).includes("README.md"));
			const list = h.find(n => n.k === "list" && (n.c ?? []).some(child => child.id === readme?.id));
			h.event({ ev: "select", sf, id: list?.id ?? "", item: readme?.id.split("/").at(-1) ?? "" });
			await settle();
			expect(JSON.stringify(path()?.p)).toContain("README.md");
		} finally {
			h.terminal.send("q");
			h.flush();
			await closed;
			h.tui.stop();
		}
	});
});

function context(kinds: readonly TspKind[]): DescribeContext {
	return { cols: 120, reduceMotion: false, dark: true, supports: kind => kinds.includes(kind), feature: () => true };
}

describe("cleanse board native", () => {
	const assignment = { index: 0, groups: [{ file: "a.ts" }], weight: 1 };

	it("keeps the live node until the board changes and meters repair progress", () => {
		const cx = context([]);
		const model = new CleanseBoardModel();
		expect(model.describeLive(cx)).toBeUndefined();
		model.agentStarted("CleanseA", assignment);
		model.agentStarted("CleanseB", { ...assignment, index: 1 });
		const first = model.describeLive(cx);
		expect(model.describeLive(cx)).toBe(first);

		model.agentFinished({ name: "CleanseA", success: true }, assignment);
		const next = model.describeLive(cx);
		expect(next).not.toBe(first);
		const progress = nodes(next ? [next] : []).find(n => n.k === "progress");
		expect(progress?.p).toMatchObject({ value: 0.5 });
		expect(model.lastSettled?.p).toMatchObject({ role: "omp.cleanse.outcome" });
	});

	it("draws running lanes as agent rows under a meter when the terminal has those kinds", () => {
		const model = new CleanseBoardModel();
		model.agentStarted("CleanseA", assignment);
		model.agentStarted("CleanseB", { ...assignment, index: 1, groups: [{ file: "b.ts" }, { file: "c.ts" }] });
		model.agentFinished({ name: "CleanseA", success: true }, assignment);
		const live = model.describeLive(context(["agent", "meter"]));
		const described = nodes(live ? [live] : []);
		expect(described.some(n => n.k === "progress")).toBe(false);
		expect(described.find(n => n.k === "meter")?.p).toMatchObject({ value: 0.5 });
		const lanes = described.filter(n => n.k === "agent");
		expect(lanes.map(n => n.p)).toMatchObject([{ name: "B", status: "running", task: [{ t: "b.ts +1" }] }]);
	});
});
