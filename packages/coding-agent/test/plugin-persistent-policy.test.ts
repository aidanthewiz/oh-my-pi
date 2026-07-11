import { afterEach, describe, expect, test } from "bun:test";
import {
	configurePersistentPluginPolicy,
	createPersistentPluginPolicy,
	filterPersistentExtensionPaths,
	filterPersistentPluginRoots,
	withPersistentPluginPolicy,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/policy";

afterEach(() => configurePersistentPluginPolicy("open", []));

describe("persistent plugin allowlist", () => {
	test("requires an exact user-installed plugin ID and rejects project impersonation", () => {
		configurePersistentPluginPolicy("allowlist", ["approved@coreforce"]);
		const roots = filterPersistentPluginRoots([
			{ id: "approved@coreforce", marketplace: "coreforce", scope: "user" as const },
			{ id: "approved@coreforce", marketplace: "coreforce", scope: "project" as const },
			{ id: "denied@external", marketplace: "external", scope: "user" as const },
			{ id: "local@__local__", marketplace: "__local__", scope: "user" as const },
		]);
		expect(roots).toEqual([{ id: "approved@coreforce", marketplace: "coreforce", scope: "user" }]);
	});

	test("rejects configured paths even when repository metadata claims an allowlisted package name", () => {
		configurePersistentPluginPolicy("allowlist", ["@coreforce/approved"]);
		expect(filterPersistentExtensionPaths(["./spoofed-extension.ts"], "/repo")).toEqual([]);
	});

	test("isolates overlapping session policies", async () => {
		const roots = [
			{ id: "plugin-a", scope: "user" as const },
			{ id: "plugin-b", scope: "user" as const },
		];
		let ready = 0;
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const run = (allowed: string) =>
			withPersistentPluginPolicy(createPersistentPluginPolicy("allowlist", [allowed]), async () => {
				ready++;
				if (ready === 2) release();
				await gate;
				return filterPersistentPluginRoots(roots).map(root => root.id);
			});

		const [a, b] = await Promise.all([run("plugin-a"), run("plugin-b")]);
		expect(a).toEqual(["plugin-a"]);
		expect(b).toEqual(["plugin-b"]);
	});
});
