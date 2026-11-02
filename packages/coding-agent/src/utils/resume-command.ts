import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import { CF_COMMAND } from "../cli/cf-version";
import { quotePosixArgument } from "./shell-quote";

export function resumeCommand(
	sessionId: string,
	sessionDir: string,
	platform: NodeJS.Platform = process.platform,
): string {
	const profile = getActiveProfile();
	const profileFlag = profile ? `--profile ${profile} ` : "";
	const directory = platform === "win32" ? `'${sessionDir.replace(/'/g, "''")}'` : quotePosixArgument(sessionDir);
	const id = platform === "win32" ? `'${sessionId.replace(/'/g, "''")}'` : quotePosixArgument(sessionId);
	return `${CF_COMMAND} ${profileFlag}--session-dir ${directory} --resume ${id}`;
}
