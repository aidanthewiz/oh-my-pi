import { isAbsolute } from "node:path";
import { LIFECYCLE_FAILURE } from "./aws-secret-input-lifecycle-values";

export const AWS_SECRET_INPUT_STARTUP_MARKER = "aws-secret-input-global-preload-ran";

export function awsSecretInputLifecycleStartupPreloadSource(markerPath: string): string {
	if (!isAbsolute(markerPath)) throw new Error(LIFECYCLE_FAILURE);
	return `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(markerPath)}, "public preload executed\\n", { flag: "wx", mode: 0o600 });
`;
}
