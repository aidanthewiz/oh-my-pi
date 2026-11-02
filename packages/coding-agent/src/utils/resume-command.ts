import { dirname } from "node:path";
import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { CF_COMMAND } from "../cli/cf-version";
import { quotePosixArgument } from "./shell-quote";

export function resumeCommand(sessionFile: string, platform: NodeJS.Platform = process.platform): string {
	const sessionDir = dirname(sessionFile);
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	const directory = platform === "win32" ? `'${sessionDir.replace(/'/g, "''")}'` : quotePosixArgument(sessionDir);
	const file = platform === "win32" ? `'${sessionFile.replace(/'/g, "''")}'` : quotePosixArgument(sessionFile);
	return `${CF_COMMAND} ${profileFlag}--session-dir ${directory} --resume ${file}`;
}
