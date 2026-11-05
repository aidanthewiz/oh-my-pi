import { createHash, timingSafeEqual } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { ConcatSink } from "@oh-my-pi/pi-utils/stream";

export interface AwsDbMysqlFixtureOptions {
	port?: number;
	username?: string;
	certificateHost?: string;
	timeoutMs?: number;
	reader?: "writable" | "unknown";
	promotion?: "during-read" | "after-read";
	replaceSession?: boolean;
	serverMismatch?: boolean;
	invalidProof?: boolean;
	principalMismatch?: boolean;
	forwarding?: boolean;
	grants?: "writable" | "role" | "malformed";
	view?: boolean;
	tableReplacement?: boolean;
	missing?: boolean;
	rawTemplate?: string;
	stepType?: string;
	delay?: "handshake" | "read";
	oversizedPacket?: boolean;
	cumulativeBytes?: boolean;
	localInfile?: boolean;
	executionLimitMismatch?: boolean;
	controlResponse?: "rows" | "affected" | "warning";
	extraRows?: boolean;
	errorAt?: number;
	badSequence?: boolean;
	disconnectAtRead?: boolean;
}

export interface AwsDbMysqlFixtureState {
	connections: number;
	tlsConnections: number;
	closedConnections: number;
	commands: string[];
	definitionReads: number;
	definitionBindingsVerified: boolean;
	authenticationVerified: boolean;
	serverExecutionLimitVerified: boolean;
	localInfilePayloadBytes: number;
}

export interface AwsDbMysqlFixture {
	target: {
		endpoint: "localhost";
		port: number;
		database: "fixture";
		instanceIdentifier: "fixture-reader";
		partition: "aws";
	};
	tlsCa: string;
	username: string;
	password: string;
	read: {
		agencyId: "7";
		automationId: "11";
		stepId: "13";
		limits: { maxRows: 1; maxBytes: 4096; timeoutMs: number };
	};
	state: AwsDbMysqlFixtureState;
	connected: Promise<void>;
	readStarted: Promise<void>;
	peerClosed: Promise<void>;
	containsSensitive(text: string): boolean;
	close(): Promise<void>;
}

type Cell = string | null;
type Row = readonly Cell[];
type QueryKind = "proof" | "grants" | "metadata" | "pin" | "begin" | "rollback" | "set" | "uncast-set" | "definition";
interface ParameterType {
	code: number;
	unsigned: boolean;
}
interface PreparedStatement {
	id: number;
	kind: "definition" | "set";
	parameterCount: number;
	integerCast: boolean;
	types?: ParameterType[];
}
interface FixtureSession {
	raw: net.Socket;
	stream: net.Socket;
	closed: Promise<void>;
}

const SERVER_UUID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "321";
const PROOF_COLUMNS = [
	"connection_id",
	"server_uuid",
	"aurora_server_id",
	"reader",
	"forwarding",
	"roles",
	"mandatory_roles",
	"execution_limit",
	"authenticated_user",
	"client_user",
];
const DEFINITION_COLUMNS = ["query_text", "source_bytes", "step_type", ...PROOF_COLUMNS];
const MAX_PACKET_BYTES = 65_536;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_SSL = 0x00000800;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const SERVER_CAPABILITIES =
	CLIENT_PROTOCOL_41 |
	CLIENT_CONNECT_WITH_DB |
	CLIENT_SSL |
	CLIENT_SECURE_CONNECTION |
	CLIENT_PLUGIN_AUTH |
	0x00000001 |
	0x00000004 |
	0x00002000;
