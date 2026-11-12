import { type MessagePort, parentPort } from "node:worker_threads";
import {
	AuthStorage,
	type AuthApiKeyOptions,
	type AuthCredentialEntry,
	type BlocksApi,
	type ApiKeyResolver,
	type ResolvedApiKey,
	type SessionRestrictionLease,
	type StoredCredentialBlock,
} from "@oh-my-pi/pi-ai";
import { MissingApiKeyError } from "@oh-my-pi/pi-ai/error";
import { SessionAccountPoolScope } from "../../src/config/account-pool-scope";
import type { OAuthAccountPools } from "../../src/config/account-pools";
import { ModelRegistry } from "../../src/config/model-registry";
import { anthropicSlowModeLanes } from "../../src/session/anthropic-slow-mode";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { authService } from "../../src/thread/services/auth";
import { RemoteSlowModeLane } from "../../src/thread/services/auth-remote";

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface AuthProbe {
	key(provider: string, sessionId: string, options?: AuthApiKeyOptions): Promise<string | undefined>;
	captureResolver(provider: string, sessionId: string): Promise<void>;
	resolveCaptured(): Promise<string | ResolvedApiKey | undefined>;
	captureSource(): Promise<void>;
	sourceCurrent(): Promise<boolean>;
	retireCapturedOwner(): Promise<void>;
	setCapturedCredential(
		provider: string,
		credential: AuthCredentialEntry,
		blockBeforeAdmission?: StoredCredentialBlock,
	): Promise<void>;
	isClosed(): Promise<boolean>;
	close(): Promise<void>;
	keyError(provider: string, sessionId: string): Promise<{ missingApiKey: boolean; message: string }>;
	accountId(provider: string, sessionId: string): Promise<string | undefined>;
	restrict(provider: string, sessionId: string, identityKeys: string[]): Promise<number>;
	unrestrict(provider: string, sessionId: string, handle: number): Promise<void>;
	ownsRestriction(
		provider: string,
		sessionId: string,
		handle: number | "symbol" | "record",
		other?: AuthStorage,
	): Promise<boolean>;
	scope(registry: ModelRegistry, pools: OAuthAccountPools, sessionId: string): Promise<number>;
	scopedKey(
		handle: number,
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<string | undefined>;
	blockRevision(): Promise<{ instanceId: string; sequence: number } | undefined>;
	listBlocks(credentialIds: readonly number[]): Promise<StoredCredentialBlock[]>;
	upsertBlock(block: StoredCredentialBlock): Promise<void>;
	deleteBlockIfMatches(...args: Parameters<BlocksApi["deleteIfMatches"]>): Promise<boolean>;
	deleteBlocksIfAllMatch(...args: Parameters<BlocksApi["deleteIfAllMatch"]>): Promise<boolean>;
	sameStorage(storage: AuthStorage): Promise<boolean>;
	watchGenerations(): Promise<void>;
	generations(): Promise<number[]>;
	unwatchGenerations(): Promise<void>;
	/** `keys.source(provider)?.kind` of each provider, read through the worker's storage. */
	sourceKinds(providers: string[]): Promise<Array<string | undefined>>;
	registry(registry: ModelRegistry): Promise<{
		local: boolean;
		canonical: boolean;
		sharesAuth: boolean;
		hasModel: boolean;
		apiKey: string | undefined;
	}>;
	observeWrapUp(lane: string): Promise<{ remoteLane: boolean; stage: string | undefined }>;
}

/** Test-only boot globals next to the services' own. */
export interface AuthTestGlobals {
	storage: AuthStorage;
	ready(probe: AuthProbe): void;
}

function isTestGlobals(value: unknown): value is AuthTestGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "storage") instanceof AuthStorage &&
		typeof Reflect.get(value, "ready") === "function"
	);
}

