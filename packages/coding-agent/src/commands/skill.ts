import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { CF_COMMAND } from "../cli/cf-version";
import { skillHelp } from "../cli/command-help";
import { handleSkillList } from "../cli/skill-list";

/** List the skills available to a session without contacting a registry. */
export default class Skill extends Command {
	static description = skillHelp.description;
	static aliases = ["skills"];

	static args = {
		action: Args.string({ description: "Skill action", required: false, options: ["list"] }),
		directory: Args.string({ description: "Directory to inspect", required: false }),
	};

	static flags = {
		json: Flags.boolean({ description: "Output skill metadata and discovery warnings as JSON" }),
	};

	static examples = [`${CF_COMMAND} skill list`, `${CF_COMMAND} skill list . --json`];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Skill);
		if (!args.action) {
			process.stdout.write(`Usage: ${CF_COMMAND} skill list [dir] [--json]\n`);
			return;
		}
		const exitCode = await handleSkillList(
			args.directory ? [args.directory] : [],
			process.cwd(),
			flags.json === true,
		);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