const EOF_PACKET = Buffer.from([0xfe, 0, 0, 2, 0]);
const SAFE_COMMANDS: Record<QueryKind, string> = {
	proof: `SELECT CONNECTION_ID() AS connection_id, @@server_uuid AS server_uuid,
@@aurora_server_id AS aurora_server_id, @@innodb_read_only AS reader,
@@session.aurora_replica_read_consistency AS forwarding, CURRENT_ROLE() AS roles,
@@global.mandatory_roles AS mandatory_roles, @@session.max_execution_time AS execution_limit,
CURRENT_USER() AS authenticated_user, USER() AS client_user`,
	grants: "SHOW GRANTS FOR CURRENT_USER()",
	metadata: `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS engine
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME IN ('automations', 'automation_steps') ORDER BY TABLE_NAME LIMIT 3`,
	pin: "SELECT 1 FROM automations AS a JOIN automation_steps AS s ON s.automation_id = a.id LIMIT 0",
	begin: "START TRANSACTION READ ONLY",
	rollback: "ROLLBACK",
	set: "SET SESSION MAX_EXECUTION_TIME = CAST(? AS UNSIGNED)",
	"uncast-set": "SET SESSION MAX_EXECUTION_TIME = ?",
	definition: `SELECT CASE WHEN OCTET_LENGTH(s.query_text) <= ? AND @@innodb_read_only = 1
AND @@session.aurora_replica_read_consistency = '' THEN s.query_text ELSE NULL END AS query_text,
OCTET_LENGTH(s.query_text) AS source_bytes,
CASE WHEN OCTET_LENGTH(s.step_type) <= 32 THEN s.step_type ELSE NULL END AS step_type,
CONNECTION_ID() AS connection_id, @@server_uuid AS server_uuid,
@@aurora_server_id AS aurora_server_id, @@innodb_read_only AS reader,
@@session.aurora_replica_read_consistency AS forwarding, CURRENT_ROLE() AS roles,
@@global.mandatory_roles AS mandatory_roles, @@session.max_execution_time AS execution_limit,
CURRENT_USER() AS authenticated_user, USER() AS client_user
FROM automations AS a JOIN automation_steps AS s
ON s.automation_id = a.id AND s.agency_id = a.agency_id
WHERE @@aurora_server_id = ? AND @@server_uuid = ? AND CONNECTION_ID() = ?
AND @@innodb_read_only = 1 AND @@session.aurora_replica_read_consistency = ''
AND a.agency_id = ? AND a.id = ? AND s.agency_id = ? AND s.id = ?
AND a.deleted_at IS NULL AND s.deleted_at IS NULL LIMIT 1`,
};
const FIXED_QUERIES = new Map<string, QueryKind>();
for (const kind of Object.keys(SAFE_COMMANDS) as QueryKind[]) {
	FIXED_QUERIES.set(SAFE_COMMANDS[kind].replace(/\s+/gu, " ").trim().toUpperCase(), kind);
}

function token(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
}

async function certificate(host: string): Promise<{ key: string; cert: string }> {
	if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/iu.test(host) || host.includes("..")) {
		throw new Error("Synthetic MySQL certificate requires a DNS hostname");
	}
	const configuration = [
		"[req]",
		"prompt = no",
		"distinguished_name = subject",
		"x509_extensions = extensions",
		"[subject]",
		`CN = ${host}`,
		"[extensions]",
		`subjectAltName = DNS:${host}`,
		"basicConstraints = critical,CA:TRUE",
		"keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign",
		"extendedKeyUsage = serverAuth",
		"",
	].join("\n");
	try {
		const child = Bun.spawn(
			[
				"/usr/bin/openssl",
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-sha256",
				"-days",
				"1",
				"-config",
				"/dev/stdin",
				"-keyout",
				"/dev/stdout",
				"-out",
				"/dev/stdout",
			],
			{
				env: { LC_ALL: "C" },
				stdin: new TextEncoder().encode(configuration),
				stdout: "pipe",
				stderr: "ignore",
				timeout: 10_000,
				killSignal: "SIGKILL",
			},
		);
		try {
			const [pem, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
			const key = /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/u.exec(pem)?.[0];
			const cert = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u.exec(pem)?.[0];
			if (code !== 0 || !key || !cert) throw new Error("Certificate generation failed");
			return { key, cert };
		} finally {
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
		}
	} catch {
		throw new Error("Synthetic MySQL fixture requires /usr/bin/openssl with in-memory certificate generation");
	}
}

