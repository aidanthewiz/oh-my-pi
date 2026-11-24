import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import { FileLock } from "@oh-my-pi/pi-natives";
import { hasFsCode } from "@oh-my-pi/pi-utils/fs-error";

interface PublicationLease {
	lock: FileLock;
	holders: number;
	live: boolean;
}

interface PublicationScope {
	lease: PublicationLease;
	active: boolean;
}

const publicationScope = new AsyncLocalStorage<PublicationScope>();

function publicationLockTarget(): { path: string; legacyKey?: string } {
	const user = userInfo();
	if (process.platform === "win32") {
		const identity = createHash("sha256").update(`${user.username}\0${user.homedir}`.toLowerCase()).digest("hex");
		return { path: `coreforge-artifact-publication-v1-${identity}` };
	}
	const name = `coreforge-artifact-publication-v1-${user.uid}`;

	// HOME, TMPDIR, CWD and artifact paths cannot select a different lease namespace.
	const root = realpathSync("/tmp");
	const rootStat = lstatSync(root);
	if (!rootStat.isDirectory() || rootStat.uid !== 0 || (rootStat.mode & 0o1002) !== 0o1002)
		throw new Error("Artifact publication requires a root-owned sticky temporary directory.");
	const directory = join(root, name);
	try {
		mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (!hasFsCode(error, "EEXIST")) throw error;
	}
	const directoryStat = lstatSync(directory);
	if (!directoryStat.isDirectory() || directoryStat.uid !== user.uid || (directoryStat.mode & 0o777) !== 0o700)
		throw new Error("Artifact publication lock directory is not private to this OS user.");
	const lockPath = join(directory, "publication.lock");
	try {
		closeSync(
			openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600),
		);
	} catch (error) {
		if (!hasFsCode(error, "EEXIST")) throw error;
	}
	const lockStat = lstatSync(lockPath);
	if (!lockStat.isFile() || lockStat.uid !== user.uid || lockStat.nlink !== 1 || (lockStat.mode & 0o777) !== 0o600)
		throw new Error("Artifact publication lock file is not private to this OS user.");
	// This inode is persistent: unlinking it would split concurrent flock owners.
	return { path: lockPath, legacyKey: process.platform === "linux" ? name : undefined };
}

/** Serialize cooperating artifact writers and directory relocations for this OS user. */
export async function withArtifactPublicationLock<T>(
	operation: () => T | Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	signal?.throwIfAborted();
	const inherited = publicationScope.getStore();
	let lease = inherited?.active && inherited.lease.live ? inherited.lease : undefined;
	if (!lease) {
		const target = publicationLockTarget();
		for (;;) {
			signal?.throwIfAborted();
			const lock = FileLock.tryAcquire(target.path, false, target.legacyKey);
			if (lock.acquired) {
				lease = { lock, holders: 0, live: true };
				break;
			}
			lock.release();
			await scheduler.wait(25, { signal });
		}
	}
	lease.holders++;
	const scope: PublicationScope = { lease, active: true };
	try {
		signal?.throwIfAborted();
		return await publicationScope.run(scope, operation);
	} finally {
		scope.active = false;
		if (--lease.holders === 0) {
			lease.live = false;
			lease.lock.release();
		}
	}
}
