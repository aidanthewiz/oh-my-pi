import { Args, Command, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { relayHelp as commandHelp } from "../cli/command-help";
import { runRelayAuthorizeCommand } from "../cli/relay-cli";

const RELAY_ACTIONS = ["authorize"] as const;

export default class Relay extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: [...RELAY_ACTIONS] }),
		code: Args.string({ description: "Browser authorization code", required: false }),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Relay);
		if (!args.action || !args.code) {
			renderCommandHelp(CF_COMMAND, "relay", Relay);
			return;
		}
		const exitCode = await runRelayAuthorizeCommand(args.code);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