function frame(payload: Uint8Array, sequence: number): Buffer {
	const packet = Buffer.allocUnsafe(4 + payload.length);
	packet.writeUIntLE(payload.length, 0, 3);
	packet[3] = sequence & 0xff;
	packet.set(payload, 4);
	return packet;
}

function lengthEncoded(value: number): Buffer {
	if (value < 0xfb) return Buffer.from([value]);
	if (value <= 0xffff) {
		const bytes = Buffer.allocUnsafe(3);
		bytes[0] = 0xfc;
		bytes.writeUInt16LE(value, 1);
		return bytes;
	}
	if (value <= 0xffffff) {
		const bytes = Buffer.allocUnsafe(4);
		bytes[0] = 0xfd;
		bytes.writeUIntLE(value, 1, 3);
		return bytes;
	}
	const bytes = Buffer.allocUnsafe(9);
	bytes[0] = 0xfe;
	bytes.writeBigUInt64LE(BigInt(value), 1);
	return bytes;
}

function encodedString(value: string): Buffer {
	const bytes = Buffer.from(value, "utf8");
	return Buffer.concat([lengthEncoded(bytes.length), bytes]);
}

function column(name: string): Buffer {
	const attributes = Buffer.alloc(13);
	attributes[0] = 0x0c;
	attributes.writeUInt16LE(45, 1);
	attributes.writeUInt32LE(MAX_PACKET_BYTES, 3);
	attributes[7] = 0xfd;
	return Buffer.concat([...["def", "fixture", "", "", name, ""].map(encodedString), attributes]);
}

function textRow(values: Row): Buffer {
	return Buffer.concat(values.map(value => (value === null ? Buffer.from([0xfb]) : encodedString(value))));
}

function binaryRow(values: Row): Buffer {
	const prefix = Buffer.alloc(1 + Math.ceil((values.length + 2) / 8));
	for (let index = 0; index < values.length; index++) {
		if (values[index] === null) prefix[1 + ((index + 2) >> 3)]! |= 1 << ((index + 2) & 7);
	}
	return Buffer.concat([prefix, ...values.filter((value): value is string => value !== null).map(encodedString)]);
}

function greeting(scramble: Buffer): Buffer {
	const fixed = Buffer.alloc(18);
	fixed.writeUInt16LE(SERVER_CAPABILITIES & 0xffff, 0);
	fixed[2] = 45;
	fixed.writeUInt16LE(2, 3);
	fixed.writeUInt16LE(SERVER_CAPABILITIES >>> 16, 5);
	fixed[7] = 21;
	const connection = Buffer.allocUnsafe(4);
	connection.writeUInt32LE(Number(CONNECTION_ID));
	return Buffer.concat([
		Buffer.from("\x0a8.0.36-synthetic\0", "utf8"),
		connection,
		scramble.subarray(0, 8),
		Buffer.from([0]),
		fixed,
		scramble.subarray(8),
		Buffer.from("\0mysql_native_password\0", "utf8"),
	]);
}

function authenticated(payload: Buffer, username: string, password: string, scramble: Buffer): boolean {
	if (payload.length < 34) return false;
	const flags = payload.readUInt32LE(0);
	const required =
		CLIENT_PROTOCOL_41 | CLIENT_CONNECT_WITH_DB | CLIENT_SSL | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
	if ((flags & required) !== required) return false;
	const usernameEnd = payload.indexOf(0, 32);
	if (usernameEnd < 0 || payload.toString("utf8", 32, usernameEnd) !== username) return false;
	const tokenLength = payload[usernameEnd + 1];
	if (tokenLength !== 20) return false;
	const authStart = usernameEnd + 2;
	const databaseStart = authStart + tokenLength;
	const databaseEnd = payload.indexOf(0, databaseStart);
	if (databaseEnd < 0 || payload.toString("utf8", databaseStart, databaseEnd) !== "fixture") return false;
	const pluginEnd = payload.indexOf(0, databaseEnd + 1);
	if (pluginEnd < 0 || payload.toString("utf8", databaseEnd + 1, pluginEnd) !== "mysql_native_password") return false;
	const first = createHash("sha1").update(password).digest();
	const second = createHash("sha1").update(first).digest();
	const mask = createHash("sha1").update(scramble).update(second).digest();
	for (let index = 0; index < first.length; index++) first[index]! ^= mask[index]!;
	return timingSafeEqual(first, payload.subarray(authStart, databaseStart));
}

