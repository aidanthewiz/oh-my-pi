import type { ApiKeyResolver } from "@oh-my-pi/pi-ai/auth-retry";
import type { AuthApiKeyOptions, AuthStorage, SessionRestrictionLease } from "@oh-my-pi/pi-ai/auth-storage";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { OAuthAccountPools } from "./account-pools";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import { kNoAuth, type ModelRegistry } from "./model-registry";

/** Rebuildable authorization behind each session-scoped registry. */
const scopedRegistries = new WeakMap<ModelRegistry, { target: ModelRegistry; pools: OAuthAccountPools }>();

/**
 * One agent session's OAuth account pools, enforced at its key lookups.
 *
 * The registry from {@link registry} restricts every provider session id that
 * resolves a pooled provider's key through it before resolving, so requests
 * the session sends under ids it mints on the side (title generation, skill
 * compression, advisors, nested subagents) stay in the pool without each call
 * site opting in. A lookup without a session id resolves under the primary id
 * instead of falling back to the provider's unrestricted credentials.
 *
 * The scope holds the lease of every id it restricted; {@link release} lifts
 * them once the session can no longer resolve keys. A lease lifts only the
 * restriction it installed, so a restriction another session has installed on
 * the same id since, such as a revived session's, stays.
 */
export class SessionAccountPoolScope {
	/** Explicit pools replace inherited policy; inherited policy gets a new session-owned lease. */
	static create(
		registry: ModelRegistry,
		pools: OAuthAccountPools | undefined,
		primarySessionId: string,
	): SessionAccountPoolScope | undefined {
		const inherited = scopedRegistries.get(registry);
		const effectivePools = pools ?? inherited?.pools;
		if (effectivePools === undefined) return undefined;
		return new SessionAccountPoolScope((inherited?.target ?? registry).authStorage, effectivePools, primarySessionId);
	}

	readonly #authStorage: Pick<AuthStorage, "sessions">;
	readonly #pools: OAuthAccountPools;
	/** Provider id → restriction lease, by restricted provider session id. */
	readonly #leases = new Map<string, Map<string, SessionRestrictionLease>>();
	#primarySessionId: string;
	#released = false;

