import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import type { IdentityAction, IdentityCommandArgs } from "../cli/identity-cli";
import { IDENTITY_ACTIONS, runIdentityCommand } from "../cli/identity-cli";

export default class Identity extends Command {
	static description = "Manage the signed-in Coreforge identity";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...IDENTITY_ACTIONS],
		}),
	};

	static flags = {
		"device-code": Flags.boolean({ description: "Use device-code sign-in instead of a loopback browser callback" }),
		json: Flags.boolean({ description: "Output the non-secret identity profile as JSON" }),
		quiet: Flags.boolean({ description: "Suppress output; status is returned through the exit code" }),
		refresh: Flags.boolean({ description: "Refresh Microsoft and AWS sessions while checking status" }),
		"skip-aws": Flags.boolean({ description: "Do not sign in to or validate the managed AWS profile" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Identity);
		if (!args.action) {
			renderCommandHelp("omp", "identity", Identity);
			return;
		}
		const command: IdentityCommandArgs = {
			action: args.action as IdentityAction,
			flags: {
				deviceCode: flags["device-code"],
				json: flags.json,
				quiet: flags.quiet,
				refresh: flags.refresh,
				skipAws: flags["skip-aws"],
			},
		};
		const exitCode = await runIdentityCommand(command);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
