/**
 * `omp browser-relay` implementation: serve the local CDP relay and install
 * its Chrome extension. Standalone CLI command — console output here is
 * intentional user-facing output.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";
import { probeRelayServer } from "../tools/browser/relay/daemon";
import backgroundJs from "../tools/browser/relay/extension-assets/background.js.txt" with { type: "text" };
import licenseText from "../tools/browser/relay/extension-assets/LICENSE.txt" with { type: "text" };
import manifestJson from "../tools/browser/relay/extension-assets/manifest.json.txt" with { type: "text" };
import optionsHtml from "../tools/browser/relay/extension-assets/options.html.txt" with { type: "text" };
import optionsJs from "../tools/browser/relay/extension-assets/options.js.txt" with { type: "text" };
import thirdPartyNotices from "../tools/browser/relay/extension-assets/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { DEFAULT_RELAY_URL } from "../tools/browser/relay/kind";
import { type RelayServer, startRelayServer } from "../tools/browser/relay/server";
import { ensureBrowserRelayToken, writeBrowserRelayToken } from "../tools/browser/relay/token";
import { CF_BRAND, CF_COMMAND } from "./cf-version";

const INJECTED_TOKEN = "__COREFORGE_BROWSER_RELAY_TOKEN__";

export const BROWSER_RELAY_ACTIONS = ["serve", "install"] as const;
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	port: number;
	token?: string;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Gather tabs the agent actively drives into an 'omp' Chrome tab group (default true). */
	group?: boolean;
	verbose?: boolean;
}

const EXTENSION_FILES: Record<string, string> = {
	LICENSE: licenseText,
	"manifest.json": manifestJson,
	"options.html": optionsHtml,
	"options.js": optionsJs,
	"THIRD-PARTY-NOTICES.txt": thirdPartyNotices,
};

/** Default port of the relay endpoint (kept in sync with DEFAULT_RELAY_URL). */
export const DEFAULT_RELAY_PORT = Number(new URL(DEFAULT_RELAY_URL).port);

export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	if (args.action === "install") {
		await runInstall(args.dir);
		return;
	}
	await runServe(args);
}
async function runInstall(dirOverride: string | undefined): Promise<void> {
	const dir = dirOverride ? path.resolve(dirOverride) : path.join(getBrowserRelayDir(), "extension");
	const token = await ensureBrowserRelayToken();
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	await fs.chmod(dir, 0o700);
	const background = backgroundJs.replace(JSON.stringify(INJECTED_TOKEN), JSON.stringify(token));
	if (background === backgroundJs) throw new Error("Browser Relay extension token placeholder is missing");
	await Bun.write(path.join(dir, "background.js"), background);
	for (const [name, contents] of Object.entries(EXTENSION_FILES)) {
		await Bun.write(path.join(dir, name), contents);
	}
	for (const name of ["background.js", ...Object.keys(EXTENSION_FILES)]) {
		await fs.chmod(path.join(dir, name), 0o600);
	}
	console.log(`Installed the ${CF_BRAND} Browser Relay extension to ${dir}`);
	console.log("");
	console.log("Finish setup in Chrome:");
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	console.log(`  3. Enable the mode:  ${CF_COMMAND} config set browser.relay true`);
	console.log("");
	console.log(`${CF_BRAND} starts the relay automatically when the browser prelude needs it;`);
	console.log(`run \`${CF_COMMAND} browser-relay\` yourself only for --token or --no-group.`);
	console.log("The extension badge shows 'on' once it reaches a relay.");
}

async function runServe(args: BrowserRelayCommandArgs): Promise<void> {
	const log = args.verbose
		? (message: string, data?: Record<string, unknown>) => {
				console.error(`[relay] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`);
			}
		: undefined;
	const token = args.token === undefined ? await ensureBrowserRelayToken() : args.token.trim();
	let relay: RelayServer | undefined;
	try {
		relay = startRelayServer({ port: args.port, token, group: args.group !== false, log });
		if (args.token !== undefined) await writeBrowserRelayToken(token);
	} catch (err) {
		if (relay) relay.stop();
		// The port is machine-global while relays can be started by any project's
		// broker (or by hand): losing the bind to a live relay is success.
		if (err instanceof Error && "code" in err && err.code === "EADDRINUSE") {
			if (await probeRelayServer(`http://127.0.0.1:${args.port}`)) {
				console.log(`${CF_BRAND} browser relay already running on http://127.0.0.1:${args.port}; nothing to do.`);
				return;
			}
			console.error(`Port ${args.port} is in use by something that is not a ${CF_BRAND} browser relay.`);
			process.exit(1);
		}
		throw err;
	}
	if (!relay) throw new Error("Browser relay failed to start");
	const runningRelay = relay;

	console.log(`${CF_BRAND} browser relay listening on http://127.0.0.1:${args.port}`);
	console.log(`  extension endpoint  ws://127.0.0.1:${args.port}/ext?token=***`);
	if (args.port === DEFAULT_RELAY_PORT) {
		console.log(`  enable with         ${CF_COMMAND} config set browser.relay true`);
	} else {
		console.log(
			`  enable with         ${CF_COMMAND} config set browser.relay true && ${CF_COMMAND} config set browser.relayUrl http://127.0.0.1:${args.port}`,
		);
	}
	console.log(
		`Waiting for the ${CF_BRAND} Browser Relay extension to connect (${CF_COMMAND} browser-relay install)...`,
	);

	let announced = false;
	const readiness = setInterval(() => {
		if (runningRelay.bridge.ready && !announced) {
			announced = true;
			console.log(`Extension connected. The ${CF_BRAND} browser prelude can now drive your tabs.`);
		} else if (!runningRelay.bridge.ready && announced) {
			announced = false;
			console.log("Extension disconnected; waiting for it to reconnect...");
		}
	}, 500);

	const shutdown = () => {
		clearInterval(readiness);
		runningRelay.stop();
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Serve runs until SIGINT/SIGTERM; keep the process alive.
	await new Promise<never>(() => {});
}
