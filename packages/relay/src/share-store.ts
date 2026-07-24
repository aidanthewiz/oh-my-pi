import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const SHARE_ID_RE = /^[A-Za-z0-9_-]{10,64}$/;

export class ShareStoreCapacityError extends Error {
	constructor() {
		super("share store capacity reached");
		this.name = "ShareStoreCapacityError";
	}
}

export interface ShareStoreStats {
	bytes: number;
	capacityBytes: number;
}

export interface ShareStore {
	put(data: Uint8Array): Promise<string>;
	get(id: string): Promise<Blob | null>;
	cleanup(): Promise<number>;
	stats(): Promise<ShareStoreStats>;
}

export interface FileShareStoreOptions {
	directory: string;
	ttlMs: number;
	maxStorageBytes: number;
}

export class FileShareStore implements ShareStore {
	readonly #directory: string;
	readonly #ttlMs: number;
	readonly #maxStorageBytes: number;
	#totalBytes = 0;
	#ready: Promise<void> | undefined;
	#mutation = Promise.resolve();

	constructor(options: FileShareStoreOptions) {
		this.#directory = path.resolve(options.directory);
		this.#ttlMs = options.ttlMs;
		this.#maxStorageBytes = options.maxStorageBytes;
	}

	async put(data: Uint8Array): Promise<string> {
		await this.#ensureReady();
		return this.#mutate(async () => {
			await this.#cleanupLocked(Date.now());
			if (this.#totalBytes + data.byteLength > this.#maxStorageBytes) throw new ShareStoreCapacityError();

			for (let attempt = 0; attempt < 5; attempt++) {
				const random = new Uint8Array(18);
				crypto.getRandomValues(random);
				const id = `s_${Buffer.from(random).toString("base64url")}`;
				const filePath = this.#filePath(id);
				let handle: FileHandle | undefined;
				try {
					handle = await open(filePath, "wx", 0o600);
					await handle.writeFile(data);
					await handle.sync();
					this.#totalBytes += data.byteLength;
					return id;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
						await unlink(filePath).catch(() => undefined);
						throw error;
					}
				} finally {
					await handle?.close();
				}
			}
			throw new Error("could not allocate a unique share id");
		});
	}

	async get(id: string): Promise<Blob | null> {
		if (!SHARE_ID_RE.test(id)) return null;
		await this.#ensureReady();
		const filePath = this.#filePath(id);
		try {
			const metadata = await stat(filePath);
			if (!metadata.isFile()) return null;
			if (metadata.mtimeMs + this.#ttlMs <= Date.now()) {
				await this.#mutate(async () => {
					await this.#deleteLocked(filePath, metadata.size);
				});
				return null;
			}
			return Bun.file(filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	async cleanup(): Promise<number> {
		await this.#ensureReady();
		return this.#mutate(() => this.#cleanupLocked(Date.now()));
	}

	async stats(): Promise<ShareStoreStats> {
		await this.#ensureReady();
		return { bytes: this.#totalBytes, capacityBytes: this.#maxStorageBytes };
	}

	async #ensureReady(): Promise<void> {
		this.#ready ??= this.#initialize();
		await this.#ready;
	}

	async #initialize(): Promise<void> {
		await mkdir(this.#directory, { recursive: true, mode: 0o700 });
		const entries = await readdir(this.#directory, { withFileTypes: true });
		const now = Date.now();
		let total = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !SHARE_ID_RE.test(entry.name)) continue;
			const filePath = this.#filePath(entry.name);
			const metadata = await stat(filePath);
			if (metadata.mtimeMs + this.#ttlMs <= now) {
				await unlink(filePath).catch(() => undefined);
				continue;
			}
			total += metadata.size;
		}
		this.#totalBytes = total;
	}

	async #cleanupLocked(now: number): Promise<number> {
		const entries = await readdir(this.#directory, { withFileTypes: true });
		let deleted = 0;
		for (const entry of entries) {
			if (!entry.isFile() || !SHARE_ID_RE.test(entry.name)) continue;
			const filePath = this.#filePath(entry.name);
			try {
				const metadata = await stat(filePath);
				if (metadata.mtimeMs + this.#ttlMs > now) continue;
				await this.#deleteLocked(filePath, metadata.size);
				deleted++;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		return deleted;
	}

	async #deleteLocked(filePath: string, size: number): Promise<void> {
		try {
			await unlink(filePath);
			this.#totalBytes = Math.max(0, this.#totalBytes - size);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	#filePath(id: string): string {
		return path.join(this.#directory, id);
	}

	async #mutate<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#mutation;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#mutation = promise;
		const release = resolve;
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}
}
