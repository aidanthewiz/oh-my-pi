import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

export interface RelayAuthScreenProps {
	userCode: string | null;
}

export function RelayAuthScreen({ userCode }: RelayAuthScreenProps): ReactNode {
	return (
		<div className="sh-connect">
			<div className="sh-ambient" />
			<div className="sh-connect-top">
				<div className="sh-brand" aria-label="Coreforce Agent Collab">
					<img className="sh-brand-mark" src="/favicon.png" alt="" aria-hidden="true" />
					<span>Coreforce Agent</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">Collab</span>
				</div>
				<ThemeToggle />
			</div>
			<div className="sh-connect-card" role="status" aria-live="polite">
				<div className="sh-connect-head">
					<h1 className="sh-connect-title">Coreforce authentication required</h1>
					<p className="sh-connect-sub">Ask the session host to approve this browser.</p>
				</div>
				<div className="sh-field">
					<span className="sh-field-label">browser authorization code</span>
					<div className="sh-input sh-input-mono sh-auth-code">{userCode ?? "Requesting code..."}</div>
					<span className="sh-field-hint">
						Browser joins require host approval. Terminal joins authenticate automatically.
					</span>
				</div>
				{userCode && (
					<>
						<code className="sh-auth-command">coreforge relay authorize {userCode}</code>
						<div className="sh-field-hint">
							Ask the session host to run this command. This page connects automatically after approval.
						</div>
					</>
				)}
			</div>
		</div>
	);
}
