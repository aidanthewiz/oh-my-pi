const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,256}$/;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const AWS_CONTEXT_CLAIM = "https://sts.amazonaws.com/";

export interface RelayIdentity {
	userId: string;
	subject: string;
}

export interface RelayIdentityVerifier {
	verify(token: string): Promise<RelayIdentity>;
}

export interface AwsRelayIdentityVerifierOptions {
	issuer: string;
	audience: string;
	awsAccountId: string;
	awsOrganizationId: string;
	identityStoreArn: string;
	roleArnPrefix: string;
	sourceRegion: string;
	jwksUrl: string;
	maxTokenLifetimeSeconds?: number;
	clockSkewSeconds?: number;
	jwksTtlMs?: number;
	fetch?: typeof fetch;
	now?: () => number;
}

interface JsonWebKey {
	alg?: string;
	e?: string;
	key_ops?: string[];
	kid?: string;
	kty?: string;
	n?: string;
	use?: string;
}

interface JsonWebKeySet {
	keys: JsonWebKey[];
}

interface JwtHeader {
	alg?: unknown;
	kid?: unknown;
	typ?: unknown;
}

interface AwsIdentityClaims {
	iss?: unknown;
	sub?: unknown;
	aud?: unknown;
	iat?: unknown;
	nbf?: unknown;
	exp?: unknown;
	[AWS_CONTEXT_CLAIM]?: unknown;
}

interface AwsIdentityContext {
	aws_account?: unknown;
	org_id?: unknown;
	identity_store_arn?: unknown;
	identity_store_user_id?: unknown;
	principal_id?: unknown;
	source_region?: unknown;
}

/** Offline validator for AWS STS GetWebIdentityToken proofs. */
export class AwsRelayIdentityVerifier implements RelayIdentityVerifier {
	readonly #options: Required<
		Pick<AwsRelayIdentityVerifierOptions, "maxTokenLifetimeSeconds" | "clockSkewSeconds" | "jwksTtlMs">
	> &
		Omit<
			AwsRelayIdentityVerifierOptions,
			"maxTokenLifetimeSeconds" | "clockSkewSeconds" | "jwksTtlMs" | "fetch" | "now"
		>;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#keys = new Map<string, CryptoKey>();
	#refreshedAt = 0;
	#refreshing: Promise<void> | null = null;

	constructor(options: AwsRelayIdentityVerifierOptions) {
		this.#options = {
			...options,
			maxTokenLifetimeSeconds: options.maxTokenLifetimeSeconds ?? 300,
			clockSkewSeconds: options.clockSkewSeconds ?? 30,
			jwksTtlMs: options.jwksTtlMs ?? 60 * 60 * 1_000,
		};
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		validateVerifierOptions(this.#options);
	}

	async verify(token: string): Promise<RelayIdentity> {
		if (token.length > 16_384 || !JWT_RE.test(token)) throw new Error("invalid identity token shape");
		const [encodedHeader, encodedPayload, encodedSignature] = token.split(".") as [string, string, string];
		const header = parseObject<JwtHeader>(encodedHeader, "header");
		if (header.alg !== "RS256" || typeof header.kid !== "string" || !KEY_ID_RE.test(header.kid)) {
			throw new Error("unsupported identity token header");
		}
		if (header.typ !== undefined && header.typ !== "JWT") throw new Error("unsupported identity token type");
		const key = await this.#key(header.kid);
		const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
		const signature = decodeBase64Url(encodedSignature);
		const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
		if (!valid) throw new Error("identity token signature is invalid");

		const claims = parseObject<AwsIdentityClaims>(encodedPayload, "claims");
		return this.#validateClaims(claims);
	}

