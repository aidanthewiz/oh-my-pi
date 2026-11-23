import { AsyncLocalStorage } from "node:async_hooks";

const approvalScope = new AsyncLocalStorage<object>();
const commandValidation = new AsyncLocalStorage<{ toolCallId: string; validate: () => void }>();

/** Give a wrapped call independent approval bindings, restoring its parent's scope after nested calls. */
export function withToolApprovalScope<T>(run: () => T): T {
	return approvalScope.run({}, run);
}

/** Key feature-owned typed storage by this token; undefined means execution is outside the approval wrapper. */
export function toolApprovalScopeToken(): object | undefined {
	return approvalScope.getStore();
}

/** Keep a command's selected definition bound while its approval is pending. */
export function withToolCommandValidation<T>(toolCallId: string, validate: () => void, run: () => T): T {
	validate();
	return commandValidation.run({ toolCallId, validate }, run);
}

export function validateToolCommandInvocation(toolCallId: string): void {
	const current = commandValidation.getStore();
	if (current?.toolCallId === toolCallId) current.validate();
}
