import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WasmGrammarInfo } from "@oh-my-pi/pi-natives";
import { installGrammar } from "@oh-my-pi/pi-coding-agent/utils/grammars";
import { TempDir } from "@oh-my-pi/pi-utils";

const RELEASE = "grammars-test";
const WASM = new Uint8Array([
	0x00,
	0x61,
	0x73,
	0x6d,
	0x01,
	0x00,
	0x00,
	0x00,
	...Uint8Array.from({ length: 4096 }, (_, index) => index % 251),
]);
const WASM_SHA256 = new Bun.CryptoHasher("sha256").update(WASM).digest("hex");

function grammarInfo(file: string, sha256: string): WasmGrammarInfo {
	return { language: "testlang", release: RELEASE, file, sha256, size: WASM.byteLength, installed: false };
}

describe("wasm grammar install", () => {
	let server: Bun.Server<undefined>;
	let previousUrl: string | undefined;

	beforeAll(() => {
		const compressed = Bun.zstdCompressSync(WASM);
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const { pathname } = new URL(request.url);
				if (pathname.startsWith(`/${RELEASE}/`) && pathname.endsWith(".wasm.zst")) return new Response(compressed);
				return new Response("not found", { status: 404 });
			},
		});
		previousUrl = process.env.PI_GRAMMARS_URL;
		// `server.url` ends in `/`: the installer must trim it.
		process.env.PI_GRAMMARS_URL = server.url.href;
	});

	afterAll(() => {
		if (previousUrl === undefined) delete process.env.PI_GRAMMARS_URL;
		else process.env.PI_GRAMMARS_URL = previousUrl;
		server.stop(true);
	});

	it("installs the verified grammar at <dir>/<file>", async () => {
		using tempDir = TempDir.createSync("@omp-grammar-install-");
		const info = grammarInfo("testlang-ok.wasm", WASM_SHA256);
		const dest = path.join(tempDir.path(), info.file);

		expect(await installGrammar(info, tempDir.path())).toBe(true);

		expect(await Bun.file(dest).bytes()).toEqual(WASM);
		expect(fs.existsSync(`${dest}.part`)).toBe(false);
		expect(fs.existsSync(`${dest}.zst.part`)).toBe(false);
	});

	it("rejects a digest mismatch without leaving files behind", async () => {
		using tempDir = TempDir.createSync("@omp-grammar-mismatch-");
		const info = grammarInfo("testlang-bad.wasm", "0".repeat(64));
		const dest = path.join(tempDir.path(), info.file);

		expect(await installGrammar(info, tempDir.path())).toBe(false);

		expect(fs.existsSync(dest)).toBe(false);
		expect(fs.existsSync(`${dest}.part`)).toBe(false);
		expect(fs.existsSync(`${dest}.zst.part`)).toBe(false);
	});

	it("replaces a corrupt cache entry instead of trusting its existence", async () => {
		using tempDir = TempDir.createSync("@omp-grammar-corrupt-");
		const info = grammarInfo("testlang-corrupt.wasm", WASM_SHA256);
		const dest = path.join(tempDir.path(), info.file);
		await Bun.write(dest, new Uint8Array(WASM.byteLength));
		expect(await installGrammar(info, tempDir.path())).toBe(true);
		expect(await Bun.file(dest).bytes()).toEqual(WASM);
	});

	it("uses a verified cache without contacting an unavailable mirror", async () => {
		using tempDir = TempDir.createSync("@omp-grammar-cached-");
		const info = grammarInfo("testlang-cached.wasm", WASM_SHA256);
		const dest = path.join(tempDir.path(), info.file);
		await Bun.write(dest, WASM);
		const mirror = process.env.PI_GRAMMARS_URL;
		process.env.PI_GRAMMARS_URL = "http://127.0.0.1:1";
		try {
			expect(await installGrammar(info, tempDir.path())).toBe(true);
			expect(await Bun.file(dest).bytes()).toEqual(WASM);
		} finally {
			process.env.PI_GRAMMARS_URL = mirror;
		}
	});

	it("backs off a failed offline install and leaves no partial files", async () => {
		using tempDir = TempDir.createSync("@omp-grammar-offline-");
		const info = grammarInfo("testlang-offline.wasm", WASM_SHA256);
		const dest = path.join(tempDir.path(), info.file);
		const mirror = process.env.PI_GRAMMARS_URL;
		process.env.PI_GRAMMARS_URL = "http://127.0.0.1:1";
		try {
			expect(await installGrammar(info, tempDir.path())).toBe(false);
			process.env.PI_GRAMMARS_URL = mirror;
			expect(await installGrammar(info, tempDir.path())).toBe(false);
			expect(fs.existsSync(dest)).toBe(false);
			expect(fs.existsSync(`${dest}.part`)).toBe(false);
			expect(fs.existsSync(`${dest}.zst.part`)).toBe(false);
		} finally {
			process.env.PI_GRAMMARS_URL = mirror;
		}
	});
});
