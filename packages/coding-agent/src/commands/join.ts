/**
 * Join a shared collab session from the CLI: launches the interactive TUI and
 * immediately runs `/join <link>`.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { joinHelp as commandHelp } from "../cli/command-help";
import { runRootCommand } from "../main";
import { launchHelp } from "./launch-help";

export async function runJoinSession(
	link: string,
	rawArgs: string[],
	runRoot: typeof runRootCommand = runRootCommand,
): Promise<void> {
	const parsed = parseArgs(rawArgs);
	parsed.join = link;
	await runRoot(parsed, rawArgs);
}

export default class Join extends Command {
	static description = commandHelp.description;
	static args = {
		link: Args.string({
			description: "Collab link shared by the host (/collab)",
			required: true,
		}),
	};
	static flags = {
		extension: launchHelp.flags.extension,
		"mcp-providers": launchHelp.flags["mcp-providers"],
	};

	static examples = [`${APP_NAME} join "relay.example.sh/abc123#key"`];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Join);
		const link = args.link?.trim();
		if (!link) {
			process.stderr.write(`Usage: ${APP_NAME} join <link>\n`);
			process.exitCode = 1;
			return;
		}
		if (!process.stdin.isTTY || !process.stdout.isTTY) {
			process.stderr.write(`${APP_NAME} join requires an interactive terminal\n`);
			process.exitCode = 1;
			return;
		}
		const rawArgs = [
			...(flags.extension ?? []).flatMap(extension => ["--extension", extension]),
			...(flags["mcp-providers"] ? ["--mcp-providers", flags["mcp-providers"]] : []),
		];
		await runJoinSession(link, rawArgs);
	}
}
