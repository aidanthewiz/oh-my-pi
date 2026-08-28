# diagram

> Render branded architecture, flow, state, or layer diagrams as terminal previews and self-contained artifacts.

## Source

- Entry: `packages/coding-agent/src/tools/diagram.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/diagram.md`
- Renderer: `packages/diagram/src/index.ts`
- Typed schema: `packages/diagram/src/spec.ts`

## Inputs

Exactly one of `spec` or `mermaid` is required.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `spec` | `object` | One input | Typed diagram specification. The renderer validates its exact shape. |
| `mermaid` | `string` | One input | Mermaid flowchart or state source. |
| `title` | `string` | With `mermaid` | Figure title and accessible name. |
| `eyebrow` | `string` | No | Uppercase kicker used with Mermaid input. |
| `standfirst` | `string` | No | One or two context sentences used with Mermaid input. |
| `out` | `string` | No | Artifact path. A bare name uses the shared artifacts directory. |
| `format` | `"html" \| "svg"` | No | Saved artifact format. Defaults to `html`. |
| `copy` | `boolean` | No | Copy standalone SVG markup to the clipboard. |
| `skin` | `string` | No | Registered skin id: `soma-navy` or `soma-light`. |
| `preview` | `"ascii" \| "none"` | No | Terminal preview mode. Defaults to `ascii`. |

### Typed specification

The typed form supports `architecture`, `flowchart`, `state`, and `layers`. Every specification requires a title and at least one node.

- Nodes use semantic `kind` values: `default`, `store`, `external`, `input`, or `optional`.
- Edges use semantic `role` values: `default`, `primary`, or `link`.
- Edge styles are `solid`, `dashed`, or `thick`.
- Zones define nested boundaries through `id` and optional `parent` references.
- `focal: true`, `badge`, and `sublabel` enrich typed nodes.
- `layers` renders nodes from top to bottom and ignores edges.

Callers select semantic roles, not colors. The active skin owns all visual tokens.

## Outputs

The tool returns one text result with:

1. the resolved skin and rendered dimensions;
2. the artifact path when `out` is set;
3. clipboard confirmation when `copy` is true;
4. lint warnings, when present;
5. an ASCII preview when requested and supported.

`details` records the input mode, resolved path, skin id, dimensions, and lint findings.

## Flow

1. Validate that exactly one input form is present.
2. Require a non-empty title for Mermaid input.
3. Validate and lay out the typed specification, or parse the Mermaid source.
4. Apply the selected skin and run diagram invariant checks.
5. Write HTML or SVG when `out` is set.
6. Copy SVG markup when `copy` is true.
7. Render the terminal preview when available.

A bare `out` name resolves under the shared artifacts directory. In plan mode, it resolves to the session `local://` artifact sandbox. A path containing a separator is used as supplied after plan-mode enforcement.

## Side effects

- Without `out` and `copy`, rendering is read-only.
- `out` writes one HTML or SVG file.
- `copy: true` writes SVG text to the local or OSC 52 clipboard.
- Rendering performs no network requests.

## Failure modes

- Supplying both `spec` and `mermaid`, or neither, fails.
- Mermaid input without a title fails.
- Empty output paths fail.
- Invalid typed fields, duplicate ids, unknown node or zone references, and zone cycles fail.
- Error-severity layout findings prevent artifact emission.
- Plan mode rejects output paths outside its writable artifact sandbox.

## Notes

- Mermaid cannot express semantic node kinds, focal marks, badges, or sublabels. Use `spec` when these distinctions matter.
- ASCII preview is unavailable for `layers` and can be unavailable for unsupported Mermaid syntax.
- `copy` places SVG markup on the clipboard, not a raster image.
