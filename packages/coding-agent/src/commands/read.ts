/**
 * Show what the read tool will return for a path, URL, or internal URI.
 */

import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { readHelp as commandHelp } from "../cli/command-help";
import { type ReadCommandArgs, runReadCommand } from "../cli/read-cli";
import { initTheme } from "../modes/theme/theme";

export default class Read extends Command {
	static description = commandHelp.description;
	static args = {
		path: Args.string({
			description:
				"Path, URL, or internal URI to read (append :sel for line ranges or raw mode, e.g. src/foo.ts:50-100)",
			required: true,
		}),
	};

	static examples = [
		`${CF_COMMAND} read src/foo.ts`,
		`${CF_COMMAND} read src/foo.ts:50-100`,
		`${CF_COMMAND} read src/foo.ts:raw`,
		`${CF_COMMAND} read https://example.com`,
		`${CF_COMMAND} read omp://`,
		`${CF_COMMAND} read issue://123`,
		`${CF_COMMAND} read path/to/archive.zip:dir/file.ts`,
		`${CF_COMMAND} read path/to/db.sqlite:users:42`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Read);
		const cmd: ReadCommandArgs = {
			path: args.path ?? "",
		};
		await initTheme();
		await runReadCommand(cmd);
	}
}
