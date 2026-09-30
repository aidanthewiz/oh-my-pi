/**
 * Log in to a model provider from the terminal.
 */

import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { loginHelp as commandHelp } from "../cli/command-help";
import { runLoginCommand } from "../cli/login-cli";

export default class Login extends Command {
	static description = commandHelp.description;
	static args = {
		provider: Args.string({
			description: "OAuth provider id (e.g. anthropic, openai-codex); omit to pick interactively",
			required: false,
		}),
	};

	static examples = [
		`# Pick a provider interactively\n  ${CF_COMMAND} login`,
		`# Log in to a specific provider\n  ${CF_COMMAND} login anthropic`,
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Login);
		await runLoginCommand(args.provider);
	}
}
