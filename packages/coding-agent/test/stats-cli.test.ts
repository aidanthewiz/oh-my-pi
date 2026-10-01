import { describe, expect, it } from "bun:test";
import { parseStatsDashboardArgs } from "../src/slash-commands/helpers/stats-dashboard";

describe("stats dashboard host arguments", () => {
	it("keeps the slash command loopback-only unless a host is requested", () => {
		expect(parseStatsDashboardArgs("")).toEqual({ port: 3847, host: "127.0.0.1" });
		expect(parseStatsDashboardArgs("--host 0.0.0.0")).toEqual({ port: 3847, host: "0.0.0.0" });
	});
});