function queryKind(sql: string): QueryKind | undefined {
	const text = sql.trim().replace(/\s+/gu, " ").toUpperCase();
	const fixed = FIXED_QUERIES.get(text);
	if (fixed) return fixed;
	if (
		/^SET SESSION (?:MAX_EXECUTION_TIME\s*=\s*[0-9]{1,5}|TRANSACTION_READ_ONLY\s*=\s*(?:1|ON)|AURORA_REPLICA_READ_CONSISTENCY\s*=\s*'')$/u.test(
			text,
		)
	)
		return "set";
	return undefined;
}

function parameters(payload: Buffer, statement: PreparedStatement): Array<string | null> | undefined {
	try {
		if (
			payload.length < 10 ||
			payload.readUInt32LE(1) !== statement.id ||
			payload[5] !== 0 ||
			payload.readUInt32LE(6) !== 1
		)
			return undefined;
		const count = statement.parameterCount;
		if (count === 0) return payload.length === 10 ? [] : undefined;
		const nullBytes = Math.ceil(count / 8);
		let offset = 10 + nullBytes;
		const newTypes = payload[offset++];
		if (newTypes === 1) {
			statement.types = [];
			for (let index = 0; index < count; index++) {
				statement.types.push({
					code: payload.readUInt8(offset),
					unsigned: (payload.readUInt8(offset + 1) & 0x80) !== 0,
				});
				offset += 2;
			}
		} else if (newTypes !== 0) return undefined;
		if (statement.types?.length !== count) return undefined;
		const result: Array<string | null> = [];
		for (let index = 0; index < count; index++) {
			const type = statement.types[index]!;
			if ((payload[10 + (index >> 3)]! & (1 << (index & 7))) !== 0 || type.code === 6) {
				result.push(null);
				continue;
			}
			if (type.code === 5) {
				result.push(String(payload.readDoubleLE(offset)));
				offset += 8;
			} else if (type.code === 3) {
				result.push(String(type.unsigned ? payload.readUInt32LE(offset) : payload.readInt32LE(offset)));
				offset += 4;
			} else if (type.code === 8) {
				result.push(String(type.unsigned ? payload.readBigUInt64LE(offset) : payload.readBigInt64LE(offset)));
				offset += 8;
			} else if ([0x0f, 0xfc, 0xfd, 0xfe].includes(type.code)) {
				let length = payload.readUInt8(offset++);
				if (length === 0xfc) {
					length = payload.readUInt16LE(offset);
					offset += 2;
				} else if (length === 0xfd) {
					length = payload.readUIntLE(offset, 3);
					offset += 3;
				} else if (length >= 0xfb) return undefined;
				if (offset + length > payload.length) return undefined;
				result.push(payload.toString("utf8", offset, offset + length));
				offset += length;
			} else return undefined;
		}
		return offset === payload.length ? result : undefined;
	} catch {
		return undefined;
	}
}

