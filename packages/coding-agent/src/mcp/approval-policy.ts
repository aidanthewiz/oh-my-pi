import type { ToolApproval } from "@oh-my-pi/pi-agent-core";

const drataApprovalDecision = Object.freeze({
	tier: "write" as const,
	policy: "prompt" as const,
	reason: "Drata calls require explicit approval; server annotations do not authorize compliance operations.",
});
const drataToolApproval: ToolApproval = () => drataApprovalDecision;

export function mcpToolApproval(serverName: string): ToolApproval {
	return serverName === "coreforge-drata-mcp" ? drataToolApproval : "write";
}
