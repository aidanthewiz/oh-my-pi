import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "bun:test";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";
import { uploadClip } from "../../src/stream/clip-upload";
import { parseRecording, SessionRecorder, type RecordingHeader } from "../../src/stream/recording";
import { StreamRedactor } from "../../src/stream/redactor";

async function testRedactor(cwd: string): Promise<StreamRedactor> {
	return StreamRedactor.load(cwd, ["secret-[a-z]+"]);
}

describe("recording metadata redaction", () => {
	it("redacts the session title before writing an ompcast header", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recording-metadata-"));
		const recordingPath = path.join(cwd, "session.ompcast");
		try {
			const recorder = await SessionRecorder.start({
				tui: new TUI(new VirtualTerminal(80, 24)),
				redactor: await testRedactor(cwd),
				title: "session secret-title",
				path: recordingPath,
			});
			await recorder.stop();

			const { header } = parseRecording(await Bun.file(recordingPath).text());
			expect(header.title).toBe("session ••••••");
		} finally {
			await fs.rm(cwd, { force: true, recursive: true });
		}
	});

	it("redacts stored and overridden clip metadata before upload", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-clip-metadata-"));
		const uploaded: RecordingHeader[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const compressed = new Uint8Array(await request.arrayBuffer());
				const recording = new TextDecoder().decode(Bun.gunzipSync(compressed));
				uploaded.push(parseRecording(recording).header);
				return Response.json({ id: `clip-${uploaded.length}`, url: `https://clips.example/${uploaded.length}` });
			},
		});
		try {
			const redactor = await testRedactor(cwd);
			const recording = `${JSON.stringify({
				ompcast: 1,
				cols: 80,
				rows: 24,
				title: "stored secret-title",
				description: "stored secret-description",
				createdAt: "2026-09-23T00:00:00.000Z",
			})}\n`;
			const serverUrl = `http://127.0.0.1:${server.port}`;

			await uploadClip({ serverUrl, token: "test-token", recording, redactor });
			await uploadClip({
				serverUrl,
				token: "test-token",
				recording,
				redactor,
				title: "override secret-title",
				description: "override secret-description",
			});

			expect(uploaded).toEqual([
				expect.objectContaining({ title: "stored ••••••", description: "stored ••••••" }),
				expect.objectContaining({ title: "override ••••••", description: "override ••••••" }),
			]);
		} finally {
			server.stop(true);
			await fs.rm(cwd, { force: true, recursive: true });
		}
	});
});
