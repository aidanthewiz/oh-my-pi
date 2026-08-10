import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type DiagramParams, DiagramTool, type DiagramToolDetails } from "@oh-my-pi/pi-coding-agent/tools/diagram";
import { getAgentDir, getArtifactsDir, setAgentDir } from "@oh-my-pi/pi-utils";

const spec = {
	type: "architecture" as const,
	title: "Request path",
	nodes: [
		{ id: "client", label: "Client", kind: "external" as const },
		{ id: "api", label: "API", kind: "default" as const },
		{ id: "db", label: "Database", kind: "store" as const },
	],
	edges: [
		{ from: "client", to: "api", role: "primary" as const },
		{ from: "api", to: "db" },
	],
};

function createSession(cwd: string, overrides: Partial<Record<string, unknown>> = {}): ToolSession {
	const settings = { get: (_path: string): boolean => false } as unknown as ToolSession["settings"];
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
		...overrides,
	} as unknown as ToolSession;
}

function textFromResult(result: AgentToolResult<DiagramToolDetails>): string {
	const block = result.content[0];
	if (!block || block.type !== "text") throw new Error("expected text content");
	return block.text;
}

describe("DiagramTool", () => {
	let testDir: string;

	afterEach(async () => {
		if (testDir) await fs.rm(testDir, { recursive: true, force: true });
	});

	it("renders a typed spec and writes an HTML artifact", async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagram-"));
		const out = path.join(testDir, "request.html");
		const result = await new DiagramTool(createSession(testDir)).execute("call-1", { spec, out });
		const html = await fs.readFile(out, "utf8");

		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(result.details?.resolvedPath).toBe(path.resolve(out));
		expect(textFromResult(result)).toContain("ASCII preview:");
	});

	it("routes a bare filename into the shared artifacts directory", async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagram-"));
		// Redirect the agent dir so the test never writes into the real home.
		const previousAgentDir = getAgentDir();
		setAgentDir(path.join(testDir, "agent"));
		try {
			const result = await new DiagramTool(createSession(testDir)).execute("call-1", {
				spec,
				out: "bare-name.html",
			});
			const resolved = result.details?.resolvedPath;
			expect(resolved).toBe(path.join(getArtifactsDir(), "bare-name.html"));
			expect((await fs.readFile(resolved as string, "utf8")).startsWith("<!doctype html>")).toBe(true);
		} finally {
			setAgentDir(previousAgentDir);
		}
	});

	it("routes a bare filename into the session sandbox under plan mode", async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagram-"));
		const sandbox = path.join(testDir, "artifacts");
		const session = createSession(testDir, {
			getArtifactsDir: () => sandbox,
			getSessionId: () => "diagram-session",
			getPlanModeState: () => ({ enabled: true, planFilePath: "local://plan.md" }),
		});

		// Plan mode holds the working tree read-only; a bare name must land in the
		// session sandbox rather than being rejected by the guard.
		const result = await new DiagramTool(session).execute("call-1", { spec, out: "planned.html" });
		expect(result.details?.resolvedPath).toBe(path.join(sandbox, "local", "planned.html"));
		expect((await fs.readFile(path.join(sandbox, "local", "planned.html"), "utf8")).length).toBeGreaterThan(0);
	});

	it("requires exactly one source", async () => {
		const tool = new DiagramTool(createSession(os.tmpdir()));
		const emptyParams = {} as DiagramParams;
		await expect(tool.execute("call-1", emptyParams)).rejects.toThrow("exactly one of spec or mermaid");
		await expect(tool.execute("call-2", { spec, mermaid: "flowchart LR\nA-->B" })).rejects.toThrow(
			"exactly one of spec or mermaid",
		);
	});

	it("renders Mermaid shorthand without claiming a branded artifact", async () => {
		const result = await new DiagramTool(createSession(os.tmpdir())).execute("call-1", {
			mermaid: "flowchart LR\n  A[Client] --> B[API]",
		});
		const text = textFromResult(result);

		expect(text).toContain("ASCII preview:");
		expect(text).toContain("requires a typed spec");
		expect(text).toContain("No branded artifact was written");
		expect(result.details?.resolvedPath).toBeUndefined();
	});

	it("writes a standalone svg artifact when format is svg", async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-diagram-"));
		const out = path.join(testDir, "figure.svg");
		const result = await new DiagramTool(createSession(testDir)).execute("call-1", {
			spec,
			out,
			format: "svg",
		});
		const svg = await fs.readFile(out, "utf8");

		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).not.toContain("<!doctype");
		expect(result.details?.resolvedPath).toBe(path.resolve(out));
		expect(textFromResult(result)).toContain("SVG artifact");
	});
});
