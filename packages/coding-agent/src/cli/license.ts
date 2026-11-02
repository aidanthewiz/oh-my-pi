import nativesNotices from "@oh-my-pi/pi-natives/THIRD-PARTY-NOTICES.txt" with { type: "text" };
import license from "../../LICENSE" with { type: "text" };
import cliNotices from "../../THIRD-PARTY-NOTICES.txt" with { type: "text" };
import { CF_BRAND } from "./cf-version";

/** License and notices for the CLI and embedded native addon. */
export function formatLicenseOutput(): string {
	const sections = [license, cliNotices, nativesNotices].map(text => text.trimEnd());
	return `${CF_BRAND} License and Third-Party Notices\n\n${sections.join("\n\n")}\n`;
}
