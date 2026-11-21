/**
 * Check for and install updates.
 */

import chalk from "@oh-my-pi/pi-utils/chalk";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { updateHelp as commandHelp } from "../cli/command-help";
import * as pluginCli from "../cli/plugin-cli";
import * as updateCli from "../cli/update-cli";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

export default class Update extends Command {
	static description = commandHelp.description;
	static flags = {
		force: Flags.boolean({ char: "f", description: "Force update", default: false }),
		check: Flags.boolean({ char: "c", description: "Check for updates without installing", default: false }),
		plugins: Flags.boolean({ char: "l", description: "Update installed plugins", default: false }),
	};

	static examples = [
		`${CF_COMMAND} update`,
		`${CF_COMMAND} update --check`,
		`# If GitHub rate-limits release metadata, set GITHUB_TOKEN or GH_TOKEN\n  GITHUB_TOKEN=... ${CF_COMMAND} update`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(Update);
		await initTheme();
		if (flags.plugins) {
			await pluginCli.runPluginCommand({ action: "upgrade", args: [], flags: flags.check ? { dryRun: true } : {} });
		} else {
			try {
				await updateCli.runUpdateCommand({
					force: flags.force,
					check: flags.check,
				});
			} catch (err) {
				console.error(chalk.red(err instanceof Error ? err.message : String(err)));
				process.exit(1);
			}
		}
	}
}
