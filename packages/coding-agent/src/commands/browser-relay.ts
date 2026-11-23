/**
 * `omp browser-relay` — drive the user's own Chrome tabs.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { BROWSER_RELAY_ACTIONS, runBrowserRelayCommand } from "../cli/browser-relay-cli";
import { CF_COMMAND } from "../cli/cf-version";
import { browserRelayHelp } from "../cli/command-help";

/** Install or sync the omp Chrome extension; Chrome launches its native host. */
export default class BrowserRelay extends Command {
	static description = browserRelayHelp.description;

	static args = {
		action: Args.string({
			description: `Action: ${BROWSER_RELAY_ACTIONS.join(" | ")} (native-host is launched by Chrome)`,
			options: [...BROWSER_RELAY_ACTIONS],
			required: true,
		}),
	};

	static flags = {
		dir: Flags.string({
			description: "Extension install directory (install; default ~/.omp/browser-relay/extension)",
		}),
		chrome: Flags.boolean({
			description: "Register in a Chrome profile and permit restarting its browser (install only)",
			default: false,
		}),
		profile: Flags.string({
			description: "Chrome profile directory for the unattended install (install; default: last used)",
		}),
	};

	static examples = [
		`${CF_COMMAND} browser-relay install    # write extension and native host; print manual Chrome steps`,
		`${CF_COMMAND} browser-relay install --chrome    # register a profile and permit a browser restart`,
		`${CF_COMMAND} browser-relay sync       # sync registered extension directories`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(BrowserRelay);
		const action = BROWSER_RELAY_ACTIONS.find(candidate => candidate === args.action);
		if (action === undefined) throw new Error(`Unknown action: ${args.action}`);
		await runBrowserRelayCommand({
			action,
			dir: flags.dir,
			chrome: flags.chrome,
			profile: flags.profile,
		});
	}
}
