import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import { InteractionRequiredAuthError, LogLevel, PublicClientApplication } from "@azure/msal-node";
import { logger } from "@oh-my-pi/pi-utils";
import { openPath } from "../utils/open";
import type { CoreforgeIdentityProfile, CoreforgeIdentityStore } from "./coreforge-store";

const CORE_FORGE_SCOPES = ["User.Read", "openid", "profile", "email", "offline_access"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTHORITY_HOSTS: Record<string, true> = {
	"login.microsoftonline.com": true,
	"login.microsoftonline.us": true,
};

export interface CoreforgeEntraConfig {
	tenantId: string;
	clientId: string;
	authorityHost: string;
}

export interface CoreforgeEntraLoginOptions {
	deviceCode?: boolean;
	onProgress?: (message: string) => void;
	openBrowser?: (url: string) => void | Promise<void>;
	fetch?: typeof globalThis.fetch;
}

interface CoreforgeEntraClient {
	acquireTokenInteractive(request: {
		scopes: string[];
		openBrowser: (url: string) => Promise<void>;
		successTemplate?: string;
		errorTemplate?: string;
	}): Promise<AuthenticationResult>;
	acquireTokenByDeviceCode(request: {
		scopes: string[];
		deviceCodeCallback: (response: { verificationUri: string; message: string }) => void;
	}): Promise<AuthenticationResult | null>;
	acquireTokenSilent(request: { scopes: string[]; account: AccountInfo }): Promise<AuthenticationResult>;
	getAllAccounts(): Promise<AccountInfo[]>;
	signOut(request: { account?: AccountInfo | null }): Promise<void>;
}

export interface CoreforgeEntraDependencies {
	createClient?: (config: CoreforgeEntraConfig, store: CoreforgeIdentityStore) => CoreforgeEntraClient;
}

interface GraphProfile {
	id?: unknown;
	displayName?: unknown;
	givenName?: unknown;
	surname?: unknown;
	mail?: unknown;
	userPrincipalName?: unknown;
}

function normalizeProfileText(value: unknown, maxLength = 256): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

export function validateCoreforgeEntraConfig(config: CoreforgeEntraConfig): CoreforgeEntraConfig {
	const tenantId = config.tenantId.trim();
	const clientId = config.clientId.trim();
	const authorityHost = config.authorityHost.trim().toLowerCase();
	if (!UUID_PATTERN.test(tenantId)) throw new Error("Coreforge Entra tenant ID is missing or invalid");
	if (!UUID_PATTERN.test(clientId)) throw new Error("Coreforge Entra client ID is missing or invalid");
	if (AUTHORITY_HOSTS[authorityHost] !== true) {
		throw new Error(`Unsupported Coreforge Entra authority host: ${authorityHost}`);
	}
	return { tenantId, clientId, authorityHost };
}

function createMsalClient(config: CoreforgeEntraConfig, store: CoreforgeIdentityStore): CoreforgeEntraClient {
	return new PublicClientApplication({
		auth: {
			clientId: config.clientId,
			authority: `https://${config.authorityHost}/${config.tenantId}`,
		},
		cache: { cachePlugin: store.cachePlugin() },
		system: {
			loggerOptions: {
				logLevel: LogLevel.Warning,
				piiLoggingEnabled: false,
				loggerCallback: (level, message, containsPii) => {
					if (!containsPii && level <= LogLevel.Warning) logger.debug("MSAL", { message });
				},
			},
		},
	});
}

export class CoreforgeEntraIdentity {
	readonly #config: CoreforgeEntraConfig;
	readonly #store: CoreforgeIdentityStore;
	readonly #client: CoreforgeEntraClient;

	constructor(config: CoreforgeEntraConfig, store: CoreforgeIdentityStore, deps: CoreforgeEntraDependencies = {}) {
		this.#config = validateCoreforgeEntraConfig(config);
		this.#store = store;
		this.#client = (deps.createClient ?? createMsalClient)(this.#config, store);
	}

	async login(options: CoreforgeEntraLoginOptions = {}): Promise<CoreforgeIdentityProfile> {
		const onProgress = options.onProgress ?? (() => {});
		let result: AuthenticationResult | null;
		if (options.deviceCode) {
			onProgress("Starting Microsoft device-code sign-in...");
			result = await this.#client.acquireTokenByDeviceCode({
				scopes: [...CORE_FORGE_SCOPES],
				deviceCodeCallback: response => {
					onProgress(response.message);
					(options.openBrowser ?? openPath)(response.verificationUri);
				},
			});
		} else {
			onProgress("Opening Microsoft sign-in in your browser...");
			result = await this.#client.acquireTokenInteractive({
				scopes: [...CORE_FORGE_SCOPES],
				openBrowser: async url => {
					await (options.openBrowser ?? openPath)(url);
				},
				successTemplate:
					"<!doctype html><title>Coreforge sign-in complete</title><h1>Coreforge sign-in complete</h1><p>You can close this window and return to your terminal.</p>",
				errorTemplate:
					"<!doctype html><title>Coreforge sign-in failed</title><h1>Coreforge sign-in failed</h1><p>Return to your terminal for details.</p>",
			});
		}
		if (!result) throw new Error("Microsoft sign-in returned no authentication result");
		onProgress("Loading your Coreforce profile...");
		return this.#persistAuthenticationResult(result, options.fetch ?? globalThis.fetch);
	}

	async refresh(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<CoreforgeIdentityProfile> {
		const profile = this.#store.getProfile();
		if (!profile) throw new Error("Coreforge is not signed in");
		const accounts = await this.#client.getAllAccounts();
		const account = accounts.find(candidate => candidate.homeAccountId === profile.homeAccountId);
		if (!account)
			throw new Error("Coreforge Microsoft token cache has no account for the stored identity; sign in again");
		try {
			const result = await this.#client.acquireTokenSilent({ scopes: [...CORE_FORGE_SCOPES], account });
			return await this.#persistAuthenticationResult(result, fetchImpl);
		} catch (error) {
			if (error instanceof InteractionRequiredAuthError) {
				throw new Error("Coreforge Microsoft session needs interactive sign-in", { cause: error });
			}
			throw error;
		}
	}

	async logout(): Promise<void> {
		const accounts = await this.#client.getAllAccounts();
		for (const account of accounts) await this.#client.signOut({ account });
		this.#store.clear();
	}

	async #persistAuthenticationResult(
		result: AuthenticationResult,
		fetchImpl: typeof globalThis.fetch,
	): Promise<CoreforgeIdentityProfile> {
		const account = result.account;
		if (!account) throw new Error("Microsoft sign-in did not return an account");
		if (account.tenantId.toLowerCase() !== this.#config.tenantId.toLowerCase()) {
			throw new Error(`Microsoft sign-in returned unexpected tenant ${account.tenantId}`);
		}
		const graph = await this.#loadGraphProfile(result.accessToken, fetchImpl);
		const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;
		const objectId =
			normalizeProfileText(claims.oid) ??
			normalizeProfileText(graph.id) ??
			normalizeProfileText(account.localAccountId);
		if (!objectId) throw new Error("Microsoft identity is missing its stable object ID");
		const graphId = normalizeProfileText(graph.id);
		if (graphId && graphId.toLowerCase() !== objectId.toLowerCase()) {
			throw new Error("Microsoft Graph profile does not match the authenticated account");
		}
		const username =
			normalizeProfileText(graph.userPrincipalName) ??
			normalizeProfileText(account.username) ??
			normalizeProfileText(claims.preferred_username);
		const email = normalizeProfileText(graph.mail) ?? normalizeProfileText(claims.email) ?? username;
		const displayName = normalizeProfileText(graph.displayName) ?? normalizeProfileText(account.name) ?? email;
		if (!username || !email || !displayName)
			throw new Error("Microsoft profile is missing required name or email attributes");
		const now = Date.now();
		const previous = this.#store.getProfile();
		const sameIdentity =
			previous?.tenantId.toLowerCase() === account.tenantId.toLowerCase() &&
			previous.objectId.toLowerCase() === objectId.toLowerCase();
		const profile: CoreforgeIdentityProfile = {
			tenantId: account.tenantId,
			objectId,
			homeAccountId: account.homeAccountId,
			username,
			displayName,
			givenName: normalizeProfileText(graph.givenName),
			familyName: normalizeProfileText(graph.surname),
			email,
			authorityHost: this.#config.authorityHost,
			authenticatedAt: sameIdentity ? previous.authenticatedAt : now,
			updatedAt: now,
			aws: sameIdentity ? previous.aws : undefined,
		};
		this.#store.setProfile(profile);
		return profile;
	}

	async #loadGraphProfile(accessToken: string, fetchImpl: typeof globalThis.fetch): Promise<GraphProfile> {
		const graphHost = this.#config.authorityHost.endsWith(".us") ? "graph.microsoft.us" : "graph.microsoft.com";
		const response = await fetchImpl(
			`https://${graphHost}/v1.0/me?$select=id,displayName,givenName,surname,mail,userPrincipalName`,
			{
				headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
			},
		);
		if (!response.ok) {
			// Do not include the response body: Graph error payloads routinely
			// carry the user's UPN/display name, which must not travel through
			// logs or crash reporters. The status code is enough to debug.
			throw new Error(`Microsoft Graph profile request failed (HTTP ${response.status})`);
		}
		return (await response.json()) as GraphProfile;
	}
}
