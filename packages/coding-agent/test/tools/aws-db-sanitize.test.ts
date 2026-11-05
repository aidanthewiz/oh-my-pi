import { describe, expect, it } from "bun:test";
import { isSafeTemplateStructure, sanitizeAutomationTemplate } from "@oh-my-pi/pi-coding-agent/tools/aws-db-sanitize";

function fixture() {
	const nonce = crypto.randomUUID().replaceAll("-", "");
	return {
		name: `private_${nonce}`,
		other: `person_${nonce}`,
		alias: `alias_${nonce}`,
		pii: `${crypto.randomUUID()}@example.invalid`,
		number: `9${crypto.getRandomValues(new Uint32Array(1))[0]}`,
	};
}

function expectSanitized(source: string, expected: string, sensitive: readonly string[] = [], stepType?: string): void {
	const result = sanitizeAutomationTemplate(source, stepType);
	const serialized = JSON.stringify(result);
	expect(sensitive.some(value => serialized.includes(value))).toBe(false);
	expect(result.disposition === "sanitized" && result.structure === expected).toBe(true);
	expect(isSafeTemplateStructure(result.disposition === "sanitized" ? result.structure : undefined)).toBe(true);
}

function expectWithheld(source: string, sensitive: readonly string[] = [], stepType?: string): void {
	const result = sanitizeAutomationTemplate(source, stepType);
	const serialized = JSON.stringify(result);
	expect(sensitive.some(value => serialized.includes(value))).toBe(false);
	expect(serialized === '{"disposition":"withheld"}').toBe(true);
}

