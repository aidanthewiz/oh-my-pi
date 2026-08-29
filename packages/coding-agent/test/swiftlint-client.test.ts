import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SwiftLintClient } from "../src/lsp/clients/swiftlint-client";
import type { ServerConfig } from "../src/lsp/types";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

describe("SwiftLintClient", () => {
	it("does not pass managed profile secrets to SwiftLint", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-swiftlint-client-test-"));
		tempDirs.push(tempDir);
		const targetFile = path.join(tempDir, "example.swift");
		const envCapture = path.join(tempDir, "child-env.txt");
		const command = path.join(tempDir, "swiftlint-env-probe");
		const previousSecret = Bun.env.OPENAI_API_KEY;
		Bun.env.OPENAI_API_KEY = "managed-profile-sentinel";
		try {
			await Bun.write(path.join(tempDir, ".env"), "OPENAI_API_KEY=managed-profile-sentinel\n");
			await Bun.write(
				command,
				`#!/bin/sh
printf '%s\n' "\${OPENAI_API_KEY-}" > "${envCapture}"
printf '%s\n' "\${PATH-}" >> "${envCapture}"
printf '[]\n'
`,
			);
			await fs.chmod(command, 0o755);
			await Bun.write(targetFile, "struct Example {}\n");

			const config: ServerConfig = {
				command: "swiftlint",
				fileTypes: [".swift"],
				rootMarkers: [],
				resolvedCommand: command,
			};
			const diagnostics = await new SwiftLintClient(config, tempDir).lint(targetFile);

			expect(diagnostics).toEqual([]);
			const [secret, childPath] = (await Bun.file(envCapture).text()).split("\n");
			expect(secret).toBe("");
			expect(childPath).toBe(Bun.env.PATH ?? "");
		} finally {
			if (previousSecret === undefined) delete Bun.env.OPENAI_API_KEY;
			else Bun.env.OPENAI_API_KEY = previousSecret;
		}
	});
});
