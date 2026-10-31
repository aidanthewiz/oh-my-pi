import assert from "node:assert/strict";
import * as path from "node:path";
import { SQL, RedisClient } from "bun";
import { receipt, required, run } from "./lib";

export async function runTitleDatabases(mode: string): Promise<void> {
	assert(mode === "source" || mode === "compiled");
	const checkout = required("CF_QUAL_CHECKOUT");
	const endpoints: Record<string, string> = {
		sqlite: "",
		mysql: required("CF_QUAL_MYSQL_URL"),
		postgres: required("CF_QUAL_POSTGRES_URL"),
		redis: required("CF_QUAL_REDIS_URL"),
	};
	const observations: object[] = [];
	let complete = false;
	try {
		for (const [adapter, endpoint] of Object.entries(endpoints)) {
			if (adapter !== "sqlite") {
				const url = new URL(endpoint);
				assert.equal(url.hostname, "127.0.0.1", "Database fixture must use explicit IPv4 loopback");
				assert.equal(url.protocol, adapter === "postgres" ? "postgres:" : adapter + ":");
				assert(Number(url.port) > 1024 && Number(url.port) < 65536);
				if (adapter === "redis") {
					const client = new RedisClient(endpoint);
					try {
						assert.equal(await client.send("PING", []), "PONG");
					} finally {
						client.close();
					}
				} else {
					const client = new SQL(endpoint, { connectionTimeout: 10 });
					try {
						assert.equal(Number((await client.unsafe("SELECT 1 AS alive"))[0].alive), 1);
					} finally {
						await client.end();
					}
				}
			}
			const argv = [
				process.execPath,
				"--no-env-file",
				path.join(checkout, "scripts/qualification/domains/run.ts"),
				"--mode",
				mode,
				"--domain",
				"title",
				"--backend",
				adapter,
				...(endpoint ? ["--url", endpoint] : []),
			];
			const result = await run(argv, { cwd: checkout, timeoutMs: 12 * 60_000 });
			observations.push({
				adapter,
				mode,
				health: adapter === "sqlite" ? "real embedded fixture" : "actual loopback service query",
				consumerCommand: argv,
				code: result.code,
				receipt: `domains-${mode}-title-${adapter}.json`,
			});
		}
		assert.equal(observations.length, 4);
		complete = true;
	} finally {
		await receipt(`title-databases-${mode}`, {
			kind: "actual-title-database-matrix",
			complete,
			observations,
			expectedAdapters: Object.keys(endpoints),
			cleanup:
				"Each actual adapter verifies table/key retirement and closes clients; workflow stops and inspects isolated service containers.",
		});
	}
}