	constructor(authStorage: Pick<AuthStorage, "sessions">, pools: OAuthAccountPools, primarySessionId: string) {
		this.#authStorage = authStorage;
		this.#pools = Object.fromEntries(
			Object.entries(pools).map(([provider, identities]) => [provider, [...identities]]),
		);
		this.#primarySessionId = primarySessionId;
		this.restrict(primarySessionId);
	}

	/** Restrict `sessionId` once; reject a superseded lease or a released scope. */
	restrict(sessionId: string): void {
		if (this.#released) throw new Error("OAuth account pool scope has been released");
		const existing = this.#leases.get(sessionId);
		if (existing) {
			for (const provider of existing.keys()) this.#assertOwnsRestriction(provider, sessionId);
			return;
		}
		if (this.#leases.size > 0) {
			for (const provider of Object.keys(this.#pools)) this.#assertOwnsRestriction(provider, this.#primarySessionId);
		}
		const leases = new Map<string, SessionRestrictionLease>();
		for (const [provider, identityKeys] of Object.entries(this.#pools)) {
			leases.set(provider, this.#authStorage.sessions.restrict(provider, sessionId, identityKeys));
		}
		this.#leases.set(sessionId, leases);
	}

	/** Make `sessionId` the session's primary id: restricted, and the id for lookups that carry none. */
	adopt(sessionId: string): void {
		this.restrict(sessionId);
		this.#primarySessionId = sessionId;
	}

	/** Permanently close this scope and lift every restriction it still owns. */
	release(): void {
		this.#released = true;
		for (const [sessionId, leases] of this.#leases) {
			for (const [provider, lease] of leases) {
				this.#authStorage.sessions.unrestrict(provider, sessionId, lease);
			}
		}
		this.#leases.clear();
	}

	#assertOwnsRestriction(provider: string, sessionId: string | undefined): void {
		if (!Object.hasOwn(this.#pools, provider)) return;
		const lease = sessionId === undefined ? undefined : this.#leases.get(sessionId)?.get(provider);
		if (
			this.#released ||
			sessionId === undefined ||
			lease === undefined ||
			!this.#authStorage.sessions.ownsRestriction(provider, sessionId, lease)
		) {
			throw new MissingApiKeyError(provider, "OAuth account pool scope no longer owns its restriction");
		}
	}

	/** The session id a key lookup for `provider` resolves under, restricted first when pooled. */
	#sessionIdFor(provider: string, sessionId: string | undefined): string | undefined {
		if (!Object.hasOwn(this.#pools, provider)) return sessionId;
		const scopedSessionId = sessionId ?? this.#primarySessionId;
		this.restrict(scopedSessionId);
		return scopedSessionId;
	}

	/**
	 * `registry` with its key lookups (`getApiKey`, `getApiKeyForProvider`,
	 * `getApiKeyWithCredentialForProvider`, `getApiKeyAndHeaders`, `resolver`)
	 * routed through this scope. Every other member is the unscoped registry's,
	 * so model state, discovery, and caches stay shared. A registry another
	 * scope returned is unwrapped first: a nested agent with its own pools uses
	 * them, not its parent's.
	 */
	registry(registry: ModelRegistry): ModelRegistry {
		const target = scopedRegistries.get(registry)?.target ?? registry;
		const getApiKey = async (model: Model<Api>, sessionId?: string, options?: { signal?: AbortSignal }) => {
			const scopedSessionId = this.#sessionIdFor(model.provider, sessionId);
			const apiKey = await target.getApiKey(model, scopedSessionId, options);
			this.#assertOwnsRestriction(model.provider, scopedSessionId);
			if (Object.hasOwn(this.#pools, model.provider) && apiKey === kNoAuth) {
				throw new MissingApiKeyError(model.provider, "OAuth account pools cannot use keyless authentication");
			}
			return apiKey;
		};
		const getApiKeyWithCredentialForProvider = async (
			provider: string,
			sessionId?: string,
			options?: AuthApiKeyOptions,
		) => {
			const scopedSessionId = this.#sessionIdFor(provider, sessionId);
			const resolved = await target.getApiKeyWithCredentialForProvider(provider, scopedSessionId, options);
			this.#assertOwnsRestriction(provider, scopedSessionId);
			if (Object.hasOwn(this.#pools, provider) && resolved?.apiKey === kNoAuth) {
				throw new MissingApiKeyError(provider, "OAuth account pools cannot use keyless authentication");
			}
			return resolved;
		};
		const scoped: Partial<ModelRegistry> = {
			getApiKey,
			getApiKeyWithCredentialForProvider,
			getApiKeyForProvider: async (provider, sessionId, options) => {
				const scopedSessionId = this.#sessionIdFor(provider, sessionId);
				const resolved = await getApiKeyWithCredentialForProvider(provider, scopedSessionId, options);
				this.#assertOwnsRestriction(provider, scopedSessionId);
				return resolved?.apiKey;
			},
			getApiKeyAndHeaders: async model => {
				try {
					const scopedSessionId = this.#sessionIdFor(model.provider, undefined);
					const apiKey = await getApiKey(model, scopedSessionId);
					if (apiKey === undefined) {
						return { ok: false, error: `No API key found for "${model.provider}"` };
					}
					const headers = await target.getProviderHeaders(model.provider);
					this.#assertOwnsRestriction(model.provider, scopedSessionId);
					return { ok: true, apiKey, headers };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
			resolver: ((
				resolverTarget: string | ApiKeyResolverModel,
				optionsOrSessionId?: ApiKeyResolverOptions | string,
			) => {
				const options =
					typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : (optionsOrSessionId ?? {});
				const provider = typeof resolverTarget === "string" ? resolverTarget : resolverTarget.provider;
				const scopedSessionId = this.#sessionIdFor(provider, options.sessionId);
				const resolver = createApiKeyResolver(
					{ getApiKeyWithCredentialForProvider, authStorage: target.authStorage },
					provider,
					{
						...options,
						...(typeof resolverTarget === "string"
							? {}
							: { baseUrl: resolverTarget.baseUrl, modelId: resolverTarget.id }),
						sessionId: scopedSessionId,
					},
				);
				const scopedResolver: ApiKeyResolver = async context => {
					this.#assertOwnsRestriction(provider, scopedSessionId);
					const resolved = await resolver(context);
					this.#assertOwnsRestriction(provider, scopedSessionId);
					return resolved;
				};
				return scopedResolver;
			}) as ModelRegistry["resolver"],
		};
		// ModelRegistry keeps its state in #private fields, so every other member
		// runs against the target itself; bound methods are cached per name.
		const bound = new Map<PropertyKey, unknown>();
		const proxy = new Proxy(target, {
			get(object, property) {
				if (Object.hasOwn(scoped, property)) return scoped[property as keyof ModelRegistry];
				const value: unknown = Reflect.get(object, property, object);
				if (typeof value !== "function") return value;
				let method = bound.get(property);
				if (method === undefined) {
					method = value.bind(object);
					bound.set(property, method);
				}
				return method;
			},
		});
		scopedRegistries.set(proxy, { target, pools: this.#pools });
		return proxy;
	}
}