describe("sanitizeAutomationTemplate SQL structures", () => {
	it("preserves supported query clauses without exposing identifiers, PII, numeric values, or reference names", () => {
		const { name, other, alias, pii, number } = fixture();
		const source = `SELECT DISTINCT ${alias}.${name} AS ${name}, COUNT(*) AS ${other}
			FROM ${other}.${name} AS ${alias}
			LEFT OUTER JOIN ${other} AS ${name} ON ${alias}.${name} = ${name}.${other}
			WHERE ${alias}.${name} NOT IN ('${pii}', {steps.${name}.value})
			AND ${alias}.${other} BETWEEN ${number} AND {agency.${name}}
			AND NOT (${alias}.${name} IS NULL OR ${alias}.${other} NOT LIKE '${pii}%')
			GROUP BY ${alias}.${name} HAVING COUNT(*) > ${number}
			ORDER BY ${alias}.${name} DESC, ${alias}.${other} ASC
			LIMIT {system.${name}} OFFSET ${number}`;
		expectSanitized(
			source,
			[
				"SELECT DISTINCT IDENTIFIER . IDENTIFIER AS IDENTIFIER , COUNT ( * ) AS IDENTIFIER",
				"FROM IDENTIFIER . IDENTIFIER AS IDENTIFIER LEFT OUTER JOIN IDENTIFIER AS IDENTIFIER",
				"ON IDENTIFIER . IDENTIFIER = IDENTIFIER . IDENTIFIER",
				"WHERE IDENTIFIER . IDENTIFIER NOT IN ( LITERAL , PLACEHOLDER )",
				"AND IDENTIFIER . IDENTIFIER BETWEEN LITERAL AND PLACEHOLDER",
				"AND NOT ( IDENTIFIER . IDENTIFIER IS NULL OR IDENTIFIER . IDENTIFIER NOT LIKE LITERAL )",
				"GROUP BY IDENTIFIER . IDENTIFIER HAVING COUNT ( * ) > LITERAL",
				"ORDER BY IDENTIFIER . IDENTIFIER DESC , IDENTIFIER . IDENTIFIER ASC LIMIT PLACEHOLDER OFFSET LITERAL",
			].join(" "),
			[name, other, alias, pii, number],
			"SQL QUERY",
		);
	});

	it("preserves whole-table and qualified projection wildcards without permitting expression wildcards", () => {
		const { name, other } = fixture();
		expectSanitized(`SELECT *, ${name}.* FROM ${other}`, "SELECT * , IDENTIFIER . * FROM IDENTIFIER", [name, other]);
		expectWithheld(`SELECT ${name}.* + 1 FROM ${other}`, [name, other]);
		expectWithheld(`SELECT ${name} FROM ${other} WHERE *`, [name, other]);
		expectWithheld(`SELECT * AS ${name} FROM ${other}`, [name, other]);
	});

	it("parses arithmetic and logical precedence while keeping BETWEEN's AND separate from logical AND", () => {
		const { name, other, number } = fixture();
		expectSanitized(
			`SELECT -${name} + ${number} * (${other} - ${number}) / +${number} % ${number}
			WHERE NOT ${name} = ${number} AND ${other} BETWEEN ${number} + ${number} AND ${number} * ${number}
			OR ${name} IS NOT NULL`,
			"SELECT - IDENTIFIER + LITERAL * ( IDENTIFIER - LITERAL ) / + LITERAL % LITERAL WHERE NOT IDENTIFIER = LITERAL AND IDENTIFIER BETWEEN LITERAL + LITERAL AND LITERAL * LITERAL OR IDENTIFIER IS NOT NULL",
			[name, other, number],
		);
		expectWithheld(`SELECT ${name} WHERE ${name} BETWEEN ${number} OR ${other} AND ${number}`, [name, other, number]);
		expectWithheld(`SELECT ${name} WHERE ${name} NOT ${other}`, [name, other]);
	});

	it("preserves comparison operators and non-subquery predicate lists without leaking operand values", () => {
		const { name, other, number, pii } = fixture();
		for (const operator of ["!=", "<>", "<", "<=", ">", ">=", "<=>"] as const) {
			expectSanitized(
				`SELECT ${name} WHERE ${name} ${operator} ${number}`,
				`SELECT IDENTIFIER WHERE IDENTIFIER ${operator} LITERAL`,
				[name, number],
			);
		}
		expectSanitized(
			`SELECT ${name} WHERE ${name} IN (${number}, (${other} + ${number}), {steps.${name}})
			AND ${name} NOT BETWEEN ${number} AND ${number} AND ${name} LIKE '${pii}%'`,
			"SELECT IDENTIFIER WHERE IDENTIFIER IN ( LITERAL , ( IDENTIFIER + LITERAL ) , PLACEHOLDER ) AND IDENTIFIER NOT BETWEEN LITERAL AND LITERAL AND IDENTIFIER LIKE LITERAL",
			[name, other, number, pii],
		);
	});

	it("supports each restricted join shape and withholds incomplete or unsupported join conditions", () => {
		const { name, other } = fixture();
		for (const join of ["JOIN", "INNER JOIN", "LEFT JOIN", "RIGHT OUTER JOIN"] as const) {
			expectSanitized(
				`SELECT ${name} FROM ${name} ${join} ${other} ON ${name}.${other} = ${other}.${name}`,
				`SELECT IDENTIFIER FROM IDENTIFIER ${join} IDENTIFIER ON IDENTIFIER . IDENTIFIER = IDENTIFIER . IDENTIFIER`,
				[name, other],
			);
		}
		expectSanitized(
			`SELECT ${name} FROM ${name} CROSS JOIN ${other}`,
			"SELECT IDENTIFIER FROM IDENTIFIER CROSS JOIN IDENTIFIER",
			[name, other],
		);
		for (const suffix of [
			"LEFT",
			`JOIN ${other}`,
			`CROSS JOIN ${other} ON ${name} = ${other}`,
			`JOIN ${other} USING (${name})`,
		]) {
			expectWithheld(`SELECT ${name} FROM ${name} ${suffix}`, [name, other]);
		}
	});

	it("keeps only allowlisted function names and enforces supported argument and DISTINCT forms", () => {
		const { name, other, pii } = fixture();
		expectSanitized(
			`SELECT COUNT(DISTINCT ${name}, ${other}), SUM(DISTINCT ${name}), MIN(${name}), MAX(${name}), AVG(${name}),
			COALESCE(${name}, '${pii}', NULL), IFNULL(${name}, '${pii}'), LOWER('${pii}'), UPPER(${name}), TRIM('${pii}')`,
			"SELECT COUNT ( DISTINCT IDENTIFIER , IDENTIFIER ) , SUM ( DISTINCT IDENTIFIER ) , MIN ( IDENTIFIER ) , MAX ( IDENTIFIER ) , AVG ( IDENTIFIER ) , COALESCE ( IDENTIFIER , LITERAL , NULL ) , IFNULL ( IDENTIFIER , LITERAL ) , LOWER ( LITERAL ) , UPPER ( IDENTIFIER ) , TRIM ( LITERAL )",
			[name, other, pii],
		);
		for (const expression of [
			"COUNT()",
			`COUNT(${name}, ${other})`,
			"COUNT(DISTINCT *)",
			`SUM(${name}, ${other})`,
			`IFNULL(${name})`,
			`IFNULL(${name}, ${other}, '${pii}')`,
			"COALESCE()",
			"LOWER()",
			`TRIM(${name}, ${other})`,
		])
			expectWithheld(`SELECT ${expression}`, [name, other, pii]);
	});

	it("normalizes keyword case but redacts builtin names when they are identifiers rather than calls", () => {
		const { name, pii } = fixture();
		expectSanitized(
			`\tsElEcT\nCoUnT, \`SELECT\`, LoWeR('${pii}')\r\nFrOm \`${name}\`\t`,
			"SELECT IDENTIFIER , IDENTIFIER , LOWER ( LITERAL ) FROM IDENTIFIER",
			[name, pii],
		);
	});

	it("handles doubled quotes and doubled backticks without treating literal contents as code", () => {
		const { name, other, pii } = fixture();
		const doubledContents = `${pii}'";--#/*{steps.${name}}`.replaceAll("'", "''");
		const quotedIdentifier = `${name}\`\`${other}`;
		expectSanitized(
			`SELECT '${doubledContents}', \`${quotedIdentifier}\` FROM \`${name}\``,
			"SELECT LITERAL , IDENTIFIER FROM IDENTIFIER",
			[name, other, pii],
		);
	});

	it("withholds backslash-containing SQL strings when the saved SQL mode is unknown", () => {
		const { name, pii } = fixture();
		for (const contents of [`${pii}\\'${name}`, `${pii}\\\\${name}`, `${pii}\\n`, `${pii}\\`]) {
			expectWithheld(`SELECT '${contents}'`, [name, pii]);
		}
	});

	it("redacts quoted keyword-like identifiers and literal values instead of exposing their recognized vocabulary", () => {
		const { pii } = fixture();
		expectSanitized(
			`SELECT \`SQL_CALC_FOUND_ROWS\`, 'HIGH_PRIORITY', 'COUNT', '${pii}'`,
			"SELECT IDENTIFIER , LITERAL , LITERAL , LITERAL",
			[pii, "SQL_CALC_FOUND_ROWS", "HIGH_PRIORITY", "COUNT"],
		);
	});

	it("recognizes only the source-backed single-brace reference roots and complete identifier paths", () => {
		const { name } = fixture();
		expectSanitized(
			`SELECT {steps.${name}.value}, {agency.${name}}, {system.${name}}`,
			"SELECT PLACEHOLDER , PLACEHOLDER , PLACEHOLDER",
			[name],
		);
		for (const reference of [
			`{{steps.${name}}}`,
			`{unknown.${name}}`,
			`{STEPS.${name}}`,
			"{steps.}",
			`{steps.${name}.}`,
			`{steps..${name}}`,
			`{steps. ${name}}`,
			`{steps.${name}`,
			`{steps.${name}}}`,
			`{steps.${name}()}`,
		])
			expectWithheld(`SELECT ${reference}`, [name]);
	});

	it("redacts decimal, exponent, boolean, and NULL literals while restricting LIMIT and OFFSET to integers or references", () => {
		const { name, number } = fixture();
		expectSanitized(
			`SELECT ${number}, .5, 1., ${number}.5, ${number}e3, -2E-4, TRUE, FALSE, NULL LIMIT 0 OFFSET {system.${name}}`,
			"SELECT LITERAL , LITERAL , LITERAL , LITERAL , LITERAL , - LITERAL , LITERAL , LITERAL , NULL LIMIT LITERAL OFFSET PLACEHOLDER",
			[name, number],
		);
		for (const limit of [
			`'${number}'`,
			`-${number}`,
			`+${number}`,
			`${number}.0`,
			`${number}e0`,
			name,
			`${number},${number}`,
		]) {
			expectWithheld(`SELECT ${name} LIMIT ${limit}`, [name, number]);
		}
		expectWithheld(`SELECT ${name} OFFSET ${number}`, [name, number]);
		expectWithheld(`SELECT ${name} LIMIT ${number} OFFSET '${number}'`, [name, number]);
	});

	it("withholds unknown executable forms, statements, subqueries, and SQL-mode-dependent quoting instead of returning source", () => {
		const { name, other, pii, number } = fixture();
		const sources = [
			`SELECT ${name}(${number})`,
			`SELECT SLEEP(${number})`,
			`SELECT LOAD_FILE('${pii}')`,
			`SELECT \`COUNT\`(${name})`,
			`SELECT (${name} + (SELECT ${other}))`,
			`SELECT ${name} FROM (SELECT ${other}) AS ${name}`,
			`SELECT ${name} WHERE ${name} IN (SELECT ${other})`,
			`WITH ${name} AS (SELECT ${other}) SELECT ${name}`,
			`SELECT ${name} UNION SELECT ${other}`,
			`SELECT ${name} INTO OUTFILE '${pii}'`,
			`SELECT @${name}`,
			`SELECT @@${name}`,
			`SELECT ${name} := ${number}`,
			`CALL ${name}('${pii}')`,
			`UPDATE ${name} SET ${other} = '${pii}'`,
			`SELECT "${pii}"`,
			`SELECT ${name} FROM "${other}"`,
			`SELECT ${name} COLLATE ${other}`,
			`SELECT COUNT(*) OVER () FROM ${name}`,
		];
		for (const source of sources) expectWithheld(source, [name, other, pii, number]);
	});

	it("withholds unsupported SELECT modifiers rather than misreading them as identifiers", () => {
		const { name, other } = fixture();
		for (const modifier of [
			"SQL_CALC_FOUND_ROWS",
			"HIGH_PRIORITY",
			"SQL_SMALL_RESULT",
			"SQL_BIG_RESULT",
			"SQL_BUFFER_RESULT",
			"SQL_NO_CACHE",
			"SQL_CACHE",
			"STRAIGHT_JOIN",
		]) {
			expectWithheld(`SELECT ${modifier} FROM ${other}`, [other]);
			expectWithheld(`SELECT ${modifier} ${name} FROM ${other}`, [name, other]);
		}
	});

	it("withholds comments, executable comments, and every semicolon outside literals", () => {
		const { name, other } = fixture();
		for (const suffix of [
			";",
			`; SELECT ${other}`,
			` -- ${other}`,
			` # ${other}`,
			` /* ${other} */`,
			` /*!50000 ${other} */`,
			` /*+ ${other} */`,
			" /*",
		])
			expectWithheld(`SELECT ${name}${suffix}`, [name, other]);
		expectWithheld(`SELECT ${name}/**/FROM ${other}`, [name, other]);
	});

	it("requires balanced delimiters, complete operands, valid lists, and one fully consumed clause order", () => {
		const { name, other, number } = fixture();
		for (const source of [
			"",
			"SELECT",
			`SELECT (${name}`,
			`SELECT ${name})`,
			"SELECT ()",
			`SELECT '${name}`,
			`SELECT '${name}\\`,
			`SELECT \`${name}`,
			"SELECT ``",
			`SELECT ${name}..${other}`,
			`SELECT ${name}.`,
			`SELECT ${name} +`,
			`SELECT ${number}${name}`,
			"SELECT 1e+",
			`SELECT ${name}, FROM ${other}`,
			`SELECT ${name} AS FROM ${other}`,
			`SELECT ${name} FROM ${other} AS`,
			`SELECT ${name} WHERE ${name} IN ()`,
			`SELECT ${name} WHERE ${name} IN (${number},)`,
			`SELECT ${name} WHERE ${name} IS NOT`,
			`SELECT ${name} WHERE ${name} = ${other} = ${number}`,
			`SELECT ${name} WHERE ${name} AND`,
			`SELECT ${name} ORDER BY ${other} WHERE ${name} = ${number}`,
			`SELECT ${name} FROM ${other} FROM ${name}`,
			`SELECT ${name} ORDER BY ${other} DESC ASC`,
		])
			expectWithheld(source, [name, other, number]);
	});

	it("accepts the exact UTF-8 byte limit but withholds longer source even when the character count remains smaller", () => {
		const available = 65_536 - Buffer.byteLength("SELECT ''", "utf8");
		const body = "é".repeat(Math.floor(available / 2)) + (available % 2 ? "x" : "");
		expectSanitized(`SELECT '${body}'`, "SELECT LITERAL", [body]);
		expectWithheld(`SELECT '${body}é'`, [body]);
	});

	it("accepts the token boundary and withholds one extra token without truncating a valid query", () => {
		const { number } = fixture();
		const projections = Array(2_048).fill(number).join(",");
		const expected = `SELECT ${Array(2_048).fill("LITERAL").join(" , ")}`;
		expectSanitized(`SELECT ${projections}`, expected, [number]);
		expectWithheld(`SELECT +${projections}`, [number]);
	});

	it("bounds recursive parentheses, unary operators, calls, and nested IN expressions instead of overflowing", () => {
		const { name, pii } = fixture();
		expectSanitized(
			`SELECT ${"(".repeat(32)}${name}${")".repeat(32)}`,
			["SELECT", ...Array(32).fill("("), "IDENTIFIER", ...Array(32).fill(")")].join(" "),
			[name],
		);
		expectWithheld(`SELECT ${"(".repeat(33)}${name}${")".repeat(33)}`, [name]);
		expectSanitized(`SELECT ${"NOT ".repeat(32)}${name}`, `SELECT ${"NOT ".repeat(32)}IDENTIFIER`, [name]);
		expectWithheld(`SELECT ${"NOT ".repeat(33)}${name}`, [name]);
		expectSanitized(`SELECT ${"- ".repeat(32)}${name}`, `SELECT ${"- ".repeat(32)}IDENTIFIER`, [name]);
		expectWithheld(`SELECT ${"- ".repeat(33)}${name}`, [name]);
		expectSanitized(
			`SELECT ${"LOWER(".repeat(32)}'${pii}'${")".repeat(32)}`,
			["SELECT", ...Array(32).fill("LOWER ("), "LITERAL", ...Array(32).fill(")")].join(" "),
			[pii],
		);
		expectWithheld(`SELECT ${"LOWER(".repeat(33)}'${pii}'${")".repeat(33)}`, [pii]);
		expectWithheld(`SELECT ${"NOT ".repeat(16)}${"(".repeat(17)}${name}${")".repeat(17)}`, [name]);
		let nested = name;
		for (let index = 0; index < 33; index++) nested = `${name} IN (${nested})`;
		expectWithheld(`SELECT ${nested}`, [name]);
	});
});

