import { AsyncLocalStorage } from "node:async_hooks";

export type PersistentPluginPolicy = "open" | "allowlist";

export interface PersistentPluginPolicyState {
	readonly mode: PersistentPluginPolicy;
	readonly allowlist: ReadonlySet<string>;
}

const policyContext = new AsyncLocalStorage<PersistentPluginPolicyState>();
let defaultPolicy = createPersistentPluginPolicy("open", []);

export function createPersistentPluginPolicy(
	mode: PersistentPluginPolicy,
	allowlist: readonly string[],
): PersistentPluginPolicyState {
	return Object.freeze({ mode, allowlist: new Set(allowlist) });
}

export function configurePersistentPluginPolicy(mode: PersistentPluginPolicy, allowlist: readonly string[]): void {
	defaultPolicy = createPersistentPluginPolicy(mode, allowlist);
}

export function withPersistentPluginPolicy<T>(policy: PersistentPluginPolicyState, run: () => T): T {
	return policyContext.run(policy, run);
}

function currentPolicy(): PersistentPluginPolicyState {
	return policyContext.getStore() ?? defaultPolicy;
}

export function persistentPluginPolicyCacheKey(): string {
	const policy = currentPolicy();
	if (policy.mode === "open") return "open";
	return `allowlist:${[...policy.allowlist].sort().join("\0")}`;
}

export function isPersistentPluginAllowed(identifier: string | undefined, scope: "user" | "project" = "user"): boolean {
	const policy = currentPolicy();
	if (policy.mode === "open") return true;
	return scope === "user" && identifier !== undefined && policy.allowlist.has(identifier);
}

export function filterPersistentPluginRoots<T extends { id: string; scope?: "user" | "project"; persistent?: boolean }>(
	roots: readonly T[],
): T[] {
	return roots.filter(root => root.persistent === false || isPersistentPluginAllowed(root.id, root.scope));
}

export function filterPersistentExtensionPaths(paths: readonly string[], _cwd: string): string[] {
	return currentPolicy().mode === "open" ? [...paths] : [];
}
