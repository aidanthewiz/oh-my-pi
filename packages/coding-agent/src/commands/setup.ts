/**
 * Run onboarding setup or install dependencies for optional features.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { CF_COMMAND } from "../cli/cf-version";
import { setupHelp as commandHelp } from "../cli/command-help";
import { runSetupCommand, type SetupCommandArgs, type SetupComponent } from "../cli/setup-cli";
import { runRootCommand } from "../main";
import { initTheme } from "../modes/theme/theme";
import { launchHelp } from "./launch-help";

const COMPONENTS: SetupComponent[] = ["python", "speech"];

export interface OnboardingSetupDependencies {
	runRoot?: typeof runRootCommand;
	stdinIsTTY?: boolean;
	stdoutIsTTY?: boolean;
	writeStderr?: (text: string) => void;
	exit?: (code: number) => never;
}

export async function runOnboardingSetup(
	deps: OnboardingSetupDependencies = {},
	rawArgs: string[] = [],
): Promise<void> {
	const stdinIsTTY = deps.stdinIsTTY ?? process.stdin.isTTY;
	const stdoutIsTTY = deps.stdoutIsTTY ?? process.stdout.isTTY;
	if (!stdinIsTTY || !stdoutIsTTY) {
		(deps.writeStderr ?? (text => process.stderr.write(text)))(`${CF_COMMAND} setup requires an interactive TTY.\n`);
		(deps.exit ?? process.exit)(1);
		return;
	}
	await (deps.runRoot ?? runRootCommand)(parseArgs(rawArgs), rawArgs, { forceSetupWizard: true });
}

export default class Setup extends Command {
	static description = commandHelp.description;
	static args = {
		component: Args.string({
			description: "Optional component to install",
			required: false,
			options: COMPONENTS,
		}),
	};

	static flags = {
		check: Flags.boolean({ char: "c", description: "Check if dependencies are installed" }),
		json: Flags.boolean({ description: "Output status as JSON" }),
		extension: launchHelp.flags.extension,
		"mcp-providers": launchHelp.flags["mcp-providers"],
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Setup);
		if (!args.component) {
			if (flags.check || flags.json) {
				renderCommandHelp(CF_COMMAND, "setup", Setup);
				return;
			}
			const rawArgs = [
				...(flags.extension ?? []).flatMap(extension => ["--extension", extension]),
				...(flags["mcp-providers"] ? ["--mcp-providers", flags["mcp-providers"]] : []),
			];
			await runOnboardingSetup({}, rawArgs);
			return;
		}
		const cmd: SetupCommandArgs = {
			component: args.component as SetupComponent,
			flags: {
				json: flags.json,
				check: flags.check,
			},
		};
		await initTheme();
		await runSetupCommand(cmd);
	}
}