describe("sanitizeAutomationTemplate record parameter structures", () => {
	it("distinguishes whole-query references from fixed-key value references without resolving their sensitive paths", () => {
		const { name, other } = fixture();
		const reference = `{steps.${name}.${other}}`;
		for (const stepType of ["QUERY RECORDS", "UPDATE RECORDS"]) {
			expectSanitized(reference, "RECORDS ( TEMPLATE = PLACEHOLDER )", [name, other, reference], stepType);
			expectSanitized(
				`data.status=${reference}`,
				"RECORDS ( FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) )",
				[name, other, reference],
				stepType,
			);
		}
		expectWithheld(reference, [name, other, reference], "SQL QUERY");
	});

	it("withholds malformed whole-query references and mixtures with parameters or code", () => {
		const { name, other, pii } = fixture();
		const reference = `{steps.${name}.${other}}`;
		for (const source of [
			`{unknown.${name}.${other}}`,
			`{{steps.${name}.${other}}}`,
			`{steps.${name}..${other}}`,
			`{steps.${name}.${other}()}`,
			`{steps.${name}.${other}`,
			`${reference}}`,
			`${reference}&data.status=${pii}`,
			`data.status=${pii}&${reference}`,
			`${reference}{agency.${name}}`,
			`${reference}; SELECT ${other}`,
			`prefix${reference}`,
			` ${reference}`,
			`${reference} `,
			`template=${reference}`,
		])
			expectWithheld(source, [name, other, pii], "QUERY RECORDS");
	});

	it("preserves source-backed filter and control structure for both record step types without reconstructing BSON", () => {
		const { name, other, pii, number } = fixture();
		const source = `_id={steps.${name}.id}&data.${name}__gte=${number}&search.confidentialTags.${other}__in=${pii},{agency.${name}}&match=any&group=${name}.${other}&sort= data.${name} , -${other}.${name} &limit={system.${name}}&skip=${number}`;
		const expected =
			"RECORDS ( FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) & FILTER IDENTIFIER GTE = VALUE ( LITERAL ) & SEARCH IDENTIFIER IN = VALUE ( LITERAL PLACEHOLDER ) & MATCH = ANY & GROUP = IDENTIFIER & SORT = ( IDENTIFIER ASC , IDENTIFIER DESC ) & LIMIT = PLACEHOLDER & SKIP = LITERAL )";
		for (const stepType of ["QUERY RECORDS", "UPDATE RECORDS"]) {
			expectSanitized(source, expected, [name, other, pii, number], stepType);
		}
	});

	it("maps every supported filter suffix to fixed structural vocabulary while redacting keys and values", () => {
		const { name, pii } = fixture();
		const operators = [
			["__ne", "NE"],
			["__gt", "GT"],
			["__gte", "GTE"],
			["__lt", "LT"],
			["__lte", "LTE"],
			["__in", "IN"],
			["__nin", "NIN"],
			["__all", "ALL"],
			["__size", "SIZE"],
			["__array-exists", "ARRAY_EXISTS"],
			["__exists", "EXISTS"],
			["__regex", "REGEX"],
		] as const;
		const source = operators.map(([suffix]) => `data.${name}${suffix}=${pii}`).join("&");
		const expected = `RECORDS ( ${operators.map(([, operator]) => `FILTER IDENTIFIER ${operator} = VALUE ( LITERAL )`).join(" & ")} )`;
		expectSanitized(source, expected, [name, pii], "QUERY RECORDS");
	});

	it("distinguishes literal segments from references and does not URL-decode parameter text", () => {
		const { name, other, pii } = fixture();
		expectSanitized(
			`data.${name}=${pii}{steps.${name}}${pii}{agency.${other}}${pii}{system.${name}}`,
			"RECORDS ( FILTER IDENTIFIER = VALUE ( LITERAL PLACEHOLDER LITERAL PLACEHOLDER LITERAL PLACEHOLDER ) )",
			[name, other, pii],
			"QUERY RECORDS",
		);
		expectSanitized(
			`confidentialTags={steps.${name}}{agency.${other}}&data.${name}=%7Bsteps.${other}%7D%26%3D`,
			"RECORDS ( FILTER IDENTIFIER = VALUE ( PLACEHOLDER PLACEHOLDER ) & FILTER IDENTIFIER = VALUE ( LITERAL ) )",
			[name, other],
			"QUERY RECORDS",
		);
		expectWithheld(`data.${name}=${pii}=${other}`, [name, other, pii], "QUERY RECORDS");
		expectWithheld(`data.${name}=${pii}&${other}`, [name, other, pii], "QUERY RECORDS");
	});

	it("preserves repeated filter parameters as template syntax instead of simulating backend overwrite or aggregation", () => {
		const { name, other, pii } = fixture();
		expectSanitized(
			`_id__in={steps.${name}}&_id__in={steps.${other}}&data.${name}=${pii}&data.${name}={agency.${other}}`,
			"RECORDS ( FILTER IDENTIFIER IN = VALUE ( PLACEHOLDER ) & FILTER IDENTIFIER IN = VALUE ( PLACEHOLDER ) & FILTER IDENTIFIER = VALUE ( LITERAL ) & FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) )",
			[name, other, pii],
			"QUERY RECORDS",
		);
	});

	it("withholds unsupported fields, dynamic keys, operators, JSON, and malformed reference values", () => {
		const { name, pii } = fixture();
		for (const source of [
			`${name}=${pii}`,
			`owner.${name}=${pii}`,
			`data..${name}=${pii}`,
			`data.{steps.${name}}=${pii}`,
			`data.${name}__unknown=${pii}`,
			`data.${name}__elemMatch={"value":"${pii}"}`,
			`$where=${pii}`,
			`data.${name}={"value":"${pii}"}`,
			`data.${name}={{steps.${name}}}`,
			`data.${name}={unknown.${name}}`,
			`data.${name}={steps.${name}`,
			`data.${name}=${pii}}`,
			`data.${name}=`,
			`?data.${name}=${pii}`,
			`data.${name}=${pii}&`,
			`&data.${name}=${pii}`,
			`data.${name}=${pii}&&limit=1`,
			"",
		])
			expectWithheld(source, [name, pii], "QUERY RECORDS");
	});

	it("rejects unknown control values and repeated controls rather than applying backend defaults or silently skipping fields", () => {
		const { name, number } = fixture();
		expectSanitized(
			"match=all&limit=0&skip=0",
			"RECORDS ( MATCH = ALL & LIMIT = LITERAL & SKIP = LITERAL )",
			[],
			"QUERY RECORDS",
		);
		for (const source of [
			`match=${name}`,
			"match=ANY",
			"match=any&match=all",
			`group=${name}&group=${name}`,
			`group=$${name}`,
			`group=${name},${name}`,
			`group={steps.${name}}`,
			`sort=${name}&sort=-${name}`,
			"sort=-",
			`sort=$${name}`,
			`sort=${name},`,
			`sort=- ${name}`,
			`limit=${number}&limit=${number}`,
			`skip=${number}&skip=${number}`,
			`limit=-${number}`,
			`skip=${number}.0`,
			`limit=1{steps.${name}}`,
			`limit={steps.${name}}tail`,
			`unknown=${number}`,
		])
			expectWithheld(source, [name, number], "QUERY RECORDS");
	});

	it("enforces the source-backed sort field count and path length limits", () => {
		const { name } = fixture();
		const path = name.padEnd(128, "_");
		const fields = Array(16).fill(path).join(",");
		const expected = `RECORDS ( SORT = ( ${Array(16).fill("IDENTIFIER ASC").join(" , ")} ) & GROUP = IDENTIFIER )`;
		expectSanitized(`sort=${fields}&group=${path}`, expected, [name, path], "QUERY RECORDS");
		expectWithheld(`sort=${fields},${path}`, [name, path], "QUERY RECORDS");
		expectWithheld(`sort=${path}_`, [name, path], "QUERY RECORDS");
		expectWithheld(`group=${path}_`, [name, path], "QUERY RECORDS");
	});

	it("bounds expanded record structure tokens instead of returning a partial parameter list", () => {
		const { name, number } = fixture();
		const ordinary = `data.${name}=${number}`;
		const mixed = `data.${name}=a{steps.${name}}b{agency.${name}}c{system.${name}}d`;
		const source = [mixed, ...Array(510).fill(ordinary)].join("&");
		const expected = `RECORDS ( FILTER IDENTIFIER = VALUE ( LITERAL PLACEHOLDER LITERAL PLACEHOLDER LITERAL PLACEHOLDER LITERAL ) & ${Array(510).fill("FILTER IDENTIFIER = VALUE ( LITERAL )").join(" & ")} )`;
		expectSanitized(source, expected, [name, number], "QUERY RECORDS");
		expectWithheld(`${source}&${ordinary}`, [name, number], "QUERY RECORDS");
	});

	it("dispatches by exact step type and does not treat another query language as an SQL fallback", () => {
		const { name, number } = fixture();
		expectWithheld(`data.${name}=${number}`, [name, number], "SQL QUERY");
		expectWithheld(`SELECT ${name}`, [name], "QUERY RECORDS");
		expectWithheld(`SELECT ${name}`, [name], "sql query");
		expectWithheld(`SELECT ${name}`, [name], "UNKNOWN");
	});
});

