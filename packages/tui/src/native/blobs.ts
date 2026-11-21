/**
 * Content-addressed binary blobs (images) for `image` nodes.
 *
 * `describe()` registers the bytes and puts the returned id in `image.p.blob`;
 * the native backend delivers each referenced blob once per terminal
 * connection (asking the terminal first which it holds, or through its blob
 * cache), else uploads it with verb `b` before the frame that first
 * references it.
 */
import type { TspProps } from "@oh-my-pi/pi-wire";
import { tryFileUri } from "../render/hyperlink";
import { getImageDimensions } from "../terminal-capabilities";
import { node } from "./describe";
import { imageLinksEnabled, transcriptImageLink } from "../prompt/image-references";
import type { NativeChild, NativeNode } from "./node";

export interface NativeBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

const blobs = new Map<string, WeakRef<NativeBlob>>();
const registeredBlobs = new Map<string, NativeBlob>();
const releasedBlobs = new FinalizationRegistry<{ id: string; reference: WeakRef<NativeBlob> }>(({ id, reference }) => {
	if (blobs.get(id) === reference) blobs.delete(id);
});
// Props spreads preserve ownership; wire serialization omits symbol keys.
const kBlob = Symbol("native.blob");
// Registration usually repeats with the same bytes object on every describe;
// the tag skips rehashing it.
const kBlobId = Symbol("native.blobId");

interface BlobTagged {
	[kBlobId]?: string;
}

function getOrCreateBlob(bytes: Uint8Array, mime: string): NativeBlob {
	const known = (bytes as BlobTagged)[kBlobId];
	const id = known ?? new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	(bytes as BlobTagged)[kBlobId] = id;
	let blob = blobs.get(id)?.deref();
	if (!blob) {
		blob = { id, mime, bytes };
		const reference = new WeakRef(blob);
		blobs.set(id, reference);
		releasedBlobs.register(blob, { id, reference });
	}
	return blob;
}

/** Register bytes for process-lifetime, id-only use. Prefer {@link nativeImageNode} for owned images. */
export function registerNativeBlob(bytes: Uint8Array, mime: string): string {
	const blob = getOrCreateBlob(bytes, mime);
	registeredBlobs.set(blob.id, blob);
	return blob.id;
}

/** The blob of `bytes`; registered, but alive only while something holds it ({@link withBlob}). */
export function nativeBlob(bytes: Uint8Array, mime: string): NativeBlob {
	return getOrCreateBlob(bytes, mime);
}

/**
 * `value` (an editor `decor` range) naming `blob`, and owning it as an `image` node's props
 * do: the terminal is sent the bytes while the value is described, and they are released
 * once it no longer is.
 */
export function withBlob<T extends object>(value: T, blob: NativeBlob): T & { blob: string } {
	return { ...value, blob: blob.id, [kBlob]: blob };
}

/** A registered blob by id. */
export function getNativeBlob(id: string): NativeBlob | undefined {
	return blobs.get(id)?.deref();
}

/** An image whose props own its bytes, including while hidden, unmounted, or awaiting upload. */
export function nativeImageNode(
	bytes: Uint8Array,
	mime: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin">,
	key?: string,
): NativeNode {
	const blob = getOrCreateBlob(bytes, mime);
	const props = { ...p, blob: blob.id, [kBlob]: blob };
	return node("image", props, undefined, key);
}

/**
 * An `image` node for a base64 payload: the bytes are registered as a blob and
 * the pixel size probed from the header. Decoding and hashing cost real time,
 * so callers cache the node per payload ({@link NativeImageCache}).
 */
export function base64ImageNode(
	data: string,
	mimeType: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin" | "w" | "h">,
	key?: string,
): NativeNode {
	const size = getImageDimensions(data, mimeType);
	return nativeImageNode(
		Buffer.from(data, "base64"),
		mimeType,
		size ? { ...p, w: size.widthPx, h: size.heightPx } : p,
		key,
	);
}

/**
 * Props that make an `image` node open the file at `filePath` (as a `file://` URL, the TSP
 * open-target form): a click zooms the image in the terminal, and the file opens from its
 * context menu. Always uses a local file URL because the open action runs locally,
 * even when remote file handlers are configured. Empty without a file.
 */
export function openableImageProps(filePath: string | undefined): Pick<TspProps<"image">, "href" | "actions"> {
	const href = filePath ? tryFileUri(filePath, { local: true }) : undefined;
	return href ? { href, actions: { menu: ["open"] } } : {};
}

/**
 * `image` nodes for base64 payloads, one per slot key, rebuilt only when the slot's payload
 * or the link policy changes. Each opens its file (`sourcePath`, else a blob copy).
 */
export class NativeImageCache {
	#entries = new Map<
		string,
		{ data: string; mimeType: string; sourcePath?: string; linked: boolean; node: NativeNode }
	>();

	get(key: string, data: string, mimeType: string, sourcePath?: string): NativeNode {
		const linked = imageLinksEnabled();
		const cached = this.#entries.get(key);
		if (
			cached?.data === data &&
			cached.mimeType === mimeType &&
			cached.sourcePath === sourcePath &&
			cached.linked === linked
		)
			return cached.node;
		const open = openableImageProps(transcriptImageLink({ data, mimeType }, sourcePath));
		const image = base64ImageNode(data, mimeType, { alt: mimeType, ...open }, key);
		this.#entries.set(key, { data, mimeType, sourcePath, linked, node: image });
		return image;
	}
}

/** Blob ids already shown by the renderer's described image nodes. */
export function shownImageBlobs(children: readonly NativeChild[] | undefined): Set<string> {
	const shown = new Set<string>();
	const visit = (list: readonly NativeChild[] | undefined): void => {
		for (const child of list ?? []) {
			if (!("k" in child)) continue;
			const props = child.p;
			if (child.k === "image" && props && "blob" in props && typeof props.blob === "string") shown.add(props.blob);
			visit(child.c);
		}
	};
	visit(children);
	return shown;
}
