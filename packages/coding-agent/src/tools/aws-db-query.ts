import { hasSubscribers } from "node:diagnostics_channel";
import { createConnection as createSocket, type Socket } from "node:net";
import { checkServerIdentity, TLSSocket } from "node:tls";
import * as mysql from "mysql2";
import type { Connection, FieldPacket, Query } from "mysql2";
import {
	AwsDbFailure,
	type AwsDbFailureCode,
	type DbCredentials,
	type DbRead,
	type DbTarget,
	type SafeTemplateResult,
} from "./aws-db-contract";
import { sanitizeAutomationTemplate } from "./aws-db-sanitize";
import { DB_TLS_SUPPORTED_PARTITIONS, getAwsDbTlsRoots } from "./aws-db-tls";

export const DB_READ_POLICY_ID = "automation-step-query-text/v1";

const PROOF_FIELDS = [
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
const PROOF_SQL = `SELECT CONNECTION_ID() AS connection_id, @@server_uuid AS server_uuid,
@@aurora_server_id AS aurora_server_id, @@innodb_read_only AS reader,
@@session.aurora_replica_read_consistency AS forwarding, CURRENT_ROLE() AS roles,
@@global.mandatory_roles AS mandatory_roles, @@session.max_execution_time AS execution_limit,
CURRENT_USER() AS authenticated_user, USER() AS client_user`;
const TABLE_SQL = `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type, ENGINE AS engine
FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
AND TABLE_NAME IN ('automations', 'automation_steps') ORDER BY TABLE_NAME LIMIT 3`;
// LIMIT 0 acquires transaction metadata locks without evaluating a saved definition.
const PIN_TABLES_SQL = "SELECT 1 FROM automations AS a JOIN automation_steps AS s ON s.automation_id = a.id LIMIT 0";
const READ_SQL = `SELECT CASE WHEN OCTET_LENGTH(s.query_text) <= ? AND @@innodb_read_only = 1
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
AND a.deleted_at IS NULL AND s.deleted_at IS NULL LIMIT 1`;
const NO_ERROR = () => {};
const MAX_STATEMENTS = 13;
const MAX_CONTROL_BYTES = 65_536;

type Cell = string | number | null;
type Row = Cell[];
interface Parser {
	execute: (data: Buffer) => void;
	buffer: Buffer[];
	largePacketParts: Buffer[];
	_reusablePacket?: { buffer: Buffer };
}
interface OwnedCommand extends Query {
	user?: string;
	password?: string;
	password1?: string;
	password2?: string;
	password3?: string;
	passwordSha1?: string | Buffer;
	values?: unknown;
	parameters?: unknown;
	options?: Record<string, unknown>;
	_rows?: unknown[];
	_fields?: unknown[];
	_currentRows?: unknown;
	_currentFields?: unknown;
	onResult?: unknown;
	_connection?: unknown;
}
type OwnedConnection = Connection & {
	stream: Socket | TLSSocket;
	packetParser: Parser;
	_command?: OwnedCommand | null;
	_commands: { shift(): OwnedCommand | undefined };
	_authPlugin?: unknown;
	_handshakePacket?: unknown;
	_fatalError?: unknown;
	_protocolError?: unknown;
	_outOfOrderPackets?: unknown[];
};
interface Proof {
	connectionId: string;
	uuid: string;
	instance: string;
}
interface FixtureTrust {
	tlsCa: string | readonly string[];
}
type TemplateReader = (
	target: DbTarget,
	credentials: DbCredentials,
	read: DbRead,
	signal: AbortSignal,
) => Promise<SafeTemplateResult>;

function plainCell(value: unknown): value is Cell {
	return value === null || typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
function proofFrom(row: Row, expected: string, username: string, baseline?: Proof, timeoutMs?: number): Proof {
	if (row.length !== PROOF_FIELDS.length) throw new AwsDbFailure("DB_READ_FAILED");
	const [id, uuid, instance, reader, forwarding, roles, mandatory, executionLimit, authenticatedUser, clientUser] =
		row;
	if (reader !== 1 && reader !== "1") throw new AwsDbFailure("DB_READER_REQUIRED");
	if (forwarding !== "" || roles !== "NONE" || mandatory !== "") throw new AwsDbFailure("DB_POLICY_DENIED");
	if (timeoutMs !== undefined && String(executionLimit) !== String(timeoutMs))
		throw new AwsDbFailure("DB_POLICY_DENIED");
	if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(String(executionLimit)) || BigInt(String(executionLimit)) > 4_294_967_295n)
		throw new AwsDbFailure("DB_POLICY_DENIED");
	for (const principal of [authenticatedUser, clientUser]) {
		if (
			typeof principal !== "string" ||
			!principal.startsWith(`${username}@`) ||
			principal.length === username.length + 1 ||
			principal.slice(username.length + 1).includes("@")
		)
			throw new AwsDbFailure("DB_POLICY_DENIED");
	}
	if (
		typeof uuid !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uuid) ||
		typeof instance !== "string" ||
		instance !== expected ||
		!/^[1-9][0-9]{0,9}$/u.test(String(id)) ||
		BigInt(String(id)) > 4_294_967_295n
	)
		throw new AwsDbFailure("DB_IDENTITY_CHANGED");
	const proof = { connectionId: String(id), uuid, instance };
	if (
		baseline &&
		(proof.connectionId !== baseline.connectionId ||
			proof.uuid !== baseline.uuid ||
			proof.instance !== baseline.instance)
	) {
		throw new AwsDbFailure("DB_IDENTITY_CHANGED");
	}
	return proof;
}
function verifyTables(rows: Row[]): void {
	if (
		rows.length !== 2 ||
		rows[0][0] !== "automation_steps" ||
		rows[1][0] !== "automations" ||
		rows.some(row => row.length !== 3 || row[1] !== "BASE TABLE" || row[2] !== "InnoDB")
	) {
		throw new AwsDbFailure("DB_POLICY_DENIED");
	}
}
function unquote(value: string): string {
	return value.slice(1, -1).replaceAll("``", "`");
}
function verifyGrants(rows: Row[], database: string, username: string): void {
	if (rows.length < 2 || rows.length > 3) throw new AwsDbFailure("DB_POLICY_DENIED");
	let principal: string | undefined;
	const tables = new Set<string>();
	let usage = false;
	for (const row of rows) {
		if (row.length !== 1 || typeof row[0] !== "string" || Buffer.byteLength(row[0]) > 4_096)
			throw new AwsDbFailure("DB_POLICY_DENIED");
		const grant =
			/^GRANT (USAGE|SELECT) ON (\*\.\*|`(?:[^`]|``)+`\.`(?:[^`]|``)+`) TO (`(?:[^`]|``)+`)@(`(?:[^`]|``)+`)(?: REQUIRE (?:SSL|X509))?$/u.exec(
				row[0],
			);
		if (!grant || unquote(grant[3]) !== username) throw new AwsDbFailure("DB_POLICY_DENIED");
		const current = `${grant[3]}@${grant[4]}`;
		if (principal !== undefined && current !== principal) throw new AwsDbFailure("DB_POLICY_DENIED");
		principal = current;
		if (grant[1] === "USAGE") {
			if (grant[2] !== "*.*" || usage) throw new AwsDbFailure("DB_POLICY_DENIED");
			usage = true;
		} else {
			const qualified = /^(`(?:[^`]|``)+`)\.(`(?:[^`]|``)+`)$/u.exec(grant[2]);
			if (!qualified || unquote(qualified[1]) !== database) throw new AwsDbFailure("DB_POLICY_DENIED");
			const table = unquote(qualified[2]);
			if ((table !== "automations" && table !== "automation_steps") || tables.has(table))
				throw new AwsDbFailure("DB_POLICY_DENIED");
			tables.add(table);
		}
	}
	if (tables.size !== 2) throw new AwsDbFailure("DB_POLICY_DENIED");
}
function scrubCommand(command: OwnedCommand): void {
	command.user = command.password = command.password1 = command.password2 = command.password3 = "";
	if (Buffer.isBuffer(command.passwordSha1)) command.passwordSha1.fill(0);
	command.passwordSha1 = undefined;
	command.values =
		command.parameters =
		command._currentRows =
		command._currentFields =
		command.onResult =
		command._connection =
			undefined;
	command._rows?.splice(0);
	command._fields?.splice(0);
	if (command.options) {
		for (const name of ["user", "password", "password1", "password2", "password3", "passwordSha1", "values"])
			command.options[name] = undefined;
	}
	command.removeAllListeners();
	command.on("error", NO_ERROR);
}
function validateInput(target: DbTarget, read: DbRead): void {
	if (
		!DB_TLS_SUPPORTED_PARTITIONS.includes(target.partition) ||
		!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(target.endpoint) ||
		target.endpoint.length > 253 ||
		target.endpoint.includes("..") ||
		!/^[A-Za-z0-9_]{1,64}$/u.test(target.database) ||
		!/^[a-zA-Z][a-zA-Z0-9-]{0,62}$/u.test(target.instanceIdentifier) ||
		!Number.isInteger(target.port) ||
		target.port < 1 ||
		target.port > 65_535 ||
		read.limits.maxRows !== 1 ||
		!Number.isInteger(read.limits.maxBytes) ||
		read.limits.maxBytes < 1 ||
		read.limits.maxBytes > 65_536 ||
		!Number.isInteger(read.limits.timeoutMs) ||
		read.limits.timeoutMs < 1 ||
		read.limits.timeoutMs > 10_000
	) {
		throw new AwsDbFailure("DB_POLICY_DENIED");
	}
	for (const id of [read.agencyId, read.automationId, read.stepId]) {
		if (!/^[1-9][0-9]{0,18}$/u.test(id) || BigInt(id) > 9_223_372_036_854_775_807n)
			throw new AwsDbFailure("DB_POLICY_DENIED");
	}
	for (const operation of ["connect", "query", "execute"]) {
		for (const phase of ["start", "end", "asyncStart", "asyncEnd", "error"]) {
			if (hasSubscribers(`tracing:mysql2:${operation}:${phase}`)) throw new AwsDbFailure("DB_POLICY_DENIED");
		}
	}
}