describe("isSafeTemplateStructure serialization gate", () => {
	it("rejects raw identifiers, literals, reference names, and injected vocabulary rather than re-sanitizing them", () => {
		const { name, pii, number } = fixture();
		for (const value of [
			`SELECT ${name}`,
			`SELECT '${pii}'`,
			`SELECT ${number}`,
			`SELECT {steps.${name}}`,
			`SELECT IDENTIFIER AS ${name}`,
			`SELECT IDENTIFIER FROM IDENTIFIER WHERE IDENTIFIER = LITERAL ${name}`,
			`SELECT IDENTIFIER /* ${name} */`,
			"SELECT IDENTIFIER ; SELECT IDENTIFIER",
			"SELECT LOAD_FILE ( LITERAL )",
			"SELECT COUNT",
			"SELECT INTEGER",
			"SELECT DISTINCT * INTO IDENTIFIER",
		])
			expect(isSafeTemplateStructure(value)).toBe(false);
	});

	it("rejects noncanonical spacing, casing, malformed structure, and trailing bytes at the native boundary", () => {
		for (const value of [
			"select IDENTIFIER",
			" SELECT IDENTIFIER",
			"SELECT  IDENTIFIER",
			"SELECT IDENTIFIER\n",
			"SELECT COUNT(*)",
			"SELECT IDENTIFIER WHERE IDENTIFIER =",
			"SELECT ( IDENTIFIER",
			"SELECT IDENTIFIER LIMIT - LITERAL",
			"SELECT IDENTIFIER\0",
		])
			expect(isSafeTemplateStructure(value)).toBe(false);
	});

	it("rejects malformed or injected record structures even when their surrounding tokens are canonical", () => {
		const { name, pii } = fixture();
		for (const value of [
			`RECORDS ( FILTER ${name} = VALUE ( LITERAL ) )`,
			`RECORDS ( FILTER IDENTIFIER = VALUE ( '${pii}' ) )`,
			`RECORDS ( FILTER IDENTIFIER = VALUE ( {steps.${name}} ) )`,
			"RECORDS ( FILTER IDENTIFIER ELEMMATCH = VALUE ( LITERAL ) )",
			"RECORDS ( FILTER IDENTIFIER = VALUE ( LITERAL LITERAL ) )",
			"RECORDS ( FILTER IDENTIFIER = VALUE ( ) )",
			"RECORDS ( MATCH = ANY & MATCH = ALL )",
			"RECORDS ( LIMIT = - LITERAL )",
			"RECORDS ( SORT = ( IDENTIFIER ) )",
			"RECORDS ( FILTER IDENTIFIER = VALUE ( LITERAL ) ) SELECT IDENTIFIER",
			"RECORDS ( FILTER IDENTIFIER = VALUE ( LITERAL )",
			"RECORDS ( )",
			`RECORDS ( SORT = ( ${Array(17).fill("IDENTIFIER ASC").join(" , ")} ) )`,
		])
			expect(isSafeTemplateStructure(value)).toBe(false);
	});

	it("rejects raw paths, non-placeholder payloads, and mixed forms in canonical whole-template structures", () => {
		const { name, other } = fixture();
		for (const value of [
			`RECORDS ( TEMPLATE = {steps.${name}.${other}} )`,
			`RECORDS ( TEMPLATE = ${name} )`,
			"RECORDS ( TEMPLATE = LITERAL )",
			"RECORDS ( TEMPLATE = IDENTIFIER )",
			"RECORDS ( TEMPLATE = PLACEHOLDER PLACEHOLDER )",
			"RECORDS ( TEMPLATE = PLACEHOLDER & FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) )",
			"RECORDS ( FILTER IDENTIFIER = VALUE ( PLACEHOLDER ) & TEMPLATE = PLACEHOLDER )",
			"RECORDS ( TEMPLATE = PLACEHOLDER ) RECORDS ( TEMPLATE = PLACEHOLDER )",
			"RECORDS ( TEMPLATE = PLACEHOLDER ) ",
		])
			expect(isSafeTemplateStructure(value)).toBe(false);
	});

	it("enforces source parser resource bounds on worker-provided canonical structures", () => {
		const nested = ["SELECT", ...Array(33).fill("("), "IDENTIFIER", ...Array(33).fill(")")].join(" ");
		const wide = `SELECT ${Array(2_049).fill("LITERAL").join(" , ")}`;
		expect(isSafeTemplateStructure(nested)).toBe(false);
		expect(isSafeTemplateStructure(wide)).toBe(false);
	});

	it("rejects non-string worker values without invoking user-defined coercion", () => {
		const hostile = {
			[Symbol.toPrimitive]() {
				throw new Error("Coercion must not run");
			},
		};
		for (const value of [undefined, null, 1, false, [], {}, new String("SELECT IDENTIFIER"), hostile]) {
			expect(isSafeTemplateStructure(value)).toBe(false);
		}
	});
});
