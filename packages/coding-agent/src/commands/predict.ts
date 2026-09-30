import { CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { predictHelp as commandHelp } from "../cli/command-help";
import { runPredictCompare } from "../cli/predict-cli";

export default class Predict extends Command {
	static description = commandHelp.description;

	static flags = {
		smollm: Flags.boolean({ description: "Compare SmolLM too (requires explicit tiny-models download)" }),
	};

	static examples = [`${CF_COMMAND} predict`, `${CF_COMMAND} predict --smollm`];

	async run(): Promise<void> {
		const { flags } = await this.parse(Predict);
		if (!process.stdin.isTTY || !process.stdout.isTTY)
			throw new CliUsageError(`${CF_COMMAND} predict needs an interactive terminal`);
		await runPredictCompare(flags.smollm === true);
	}
}
