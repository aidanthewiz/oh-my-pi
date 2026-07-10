import { describe, expect, it } from "bun:test";
import { ensureManagedCoreforgeAwsSso } from "@oh-my-pi/pi-coding-agent/identity/aws-sso";

const MANAGED_CONSTANTS = {
	profile: "somacommercial",
	region: "us-east-1",
	ssoStartUrl: "https://d-example.awsapps.com/start",
	ssoRegion: "us-east-1",
	ssoAccountId: "891455110252",
	ssoRoleName: "CoreforgeModelAccess",
};

describe("ensureManagedCoreforgeAwsSso", () => {
	it("resolves the managed profile before AWS identity validation", async () => {
		const commands: string[][] = [];
		const progress: string[] = [];
		const identity = await ensureManagedCoreforgeAwsSso(
			{ profile: MANAGED_CONSTANTS.profile, region: MANAGED_CONSTANTS.region },
			MANAGED_CONSTANTS,
			message => progress.push(message),
			{
				resolveProfile: received => {
					expect(received).toEqual(MANAGED_CONSTANTS);
					return { profile: "employee-existing", source: "adopted" };
				},
				findAws: () => "/usr/local/bin/aws",
				run: async command => {
					commands.push(command);
					return {
						exitCode: 0,
						stdout: JSON.stringify({
							Account: MANAGED_CONSTANTS.ssoAccountId,
							Arn: "arn:aws:sts::891455110252:assumed-role/CoreforgeModelAccess/aidan",
						}),
						stderr: "",
					};
				},
			},
		);
		expect(identity.profile).toBe("employee-existing");
		expect(commands[0]).toContain("employee-existing");
		expect(progress).toEqual([
			"AWS profile 'employee-existing' (adopted) targets the managed Identity Center account.",
		]);
	});

	it("rejects a managed profile that resolves to another AWS account", async () => {
		await expect(
			ensureManagedCoreforgeAwsSso(
				{ profile: MANAGED_CONSTANTS.profile, region: MANAGED_CONSTANTS.region },
				MANAGED_CONSTANTS,
				() => {},
				{
					resolveProfile: () => ({ profile: MANAGED_CONSTANTS.profile, source: "existing-managed" }),
					findAws: () => "/usr/local/bin/aws",
					run: async () => ({
						exitCode: 0,
						stdout: JSON.stringify({
							Account: "000000000000",
							Arn: "arn:aws:sts::000000000000:assumed-role/foreign/user",
						}),
						stderr: "",
					}),
				},
			),
		).rejects.toThrow("expected the managed account 891455110252");
	});
});