async function readTemplate(
	targetInput: DbTarget,
	credentials: DbCredentials,
	readInput: DbRead,
	signal: AbortSignal,
	trust?: FixtureTrust,
): Promise<SafeTemplateResult> {
	const target = { ...targetInput };
	const read = { ...readInput, limits: { ...readInput.limits } };
	let username = credentials.username;
	let connection: OwnedConnection | undefined;
	let transport: Socket | undefined;
	let secured: TLSSocket | undefined;
	let baseline: Proof | undefined;
	let failure: AwsDbFailureCode | undefined;
	let phase: "connect" | "read" = "connect";
	let disposing = false;
	let closed = false;
	let pendingReject: ((error: AwsDbFailure) => void) | undefined;
	let timer: Timer | undefined;
	let statementCount = 0;
	let received = 0;
	let headerBytes = 0;
	let payloadBytes = 0;
	let payloadStarted = false;
	let fieldsReady = false;
	const header = Buffer.alloc(4);
	const commands = new Set<OwnedCommand>();
	const ownedRows: Row[][] = [];
	let disposition: SafeTemplateResult["disposition"] = "withheld";
	let structure: string | undefined;

	const stop = (code: AwsDbFailureCode) => {
		if (disposing) return;
		failure ??= code;
		connection?.stream.destroy();
		transport?.destroy();
		pendingReject?.(new AwsDbFailure(failure));
	};
	const abort = () => stop("DB_CANCELLED");
	const assertPhysical = () => {
		if (failure) throw new AwsDbFailure(failure);
		if (
			!connection ||
			!transport ||
			!secured ||
			connection.stream !== secured ||
			transport.destroyed ||
			secured.destroyed ||
			!secured.authorized ||
			String(connection.threadId) !== baseline?.connectionId
		) {
			throw new AwsDbFailure("DB_IDENTITY_CHANGED");
		}
	};
	const query = async (
		sql: string,
		fields: readonly string[] | number,
		maxRows: number,
		values?: (string | number)[],
	): Promise<Row[]> => {
		assertPhysical();
		statementCount += values ? 2 : 1;
		if (statementCount > MAX_STATEMENTS) throw new AwsDbFailure("DB_POLICY_DENIED");
		const completed = Promise.withResolvers<Row[]>();
		pendingReject = completed.reject;
		const rows: Row[] = [];
		ownedRows.push(rows);
		let gotFields = false;
		const expectOk = fields === 0 && maxRows === 0;
		let gotOk = false;
		fieldsReady = false;
		let command: OwnedCommand;
		try {
			command = (
				values
					? connection!.execute({ sql, values, rowsAsArray: true })
					: connection!.query({ sql, rowsAsArray: true })
			) as OwnedCommand;
			commands.add(command);
			if (connection!._command) commands.add(connection!._command);
			command.on("fields", (actual: FieldPacket[] | undefined) => {
				if (expectOk) {
					if (gotFields || actual !== undefined) {
						stop("DB_READ_FAILED");
						return;
					}
				} else {
					const count = typeof fields === "number" ? fields : fields.length;
					if (
						gotFields ||
						!Array.isArray(actual) ||
						actual.length !== count ||
						actual.some((field, index) => typeof fields !== "number" && field.name !== fields[index])
					) {
						stop("DB_READ_FAILED");
						return;
					}
				}
				gotFields = true;
				fieldsReady = true;
			});
			command.on("result", (row: unknown) => {
				if (failure) return;
				if (expectOk) {
					if (!gotFields || gotOk || row === null || typeof row !== "object" || Array.isArray(row)) {
						stop("DB_READ_FAILED");
						return;
					}
					const result = row as {
						fieldCount?: unknown;
						affectedRows?: unknown;
						insertId?: unknown;
						warningStatus?: unknown;
						serverStatus?: unknown;
						changedRows?: unknown;
					};
					if (
						result.fieldCount !== 0 ||
						result.affectedRows !== 0 ||
						result.insertId !== 0 ||
						result.warningStatus !== 0 ||
						typeof result.serverStatus !== "number" ||
						!Number.isInteger(result.serverStatus) ||
						result.serverStatus < 0 ||
						result.serverStatus > 65_535 ||
						(result.serverStatus & 8) !== 0 ||
						(result.changedRows !== undefined && result.changedRows !== 0)
					) {
						stop("DB_READ_FAILED");
						return;
					}
					gotOk = true;
					return;
				}
				if (
					!gotFields ||
					!Array.isArray(row) ||
					!row.every(plainCell) ||
					row.length !== (typeof fields === "number" ? fields : fields.length)
				) {
					stop("DB_READ_FAILED");
				} else if (rows.length >= maxRows) {
					stop("DB_LIMIT_EXCEEDED");
				} else {
					rows.push(row);
				}
			});
			command.on("error", () => stop("DB_READ_FAILED"));
			command.once("end", () => {
				try {
					assertPhysical();
					if (!gotFields || (expectOk && !gotOk)) throw new AwsDbFailure("DB_READ_FAILED");
					completed.resolve(rows);
				} catch (error) {
					completed.reject(
						new AwsDbFailure(failure ?? (error instanceof AwsDbFailure ? error.code : "DB_READ_FAILED")),
					);
				}
			});
			return await completed.promise;
		} finally {
			pendingReject = undefined;
		}
	};

	try {
		validateInput(target, read);
		if (!username || !credentials.password) throw new AwsDbFailure("DB_POLICY_DENIED");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) throw new AwsDbFailure("DB_CANCELLED");
		timer = setTimeout(() => stop("DB_TIMEOUT"), read.limits.timeoutMs);
		transport = createSocket({ host: target.endpoint, port: target.port, family: 4 });
		transport.on("error", () => stop(phase === "connect" ? "DB_CONNECT_FAILED" : "DB_IDENTITY_CHANGED"));
		transport.on("end", () => stop("DB_IDENTITY_CHANGED"));
		transport.on("close", () => stop("DB_IDENTITY_CHANGED"));
		connection = mysql.createConnection({
			host: target.endpoint,
			port: target.port,
			database: target.database,
			user: username,
			password: credentials.password,
			stream: transport,
			ssl: {
				ca: trust
					? typeof trust.tlsCa === "string"
						? trust.tlsCa
						: [...trust.tlsCa]
					: [...getAwsDbTlsRoots(target.partition)],
				rejectUnauthorized: true,
				verifyIdentity: true,
				minVersion: "TLSv1.2",
			},
			connectTimeout: read.limits.timeoutMs,
			multipleStatements: false,
			namedPlaceholders: false,
			flags: [
				"-LOCAL_FILES",
				"-MULTI_STATEMENTS",
				"-MULTI_RESULTS",
				"-PS_MULTI_RESULTS",
				"-CLIENT_QUERY_ATTRIBUTES",
			],
			compress: false,
			debug: false,
			trace: false,
			enableKeepAlive: false,
			enableCleartextPlugin: false,
			rowsAsArray: true,
			supportBigNumbers: true,
			bigNumberStrings: true,
			dateStrings: true,
			jsonStrings: true,
			disableEval: true,
			maxPreparedStatements: 1,
			connectAttributes: {},
		}) as OwnedConnection;
		if (connection._command) commands.add(connection._command);
		connection.on("error", () => stop(phase === "connect" ? "DB_CONNECT_FAILED" : "DB_IDENTITY_CHANGED"));
		connection.on("end", () => stop("DB_IDENTITY_CHANGED"));
		connection.on("warn", () => stop("DB_READ_FAILED"));

		// The pinned mysql2 parser otherwise buffers an announced 16 MiB packet before row limits apply.
		const parser = connection.packetParser;
		let parse = parser.execute;
		const guardedParse = (data: Buffer) => {
			if (failure || disposing) return;
			if (secured && connection?.stream !== secured) {
				stop("DB_IDENTITY_CHANGED");
				return;
			}
			if (received + data.length > read.limits.maxBytes + MAX_CONTROL_BYTES) {
				stop("DB_LIMIT_EXCEEDED");
				return;
			}
			received += data.length;
			let offset = 0;
			while (offset < data.length && !failure) {
				if (payloadBytes === 0) {
					const count = Math.min(4 - headerBytes, data.length - offset);
					data.copy(header, headerBytes, offset, offset + count);
					headerBytes += count;
					offset += count;
					if (headerBytes < 4) continue;
					payloadBytes = header.readUIntLE(0, 3);
					if (
						payloadBytes > read.limits.maxBytes + 4_096 ||
						received - (data.length - offset) + payloadBytes > read.limits.maxBytes + MAX_CONTROL_BYTES
					) {
						stop("DB_LIMIT_EXCEEDED");
						return;
					}
					if (header[3] !== connection!.sequenceId) {
						stop("DB_READ_FAILED");
						return;
					}
					headerBytes = 0;
					payloadStarted = false;
					try {
						parse.call(parser, header);
					} catch {
						stop("DB_READ_FAILED");
						return;
					}
					if (!payloadBytes) continue;
				}
				const count = Math.min(payloadBytes, data.length - offset);
				if (count === 0) continue;
				if (!payloadStarted) {
					payloadStarted = true;
					if (phase === "read" && !fieldsReady && data[offset] === 0xfb) {
						stop("DB_POLICY_DENIED");
						return;
					}
				}
				const part = data.subarray(offset, offset + count);
				offset += count;
				payloadBytes -= count;
				try {
					parse.call(parser, part);
				} catch {
					stop("DB_READ_FAILED");
					return;
				}
			}
		};
		Object.defineProperty(parser, "execute", {
			get: () => guardedParse,
			set: (next: (data: Buffer) => void) => {
				parse = next;
			},
		});
		const connected = Promise.withResolvers<void>();
		pendingReject = connected.reject;
		connection.once("connect", () => connected.resolve());
		await connected.promise;
		pendingReject = undefined;
		phase = "read";
		if (
			!(connection.stream instanceof TLSSocket) ||
			!connection.stream.authorized ||
			checkServerIdentity(target.endpoint, connection.stream.getPeerCertificate(true))
		) {
			throw new AwsDbFailure("DB_TLS_REQUIRED");
		}
		secured = connection.stream;
		secured.on("end", () => stop("DB_IDENTITY_CHANGED"));
		secured.on("close", () => stop("DB_IDENTITY_CHANGED"));
		baseline = { connectionId: String(connection.threadId), uuid: "", instance: target.instanceIdentifier };
		credentials.password = "";
		connection.config.password = connection.config.password1 = connection.config.user = "";
		connection._authPlugin = undefined;
		for (const command of commands) scrubCommand(command);
		commands.clear();
		const initial = await query(PROOF_SQL, PROOF_FIELDS, 1);
		if (initial.length !== 1) throw new AwsDbFailure("DB_READER_REQUIRED");
		baseline = proofFrom(initial[0], target.instanceIdentifier, username);
		if (baseline.connectionId !== String(connection.threadId)) throw new AwsDbFailure("DB_IDENTITY_CHANGED");
		await query("SET SESSION MAX_EXECUTION_TIME = CAST(? AS UNSIGNED)", 0, 0, [read.limits.timeoutMs]);
		verifyGrants(await query("SHOW GRANTS FOR CURRENT_USER()", 1, 4), target.database, username);
		verifyTables(await query(TABLE_SQL, ["table_name", "table_type", "engine"], 3));
		await query("START TRANSACTION READ ONLY", 0, 0);
		await query(PIN_TABLES_SQL, 1, 0);
		verifyTables(await query(TABLE_SQL, ["table_name", "table_type", "engine"], 3));
		const definitions = await query(READ_SQL, ["query_text", "source_bytes", "step_type", ...PROOF_FIELDS], 1, [
			read.limits.maxBytes,
			target.instanceIdentifier,
			baseline.uuid,
			baseline.connectionId,
			read.agencyId,
			read.automationId,
			read.agencyId,
			read.stepId,
		]);
		if (definitions.length === 0) {
			disposition = "not-found";
		} else {
			const row = definitions[0];
			proofFrom(row.slice(3), target.instanceIdentifier, username, baseline, read.limits.timeoutMs);
			const length = row[1];
			if (!/^(?:0|[1-9][0-9]*)$/u.test(String(length)) || BigInt(String(length)) > BigInt(read.limits.maxBytes))
				throw new AwsDbFailure("DB_LIMIT_EXCEEDED");
			if (typeof row[0] !== "string" || Buffer.byteLength(row[0]) !== Number(length))
				throw new AwsDbFailure("DB_READ_FAILED");
			if (typeof row[2] === "string" && Buffer.byteLength(row[2]) <= 32) {
				const sanitized = sanitizeAutomationTemplate(row[0], row[2]);
				disposition = sanitized.disposition;
				if (sanitized.disposition === "sanitized") structure = sanitized.structure;
			}
		}
		const after = await query(PROOF_SQL, PROOF_FIELDS, 1);
		if (after.length !== 1) throw new AwsDbFailure("DB_READER_REQUIRED");
		proofFrom(after[0], target.instanceIdentifier, username, baseline, read.limits.timeoutMs);
		verifyGrants(await query("SHOW GRANTS FOR CURRENT_USER()", 1, 4), target.database, username);
		await query("ROLLBACK", 0, 0);
		assertPhysical();
	} catch (error) {
		failure ??=
			error instanceof AwsDbFailure ? error.code : phase === "connect" ? "DB_CONNECT_FAILED" : "DB_READ_FAILED";
	} finally {
		disposing = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		pendingReject = undefined;
		const sockets = new Set<Socket>([
			...(transport ? [transport] : []),
			...(connection?.stream ? [connection.stream] : []),
		]);
		try {
			const closures: Promise<void>[] = [];
			for (const socket of sockets) {
				if (socket.closed) continue;
				const close = Promise.withResolvers<void>();
				socket.once("close", () => close.resolve());
				closures.push(close.promise);
			}
			connection?.destroy();
			for (const socket of sockets) socket.destroy();
			const deadline = Promise.withResolvers<void>();
			const cleanupTimer = setTimeout(() => deadline.reject(new AwsDbFailure("DB_READ_FAILED")), 500);
			try {
				await Promise.race([Promise.all(closures), deadline.promise]);
				closed = true;
			} finally {
				clearTimeout(cleanupTimer);
			}
		} catch {
			failure ??= "DB_READ_FAILED";
		} finally {
			credentials.username = credentials.password = username = "";
			for (const rows of ownedRows) {
				for (const row of rows) row.fill(null);
				rows.length = 0;
			}
			ownedRows.length = 0;
			if (connection) {
				if (connection._command) commands.add(connection._command);
				let queued = connection._commands.shift();
				while (queued) {
					commands.add(queued);
					queued = connection._commands.shift();
				}
				for (const command of commands) scrubCommand(command);
				connection.config.password =
					connection.config.password1 =
					connection.config.password2 =
					connection.config.password3 =
					connection.config.user =
						"";
				if (Buffer.isBuffer(connection.config.passwordSha1)) connection.config.passwordSha1.fill(0);
				connection.config.passwordSha1 = undefined;
				connection._command = null;
				connection._authPlugin =
					connection._handshakePacket =
					connection._fatalError =
					connection._protocolError =
						undefined;
				connection._outOfOrderPackets?.splice(0);
				for (const buffer of connection.packetParser.buffer) buffer.fill(0);
				for (const buffer of connection.packetParser.largePacketParts) buffer.fill(0);
				connection.packetParser.buffer.length = connection.packetParser.largePacketParts.length = 0;
				connection.packetParser._reusablePacket?.buffer.fill(0);
				connection.removeAllListeners();
				connection.on("error", NO_ERROR);
			}
			for (const socket of sockets) {
				socket.removeAllListeners();
				socket.on("error", NO_ERROR);
			}
			commands.clear();
			header.fill(0);
			baseline = undefined;
			secured = undefined;
			transport = undefined;
			connection = undefined;
		}
	}
	if (failure || !closed) throw new AwsDbFailure(failure ?? "DB_READ_FAILED");
	return {
		disposition,
		...(structure === undefined ? {} : { structure }),
		proof: { sameConnection: true, reader: true },
		teardown: { connectionClosed: true, referencesReleased: true },
	};
}

export const runAutomationTemplateRead: TemplateReader = (target, credentials, read, signal) =>
	readTemplate(target, credentials, read, signal);

/** Internal fixture trust seam. The native request/provider never accepts custom roots or driver options. */
export function createAutomationTemplateReader(trust: FixtureTrust): TemplateReader {
	const owned = { tlsCa: typeof trust.tlsCa === "string" ? trust.tlsCa : [...trust.tlsCa] };
	return (target, credentials, read, signal) => readTemplate(target, credentials, read, signal, owned);
}
