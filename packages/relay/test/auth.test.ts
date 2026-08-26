import { beforeAll, describe, expect, test } from "bun:test";
import { AwsRelayIdentityVerifier, BrowserAuthorizationStore } from "../src/auth";

const NOW_SECONDS = 1_800_000_000;
const ISSUER = "https://issuer.tokens.sts.global.api.aws";
const AUDIENCE = "https://agent-collab.internal.somahub.io";
const ACCOUNT_ID = "891455110252";
const ORGANIZATION_ID = "o-hmsoycfvcb";
const IDENTITY_STORE_ARN = `arn:aws:identitystore::${ACCOUNT_ID}:identitystore/d-9067c31b82`;
const ROLE_PREFIX = `arn:aws:iam::${ACCOUNT_ID}:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_CoreforgeModelAccess_`;
const USER_ID = "140894b8-9011-70d3-65fa-cde7c8eb0194";
const SOURCE_REGION = "us-east-1";
const KID = "test-key";

let privateKey: CryptoKey;
let jwk: Record<string, unknown>;

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	privateKey = pair.privateKey;
	jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
});

function verifier(): AwsRelayIdentityVerifier {
	return new AwsRelayIdentityVerifier({
		issuer: ISSUER,
		audience: AUDIENCE,
		awsAccountId: ACCOUNT_ID,
		awsOrganizationId: ORGANIZATION_ID,
		identityStoreArn: IDENTITY_STORE_ARN,
		roleArnPrefix: ROLE_PREFIX,
		sourceRegion: SOURCE_REGION,
		jwksUrl: "http://jwks.test/jwks",
		fetch: (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch,
		now: () => NOW_SECONDS * 1_000,
	});
}

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const subject = `${ROLE_PREFIX}4f9ea1f053d8aae5`;
	return {
		iss: ISSUER,
		sub: subject,
		aud: AUDIENCE,
		iat: NOW_SECONDS - 1,
		exp: NOW_SECONDS + 299,
		"https://sts.amazonaws.com/": {
			aws_account: ACCOUNT_ID,
			org_id: ORGANIZATION_ID,
			identity_store_arn: IDENTITY_STORE_ARN,
			identity_store_user_id: USER_ID,
			principal_id: subject,
			source_region: SOURCE_REGION,
		},
		...overrides,
	};
}

async function sign(payload: Record<string, unknown>): Promise<string> {
	const header = encode({ alg: "RS256", kid: KID, typ: "JWT" });
	const body = encode(payload);
	const signed = new TextEncoder().encode(`${header}.${body}`);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signed);
	return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("AWS relay identity verification", () => {
	test("accepts an exact, five-minute Coreforge role proof", async () => {
		await expect(verifier().verify(await sign(claims()))).resolves.toEqual({
			userId: USER_ID,
			subject: `${ROLE_PREFIX}4f9ea1f053d8aae5`,
		});
	});

	test("accepts an omitted identity store ARN and rejects a mismatched one", async () => {
		const withoutStoreArn = claims();
		const context = withoutStoreArn["https://sts.amazonaws.com/"] as Record<string, unknown>;
		delete context.identity_store_arn;
		await expect(verifier().verify(await sign(withoutStoreArn))).resolves.toEqual({
			userId: USER_ID,
			subject: `${ROLE_PREFIX}4f9ea1f053d8aae5`,
		});

		context.identity_store_arn = "arn:aws:identitystore::891455110252:identitystore/d-other";
		await expect(verifier().verify(await sign(withoutStoreArn))).rejects.toThrow("identity store");
	});

	test("rejects audience, role, lifetime, and signature drift", async () => {
		await expect(verifier().verify(await sign(claims({ aud: "https://other.example" })))).rejects.toThrow("audience");
		await expect(verifier().verify(await sign(claims({ sub: `${ROLE_PREFIX}not-a-suffix` })))).rejects.toThrow(
			"role",
		);
		await expect(
			verifier().verify(await sign(claims({ iat: NOW_SECONDS - 1, exp: NOW_SECONDS + 300 }))),
		).rejects.toThrow("lifetime");
		await expect(verifier().verify(await sign(claims({ aud: [AUDIENCE, "https://other.example"] })))).rejects.toThrow(
			"audience",
		);
		const token = await sign(claims());
		const [header, payload, signature] = token.split(".") as [string, string, string];
		const changed = `${header}.${encode(claims({ identity_store_user_id: "different-user" }))}.${signature}`;
		await expect(verifier().verify(changed)).rejects.toThrow("signature");
		void payload;
	});
});

describe("browser authorization store", () => {
	test("exchanges an approved challenge exactly once and expires the opaque session", () => {
		let now = 1_000;
		const store = new BrowserAuthorizationStore({ challengeTtlMs: 100, sessionTtlMs: 200, now: () => now });
		const challenge = store.create();
		expect(store.exchange(challenge.challengeId)).toEqual({ status: "pending" });
		expect(store.approve(challenge.userCode, { userId: USER_ID, subject: "role" })).toBe("approved");
		const exchange = store.exchange(challenge.challengeId);
		expect(exchange.status).toBe("approved");
		if (exchange.status !== "approved") throw new Error("expected approved exchange");
		expect(store.exchange(challenge.challengeId)).toEqual({ status: "expired" });
		expect(store.verifySession(exchange.accessToken)).toEqual({ userId: USER_ID, subject: "role" });
		now += 201;
		expect(store.verifySession(exchange.accessToken)).toBeNull();
	});
});
