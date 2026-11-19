import type { AwsSecretInputService } from "../../src/tools/aws-secret-input-provider";

export const SYNTHETIC_ACCESS_KEY_ID = "scope-fixture-access-key";
export const SYNTHETIC_SECRET_ACCESS_KEY = "scope-fixture-private-key-never-real";
export const SYNTHETIC_SESSION_TOKEN = "scope-fixture-session-token-never-real";
export const SYNTHETIC_SECRET_TEXT = "\0 scope-secret-é-e\u0301-雪-🔒\r\n trailing \t";
export const SYNTHETIC_DIAGNOSTIC = "scope-private-diagnostic-never-return-this";
export const FIXTURE_NOW = Date.UTC(2099, 0, 1);
export const STATIC_PROFILE_CONFIG = "[profile scope-fixture]\nregion = us-east-1\n";
export const STATIC_PROFILE_WITH_UNRELATED_SERVICES = [
	STATIC_PROFILE_CONFIG,
	"[services local]",
	"secretsmanager =",
	"  endpoint_url = https://never-connect.invalid",
	"",
].join("\n");
export const STATIC_PROFILE_CREDENTIALS = [
	"[scope-fixture]",
	`aws_access_key_id = ${SYNTHETIC_ACCESS_KEY_ID}`,
	`aws_secret_access_key = ${SYNTHETIC_SECRET_ACCESS_KEY}`,
	`aws_session_token = ${SYNTHETIC_SESSION_TOKEN}`,
	"",
].join("\n");
export const SSO_SESSION_NAME = "scope-session";
export const SSO_START_URL = "https://scope-fixture.awsapps.com/start";
export const SSO_PROFILE_CONFIG = [
	"[profile scope-fixture]",
	`sso_session = ${SSO_SESSION_NAME}`,
	"sso_account_id = 123456789012",
	"sso_role_name = scope-role",
	`[sso-session ${SSO_SESSION_NAME}]`,
	`sso_start_url = ${SSO_START_URL}`,
	"sso_region = us-east-1",
	"",
].join("\n");

export function syntheticSsoToken(expiresAt = FIXTURE_NOW + 60_000, startUrl = SSO_START_URL): string {
	return JSON.stringify({
		accessToken: SYNTHETIC_SESSION_TOKEN,
		expiresAt: new Date(expiresAt).toISOString(),
		region: "us-east-1",
		startUrl,
	});
}

export function syntheticRoleCredentials() {
	return {
		accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
		secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
		sessionToken: SYNTHETIC_SESSION_TOKEN,
		expiration: FIXTURE_NOW + 60_000,
	};
}

export const WRITABLE_INPUT = JSON.stringify({
	increment: 7,
	privateNote: SYNTHETIC_SECRET_TEXT,
});

export function syntheticBinary(): Uint8Array {
	return Uint8Array.from([0, 255, 128, 13, 10, 195, 40, 240, 159, 148, 146, 0]);
}

export function leakyFailure(): Error {
	const failure = new Error(SYNTHETIC_DIAGNOSTIC, {
		cause: new Error(SYNTHETIC_DIAGNOSTIC, {
			cause: {
				secret: SYNTHETIC_SECRET_TEXT,
				credentials: {
					accessKeyId: SYNTHETIC_ACCESS_KEY_ID,
					secretAccessKey: SYNTHETIC_SECRET_ACCESS_KEY,
					sessionToken: SYNTHETIC_SESSION_TOKEN,
				},
			},
		}),
	});
	failure.stack = `${SYNTHETIC_DIAGNOSTIC}\n${SYNTHETIC_SECRET_ACCESS_KEY}`;
	return Object.defineProperty(
		Object.assign(failure, {
			response: { SecretString: SYNTHETIC_SECRET_TEXT, SecretBinary: syntheticBinary() },
			$metadata: { requestId: SYNTHETIC_SESSION_TOKEN },
		}),
		Symbol(SYNTHETIC_DIAGNOSTIC),
		{ value: { bytes: syntheticBinary(), diagnostic: SYNTHETIC_DIAGNOSTIC } },
	);
}

export interface InputCase {
	name: string;
	secretString?: string;
	secretBinary?: Uint8Array;
	jsonPointer?: string;
	appendNewline?: boolean;
	expected: Uint8Array;
}

