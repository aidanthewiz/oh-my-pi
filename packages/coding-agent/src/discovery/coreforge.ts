import * as path from "node:path";
import { registerProvider } from "../capability";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { LoadContext, LoadResult } from "../capability/types";
import { loadMCPJsonFile } from "./mcp-json";

export const COREFORGE_MCP_PROVIDER_ID = "coreforge";

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const projectRoot = ctx.repoRoot ?? ctx.cwd;
	return loadMCPJsonFile(path.join(projectRoot, ".coreforge", "mcp.json"), "project", COREFORGE_MCP_PROVIDER_ID);
}

registerProvider(mcpCapability.id, {
	id: COREFORGE_MCP_PROVIDER_ID,
	displayName: "Coreforge Project",
	description: "Load MCP servers from .coreforge/mcp.json at the repository root",
	priority: 110,
	load: loadMCPServers,
});
