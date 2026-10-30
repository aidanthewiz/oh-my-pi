import { describe, expect, it, spyOn } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { AsyncJobManager, type AsyncJob } from "../../src/async/job-manager";
import {
	type JobWidgetAuthorRequest,
	JobWidgets,
	redactWidgetSample,
	renderJobWidgetPrompt,
	TextTap,
} from "../../src/job-widgets";

const SECRET = "w14-private";
const PLACEHOLDER = "[secret:synthetic]";
const GRID_SPEC = {
	title: "CI",
	rules: [{ from: "out", match: String.raw`^(?P<name>\S+) (?P<status>\S+)$`, key: "name", text: "status" }],
	blocks: [{ kind: "grid", field: "status", label: "checks", tones: { pass: "success", pending: "pending" } }],
};

function rows(status: string): string {
	return ["lint", "test", "build"].map(name => `${name} ${status}\n`).join("");
}

describe("job widget diagnostic confidentiality", () => {
	for (const phase of ["candidate replay", "installed spec"] as const) {
		it(`keeps captured statuses out of ${phase} diagnostics and logs`, async () => {
			const logs: unknown[][] = [];
			const debug = spyOn(logger, "debug").mockImplementation((...args) => {
				logs.push(args);
			});
			const manager = new AsyncJobManager({});
			const done = Promise.withResolvers<string>();
			const tap = new TextTap("out", "stdout+stderr");
			const requests: JobWidgetAuthorRequest[] = [];
			const prompts: string[] = [];
			const widgets = new JobWidgets({
				authorAfterMs: 0,
				minIngestMs: 0,
				author: async request => {
					const { canAuthor: _canAuthor, ...data } = request;
					requests.push(structuredClone(data));
					prompts.push(
						renderJobWidgetPrompt(request, text =>
							redactWidgetSample(text, value => value.replaceAll(SECRET, PLACEHOLDER)),
						),
					);
					return requests.length === 1 ? GRID_SPEC : { skip: "not a progress status" };
				},
			});
			try {
				const id = manager.register(
					"bash",
					"synthetic checks",
					({ signal }) => {
						signal.addEventListener("abort", () => done.resolve("cancelled"), { once: true });
						return done.promise;
					},
					{
						widgetInputs: {
							canAuthor: () => true,
							sources: () => [tap],
							brief: () => ({ kind: "bash", command: "synthetic checks" }),
						},
					},
				);
				const job = manager.getJob(id) as AsyncJob;
				tap.append(rows(phase === "candidate replay" ? SECRET : "pass"));
				widgets.view(job);
				await widgets.drain();
				if (phase === "installed spec") {
					const live = widgets.view(job);
					expect(live?.state).toBe("live");
					const grid = live?.blocks.find(block => block.kind === "grid");
					expect(grid?.kind === "grid" ? grid.items : []).toEqual([
						{ label: "lint", text: "pass", tone: "success" },
						{ label: "test", text: "pass", tone: "success" },
						{ label: "build", text: "pass", tone: "success" },
					]);
					tap.append(rows(SECRET));
					const reauthoring = widgets.view(job);
					expect(reauthoring?.state).toBe("authoring");
					expect(reauthoring?.blocks.some(block => block.kind === "grid")).toBe(false);
					await widgets.drain();
				}
				expect(requests).toHaveLength(2);
				expect(requests[1].rejected?.errors).toHaveLength(1);
				expect(prompts[phase === "candidate replay" ? 0 : 1]).toContain(PLACEHOLDER);
				for (const text of prompts) expect(text).not.toContain(SECRET);
				const fallback = widgets.view(job);
				expect(fallback?.state).toBe("fallback");
				expect(fallback?.blocks.some(block => block.kind === "grid")).toBe(false);
				expect(requests).toHaveLength(2);
				const diagnosticLogs = logs.filter(
					args =>
						args[0] === (phase === "candidate replay" ? "Job widget spec rejected" : "Job widget spec dropped") &&
						(args[1] as { jobId?: unknown } | undefined)?.jobId === id,
				);
				expect(diagnosticLogs).toHaveLength(1);
				expect(JSON.stringify(diagnosticLogs)).not.toContain(SECRET);
				expect(JSON.stringify(requests[1].rejected?.errors)).not.toContain(SECRET);
			} finally {
				widgets.dispose();
				done.resolve("finished");
				try {
					await manager.dispose({ timeoutMs: 500 });
				} finally {
					debug.mockRestore();
				}
			}
		});
	}
});
