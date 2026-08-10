Use `diagram` when a system, architecture, flow, or dependency relationship is easier to understand spatially than as prose. Use prose for a short explanation and a table for row-and-column comparisons, inventories, or exact values.

Prefer the typed `spec` input. It gives the engine one validated layout for the branded HTML artifact and the ASCII preview. Use `mermaid` only as shorthand when an ASCII preview is enough; it cannot emit the branded artifact.

Callers choose semantic node kinds and edge roles, never colors. The active skin owns every color and registered skin palette. Use at most two focal nodes; the accent is emphasis, not a general-purpose signaling system.

For an artifact, set `out`. A bare filename lands in the shared artifacts directory, which is the predictable home for generated files; any path containing a separator is used as given. `format: "html"` (the default) writes a full page, and `format: "svg"` writes a standalone figure suited to a design tool or an existing document.

`copy: true` puts the standalone SVG markup on the clipboard, which design tools accept as a paste. It is markup, not a raster image; there is no image-to-clipboard path, so never describe it as copying a picture.

The default preview is ASCII; use `preview: "none"` when the preview is not useful. There is no PNG preview: terminal image protocols never accept SVG, so a raster preview needs rasterization that this tool does not do.
