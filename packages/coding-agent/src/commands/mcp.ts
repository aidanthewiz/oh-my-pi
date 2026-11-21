import { getMCPConfigPath, getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { Args, CliUsageError, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { mcpHelp as commandHelp } from "../cli/command-help";
import { runMcpAuthCommand } from "../mcp/auth-command";
import { setServerOverrides, validateServerName } from "../mcp/config-writer";

export default class Mcp extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "MCP action",
			required: true,
			options: ["configure", "auth", "reauth"],
		}),
		selections: Args.string({
			description: "Server names, or configure selections as name=enabled or name=disabled",
			multiple: true,
		}),
	};

	static flags = {
		check: Flags.boolean({
			description: "Verify selected hosted connections without prompting or opening a browser (auth only)",
			default: false,
		}),
	};

	static examples = [
		"mcp configure sentry=enabled rootly=disabled",
		"mcp auth",
		"mcp auth sentry --check",
		"mcp reauth sentry",
	];

	async run(): Promise<void> {
		try {
			const { args, flags } = await this.parse(Mcp);
			const values = Array.isArray(args.selections) ? args.selections : args.selections ? [args.selections] : [];
			if (args.action !== "auth" && flags.check) {
				throw new CliUsageError("--check is supported only by mcp auth");
			}
			if (args.action === "reauth" && values.length !== 1) {
				throw new CliUsageError("mcp reauth requires exactly one server name");
			}
			if (args.action !== "configure") {
				if (new Set(values).size !== values.length) throw new CliUsageError("Duplicate MCP server name");
				if (values.some(name => !name.trim() || name.includes("="))) {
					throw new CliUsageError("mcp auth and reauth accept server names, not selections");
				}
				process.exitCode = await runMcpAuthCommand({
					action: args.action as "auth" | "reauth",
					names: values,
					check: flags.check,
				});
				return;
			}
			if (values.length === 0) throw new CliUsageError("mcp configure requires at least one server selection");
			const selections = new Map<string, boolean>();
			for (const raw of values) {
				const separator = raw.lastIndexOf("=");
				const name = raw.slice(0, separator);
				const state = raw.slice(separator + 1);
				if (separator < 1 || !name.trim() || (state !== "enabled" && state !== "disabled")) {
					throw new CliUsageError(`Invalid MCP selection "${raw}"; use name=enabled or name=disabled`);
				}
				const nameError = validateServerName(name);
				if (nameError) throw new CliUsageError(`Invalid server name "${name}": ${nameError}`);
				if (selections.has(name)) throw new CliUsageError(`Duplicate MCP selection: ${name}`);
				selections.set(name, state === "enabled");
			}

			const userPath = getMCPConfigPath("user", getProjectDir());
			await setServerOverrides(userPath, selections);
		} catch (error) {
			if (!(error instanceof CliUsageError)) throw error;
			process.stderr.write(`error: ${sanitizeText(error.message)}\n`);
			process.exitCode = 2;
		}
	}
}