function buildProbe(storage: AuthStorage): AuthProbe {
	const leases: SessionRestrictionLease[] = [];
	const scopes: ModelRegistry[] = [];
	const seen: number[] = [];
	let unwatch: (() => void) | undefined;
	let firstRegistry: ModelRegistry | undefined;
	let capturedResolver: ApiKeyResolver | undefined;
	let capturedSource: string | undefined;
	let capturedGeneration: number | undefined;
	let capturedOwnerCurrent = false;
	return {
		key: (provider, sessionId, options) => storage.keys.get(provider, sessionId, options),
		captureResolver: async (provider, sessionId) => {
			capturedResolver = storage.keys.resolver(provider, { sessionId });
		},
		resolveCaptured: async () => {
			if (!capturedResolver) throw new Error("resolver was not captured");
			return capturedResolver({ lastChance: false, error: undefined });
		},
		captureSource: async () => {
			capturedSource = storage.sourceIdentity;
			capturedGeneration = storage.credentials.generation;
			capturedOwnerCurrent = true;
		},
		sourceCurrent: async () => !storage.isClosed && storage.sourceIdentity === capturedSource,
		retireCapturedOwner: async () => {
			capturedOwnerCurrent = false;
		},
		setCapturedCredential: (provider, credential, blockBeforeAdmission) =>
			storage.credentials.set(provider, credential, {
				assertCurrent: () => {
					if (
						!capturedOwnerCurrent ||
						capturedGeneration === undefined ||
						storage.isClosed ||
						storage.sourceIdentity !== capturedSource ||
						storage.credentials.generation !== capturedGeneration
					) {
						throw new Error("captured credential owner changed");
					}
					if (blockBeforeAdmission) storage.blocks.upsert(blockBeforeAdmission);
				},
			}),
		isClosed: async () => storage.isClosed,
		close: () => storage.close(),
		keyError: async (provider, sessionId) => {
			try {
				await storage.keys.get(provider, sessionId);
				return { missingApiKey: false, message: "resolved" };
			} catch (error) {
				return {
					missingApiKey: error instanceof MissingApiKeyError,
					message: error instanceof Error ? error.message : String(error),
				};
			}
		},
		accountId: async (provider, sessionId) => storage.oauth.identity(provider, sessionId)?.accountId,
		restrict: async (provider, sessionId, identityKeys) =>
			leases.push(storage.sessions.restrict(provider, sessionId, identityKeys)) - 1,
		unrestrict: async (provider, sessionId, handle) => {
			const lease = leases[handle];
			if (lease === undefined) throw new Error(`no lease ${handle}`);
			storage.sessions.unrestrict(provider, sessionId, lease);
		},
		ownsRestriction: async (provider, sessionId, handle, other) => {
			const lease =
				typeof handle === "number"
					? leases[handle]
					: handle === "symbol"
						? Symbol("sessions.restrict")
						: { provider, sessionId };
			return (other ?? storage).sessions.ownsRestriction(provider, sessionId, lease as SessionRestrictionLease);
		},
		scope: async (registry, pools, sessionId) =>
			scopes.push(new SessionAccountPoolScope(storage, pools, sessionId).registry(registry)) - 1,
		scopedKey: (handle, provider, sessionId, options) => {
			const registry = scopes[handle];
			if (!registry) throw new Error(`no scope ${handle}`);
			return registry.getApiKeyForProvider(provider, sessionId, options);
		},
		blockRevision: async () => storage.blocks.revision(),
		listBlocks: async credentialIds => storage.blocks.list(credentialIds),
		upsertBlock: async block => storage.blocks.upsert(block),
		deleteBlockIfMatches: async (...args) => storage.blocks.deleteIfMatches(...args),
		deleteBlocksIfAllMatch: async (...args) => storage.blocks.deleteIfAllMatch(...args),
		sameStorage: async other => other === storage,
		watchGenerations: async () => {
			unwatch = storage.credentials.onGeneration(generation => {
				seen.push(generation);
			});
		},
		generations: async () => [...seen],
		sourceKinds: async providers => providers.map(provider => storage.keys.source(provider)?.kind),
		unwatchGenerations: async () => {
			unwatch?.();
			unwatch = undefined;
		},
		registry: async registry => {
			firstRegistry ??= registry;
			return {
				local: registry instanceof ModelRegistry,
				canonical: firstRegistry === registry,
				sharesAuth: registry.authStorage === storage,
				hasModel: registry.find("unit-mirror", "mirror-model") !== undefined,
				apiKey: await registry.getApiKeyForProvider("unit-mirror"),
			};
		},
		observeWrapUp: async lane => {
			const nowSec = Math.floor(Date.now() / 1000);
			anthropicSlowModeLanes.hooks({}).observe(
				{
					graceUtilization: { fiveHour: 0.3, sevenDay: 0 },
					fiveHourResetAtSec: nowSec + 3_600,
					weeklyResetAtSec: nowSec + 400_000,
					unifiedLimitClaim: false,
					overageInUse: false,
				},
				lane,
			);
			const controller = anthropicSlowModeLanes.lane(lane);
			return { remoteLane: controller instanceof RemoteSlowModeLane, stage: controller.status()?.stage };
		},
	};
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "auth-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	authService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await authService.boot?.(globals[authService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("auth fixture: missing test globals");
		await test.ready(buildProbe(test.storage));
	});
	port.postMessage({ ready: true });
});
