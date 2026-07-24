import { describe, expect, test } from "bun:test";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	approveRelayBrowser,
	assertRelayServiceAudience,
	getCoreforgeRelayIdentityToken,
	resolveRelayIdentityAudience,
} from "@oh-my-pi/pi-coding-agent/identity/relay";

const AUDIENCE = "https://agent-collab.internal.somahub.io";

function settings(): Settings {
	const values: Record<string, unknown> = {
		"identity.relay.audience": AUDIENCE,
		"identity.aws.profile": "somacommercial",
		"identity.aws.region": "us-east-1",
		"identity.aws.ssoStartUrl": "https://d-example.awsapps.com/start",
		"identity.aws.ssoRegion": "us-east-1",
		"identity.aws.ssoAccountId": "891455110252",
		"identity.aws.ssoRoleName": "CoreforgeModelAccess",
	};
	return { get: (key: string) => values[key] } as unknown as Settings;
}

const identity = {
	profile: "employee-existing",
	region: "us-east-1",
	accountId: "891455110252",
	roleArn: "arn:aws:sts::891455110252:assumed-role/CoreforgeModelAccess/tester",
	validatedAt: 1,
};

describe("managed relay identity token", () => {
	test("requests an exact five-minute RS256 proof from the adopted AWS profile", async () => {
		const commands: string[][] = [];
		const token = await getCoreforgeRelayIdentityToken(settings(), () => {}, {
			findAws: () => "/managed/aws",
			ensureAwsSso: async () => identity,
			run: async command => {
				commands.push(command);
				return { exitCode: 0, stdout: "header.payload.signature\n", stderr: "" };
			},
		});
		expect(token).toBe("header.payload.signature");
		expect(commands).toEqual([
			[
				"/managed/aws",
				"sts",
				"get-web-identity-token",
				"--profile",
				"employee-existing",
				"--region",
				"us-east-1",
				"--audience",
				AUDIENCE,
				"--duration-seconds",
				"300",
				"--signing-algorithm",
				"RS256",
				"--query",
				"WebIdentityToken",
				"--output",
				"text",
			],
		]);
	});

	test("rejects relay origins that do not match the token audience", () => {
		expect(resolveRelayIdentityAudience(settings())).toBe(AUDIENCE);
		expect(() => assertRelayServiceAudience("wss://agent-collab.internal.somahub.io/r/room", AUDIENCE)).not.toThrow();
		expect(() => assertRelayServiceAudience("wss://attacker.example/r/room", AUDIENCE)).toThrow(
			"does not match identity audience",
		);
	});

	test("authorizes a browser without putting the AWS proof in the URL", async () => {
		let requestedUrl = "";
		let authorization = "";
		await approveRelayBrowser(settings(), "ABCD-EFGH", () => {}, {
			findAws: () => "/managed/aws",
			ensureAwsSso: async () => identity,
			run: async () => ({ exitCode: 0, stdout: "header.payload.signature\n", stderr: "" }),
			fetch: (async (input, init) => {
				requestedUrl = String(input);
				authorization = new Headers(init?.headers).get("authorization") ?? "";
				return new Response(null, { status: 204 });
			}) as typeof fetch,
		});
		expect(requestedUrl).toBe(`${AUDIENCE}/auth/browser/approve`);
		expect(authorization).toBe("Bearer header.payload.signature");
		expect(requestedUrl).not.toContain("header.payload.signature");
	});
});
