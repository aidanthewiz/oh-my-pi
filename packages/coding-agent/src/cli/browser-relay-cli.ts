/**
 * Coreforge browser-relay: install and sync the extension or serve Chrome's native host.
 */
import { CF_BRAND, CF_COMMAND } from "./cf-version";

import { findUnpackedInstalls } from "../tools/browser/relay/chromium-profiles";
import { defaultRelayExtensionDir, extensionIdForPath } from "../tools/browser/relay/extension-files";
import { installRelayExtension, registeredRelayExtensionIds, syncRelayInstalls } from "../tools/browser/relay/installs";
import { runNativeHost } from "../tools/browser/relay/native-host";
import { registerRelayNativeHost } from "../tools/browser/relay/native-host-manifest";
import { installRelayInChrome } from "../tools/browser/relay/chrome";

/** Subcommands supported by `omp browser-relay`. */
export const BROWSER_RELAY_ACTIONS = ["install", "sync", "native-host"] as const;

/** Selected browser-relay subcommand. */
export type BrowserRelayAction = (typeof BROWSER_RELAY_ACTIONS)[number];

/** Parsed browser-relay command and options. */
export interface BrowserRelayCommandArgs {
	action: BrowserRelayAction;
	/** Install target directory; defaults to ~/.omp/browser-relay/extension. */
	dir?: string;
	/** Explicitly register in a real Chrome profile and restart its browser if running. Default false. */
	chrome?: boolean;
	/** Chrome profile directory name for the unattended install (default: last used). */
	profile?: string;
}

/** Run a relay lifecycle command or the native messaging host. */
export async function runBrowserRelayCommand(args: BrowserRelayCommandArgs): Promise<void> {
	switch (args.action) {
		case "install":
			return runInstall(args);
		case "sync":
			return runSync();
		case "native-host":
			return runNativeHost();
	}
}

async function runSync(): Promise<void> {
	const results = await syncRelayInstalls();
	if (results.length === 0) {
		console.log(
			`No ${CF_BRAND} extension directories registered. Use \`${CF_COMMAND} browser-relay install\` to register one.`,
		);
		return;
	}
	let failed = false;
	for (const result of results) {
		if (result.status === "failed") {
			failed = true;
			console.error(`${result.dir}: failed (${result.error})`);
		} else {
			console.log(`${result.dir}: ${result.status}`);
		}
	}
	if (failed) process.exitCode = 1;
}
async function runInstall(args: BrowserRelayCommandArgs): Promise<void> {
	const dir = await installRelayExtension(args.dir ?? defaultRelayExtensionDir());
	await registerRelayNativeHost(await registeredRelayExtensionIds());
	console.log(`Installed the ${CF_BRAND} extension to ${dir}`);
	const extensionId = extensionIdForPath(dir);
	const profiles = await findUnpackedInstalls(extensionId);

	if (args.chrome === true && !profiles.some(profile => profile.loaded)) {
		const report = await installRelayInChrome({ dir, profile: args.profile }).catch((error: unknown) => {
			console.error(
				`Could not register the extension in Chrome: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		});
		for (const installed of report) {
			console.log(
				`Registered in ${installed.browser} (${installed.profileDir})` +
					`${installed.restarted ? "; Chrome was restarted" : ""}.`,
			);
		}
		if (report.length > 0) {
			const deadline = Date.now() + 8_000;
			while (Date.now() < deadline) {
				if ((await findUnpackedInstalls(extensionId)).some(profile => profile.loaded)) break;
				await Bun.sleep(250);
			}
		}
	}

	const loaded = (await findUnpackedInstalls(extensionId)).filter(profile => profile.loaded);
	for (const { browser, profile, enabled } of loaded) {
		console.log(
			enabled
				? `${browser} (${profile}) has it loaded and reloads into this build once idle.`
				: `${browser} (${profile}) has it loaded but switched off; turn it on in chrome://extensions.`,
		);
	}
	if (loaded.length === 0) {
		const developerMode = profiles.some(profile => profile.developerMode);
		console.log("");
		console.log(
			`Open chrome://extensions${developerMode ? "" : ", turn on Developer mode"}, click "Load unpacked" and pick ${dir}.`,
		);
		console.log(
			`To register a profile automatically and permit a browser restart, explicitly use \`${CF_COMMAND} browser-relay install --chrome\`.`,
		);
	}
	console.log(
		`Optional: \`${CF_COMMAND} config set browser.relay true\` makes the browser tool drive this Chrome by default.`,
	);
}