export function exactInputCases(): InputCase[] {
	const utf8 = (value: string) => new TextEncoder().encode(value);
	return [
		{
			name: "full UTF-8 string including NUL, combining characters and whitespace",
			secretString: SYNTHETIC_SECRET_TEXT,
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "full JSON string without implicit field selection",
			secretString: JSON.stringify({ token: SYNTHETIC_SECRET_TEXT }),
			expected: utf8(JSON.stringify({ token: SYNTHETIC_SECRET_TEXT })),
		},
		{ name: "empty unselected string", secretString: "", expected: new Uint8Array() },
		{ name: "binary without text decoding", secretBinary: syntheticBinary(), expected: syntheticBinary() },
		{ name: "empty binary", secretBinary: new Uint8Array(), expected: new Uint8Array() },
		{
			name: "escaped slash and tilde tokens",
			secretString: JSON.stringify({ "a/b": { "~key": SYNTHETIC_SECRET_TEXT } }),
			jsonPointer: "/a~1b/~0key",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "escape tokens decoded exactly once",
			secretString: JSON.stringify({ "~1": SYNTHETIC_SECRET_TEXT, "/": "wrong-leaf" }),
			jsonPointer: "/~01",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "empty pointer selecting a root string",
			secretString: JSON.stringify(SYNTHETIC_SECRET_TEXT),
			jsonPointer: "",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{ name: "empty root string leaf", secretString: '""', jsonPointer: "", expected: new Uint8Array() },
		{
			name: "empty object key",
			secretString: JSON.stringify({ "": SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "empty nested string leaf",
			secretString: '{"empty":""}',
			jsonPointer: "/empty",
			expected: new Uint8Array(),
		},
		{
			name: "array string leaf",
			secretString: JSON.stringify({ items: ["wrong-leaf", SYNTHETIC_SECRET_TEXT] }),
			jsonPointer: "/items/1",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "nested root array",
			secretString: JSON.stringify([[SYNTHETIC_SECRET_TEXT]]),
			jsonPointer: "/0/0",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "numeric object key is not an array index",
			secretString: JSON.stringify({ "01": SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/01",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "own constructor key",
			secretString: JSON.stringify({ constructor: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/constructor",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "own __proto__ key",
			secretString: `{"__proto__":${JSON.stringify(SYNTHETIC_SECRET_TEXT)}}`,
			jsonPointer: "/__proto__",
			expected: utf8(SYNTHETIC_SECRET_TEXT),
		},
		{
			name: "newline is appended without trimming existing newline",
			secretString: `${SYNTHETIC_SECRET_TEXT}\n`,
			appendNewline: true,
			expected: utf8(`${SYNTHETIC_SECRET_TEXT}\n\n`),
		},
		{
			name: "newline after selected string",
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/value",
			appendNewline: true,
			expected: utf8(`${SYNTHETIC_SECRET_TEXT}\n`),
		},
		{
			name: "newline after binary",
			secretBinary: syntheticBinary(),
			appendNewline: true,
			expected: Uint8Array.from([...syntheticBinary(), 10]),
		},
	];
}

export interface RejectedPointerCase {
	name: string;
	secretString?: string;
	secretBinary?: Uint8Array;
	jsonPointer: string;
	invalidRequest?: boolean;
}

export function rejectedPointerCases(): RejectedPointerCase[] {
	const array = JSON.stringify({ items: [SYNTHETIC_SECRET_TEXT] });
	return [
		...["value", "#/value", "/value~", "/value~2", "/value~x"].map(jsonPointer => ({
			name: `invalid pointer syntax ${JSON.stringify(jsonPointer)}`,
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer,
			invalidRequest: true,
		})),
		...["01", "-1", "+0", "1.0", "1e0", "-", "1", "9007199254740992", "length"].map(index => ({
			name: `invalid array index ${index}`,
			secretString: array,
			jsonPointer: `/items/${index}`,
		})),
		...["/constructor/name", "/__proto__/constructor/name", "/items/constructor/name"].map(jsonPointer => ({
			name: `inherited property ${jsonPointer}`,
			secretString: array,
			jsonPointer,
		})),
		{
			name: "missing object property",
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/missing",
		},
		{
			name: "missing nested property",
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/value/missing",
		},
		{
			name: "string leaves cannot be traversed as character arrays",
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "/value/0",
		},
		...[null, true, 1, {}, []].map(value => ({
			name: `non-string leaf ${JSON.stringify(value)}`,
			secretString: JSON.stringify({ value }),
			jsonPointer: "/value",
		})),
		{
			name: "root object is not a string leaf",
			secretString: JSON.stringify({ value: SYNTHETIC_SECRET_TEXT }),
			jsonPointer: "",
		},
		{
			name: "invalid JSON",
			secretString: `${JSON.stringify({ value: SYNTHETIC_SECRET_TEXT })} trailing`,
			jsonPointer: "/value",
		},
		{ name: "empty input is not JSON", secretString: "", jsonPointer: "" },
		{
			name: "binary does not support pointer selection",
			secretBinary: new TextEncoder().encode(JSON.stringify({ value: SYNTHETIC_SECRET_TEXT })),
			jsonPointer: "/value",
		},
		{
			name: "binary root pointer is not a text conversion",
			secretBinary: new TextEncoder().encode(JSON.stringify(SYNTHETIC_SECRET_TEXT)),
			jsonPointer: "",
		},
	];
}

export interface BoundaryInputCase {
	name: string;
	secretString?: string;
	secretBinary?: Uint8Array;
	jsonPointer?: string;
	appendNewline: boolean;
	rejected: boolean;
	expected: Uint8Array;
}

export function boundaryInputCases(maxInputBytes: number): BoundaryInputCase[] {
	const rawCases = (["utf8", "binary"] as const).flatMap(kind =>
		[false, true].flatMap(appendNewline =>
			[-1, 0, 1].map(delta => {
				const sourceBytes = maxInputBytes + delta - (appendNewline ? 1 : 0);
				const secretString = "é".repeat(Math.floor(sourceBytes / 2)) + "x".repeat(sourceBytes % 2);
				const source =
					kind === "utf8" ? new TextEncoder().encode(secretString) : new Uint8Array(sourceBytes).fill(0xa5);
				const relation = delta < 0 ? "below" : delta === 0 ? "at" : "above";
				return {
					name: `${kind} ${relation} byte limit${appendNewline ? " with newline" : ""}`,
					...(kind === "utf8" ? { secretString } : { secretBinary: source }),
					appendNewline,
					rejected: delta > 0,
					expected: appendNewline ? Uint8Array.from([...source, 10]) : source.slice(),
				};
			}),
		),
	);
	const base = JSON.stringify({ value: SYNTHETIC_SECRET_TEXT, padding: "" });
	const pointerCases = [0, 1].map(delta => ({
		name: `pointer source ${delta === 0 ? "at" : "above"} byte limit`,
		secretString: JSON.stringify({
			value: SYNTHETIC_SECRET_TEXT,
			padding: "x".repeat(maxInputBytes + delta - new TextEncoder().encode(base).byteLength),
		}),
		jsonPointer: "/value",
		appendNewline: false,
		rejected: delta > 0,
		expected: new TextEncoder().encode(SYNTHETIC_SECRET_TEXT),
	}));
	return [...rawCases, ...pointerCases];
}

export function syntheticAwsHttpResponse(
	service: AwsSecretInputService,
	identity: { Account?: unknown; Arn?: unknown },
	secret: unknown,
	retryableFailure: boolean,
) {
	let body: string;
	if (service === "sts") {
		body = retryableFailure
			? [
					'<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
					"<Error><Type>Receiver</Type><Code>ServiceUnavailable</Code>",
					`<Message>${SYNTHETIC_DIAGNOSTIC}</Message></Error>`,
					"<RequestId>scope-request</RequestId></ErrorResponse>",
				].join("")
			: [
					'<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">',
					`<GetCallerIdentityResult><Arn>${identity.Arn}</Arn><UserId>scope-user</UserId>`,
					`<Account>${identity.Account}</Account></GetCallerIdentityResult>`,
					"<ResponseMetadata><RequestId>scope-request</RequestId></ResponseMetadata>",
					"</GetCallerIdentityResponse>",
				].join("");
	} else if (retryableFailure) {
		body = JSON.stringify({ __type: "InternalServerException", message: SYNTHETIC_DIAGNOSTIC });
	} else if (service === "sso") {
		body = JSON.stringify({ roleCredentials: syntheticRoleCredentials() });
	} else {
		body = JSON.stringify(secret, (_key, value: unknown) =>
			value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value,
		);
	}
	return {
		statusCode: retryableFailure ? 503 : 200,
		headers: {
			"content-type": service === "sts" ? "text/xml" : "application/x-amz-json-1.1",
			"x-amzn-requestid": "scope-request",
		},
		body: new TextEncoder().encode(body),
	};
}
