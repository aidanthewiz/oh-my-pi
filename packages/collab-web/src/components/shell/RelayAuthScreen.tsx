import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle";

export interface RelayAuthScreenProps {
	userCode: string | null;
}

export function RelayAuthScreen({ userCode }: RelayAuthScreenProps): ReactNode {
	return (
		<div className="sh-connect">
			<div className="sh-connect-card">
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<img className="sh-lockup-mark" src="/favicon.png" alt="" aria-hidden="true" />
						Coreforce Agent Collab
					</div>
					<ThemeToggle />
				</div>
				<div className="sh-connect-sub">Coreforce authentication required</div>
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
