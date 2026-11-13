import { spyOn } from "bun:test";
import * as os from "node:os";
import * as browsers from "@oh-my-pi/pi-utils/browsers";
import {
	chromiumNeedsDownload,
	ensureChromiumExecutable,
	ensureSignInChromiumExecutable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Launch policy reads `process.platform`; Chrome-for-Testing platform detection reads `os.platform()`, which Bun does
// not derive from the `process.platform` override. Pin both so the child resolves the emulated host's paths.
const platform = process.env.OMP_BROWSER_PROBE_PLATFORM;
if (platform === "darwin" || platform === "win32" || platform === "linux" || platform === "freebsd") {
	Object.defineProperty(process, "platform", { value: platform });
	spyOn(os, "platform").mockReturnValue(platform);
} else if (platform) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_PLATFORM: ${platform}`);
}

const arch = process.env.OMP_BROWSER_PROBE_ARCH;
if (arch === "x64" || arch === "arm64") {
	spyOn(os, "arch").mockReturnValue(arch);
} else if (arch) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_ARCH: ${arch}`);
}

// Missing managed builds fail locally instead of starting a network download.
spyOn(browsers, "install").mockImplementation(async options => {
	throw new Error(`browser-executable-probe must not download a browser (cacheDir ${options.cacheDir})`);
});

if (process.env.OMP_BROWSER_PROBE_PURPOSE === "needs-download") {
	process.stdout.write(JSON.stringify(await chromiumNeedsDownload()));
} else {
	const executable =
		process.env.OMP_BROWSER_PROBE_PURPOSE === "sign-in"
			? await ensureSignInChromiumExecutable()
			: await ensureChromiumExecutable();
	process.stdout.write(executable ?? "");
}
