import path from "node:path";
import { AwsRelayIdentityVerifier, BrowserAuthorizationStore } from "./auth";
import { startRelayServer } from "./server";
import { FileShareStore } from "./share-store";

const port = integerEnv("PORT", 8080, 1, 65_535);
const shareMaxBytes = integerEnv("SHARE_MAX_BYTES", 1_000_000, 29, 16 * 1024 * 1024);
const shareTtlSeconds = integerEnv("SHARE_TTL_SECONDS", 7 * 24 * 60 * 60, 60, 365 * 24 * 60 * 60);
const maxStorageBytes = integerEnv("SHARE_MAX_STORAGE_BYTES", 1_000_000_000, shareMaxBytes, 100_000_000_000);
const maxGuestsPerRoom = integerEnv("MAX_GUESTS_PER_ROOM", 32, 1, 1_000);
const maxRooms = integerEnv("MAX_ROOMS", 1_000, 1, 100_000);
const maxHostRoomsPerClient = integerEnv("MAX_HOST_ROOMS_PER_CLIENT", 25, 1, 1_000);
const maxShareUploadsPerClient = integerEnv("MAX_SHARE_UPLOADS_PER_CLIENT", 20, 1, 10_000);
const shareUploadWindowSeconds = integerEnv("SHARE_UPLOAD_WINDOW_SECONDS", 60 * 60, 60, 7 * 24 * 60 * 60);
const roomIdleTimeoutSeconds = integerEnv("ROOM_IDLE_TIMEOUT_SECONDS", 60 * 60, 60, 7 * 24 * 60 * 60);
const roomMaxAgeSeconds = integerEnv("ROOM_MAX_AGE_SECONDS", 24 * 60 * 60, roomIdleTimeoutSeconds, 30 * 24 * 60 * 60);
const trustedProxyHops = integerEnv("TRUSTED_PROXY_HOPS", 0, 0, 10);
const maxWebSocketPayloadBytes = integerEnv("MAX_WS_PAYLOAD_BYTES", 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const authRequired = booleanEnv("AUTH_REQUIRED", false);
const maxBrowserChallengesPerClient = integerEnv("MAX_BROWSER_CHALLENGES_PER_CLIENT", 20, 1, 1_000);
const browserChallengeWindowSeconds = integerEnv("BROWSER_CHALLENGE_WINDOW_SECONDS", 5 * 60, 60, 60 * 60);
const browserChallengeTtlSeconds = integerEnv("AUTH_BROWSER_CHALLENGE_TTL_SECONDS", 5 * 60, 60, 15 * 60);
const browserSessionTtlSeconds = integerEnv("AUTH_BROWSER_SESSION_TTL_SECONDS", 60 * 60, 60, 8 * 60 * 60);

const shareStore = new FileShareStore({
	directory: process.env.SHARE_DATA_DIR ?? "/data/shares",
	ttlMs: shareTtlSeconds * 1_000,
	maxStorageBytes,
});
const identityVerifier = authRequired
	? new AwsRelayIdentityVerifier({
			issuer: requiredEnv("AUTH_ISSUER"),
			audience: requiredEnv("AUTH_AUDIENCE"),
			awsAccountId: requiredEnv("AUTH_AWS_ACCOUNT_ID"),
			awsOrganizationId: requiredEnv("AUTH_AWS_ORGANIZATION_ID"),
			identityStoreArn: requiredEnv("AUTH_IDENTITY_STORE_ARN"),
			roleArnPrefix: requiredEnv("AUTH_ROLE_ARN_PREFIX"),
			sourceRegion: requiredEnv("AUTH_SOURCE_REGION"),
			jwksUrl: requiredEnv("AUTH_JWKS_URL"),
			maxTokenLifetimeSeconds: integerEnv("AUTH_MAX_TOKEN_LIFETIME_SECONDS", 300, 60, 300),
		})
	: undefined;
const browserAuthorizationStore = new BrowserAuthorizationStore({
	challengeTtlMs: browserChallengeTtlSeconds * 1_000,
	sessionTtlMs: browserSessionTtlSeconds * 1_000,
});

const relay = await startRelayServer({
	hostname: process.env.HOST ?? "0.0.0.0",
	port,
	staticRoot: path.resolve(process.env.COLLAB_WEB_ROOT ?? "/app/public"),
	shareViewerPath: path.resolve(process.env.SHARE_VIEWER_PATH ?? "/app/share-viewer.html"),
	shareStore,
	shareMaxBytes,
	maxGuestsPerRoom,
	maxRooms,
	maxHostRoomsPerClient,
	maxShareUploadsPerClient,
	shareUploadWindowMs: shareUploadWindowSeconds * 1_000,
	roomIdleTimeoutMs: roomIdleTimeoutSeconds * 1_000,
	roomMaxAgeMs: roomMaxAgeSeconds * 1_000,
	trustedProxyHops,
	maxWebSocketPayloadBytes,
	identityVerifier,
	browserAuthorizationStore,
	maxBrowserChallengesPerClient,
	browserChallengeWindowMs: browserChallengeWindowSeconds * 1_000,
});

let stopping = false;
const shutdown = async (): Promise<void> => {
	if (stopping) return;
	stopping = true;
	await relay.stop();
	process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function booleanEnv(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new Error(`${name} must be true or false`);
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is required when AUTH_REQUIRED=true`);
	return value;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
	}
	return value;
}
