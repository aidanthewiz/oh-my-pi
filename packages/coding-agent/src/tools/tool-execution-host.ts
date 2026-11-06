import { TOOL_CANCELLATION_CLEANUP_VERSION } from "@oh-my-pi/pi-agent-core/tool-cancellation";

export const TOOL_EXECUTION_HOST_VERSION = "native-tool-host/v2";
export const TOOL_SESSION_LIFECYCLE_VERSION = "tool-session-lifecycle/v2";
export const TOOL_EXECUTION_HOST_CAPABILITIES = Object.freeze({
	protocol: TOOL_EXECUTION_HOST_VERSION,
	cancellationCleanup: TOOL_CANCELLATION_CLEANUP_VERSION,
	sessionLifecycle: TOOL_SESSION_LIFECYCLE_VERSION,
});
export type ToolExecutionHostCapabilities = typeof TOOL_EXECUTION_HOST_CAPABILITIES;
