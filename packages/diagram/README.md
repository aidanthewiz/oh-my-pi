# @oh-my-pi/pi-diagram

Typed diagram specs rendered to branded, self-contained SVG and to terminal ASCII
from one shared layout.

A spec describes meaning, never appearance: nodes carry a `kind`, edges carry a
`role`, and colors come from a skin. Layout is computed once and consumed by both
backends, so a saved artifact cannot structurally disagree with its terminal
preview.

## Usage

```ts
import { renderDiagram } from "@oh-my-pi/pi-diagram";

const { html, ascii, findings } = renderDiagram({
	type: "architecture",
	title: "Request path",
	direction: "LR",
	zones: [{ id: "vpc", label: "Private network" }],
	nodes: [
		{ id: "client", label: "Client", kind: "input" },
		{ id: "api", label: "API", sublabel: "http", focal: true, zone: "vpc" },
		{ id: "db", label: "Database", kind: "store", badge: "sql", zone: "vpc" },
	],
	edges: [
		{ from: "client", to: "api", role: "link", label: "HTTPS" },
		{ from: "api", to: "db" },
	],
});
```

`renderDiagram` validates the spec, lays it out, lints it, and emits. It throws on
an invalid spec or on any error-severity invariant, so a violation fails loudly
instead of producing a subtly wrong figure.

## Layout

Graph layout reuses the positioned geometry already produced by the vendored
Mermaid renderer in `@oh-my-pi/pi-utils`, via `layoutPositionedGraph`. Spec ids and
label text are never serialized into the Mermaid grammar: ids are synthesized and
mapped back after layout, and label text is sanitized, so an accepted spec cannot
alter the structure of the emitted graph.

## Invariants

`lintFigure` runs on positioned geometry before emit: orthogonal connector runs,
masked arrow labels that keep a visible gap from their connector, palette closure,
a budgeted accent, a node budget, no overlapping nodes, zone containment, and grid
alignment.

Corners are drawn as quarter-arc fillets between axis-aligned runs. That is a
rounded right-angle elbow, not a diagonal, and the lint tests the polyline rather
than the emitted path.

## Artifacts

Emitted documents are self-contained and offline: inline styles, no scripts, no
remote assets, and a system font stack. Squared corners, no shadows. An accessible
`<title>` and `<desc>` are mandatory and wired through `aria-labelledby`.

## Skins

`SKINS` is a registry of data. `soma-navy` (default) is a dark blueprint skin;
`soma-light` inverts the ground and darkens the accent and link tokens, which fail
contrast on white at their source values. Adding a skin means adding a key, not
touching layout or emit code.
