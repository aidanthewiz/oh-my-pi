import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionFormDialogResult,
	ExtensionUIDialogOptions,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AskTool, BUILTIN_TOOLS, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { parseImageMetadata, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkRkAAAAASUVORK5CYII=";
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16384" height="8192"><rect width="16384" height="8192" fill="red"/></svg>`;

beforeAll(() => initTheme(false));

describe("ask form external image authority", () => {
	it.each([
		["allow", "png"],
		["deny", "png"],
		["allow", "svg"],
	] as const)("keeps the read tool's %s policy for external %s media", async (policy, format) => {
		using temp = TempDir.createSync("@ask-media-");
		const file = temp.join(`picture.${format}`);
		const admittedBytes = format === "png" ? Uint8Array.fromBase64(PNG) : new TextEncoder().encode(SVG);
		await Bun.write(file, admittedBytes);
		const authStorage = createInMemoryAuthStorage();
		const settings = Settings.isolated({
			"ask.notify": "off",
			"images.autoResize": false,
			"tools.approvalMode": "yolo",
			"tools.approval": { read: policy },
		});
		const manager = SessionManager.inMemory(temp.path());
		const registry = new ModelRegistry(authStorage);
		const toolContext: AgentToolContext = {
			settings,
			sessionManager: manager,
			modelRegistry: registry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
		};
		const session: ToolSession = {
			cwd: temp.path(),
			hasUI: true,
			settings,
			sessionManager: manager,
			modelRegistry: registry,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getSessionId: () => manager.getSessionId(),
			getToolContext: () => toolContext,
		};
		const runner = new ExtensionRunner(
			[],
			new ExtensionRuntime(),
			temp.path(),
			manager,
			registry,
			undefined,
			settings,
		);
		const nativeRead = await BUILTIN_TOOLS.read(session);
		if (!nativeRead) throw new Error("Read tool is unavailable");
		const read = new ExtensionToolWrapper(nativeRead, runner);
		session.getToolForEvalBridge = name => (name === "read" ? read : undefined);
		let rendered = false;
		let preview: Uint8Array | undefined;
		const formDialog = async (
			_html: string,
			options?: ExtensionUIDialogOptions,
		): Promise<ExtensionFormDialogResult> => {
			rendered = true;
			// The user-facing dialog must consume already-admitted bytes, not reopen this changed source.
			await Bun.write(file, "changed after media admission");
			if (!options?.loadMedia) throw new Error("Missing admitted media loader");
			if (policy === "deny") {
				await expect(options.loadMedia(file, new AbortController().signal)).rejects.toBeInstanceOf(Error);
			} else {
				const loaded = await options.loadMedia(file, new AbortController().signal);
				expect(loaded.mime).toBe("image/png");
				loaded.bytes.fill(0);
				preview = (await options.loadMedia(file, new AbortController().signal)).bytes;
				await expect(
					options.loadMedia(temp.join("unlisted.png"), new AbortController().signal),
				).rejects.toBeInstanceOf(Error);
			}
			return { data: { answer: "no" } };
		};
		try {
			const result = await new AskTool(session).execute(
				"media-form",
				{
					html: `<form><img src="${file}" alt="Proposal"><label><input type="radio" name="answer" value="yes">Yes</label><label><input type="radio" name="answer" value="no">No</label></form>`,
				},
				undefined,
				undefined,
				{ ...toolContext, hasUI: true, ui: { formDialog } } as unknown as AgentToolContext,
			);
			expect(rendered).toBe(true);
			expect(result.details?.answers[0]?.answer).toBe("No");
			if (policy === "deny") expect(preview).toBeUndefined();
			else if (format === "png") expect(preview).toEqual(admittedBytes);
			else {
				if (!preview) throw new Error("Missing admitted SVG raster");
				expect(parseImageMetadata(preview)).toMatchObject({
					mimeType: "image/png",
					width: 2048,
					height: 1024,
				});
			}
		} finally {
			await authStorage.close();
		}
	});
});
