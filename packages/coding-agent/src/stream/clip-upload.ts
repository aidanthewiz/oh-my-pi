import { type ClipUploadResponse, STREAM_ROUTES } from "@oh-my-pi/pi-wire";
import { parseRecording, type RecordingHeader } from "./recording";
import type { StreamRedactor } from "./redactor";

export interface ClipUploadOptions {
	/** Stream server base URL (`stream.serverUrl`), e.g. https://live.omp.sh. */
	serverUrl: string;
	/** Stencil bearer (see `StencilCredential`); the clip belongs to its account. */
	token: string;
	/** `.ompcast` file contents. */
	recording: string;
	/** Redacts all public metadata before transmission. */
	redactor: StreamRedactor;
	/** Replaces the recording's title. */
	title?: string;
	description?: string;
}

/**
 * Publish a `/record` capture as a clip at `<server>/c/<id>`. The recording is
 * validated locally, its header stamped with title/description, and sent
 * gzip-compressed.
 *
 * @throws {Error} when the recording is malformed, the server URL is not
 *   http(s), or the server rejects the upload (its error message is included).
 */
export async function uploadClip(options: ClipUploadOptions): Promise<ClipUploadResponse> {
	const base = new URL(options.serverUrl);
	if (base.protocol !== "https:" && base.protocol !== "http:") {
		throw new Error(`clip server URL must use http or https: ${options.serverUrl}`);
	}
	const { header } = parseRecording(options.recording);
	const description = options.description ?? header.description;
	const stamped: RecordingHeader = {
		...header,
		title: options.redactor.redactText(options.title ?? header.title),
		...(description !== undefined && { description: options.redactor.redactText(description) }),
	};
	const body = JSON.stringify(stamped) + options.recording.slice(options.recording.indexOf("\n"));
	const response = await fetch(`${base.origin}${base.pathname.replace(/\/+$/, "")}${STREAM_ROUTES.clips}`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${options.token}`,
			"Content-Type": "application/x-ndjson",
			"Content-Encoding": "gzip",
		},
		body: Bun.gzipSync(body),
	});
	const payload: unknown = await response.json().catch(() => null);
	if (!response.ok) {
		const reason =
			payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
				? payload.error
				: response.statusText;
		throw new Error(`clip upload failed (${response.status}): ${reason}`);
	}
	if (
		!payload ||
		typeof payload !== "object" ||
		!("id" in payload) ||
		!("url" in payload) ||
		typeof payload.id !== "string" ||
		typeof payload.url !== "string"
	) {
		throw new Error("clip upload failed: unexpected server response");
	}
	return { id: payload.id, url: payload.url };
}
