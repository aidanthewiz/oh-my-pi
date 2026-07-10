import { describe, expect, it } from "bun:test";
import {
	AWS_MODEL_AUTH_MODE_ENV,
	AWS_MODEL_PROFILE_ENV,
	AWS_MODEL_REGION_ENV,
	allowAmbientAwsModelCredentials,
	hasAwsModelCredentialChain,
	MANAGED_AWS_MODEL_AUTH_MODE,
	resolveAwsModelProfile,
	resolveAwsModelRegion,
} from "../src/aws-model-auth";

describe("AWS model credential isolation", () => {
	it("uses ordinary AWS settings outside managed model authentication", () => {
		const env = {
			AWS_PROFILE: "employee-operations",
			AWS_REGION: "eu-west-1",
		};

		expect(resolveAwsModelProfile(env)).toBe("employee-operations");
		expect(resolveAwsModelRegion(env)).toBe("eu-west-1");
		expect(allowAmbientAwsModelCredentials(env)).toBe(true);
		expect(hasAwsModelCredentialChain(env)).toBe(true);
	});

	it("uses only the isolated profile and region in managed mode", () => {
		const env = {
			[AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE,
			[AWS_MODEL_PROFILE_ENV]: "coreforge",
			[AWS_MODEL_REGION_ENV]: "us-east-1",
			AWS_PROFILE: "employee-operations",
			AWS_REGION: "eu-west-1",
			AWS_ACCESS_KEY_ID: "operational-access-key",
			AWS_SECRET_ACCESS_KEY: "operational-secret-key",
		};

		expect(resolveAwsModelProfile(env)).toBe("coreforge");
		expect(resolveAwsModelRegion(env)).toBe("us-east-1");
		expect(allowAmbientAwsModelCredentials(env)).toBe(false);
		expect(hasAwsModelCredentialChain(env)).toBe(true);
	});

	it("does not fall back to operational credentials when managed identity is signed out", () => {
		const env = {
			[AWS_MODEL_AUTH_MODE_ENV]: MANAGED_AWS_MODEL_AUTH_MODE,
			AWS_PROFILE: "employee-operations",
			AWS_ACCESS_KEY_ID: "operational-access-key",
			AWS_SECRET_ACCESS_KEY: "operational-secret-key",
		};

		expect(resolveAwsModelProfile(env)).toBeUndefined();
		expect(resolveAwsModelRegion(env)).toBeUndefined();
		expect(hasAwsModelCredentialChain(env)).toBe(false);
	});
});
