import * as path from "node:path";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApproval,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { type LintFinding, type RenderedDiagram, renderDiagram, SKINS } from "@oh-my-pi/pi-diagram";
import { getArtifactsDir, prompt, renderMermaidAsciiSafe } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import diagramDescription from "../prompts/tools/diagram.md" with { type: "text" };
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";

const diagramSchema = type({
	"spec?": type("object").describe("typed diagram spec object; renderDiagram validates its exact shape"),
	"mermaid?": type("string").describe("Mermaid source shorthand for an ASCII preview"),
	"out?": type("string").describe(
		"where to save the standalone HTML artifact; a bare filename lands in the agent artifacts directory, while any path containing a separator is used as given",
	),
	"skin?": type("string").describe(`skin id; registered ids: ${Object.keys(SKINS).join(", ")}`),
	"preview?": type("'ascii'|'none'").describe("preview mode; defaults to ascii"),
	"+": "reject",
});

export type DiagramParams = typeof diagramSchema.infer;

export interface DiagramToolDetails {
	mode: "spec" | "mermaid";
	resolvedPath?: string;
	skinId?: string;
	width?: number;
	height?: number;
	findings?: LintFinding[];
}

function renderFindings(findings: readonly LintFinding[]): string[] {
	const warnings = findings.filter(finding => finding.severity === "warning");
	if (warnings.length === 0) return [];
	return ["Lint warnings:", ...warnings.map(finding => `- ${finding.rule}: ${finding.message}`)];
}

export class DiagramTool implements AgentTool<typeof diagramSchema, DiagramToolDetails> {
	readonly name = "diagram";
	readonly approval: ToolApproval = (args: unknown) => {
		if (args && typeof args === "object" && "out" in args && typeof args.out === "string") return "write";
		return "read";
	};
	readonly label = "Diagram";
	readonly loadMode = "discoverable" as const;
	readonly summary = "Render a typed architecture or flow diagram";
	readonly description: string;
	readonly parameters = diagramSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<DiagramParams>[] = [
		{
			caption: "Typed architecture diagram",
			call: {
				spec: {
					type: "architecture",
					title: "Request path",
					nodes: [
						{ id: "client", label: "Client", kind: "external" },
						{ id: "api", label: "API", kind: "default" },
						{ id: "db", label: "Database", kind: "store" },
					],
					edges: [
						{ from: "client", to: "api", role: "primary" },
						{ from: "api", to: "db", role: "default" },
					],
				},
			},
		},
		{
			caption: "Mermaid ASCII shorthand",
			call: { mermaid: "flowchart LR\n  A[Client] --> B[API]", preview: "ascii" },
		},
	];

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(diagramDescription);
	}

	async execute(
		_toolCallId: string,
		params: DiagramParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<DiagramToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<DiagramToolDetails>> {
		signal?.throwIfAborted();
		const hasSpec = params.spec !== undefined;
		const hasMermaid = params.mermaid !== undefined;
		if (hasSpec === hasMermaid) {
			throw new ToolError("diagram requires exactly one of spec or mermaid; provide one, but not both.");
		}

		const preview = params.preview ?? "ascii";
		const mermaid = params.mermaid;
		if (mermaid !== undefined) {
			const ascii = preview === "ascii" ? renderMermaidAsciiSafe(mermaid) : null;
			const content = [
				"Mermaid shorthand rendered as ASCII only; branded HTML artifact emission currently requires a typed spec.",
				"No branded artifact was written.",
			];
			if (ascii !== null) content.push("", "ASCII preview:", ascii);
			else if (preview === "ascii") content.push("", "ASCII preview was unavailable for this Mermaid source.");
			return {
				content: [{ type: "text", text: content.join("\n") }],
				details: { mode: "mermaid" },
			};
		}

		let rendered: RenderedDiagram;
		try {
			const diagramInput = params.skin === undefined ? params.spec : { ...params.spec, skin: params.skin };
			rendered = renderDiagram(diagramInput);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new ToolError(`Unable to render diagram: ${message}`);
		}

		let resolvedPath: string | undefined;
		const content: string[] = [`Rendered branded ${rendered.skinId} diagram (${rendered.width}x${rendered.height}).`];
		if (params.out !== undefined) {
			if (params.out.trim().length === 0) throw new ToolError("diagram out must be a non-empty file path.");
			// A bare filename goes to the shared artifacts directory so generated
			// files land in one predictable place instead of the project tree or a
			// temp dir. An explicit path always wins.
			//
			// Plan mode is the exception: it holds the working tree read-only and
			// gives the session its own `local://` artifact sandbox, so a bare name
			// resolves there. Sending it to the global directory instead would trip
			// the guard and fail the one path this tool recommends.
			const bareName = !params.out.includes("/") && !params.out.includes("\\");
			const planMode = this.session.getPlanModeState?.()?.enabled === true;
			const target = bareName
				? planMode
					? `local://${params.out}`
					: path.join(getArtifactsDir(), params.out)
				: params.out;
			enforcePlanModeWrite(this.session, target, { op: "create" });
			resolvedPath = resolvePlanPath(this.session, target);
			await Bun.write(resolvedPath, rendered.html);
			content.push(`Wrote branded HTML artifact to ${formatPathRelativeToCwd(resolvedPath, this.session.cwd)}.`);
		}

		content.push(...renderFindings(rendered.findings));
		if (preview === "ascii" && rendered.ascii !== null) content.push("", "ASCII preview:", rendered.ascii);
		return {
			content: [{ type: "text", text: content.join("\n") }],
			details: {
				mode: "spec",
				resolvedPath,
				skinId: rendered.skinId,
				width: rendered.width,
				height: rendered.height,
				findings: rendered.findings,
			},
		};
	}
}
