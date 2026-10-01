#!/usr/bin/env bun
/**
 * Accepts the stdio transport but never answers `initialize`.
 */
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
	// Intentionally drop every message — server never responds.
});
rl.on("close", () => process.exit(0));
