import { describe, expect, test } from "bun:test";
import { SKINS } from "../src/skin";

/** WCAG relative luminance for an `#rgb`/`#rrggbb` color. */
function luminance(hex: string): number {
	const value = hex.replace("#", "");
	const full = value.length === 3 ? [...value].map(c => c + c).join("") : value;
	const channels = [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16) / 255);
	const linear = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (high + 0.05) / (low + 0.05);
}

describe("skin contrast", () => {
	// These roles are drawn as small uppercase text, not only as strokes, so they
	// must clear the 4.5:1 small-text threshold against the figure ground. `rule`
	// is the trap: it reads fine as a hairline at any lightness.
	const textRoles = ["ink", "ink2", "muted", "soft", "rule", "accent", "link", "danger"] as const;

	for (const [id, skin] of Object.entries(SKINS)) {
		test(`${id} keeps text roles legible on its own ground`, () => {
			for (const role of textRoles) {
				const color = skin.colors[role];
				// Only opaque colors are comparable; tints are drawn over fills.
				if (!color.startsWith("#")) continue;
				expect(contrast(color, skin.colors.paper), `${id}.${role} on paper`).toBeGreaterThanOrEqual(4.5);
			}
		});
	}
});
