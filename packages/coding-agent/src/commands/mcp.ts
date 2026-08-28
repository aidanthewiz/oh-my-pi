import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { mcpHelp as commandHelp } from "../cli/command-help";
import { setServerOverrides } from "../mcp/config-writer";

export default class Mcp extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "MCP action",
			required: true,
			options: ["configure"],
		}),
		selections: Args.string({
			description: "Server selections as name=enabled or name=disabled",
			required: true,
			multiple: true,
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Mcp);
		const rawSelections = Array.isArray(args.selections) ? args.selections : args.selections ? [args.selections] : [];
		const selections = new Map<string, boolean>();
		for (const raw of rawSelections) {
			const separator = raw.lastIndexOf("=");
			const name = raw.slice(0, separator);
			const state = raw.slice(separator + 1);
			if (separator < 1 || (state !== "enabled" && state !== "disabled")) {
				throw new Error(`Invalid MCP selection "${raw}"; use name=enabled or name=disabled`);
			}
			if (selections.has(name)) throw new Error(`Duplicate MCP selection: ${name}`);
			selections.set(name, state === "enabled");
		}

		const userPath = getMCPConfigPath("user", getProjectDir());
		await setServerOverrides(userPath, selections);
	}
}
