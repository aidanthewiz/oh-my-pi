Use `diagram` when a system, architecture, flow, state machine, or layering is easier to understand spatially than as prose. Use prose for a short explanation and a table for row-and-column comparisons, inventories, or exact values.

Types: `architecture` and `flowchart` for components and flow, `state` for lifecycles and transitions, `layers` for stacked abstraction levels. `layers` is ordered top to bottom by node order and ignores `edges`, because stacking is the relationship.

Prefer the typed `spec` input. Only a spec can express node kinds, focal emphasis, badges, and sublabels. `mermaid` renders a branded artifact too, but every node gets the default treatment because Mermaid cannot express those semantics; it accepts flowchart and state sources and needs a `title`, since the figure and its accessible description both require a name.

Callers choose semantic node kinds and edge roles, never colors. The active skin owns every color and registered skin palette. Use at most two focal nodes; the accent is emphasis, not a general-purpose signaling system.

For an artifact, set `out`. A bare filename lands in the shared artifacts directory, which is the predictable home for generated files; any path containing a separator is used as given. `format: "html"` (the default) writes a full page, and `format: "svg"` writes a standalone figure suited to a design tool or an existing document.

`copy: true` puts the standalone SVG markup on the clipboard, which design tools accept as a paste. It is markup, not a raster image; there is no image-to-clipboard path, so never describe it as copying a picture.

The default preview is ASCII; use `preview: "none"` when the preview is not useful. `layers` has no ASCII form because it is not a Mermaid family. There is no PNG preview: terminal image protocols never accept SVG, so a raster preview needs rasterization that this tool does not do.
