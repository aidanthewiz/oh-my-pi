import { beforeAll, expect, it } from "bun:test";
import { type AdvisorMessageCard, createAdvisorMessageCard } from "../src/chat/advisor-message";
import { chatTranscriptDisplayPreferences, setChatTranscriptDisplayPreferences } from "../src/chat/display-preferences";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";

let theme: Theme;
beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	theme = loaded;
	setThemeInstance(theme);
});

const describeContext = {
	cols: 80,
	dark: true,
	reduceMotion: false,
	supports: () => true,
	feature: () => true,
};

for (const limit of [1, 5, 0]) {
	it(`applies advisor preview limit ${limit} without deleting expanded note content`, () => {
		const previous = chatTranscriptDisplayPreferences.advisorCollapsedLines;
		let card: AdvisorMessageCard | undefined;
		try {
			setChatTranscriptDisplayPreferences({ advisorCollapsedLines: limit });
			const rows = Array.from({ length: 9 }, (_, index) => `note-row-${index}`);
			card = createAdvisorMessageCard({ notes: [{ note: rows.join("\n") }] }, () => false, theme);
			const collapsed = card.describe!(describeContext);
			if (!collapsed) throw new Error("advisor described nothing");
			expect(collapsed.p).toMatchObject({ collapsible: limit > 0 });
			if (limit > 0) {
				expect(collapsed.p).toMatchObject({ collapsed: true, preview: { lines: limit } });
				expect(card.render(80).length).toBeLessThanOrEqual(limit + 1);
			} else {
				for (const row of rows) expect(Bun.stripANSI(card.render(80).join("\n"))).toContain(row);
			}
			card.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
			const expanded = card.describe!(describeContext);
			if (!expanded) throw new Error("expanded advisor described nothing");
			if (limit > 0) expect(expanded.p).toMatchObject({ collapsed: false });
			const rendered = Bun.stripANSI(card.render(80).join("\n"));
			for (const row of rows) {
				expect(rendered).toContain(row);
				expect(JSON.stringify(expanded)).toContain(row);
			}
		} finally {
			card?.dispose?.();
			setChatTranscriptDisplayPreferences({ advisorCollapsedLines: previous });
		}
	});
}

it("retains the zero-limit multi-note preview and reveals every note on native expansion", () => {
	const previous = chatTranscriptDisplayPreferences.advisorCollapsedLines;
	let card: AdvisorMessageCard | undefined;
	try {
		setChatTranscriptDisplayPreferences({ advisorCollapsedLines: 0 });
		const notes = Array.from({ length: 4 }, (_, index) => ({ note: `advisor-note-${index}` }));
		card = createAdvisorMessageCard({ notes }, () => false, theme);
		expect(card.describe!(describeContext)?.p).toMatchObject({ collapsible: true, collapsed: true, preview: "auto" });
		expect(card.render(80).join("\n")).not.toContain("advisor-note-3");
		card.handleNativeEvent({ type: "toggle", key: "", collapsed: false });
		expect(card.describe!(describeContext)?.p).toMatchObject({ collapsed: false });
		for (const entry of notes) {
			expect(Bun.stripANSI(card.render(80).join("\n"))).toContain(entry.note);
			expect(JSON.stringify(card.describe!(describeContext))).toContain(entry.note);
		}
	} finally {
		card?.dispose?.();
		setChatTranscriptDisplayPreferences({ advisorCollapsedLines: previous });
	}
});