/** Synthetic wire responses exercise transport and proof handling, not Aurora SQL execution semantics. */
export async function startAwsDbMysqlFixture(options: AwsDbMysqlFixtureOptions = {}): Promise<AwsDbMysqlFixture> {
	const port = options.port ?? 0;
	if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Synthetic MySQL port is invalid");
	const timeoutMs = options.timeoutMs ?? 2000;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
		throw new Error("Synthetic MySQL timeout is invalid");
	const material = await certificate(options.certificateHost ?? "localhost");
	const context = tls.createSecureContext({ key: material.key, cert: material.cert, minVersion: "TLSv1.2" });
	const sensitive = new Set<string>([material.key, JSON.stringify(material.key).slice(1, -1)]);
	for (const line of material.key.split(/\r?\n/u)) {
		if (line.length >= 32 && !line.startsWith("-----")) sensitive.add(line);
	}
	function secretToken(): string {
		const value = token();
		sensitive.add(value);
		return value;
	}
	const username = options.username ?? `fixture_${token().slice(0, 16)}`;
	if (!/^[a-zA-Z0-9_]{1,32}$/u.test(username)) throw new Error("Synthetic MySQL username is invalid");
	const password = secretToken();
	const rawTemplate =
		options.rawTemplate ??
		`SELECT \`field_${secretToken()}\` FROM \`table_${secretToken()}\` WHERE \`owner_${secretToken()}\` = '${secretToken()}@example.invalid'`;
	const read: AwsDbMysqlFixture["read"] = {
		agencyId: "7",
		automationId: "11",
		stepId: "13",
		limits: { maxRows: 1, maxBytes: 4096, timeoutMs },
	};
	const state: AwsDbMysqlFixtureState = {
		connections: 0,
		tlsConnections: 0,
		closedConnections: 0,
		commands: [],
		definitionReads: 0,
		definitionBindingsVerified: false,
		authenticationVerified: false,
		serverExecutionLimitVerified: false,
		localInfilePayloadBytes: 0,
	};
	const sessions = new Set<FixtureSession>();
	const connected = Promise.withResolvers<void>();
	const readStarted = Promise.withResolvers<void>();
	const peerClosed = Promise.withResolvers<void>();
	let closing: Promise<void> | undefined;
	let closed = false;
	const server = net.createServer(raw => {
		state.connections++;
		connected.resolve();
		const completion = Promise.withResolvers<void>();
		const session: FixtureSession = { raw, stream: raw, closed: completion.promise };
		sessions.add(session);
		raw.once("close", () => {
			state.closedConnections++;
			peerClosed.resolve();
			sessions.delete(session);
			completion.resolve();
		});
		raw.on("error", () => raw.destroy());
		if (closed) {
			raw.destroy();
			return;
		}
		raw.setNoDelay(true);
		const scramble = Buffer.from(crypto.getRandomValues(new Uint8Array(20)));
		const pending = new ConcatSink();
		let phase: "ssl-request" | "authenticate" | "commands" = "ssl-request";
		const statements = new Map<number, PreparedStatement>();
		let nextStatementId = 1;
		let executionLimit = "0";
		let localInfileRequested = false;
		let queryOrdinal = 0;
		let definitionReads = 0;
		let inTransaction = false;
		let pinned = false;

		function send(payload: Uint8Array, sequence = 1): void {
			if (!closed && !session.stream.destroyed) session.stream.write(frame(payload, sequence));
		}
		function ok(sequence = 1, affectedRows = 0, warningStatus = 0): void {
			const status = inTransaction ? 0x2003 : 2;
			send(Buffer.from([0, affectedRows, 0, status & 0xff, status >>> 8, warningStatus, 0]), sequence);
		}
		function error(sensitive = false, sequence = 1): void {
			const message = sensitive
				? `${secretToken()} ${password} ${rawTemplate}`
				: "Unsupported synthetic MySQL command";
			send(Buffer.concat([Buffer.from([0xff, 0x51, 0x04]), Buffer.from("#HY000"), Buffer.from(message)]), sequence);
		}
		function rows(columns: readonly string[], values: readonly Row[], binary = false): void {
			let sequence = binary && options.badSequence ? 2 : 1;
			send(lengthEncoded(columns.length), sequence++);
			for (const name of columns) send(column(name), sequence++);
			send(EOF_PACKET, sequence++);
			for (const value of values) send(binary ? binaryRow(value) : textRow(value), sequence++);
			send(EOF_PACKET, sequence);
		}
		function proof(duringRead = false): Row {
			const promoted =
				(options.promotion === "during-read" && duringRead) ||
				(options.promotion !== undefined && definitionReads > 0 && !duringRead);
			return [
				options.replaceSession && (duringRead || definitionReads > 0) ? "322" : CONNECTION_ID,
				options.invalidProof ? "invalid" : SERVER_UUID,
				options.serverMismatch ? "fixture-other" : "fixture-reader",
				options.reader === "unknown" ? "unknown" : options.reader === "writable" || promoted ? "0" : "1",
				options.forwarding ? "SESSION" : "",
				"NONE",
				"",
				options.executionLimitMismatch ? "0" : executionLimit,
				`${options.principalMismatch ? "fixture_other" : username}@localhost`,
				`${username}@localhost`,
			];
		}
		function failAtOrdinal(): boolean {
			queryOrdinal++;
			if (queryOrdinal !== options.errorAt) return false;
			error(true);
			return true;
		}
		function setExecutionLimit(
			value: string | null | undefined,
			numeric: boolean,
			response?: AwsDbMysqlFixtureOptions["controlResponse"],
		): void {
			if (
				!numeric ||
				value === null ||
				value === undefined ||
				!/^[0-9]{1,5}$/u.test(value) ||
				Number(value) < 1 ||
				Number(value) > 10_000
			) {
				error();
				return;
			}
			executionLimit = String(Number(value));
			state.serverExecutionLimitVerified = Number(value) === read.limits.timeoutMs;
			if (response === "rows") rows(["unexpected"], [["1"]], true);
			else ok(1, response === "affected" ? 1 : 0, response === "warning" ? 1 : 0);
		}
		function definition(bindings: Array<string | null>, binary: boolean): void {
			state.definitionReads++;
			readStarted.resolve();
			const expected = [
				String(read.limits.maxBytes),
				"fixture-reader",
				SERVER_UUID,
				CONNECTION_ID,
				read.agencyId,
				read.automationId,
				read.agencyId,
				read.stepId,
			];
			state.definitionBindingsVerified =
				bindings.length === expected.length && bindings.every((value, index) => value === expected[index]);
			if (failAtOrdinal()) return;
			if (options.disconnectAtRead) {
				session.stream.destroy();
				return;
			}
			if (options.delay === "read") return;
			if (options.oversizedPacket) {
				const header = Buffer.allocUnsafe(4);
				header.writeUIntLE(MAX_PACKET_BYTES + 1, 0, 3);
				header[3] = 1;
				session.stream.write(header);
				return;
			}
			if (options.cumulativeBytes) {
				send(lengthEncoded(80));
				const field = column(`fixture_${"x".repeat(2048)}`);
				for (let index = 0; index < 80; index++) send(field, index + 2);
				return;
			}
			if (options.localInfile) {
				localInfileRequested = true;
				send(Buffer.concat([Buffer.from([0xfb]), Buffer.from("/__omp_synthetic_mysql_no_upload__")]));
				return;
			}
			const identity = proof(true);
			definitionReads++;
			if (options.missing || bindings.slice(4).some((value, index) => value !== expected[index + 4])) {
				rows(DEFINITION_COLUMNS, [], binary);
				return;
			}
			const bytes = Buffer.byteLength(rawTemplate, "utf8");
			const permitted =
				bytes <= Number(bindings[0]) &&
				identity[0] === bindings[3] &&
				identity[1] === bindings[2] &&
				identity[2] === bindings[1] &&
				identity[3] === "1" &&
				identity[4] === "";
			const stepType = options.stepType ?? "SQL QUERY";
			const value: Row = [
				permitted ? rawTemplate : null,
				String(bytes),
				Buffer.byteLength(stepType) <= 32 ? stepType : null,
				...identity,
			];
			rows(DEFINITION_COLUMNS, options.extraRows ? [value, value] : [value], binary);
		}
		function query(sql: string): void {
			const kind = queryKind(sql);
			state.commands.push(kind ? SAFE_COMMANDS[kind].replace(/\s+/gu, " ").trim() : "COM_QUERY unsupported");
			if (kind === "definition") {
				error();
				return;
			}
			if (failAtOrdinal()) return;
			switch (kind) {
				case "proof":
					rows(PROOF_COLUMNS, [proof()]);
					break;
				case "grants": {
					const grantee = `\`${username}\`@\`localhost\``;
					const grants = [
						`GRANT USAGE ON *.* TO ${grantee}`,
						`GRANT ${options.grants === "writable" ? "ALL PRIVILEGES" : "SELECT"} ON \`fixture\`.\`automations\` TO ${grantee}`,
						`GRANT SELECT ON \`fixture\`.\`automation_steps\` TO ${grantee}`,
					];
					if (options.grants === "role") grants.push(`GRANT \`fixture_role\`@\`%\` TO ${grantee}`);
					if (options.grants === "malformed") grants[1] = "Unparseable synthetic grant";
					rows(
						["Grants for current_user"],
						grants.map(grant => [grant]),
					);
					break;
				}
				case "metadata": {
					const view = options.view || (options.tableReplacement && pinned);
					rows(
						["table_name", "table_type", "engine"],
						[
							["automation_steps", view ? "VIEW" : "BASE TABLE", view ? null : "InnoDB"],
							["automations", "BASE TABLE", "InnoDB"],
						],
					);
					break;
				}
				case "pin":
					pinned = true;
					rows(["1"], []);
					break;
				case "begin":
					inTransaction = true;
					ok();
					break;
				case "rollback":
					inTransaction = false;
					ok();
					break;
				case "set": {
					const limit = /^SET SESSION MAX_EXECUTION_TIME\s*=\s*([0-9]{1,5})$/iu.exec(
						sql.trim().replace(/\s+/gu, " "),
					);
					if (limit) setExecutionLimit(limit[1], true);
					else if (sql.includes("?")) error();
					else ok();
					break;
				}
				default:
					error();
			}
		}
		function command(payload: Buffer): void {
			switch (payload[0]) {
				case 0x01:
					state.commands.push("COM_QUIT");
					session.stream.end();
					break;
				case 0x03:
					query(payload.toString("utf8", 1));
					break;
				case 0x16: {
					const sql = payload.toString("utf8", 1);
					const kind = queryKind(sql);
					if (kind !== "definition" && kind !== "set" && kind !== "uncast-set") {
						state.commands.push("COM_STMT_PREPARE unsupported");
						error();
						break;
					}
					state.commands.push(`COM_STMT_PREPARE ${SAFE_COMMANDS[kind].replace(/\s+/gu, " ").trim()}`);
					const statement: PreparedStatement = {
						id: nextStatementId++,
						kind: kind === "definition" ? "definition" : "set",
						parameterCount: sql.match(/\?/gu)?.length ?? 0,
						integerCast: sql.trim().replace(/\s+/gu, " ").toUpperCase() === SAFE_COMMANDS.set,
					};
					statements.set(statement.id, statement);
					const response = Buffer.alloc(12);
					response.writeUInt32LE(statement.id, 1);
					response.writeUInt16LE(statement.parameterCount, 7);
					send(response);
					let sequence = 2;
					for (let index = 0; index < statement.parameterCount; index++) send(column("?"), sequence++);
					if (statement.parameterCount > 0) send(EOF_PACKET, sequence);
					break;
				}
				case 0x17: {
					state.commands.push("COM_STMT_EXECUTE");
					const statement = payload.length >= 5 ? statements.get(payload.readUInt32LE(1)) : undefined;
					const bindings = statement ? parameters(payload, statement) : undefined;
					if (!statement || !bindings) {
						error();
						break;
					}
					if (statement.kind === "set") {
						if (failAtOrdinal()) break;
						if (!statement.integerCast) {
							if (statement.types?.[0]?.code === 5) {
								send(
									Buffer.concat([
										Buffer.from([0xff, 0xd0, 0x04]),
										Buffer.from("#42000Incorrect argument type to variable 'max_execution_time'"),
									]),
								);
							} else error();
							break;
						}
						setExecutionLimit(
							bindings.length === 1 ? bindings[0] : undefined,
							[3, 5, 8].includes(statement.types?.[0]?.code ?? -1),
							options.controlResponse,
						);
					} else definition(bindings, true);
					break;
				}
				case 0x19: {
					state.commands.push("COM_STMT_CLOSE");
					if (payload.length >= 5) statements.delete(payload.readUInt32LE(1));
					break;
				}
				default:
					state.commands.push("UNSUPPORTED_COMMAND");
					error();
			}
		}
		function receive(chunk: Buffer): void {
			if (localInfileRequested) {
				state.localInfilePayloadBytes += chunk.length;
				session.stream.destroy();
				return;
			}
			try {
				pending.append(chunk);
				for (;;) {
					const bytes = pending.flush();
					if (!bytes || bytes.length < 4) return;
					const size = bytes[0]! | (bytes[1]! << 8) | (bytes[2]! << 16);
					if (size > MAX_PACKET_BYTES) {
						session.stream.destroy();
						return;
					}
					if (bytes.length < size + 4) return;
					const packet = Buffer.from(bytes.buffer, bytes.byteOffset + 4, size);
					const sequence = bytes[3];
					if (phase === "ssl-request") {
						if (size !== 32 || sequence !== 1 || !(packet.readUInt32LE(0) & CLIENT_SSL)) {
							raw.destroy();
							return;
						}
						const remainder = Buffer.from(bytes.subarray(size + 4));
						pending.reset(new Uint8Array(0));
						raw.pause();
						raw.off("data", receive);
						if (remainder.length > 0) raw.unshift(remainder);
						phase = "authenticate";
						const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context, requestCert: false });
						session.stream = secure;
						secure.once("secure", () => {
							state.tlsConnections++;
						});
						secure.on("error", () => secure.destroy());
						secure.once("close", () => raw.destroy());
						secure.on("data", receive);
						secure.resume();
						return;
					}
					if (phase === "authenticate") {
						if (sequence !== 2 || !authenticated(packet, username, password, scramble)) {
							error(false, 3);
							session.stream.end();
							return;
						}
						state.authenticationVerified = true;
						phase = "commands";
						ok(3);
					} else {
						if (sequence !== 0 || packet.length === 0) {
							session.stream.destroy();
							return;
						}
						command(packet);
					}
					pending.consume(size + 4);
				}
			} catch {
				session.stream.destroy();
			}
		}
		raw.on("data", receive);
		if (options.delay !== "handshake") send(greeting(scramble), 0);
	});
	const listening = Promise.withResolvers<void>();
	const listenError = (): void => listening.reject(new Error("Synthetic MySQL listener failed"));
	server.once("error", listenError);
	server.listen(port, "127.0.0.1", listening.resolve);
	await listening.promise;
	server.off("error", listenError);
	server.on("error", () => {
		for (const session of sessions) {
			session.stream.destroy();
			session.raw.destroy();
		}
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Synthetic MySQL listener has no TCP port");
	}
	return {
		target: {
			endpoint: "localhost",
			port: address.port,
			database: "fixture",
			instanceIdentifier: "fixture-reader",
			partition: "aws",
		},
		tlsCa: material.cert,
		username,
		password,
		read,
		state,
		connected: connected.promise,
		readStarted: readStarted.promise,
		peerClosed: peerClosed.promise,
		containsSensitive(text: string): boolean {
			for (const value of sensitive) {
				if (text.includes(value)) return true;
			}
			return false;
		},
		close(): Promise<void> {
			if (closing) return closing;
			closed = true;
			const listenerClosed = Promise.withResolvers<void>();
			server.close(error =>
				error
					? listenerClosed.reject(new Error("Synthetic MySQL listener cleanup failed"))
					: listenerClosed.resolve(),
			);
			const completions = [...sessions].map(session => {
				session.stream.destroy();
				session.raw.destroy();
				return session.closed;
			});
			closing = Promise.all([listenerClosed.promise, ...completions]).then(() => undefined);
			return closing;
		},
	};
}
