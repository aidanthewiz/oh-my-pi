Use `diagram` when a system, architecture, flow, or dependency relationship is easier to understand spatially than as prose. Use prose for a short explanation and a table for row-and-column comparisons, inventories, or exact values.

Prefer the typed `spec` input. It gives the engine one validated layout for the branded HTML artifact and the ASCII preview. Use `mermaid` only as shorthand when an ASCII preview is enough; it cannot emit the branded artifact.

Callers choose semantic node kinds and edge roles, never colors. The active skin owns every color and registered skin palette. Use at most two focal nodes; the accent is emphasis, not a general-purpose signaling system.

For an artifact, set `out` to the desired HTML path. The default preview is ASCII; use `preview: "none"` when the preview is not useful.
