/**
 * `omp join <link>` must route to the registered `join` subcommand instead of
 * being rewritten to `launch join <link>` and forwarded to the LLM as an
 * initial prompt (same failure mode as #1496).
 */
import { describe, expect, test } from "bun:test";
import { isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { runJoinSession } from "@oh-my-pi/pi-coding-agent/commands/join";

describe("join command is registered as a top-level subcommand", () => {
	test("CLI runner routes `join <link>` to the join command, not launch", () => {
		expect(isSubcommand("join")).toBe(true);
		expect(resolveCliArgv(["join", "wss://my.omp.sh/s/abc#key"])).toEqual({
			argv: ["join", "wss://my.omp.sh/s/abc#key"],
		});
	});

	test("forwards managed extension and MCP flags into the joined session", async () => {
		const rawArgs = ["--extension", "/managed/l3.ts", "--mcp-providers", "native"];
		let receivedRawArgs: string[] | undefined;
		let parsedExtensions: string[] | undefined;
		let parsedMcpProviders: string[] | undefined;
		let joinedLink: string | undefined;
		await runJoinSession("relay.example/link", rawArgs, async (parsed, forwardedRawArgs) => {
			receivedRawArgs = forwardedRawArgs;
			parsedExtensions = parsed.extensions;
			parsedMcpProviders = parsed.mcpProviders;
			joinedLink = parsed.join;
		});

		expect(receivedRawArgs).toEqual(rawArgs);
		expect(parsedExtensions).toEqual(["/managed/l3.ts"]);
		expect(parsedMcpProviders).toEqual(["native"]);
		expect(joinedLink).toBe("relay.example/link");
	});
});
