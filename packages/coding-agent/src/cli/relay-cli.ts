import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { approveRelayBrowser } from "../identity/relay";

export interface RelayAuthorizeDependencies {
	settings?: Settings;
	approve?: typeof approveRelayBrowser;
	writeOut?: (text: string) => void;
	writeErr?: (text: string) => void;
}

export async function runRelayAuthorizeCommand(code: string, deps: RelayAuthorizeDependencies = {}): Promise<number> {
	const writeOut = deps.writeOut ?? (text => process.stdout.write(text));
	const writeErr = deps.writeErr ?? (text => process.stderr.write(text));
	const settings = deps.settings ?? (await Settings.init({ cwd: getProjectDir() }));
	const approve = deps.approve ?? approveRelayBrowser;
	try {
		await approve(settings, code, message => writeErr(`[coreforge] ${message}\n`));
		writeOut("Browser authorized for the Coreforge relay.\n");
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeErr(`[coreforge] relay authorization failed: ${message}\n`);
		return 1;
	}
}