	#validateClaims(claims: AwsIdentityClaims): RelayIdentity {
		const now = Math.floor(this.#now() / 1_000);
		const skew = this.#options.clockSkewSeconds;
		const context = claims[AWS_CONTEXT_CLAIM];
		if (!context || typeof context !== "object" || Array.isArray(context)) {
			throw new Error("identity token AWS context is invalid");
		}
		const aws = context as AwsIdentityContext;
		if (claims.iss !== this.#options.issuer) throw new Error("identity token issuer is invalid");
		if (!hasExactAudience(claims.aud, this.#options.audience)) throw new Error("identity token audience is invalid");
		if (aws.aws_account !== this.#options.awsAccountId) throw new Error("identity token account is invalid");
		if (aws.org_id !== this.#options.awsOrganizationId) throw new Error("identity token organization is invalid");
		if (aws.identity_store_arn !== undefined && aws.identity_store_arn !== this.#options.identityStoreArn) {
			throw new Error("identity token identity store is invalid");
		}
		if (aws.source_region !== this.#options.sourceRegion) throw new Error("identity token source region is invalid");
		if (typeof aws.identity_store_user_id !== "string" || !USER_ID_RE.test(aws.identity_store_user_id)) {
			throw new Error("identity token user is invalid");
		}
		if (
			typeof claims.sub !== "string" ||
			!isExpectedRoleSubject(claims.sub, this.#options.roleArnPrefix) ||
			aws.principal_id !== claims.sub
		) {
			throw new Error("identity token role is invalid");
		}
		if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
			throw new Error("identity token timestamps are invalid");
		}
		const issuedAt = claims.iat as number;
		const expiresAt = claims.exp as number;
		if (issuedAt > now + skew || expiresAt <= now - skew) throw new Error("identity token is not current");
		if (expiresAt <= issuedAt || expiresAt - issuedAt > this.#options.maxTokenLifetimeSeconds) {
			throw new Error("identity token lifetime is invalid");
		}
		if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || (claims.nbf as number) > now + skew)) {
			throw new Error("identity token is not active");
		}
		return { userId: aws.identity_store_user_id, subject: claims.sub };
	}

	async #key(kid: string): Promise<CryptoKey> {
		const now = this.#now();
		if (this.#keys.size === 0 || now - this.#refreshedAt >= this.#options.jwksTtlMs) await this.#refresh();
		let key = this.#keys.get(kid);
		if (key) return key;
		// Unknown kids force one refresh for rotation, but never more than once per minute.
		if (now - this.#refreshedAt >= 60_000) await this.#refresh();
		key = this.#keys.get(kid);
		if (!key) throw new Error("identity token signing key is unknown");
		return key;
	}

	async #refresh(): Promise<void> {
		if (this.#refreshing) return this.#refreshing;
		this.#refreshing = this.#loadKeys();
		try {
			await this.#refreshing;
		} finally {
			this.#refreshing = null;
		}
	}

	async #loadKeys(): Promise<void> {
		const signal = AbortSignal.timeout(5_000);
		const response = await this.#fetch(this.#options.jwksUrl, { redirect: "error", signal });
		if (!response.ok) throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
		const body = (await response.json()) as Partial<JsonWebKeySet>;
		if (!Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 20) {
			throw new Error("JWKS response is invalid");
		}
		const next = new Map<string, CryptoKey>();
		for (const jwk of body.keys) {
			if (
				jwk.kty !== "RSA" ||
				typeof jwk.kid !== "string" ||
				!KEY_ID_RE.test(jwk.kid) ||
				(jwk.alg !== undefined && jwk.alg !== "RS256") ||
				(jwk.use !== undefined && jwk.use !== "sig")
			) {
				continue;
			}
			const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
				"verify",
			]);
			next.set(jwk.kid, key);
		}
		if (next.size === 0) throw new Error("JWKS contains no usable RS256 keys");
		this.#keys = next;
		this.#refreshedAt = this.#now();
	}
}

export interface BrowserAuthorizationStoreOptions {
	challengeTtlMs?: number;
	sessionTtlMs?: number;
	maxChallenges?: number;
	maxSessions?: number;
	now?: () => number;
}

interface BrowserChallenge {
	id: string;
	code: string;
	expiresAt: number;
	identity?: RelayIdentity;
}

interface BrowserSession {
	identity: RelayIdentity;
	expiresAt: number;
}

export type BrowserChallengeStatus =
	| { status: "pending" }
	| { status: "approved"; accessToken: string; expiresIn: number }
	| { status: "expired" };

/** In-memory, single-use device challenges and opaque browser sessions. */
export class BrowserAuthorizationStore {
	readonly #challengeTtlMs: number;
	readonly #sessionTtlMs: number;
	readonly #maxChallenges: number;
	readonly #maxSessions: number;
	readonly #now: () => number;
	readonly #challenges = new Map<string, BrowserChallenge>();
	readonly #challengeIdsByCode = new Map<string, string>();
	readonly #sessions = new Map<string, BrowserSession>();

	constructor(options: BrowserAuthorizationStoreOptions = {}) {
		this.#challengeTtlMs = options.challengeTtlMs ?? 5 * 60 * 1_000;
		this.#sessionTtlMs = options.sessionTtlMs ?? 60 * 60 * 1_000;
		this.#maxChallenges = options.maxChallenges ?? 10_000;
		this.#maxSessions = options.maxSessions ?? 10_000;
		this.#now = options.now ?? Date.now;
	}

	create(): { challengeId: string; userCode: string; expiresIn: number } {
		this.cleanup();
		if (this.#challenges.size >= this.#maxChallenges) throw new Error("browser challenge capacity reached");
		const id = randomToken();
		let code = randomUserCode();
		while (this.#challengeIdsByCode.has(code)) code = randomUserCode();
		const expiresAt = this.#now() + this.#challengeTtlMs;
		this.#challenges.set(id, { id, code, expiresAt });
		this.#challengeIdsByCode.set(code, id);
		return { challengeId: id, userCode: code, expiresIn: Math.ceil(this.#challengeTtlMs / 1_000) };
	}

	approve(code: string, identity: RelayIdentity): "approved" | "not-found" | "expired" {
		const id = this.#challengeIdsByCode.get(code);
		if (!id) return "not-found";
		const challenge = this.#challenges.get(id);
		if (!challenge) return "not-found";
		if (challenge.expiresAt <= this.#now()) {
			this.#deleteChallenge(challenge);
			return "expired";
		}
		challenge.identity = identity;
		return "approved";
	}

	exchange(challengeId: string): BrowserChallengeStatus {
		const challenge = this.#challenges.get(challengeId);
		if (!challenge) return { status: "expired" };
		if (challenge.expiresAt <= this.#now()) {
			this.#deleteChallenge(challenge);
			return { status: "expired" };
		}
		if (!challenge.identity) return { status: "pending" };
		if (this.#sessions.size >= this.#maxSessions) return { status: "expired" };
		const accessToken = randomToken();
		const expiresAt = this.#now() + this.#sessionTtlMs;
		this.#sessions.set(accessToken, { identity: challenge.identity, expiresAt });
		this.#deleteChallenge(challenge);
		return { status: "approved", accessToken, expiresIn: Math.ceil(this.#sessionTtlMs / 1_000) };
	}

	verifySession(token: string): RelayIdentity | null {
		if (!SESSION_TOKEN_RE.test(token)) return null;
		const session = this.#sessions.get(token);
		if (!session) return null;
		if (session.expiresAt <= this.#now()) {
			this.#sessions.delete(token);
			return null;
		}
		return session.identity;
	}

	cleanup(): void {
		const now = this.#now();
		for (const challenge of this.#challenges.values()) {
			if (challenge.expiresAt <= now) this.#deleteChallenge(challenge);
		}
		for (const [token, session] of this.#sessions) {
			if (session.expiresAt <= now) this.#sessions.delete(token);
		}
	}

	#deleteChallenge(challenge: BrowserChallenge): void {
		this.#challenges.delete(challenge.id);
		this.#challengeIdsByCode.delete(challenge.code);
	}
}

function validateVerifierOptions(value: AwsRelayIdentityVerifierOptions): void {
	for (const [name, candidate] of Object.entries({
		issuer: value.issuer,
		audience: value.audience,
		identityStoreArn: value.identityStoreArn,
		roleArnPrefix: value.roleArnPrefix,
		sourceRegion: value.sourceRegion,
		jwksUrl: value.jwksUrl,
	})) {
		if (typeof candidate !== "string" || candidate.length === 0) throw new Error(`${name} is required`);
	}
	if (!/^\d{12}$/.test(value.awsAccountId)) throw new Error("awsAccountId must contain 12 digits");
	if (!/^o-[a-z0-9]{10,32}$/.test(value.awsOrganizationId)) throw new Error("awsOrganizationId is invalid");
	if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value.sourceRegion)) throw new Error("sourceRegion is invalid");
}

function parseObject<T>(encoded: string, label: string): T {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
	} catch {
		throw new Error(`identity token ${label} is invalid`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`identity token ${label} is invalid`);
	}
	return value as T;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
	try {
		const decoded = Buffer.from(value, "base64url");
		const bytes = new Uint8Array(decoded.byteLength);
		bytes.set(decoded);
		return bytes;
	} catch {
		throw new Error("identity token base64url is invalid");
	}
}

function hasExactAudience(value: unknown, expected: string): boolean {
	return value === expected || (Array.isArray(value) && value.length === 1 && value[0] === expected);
}

function isExpectedRoleSubject(subject: string, prefix: string): boolean {
	if (!subject.startsWith(prefix)) return false;
	return /^[0-9a-f]{16}$/.test(subject.slice(prefix.length));
}

function randomToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

function randomUserCode(): string {
	const bytes = new Uint8Array(8);
	crypto.getRandomValues(bytes);
	let code = "";
	for (let index = 0; index < bytes.length; index++) {
		if (index === 4) code += "-";
		code += USER_CODE_ALPHABET[bytes[index]! % USER_CODE_ALPHABET.length];
	}
	return code;
}
