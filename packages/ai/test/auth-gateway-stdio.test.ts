import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createAuthGatewayRouter, serveAuthGatewayStdio } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

/** Serves `lines` through `route`; the parsed output lines. */
async function serve(lines: string[], route: (req: Request) => Promise<Response>): Promise<unknown[]> {
	const output: unknown[] = [];
	await serveAuthGatewayStdio({
		input: new Response(`${lines.join("\n")}\n`).body!,
		write: line => {
			output.push(JSON.parse(line));
		},
		route,
		version: "test",
	});
	return output;
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway stdio transport", () => {
	it("answers a chat request line through the gateway routes", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stdio-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/stdio-model" });
		const router = createAuthGatewayRouter({ storage, resolveModel: () => mock.model });
		try {
			mock.push({ content: ["hello"] });
			const request = {
				id: "a",
				path: "/v1/chat/completions",
				body: { model: "mock/stdio-model", messages: [{ role: "user", content: "hi" }] },
			};
			const output = await serve([JSON.stringify(request)], req => router.route(req, "test"));
			expect(output[0]).toEqual({ ready: true, version: "test" });
			expect(output[1]).toMatchObject({
				id: "a",
				status: 200,
				body: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] },
			});
		} finally {
			router.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("answers in completion order by id, rejects malformed lines and waits for requests in flight", async () => {
		const fastAnswered = Promise.withResolvers<void>();
		const route = async (req: Request): Promise<Response> => {
			const { pathname } = new URL(req.url);
			if (pathname === "/slow") {
				await fastAnswered.promise;
				return Response.json({ state: "complete" });
			}
			queueMicrotask(() => fastAnswered.resolve());
			return new Response(new Uint8Array([0xff, 0x00, 0x7f]), { headers: { "content-type": "audio/mpeg" } });
		};
		const output = await serve(
			[
				JSON.stringify({ id: 1, path: "/slow" }),
				"{not json",
				JSON.stringify({ id: 2, path: "relative" }),
				JSON.stringify({ id: 3, path: "/fast" }),
			],
			route,
		);
		expect(output.slice(1)).toEqual([
			{ id: null, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 2, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 3, status: 200, body: "/wB/", encoding: "base64" },
			{ id: 1, status: 200, body: { state: "complete" } },
		]);
	});

	it("cancels pending route waits when its caller aborts after EOF", async () => {
		const controller = new AbortController();
		const started = Promise.withResolvers<AbortSignal>();
		const output: unknown[] = [];
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/v1/models"}\n').body!,
			write: line => {
				output.push(JSON.parse(line));
			},
			signal: controller.signal,
			route: req => {
				started.resolve(req.signal);
				return new Promise<Response>(() => {});
			},
		});
		const requestSignal = await started.promise;
		controller.abort();
		await work;
		expect(requestSignal.aborted).toBe(true);
		expect(output[1]).toMatchObject({ id: 1, status: 499, body: { error: { type: "request_aborted" } } });
	});

	it("waits for the final output write before completing", async () => {
		const written = Promise.withResolvers<void>();
		const drained = Promise.withResolvers<void>();
		let complete = false;
		const work = serveAuthGatewayStdio({
			input: new Response('{"id":1,"path":"/v1/models"}\n').body!,
			write: async line => {
				if (!("id" in JSON.parse(line))) return;
				written.resolve();
				await drained.promise;
			},
			route: async () => Response.json({ data: [] }),
		}).then(() => {
			complete = true;
		});
		await written.promise;
		expect(complete).toBe(false);
		drained.resolve();
		await work;
		expect(complete).toBe(true);
	});

	it("isolates concurrent request model resolution without changing the default resolver", async () => {
		const storage = await AuthStorage.create(":memory:");
		const chat = createMockModel({ provider: "stdio-resolver-test", id: "same-model" });
		const video = { ...chat, kind: "video" as const };
		const router = createAuthGatewayRouter({ storage, resolveModel: () => video });
		const request = () =>
			new Request("http://stdio/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "same-model", messages: [{ role: "user", content: "hi" }] }),
			});
		try {
			const [chatResponse, videoResponse] = await Promise.all([
				router.route(request(), "test", () => chat),
				router.route(request(), "test", () => video),
			]);
			expect(chatResponse.status).toBe(401);
			expect(videoResponse.status).toBe(400);
			const next = await router.route(request(), "test");
			expect(next.status).toBe(400);
		} finally {
			router.close();
			storage.close();
		}
	});
});
