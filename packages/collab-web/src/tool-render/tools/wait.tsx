import type { ReactNode } from "react";
import { Badge, Row } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, str } from "../util";
import { ircRenderer } from "./irc";
import { jobRenderer } from "./job";

function Summary(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	if (details?.waited) return <ircRenderer.Summary {...props} args={{ op: "wait", from: props.args.from }} />;
	if (
		Array.isArray(details?.agents) &&
		details.agents.length > 0 &&
		(!Array.isArray(details.jobs) || details.jobs.length === 0)
	) {
		return <span className="tv-muted">{details.agents.length} running agents</span>;
	}
	return <jobRenderer.Summary {...props} args={{ poll: props.args.ids ?? [] }} />;
}

function Body(props: ToolRenderProps): ReactNode {
	const details = detailsRecord(props.result);
	const agents = Array.isArray(details?.agents) ? details.agents : [];
	return (
		<>
			{details?.waited && ircRenderer.Body && (
				<ircRenderer.Body {...props} args={{ op: "wait", from: props.args.from }} />
			)}
			{(Array.isArray(details?.jobs) || !details?.waited) && jobRenderer.Body && (
				<jobRenderer.Body {...props} args={{ poll: props.args.ids ?? [] }} />
			)}
			{agents.length > 0 && (
				<div className="tv-list">
					{agents.map(agent => {
						if (!isRecord(agent)) return null;
						const id = str(agent.id);
						if (!id) return null;
						return (
							<Row key={id} k={id}>
								<Badge tone={agent.live === true ? "accent" : "warn"}>
									{agent.live === true ? "running" : "pending"}
								</Badge>
								{str(agent.activity) && <span className="tv-faint"> {str(agent.activity)}</span>}
							</Row>
						);
					})}
				</div>
			)}
		</>
	);
}

export const waitRenderer: ToolRenderer = { Summary, Body };
