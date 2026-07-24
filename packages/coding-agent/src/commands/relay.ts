import { Args, Command, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import { runRelayAuthorizeCommand } from "../cli/relay-cli";

const RELAY_ACTIONS = ["authorize"] as const;

export default class Relay extends Command {
	static description = "Approve a browser for Coreforce Agent Collab";

	static args = {
		action: Args.string({ description: "Sub-command", required: false, options: [...RELAY_ACTIONS] }),
		code: Args.string({ description: "Browser authorization code", required: false }),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Relay);
		if (!args.action || !args.code) {
			renderCommandHelp("omp", "relay", Relay);
			return;
		}
		const exitCode = await runRelayAuthorizeCommand(args.code);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
