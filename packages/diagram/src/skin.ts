/**
 * Skin registry.
 *
 * A skin is data, never hardcoded constants inside the renderer, so a new brand
 * or tenant palette is added by adding a key here rather than touching layout or
 * emit code.
 *
 * `soma-navy` tokens were sampled from the SOMA product login page: computed
 * styles for type and chrome, plus a pixel histogram over its background image
 * for the ground and grid-line values. `soma-light` inverts the ground and
 * darkens two tokens that fail contrast on white at their sampled values.
 */

/** Semantic color roles. Every emitted color must resolve to one of these. */
export interface SkinColors {
	/** Page behind the figure. */
	page: string;
	/** Figure ground, and the mask color for label cutouts. */
	paper: string;
	/** Secondary fill: node bodies. */
	paper2: string;
	/** Blueprint grid lines. */
	grid: string;
	/** Primary text. */
	ink: string;
	/** Body text. */
	ink2: string;
	/** Secondary text and default connector stroke. */
	muted: string;
	/** Tertiary text: sublabels. */
	soft: string;
	/** Hairlines and node borders. */
	rule: string;
	/** Focal accent. Budgeted, never a signaling system. */
	accent: string;
	/** Fill behind accent-bordered nodes. */
	accentTint: string;
	/** External and inbound connectors. */
	link: string;
	/** Failure and severity emphasis. */
	danger: string;
}

export interface Skin {
	readonly id: string;
	readonly mode: "dark" | "light";
	readonly colors: SkinColors;
	/** Font stacks. Deliberately system-only: artifacts must not fetch fonts. */
	readonly fonts: { readonly sans: string; readonly mono: string };
	/** Blueprint grid pitch in user units. */
	readonly gridSize: number;
}

/**
 * System-only stacks. Inter is named first because employee workstations carry
 * it, but nothing is fetched, so an artifact renders offline and in restricted
 * environments.
 */
const SANS = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

export const SKINS: Record<string, Skin> = {
	"soma-navy": {
		id: "soma-navy",
		mode: "dark",
		colors: {
			page: "#00263d",
			paper: "#072840",
			paper2: "#0d2f46",
			grid: "#14374d",
			ink: "#ffffff",
			ink2: "#edf4f8",
			muted: "#c9dce9",
			soft: "#b7d1e2",
			rule: "#6ba3c8",
			accent: "#f78279",
			accentTint: "rgba(247,130,121,0.14)",
			link: "#179fce",
			danger: "#e73d4a",
		},
		fonts: { sans: SANS, mono: MONO },
		gridSize: 40,
	},
	// Sampled `accent` (#f78279) measures roughly 2.1:1 on white and fails both
	// as text and as a thin stroke; sampled `link` (#179fce) fails similarly.
	// `accent` and `link` below are the only deliberate departures from sampled
	// values, and the reason is contrast rather than taste.
	"soma-light": {
		id: "soma-light",
		mode: "light",
		colors: {
			page: "#ffffff",
			paper: "#ffffff",
			paper2: "#edf4f8",
			grid: "rgba(7,40,64,0.06)",
			ink: "#072840",
			ink2: "#1d4e6b",
			muted: "#4a6b85",
			soft: "#6b8ba3",
			rule: "#b7d1e2",
			accent: "#d9503f",
			accentTint: "rgba(217,80,63,0.10)",
			link: "#10688a",
			danger: "#b3252f",
		},
		fonts: { sans: SANS, mono: MONO },
		gridSize: 40,
	},
};

export const DEFAULT_SKIN_ID = "soma-navy";

/** Resolve a skin id, defaulting when unset and rejecting unknown ids. */
export function resolveSkin(id?: string): Skin {
	const skin = SKINS[id ?? DEFAULT_SKIN_ID];
	if (skin === undefined) {
		throw new Error(`unknown skin: ${id} (registered: ${Object.keys(SKINS).join(", ")})`);
	}
	return skin;
}
