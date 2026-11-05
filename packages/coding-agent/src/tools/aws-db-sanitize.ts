export const DB_SANITIZER_POLICY_ID = "restricted-template-structure/v1";

const MAX_SOURCE_BYTES = 65_536;
const MAX_TOKENS = 4_096;
const MAX_DEPTH = 32;

const KEYWORDS = {
	SELECT: "SELECT",
	DISTINCT: "DISTINCT",
	FROM: "FROM",
	AS: "AS",
	JOIN: "JOIN",
	INNER: "INNER",
	LEFT: "LEFT",
	RIGHT: "RIGHT",
	OUTER: "OUTER",
	CROSS: "CROSS",
	ON: "ON",
	WHERE: "WHERE",
	GROUP: "GROUP",
	BY: "BY",
	HAVING: "HAVING",
	ORDER: "ORDER",
	ASC: "ASC",
	DESC: "DESC",
	LIMIT: "LIMIT",
	OFFSET: "OFFSET",
	AND: "AND",
	OR: "OR",
	NOT: "NOT",
	IS: "IS",
	NULL: "NULL",
	IN: "IN",
	BETWEEN: "BETWEEN",
	LIKE: "LIKE",
	COUNT: "COUNT",
	SUM: "SUM",
	MIN: "MIN",
	MAX: "MAX",
	AVG: "AVG",
	COALESCE: "COALESCE",
	IFNULL: "IFNULL",
	LOWER: "LOWER",
	UPPER: "UPPER",
	TRIM: "TRIM",
} as const;

const RECORD_KEYWORDS = {
	RECORDS: "RECORDS",
	TEMPLATE: "TEMPLATE",
	FILTER: "FILTER",
	SEARCH: "SEARCH",
	VALUE: "VALUE",
	MATCH: "MATCH",
	SORT: "SORT",
	SKIP: "SKIP",
	ANY: "ANY",
	ALL: "ALL",
	NE: "NE",
	GT: "GT",
	GTE: "GTE",
	LT: "LT",
	LTE: "LTE",
	NIN: "NIN",
	SIZE: "SIZE",
	ARRAY_EXISTS: "ARRAY_EXISTS",
	EXISTS: "EXISTS",
	REGEX: "REGEX",
} as const;

const RECORD_OPERATORS = {
	__ne: "NE",
	__gt: "GT",
	__gte: "GTE",
	__lt: "LT",
	__lte: "LTE",
	__in: "IN",
	__nin: "NIN",
	__all: "ALL",
	__size: "SIZE",
	"__array-exists": "ARRAY_EXISTS",
	__exists: "EXISTS",
	__regex: "REGEX",
} as const;

const UNSUPPORTED_SQL_WORDS = {
	SQL_CALC_FOUND_ROWS: true,
	HIGH_PRIORITY: true,
	SQL_SMALL_RESULT: true,
	SQL_BIG_RESULT: true,
	SQL_BUFFER_RESULT: true,
	SQL_NO_CACHE: true,
	SQL_CACHE: true,
	STRAIGHT_JOIN: true,
	WITH: true,
	RECURSIVE: true,
	UNION: true,
	INTERSECT: true,
	EXCEPT: true,
	INTO: true,
	OUTFILE: true,
	DUMPFILE: true,
	INSERT: true,
	UPDATE: true,
	DELETE: true,
	REPLACE: true,
	CREATE: true,
	DROP: true,
	ALTER: true,
	TRUNCATE: true,
	CALL: true,
	EXEC: true,
	EXECUTE: true,
	PREPARE: true,
	DEALLOCATE: true,
	SET: true,
	DO: true,
	GRANT: true,
	REVOKE: true,
	LOAD: true,
	HANDLER: true,
	EXISTS: true,
	CASE: true,
	WHEN: true,
	THEN: true,
	ELSE: true,
	END: true,
	OVER: true,
	WINDOW: true,
	FOR: true,
	LOCK: true,
	UNLOCK: true,
	PROCEDURE: true,
	USING: true,
	NATURAL: true,
	FULL: true,
	ALL: true,
	COLLATE: true,
	ESCAPE: true,
	INTERVAL: true,
	BINARY: true,
	DIV: true,
	MOD: true,
	XOR: true,
	REGEXP: true,
	RLIKE: true,
} as const;

type Keyword = (typeof KEYWORDS)[keyof typeof KEYWORDS];
type Token =
	| Keyword
	| (typeof RECORD_KEYWORDS)[keyof typeof RECORD_KEYWORDS]
	| "IDENTIFIER"
	| "LITERAL"
	| "INTEGER"
	| "PLACEHOLDER"
	| "("
	| ")"
	| ","
	| "."
	| "*"
	| "+"
	| "-"
	| "/"
	| "%"
	| "="
	| "&"
	| "!="
	| "<>"
	| "<"
	| "<="
	| ">"
	| ">="
	| "<=>";

const RECORD_OPERATOR_TOKENS: readonly Token[] = Object.values(RECORD_OPERATORS);

function keyword(word: string): Keyword | undefined {
	return Object.hasOwn(KEYWORDS, word) ? KEYWORDS[word as keyof typeof KEYWORDS] : undefined;
}

function isIdentifierStart(char: string | undefined): boolean {
	return char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_");
}

function isDigit(char: string | undefined): boolean {
	return char !== undefined && char >= "0" && char <= "9";
}

function isIdentifierPart(char: string | undefined): boolean {
	return isIdentifierStart(char) || isDigit(char);
}

function readPlaceholder(source: string, index: number): number | undefined {
	if (source[index++] !== "{") return undefined;
	if (source.startsWith("steps.", index)) index += "steps.".length;
	else if (source.startsWith("agency.", index)) index += "agency.".length;
	else if (source.startsWith("system.", index)) index += "system.".length;
	else return undefined;
	while (true) {
		if (!isIdentifierStart(source[index])) return undefined;
		index++;
		while (isIdentifierPart(source[index])) index++;
		if (source[index] !== ".") break;
		index++;
	}
	return source[index] === "}" ? index + 1 : undefined;
}

function tokenize(source: string, canonical: boolean): Token[] | undefined {
	const tokens: Token[] = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f") {
			index++;
			continue;
		}
		let token: Token;
		if (isIdentifierStart(char)) {
			const start = index++;
			while (isIdentifierPart(source[index])) index++;
			const word = source.slice(start, index);
			if (canonical) {
				if (word === "IDENTIFIER" || word === "PLACEHOLDER") token = word;
				else if (word === "LITERAL") token = "INTEGER";
				else {
					const fixed =
						keyword(word) ??
						(Object.hasOwn(RECORD_KEYWORDS, word)
							? RECORD_KEYWORDS[word as keyof typeof RECORD_KEYWORDS]
							: undefined);
					if (!fixed) return undefined;
					token = fixed;
				}
			} else {
				const upper = word.toUpperCase();
				if (Object.hasOwn(UNSUPPORTED_SQL_WORDS, upper)) return undefined;
				token = upper === "TRUE" || upper === "FALSE" ? "LITERAL" : (keyword(upper) ?? "IDENTIFIER");
			}
		} else if (!canonical && (char === "'" || char === "`")) {
			const delimiter = char;
			const start = ++index;
			let closed = false;
			while (index < source.length) {
				if (source[index] === delimiter) {
					if (source[index + 1] === delimiter) {
						index += 2;
						continue;
					}
					if (delimiter === "`" && index === start) return undefined;
					index++;
					closed = true;
					break;
				}
				if (source[index] === "\\") return undefined;
				index++;
			}
			if (!closed) return undefined;
			token = delimiter === "`" ? "IDENTIFIER" : "LITERAL";
		} else if (!canonical && char === "{") {
			const end = readPlaceholder(source, index);
			if (end === undefined) return undefined;
			index = end;
			token = "PLACEHOLDER";
		} else if (!canonical && (isDigit(char) || (char === "." && isDigit(source[index + 1])))) {
			let integer = true;
			while (isDigit(source[index])) index++;
			if (source[index] === ".") {
				integer = false;
				index++;
				while (isDigit(source[index])) index++;
			}
			if (source[index] === "e" || source[index] === "E") {
				integer = false;
				index++;
				if (source[index] === "+" || source[index] === "-") index++;
				if (!isDigit(source[index])) return undefined;
				while (isDigit(source[index])) index++;
			}
			if (isIdentifierPart(source[index])) return undefined;
			token = integer ? "INTEGER" : "LITERAL";
		} else {
			index++;
			switch (char) {
				case "(":
				case ")":
				case ",":
				case ".":
				case "*":
				case "+":
				case "%":
				case "=":
					token = char;
					break;
				case "&":
					if (!canonical) return undefined;
					token = "&";
					break;
				case "-":
					if (source[index] === "-") return undefined;
					token = "-";
					break;
				case "/":
					if (source[index] === "*") return undefined;
					token = "/";
					break;
				case "!":
					if (source[index++] !== "=") return undefined;
					token = "!=";
					break;
				case "<":
					if (source[index] === "=") {
						index++;
						if (source[index] === ">") {
							index++;
							token = "<=>";
						} else token = "<=";
					} else if (source[index] === ">") {
						index++;
						token = "<>";
					} else token = "<";
					break;
				case ">":
					if (source[index] === "=") {
						index++;
						token = ">=";
					} else token = ">";
					break;
				default:
					return undefined;
			}
		}
		if (tokens.length === MAX_TOKENS) return undefined;
		tokens.push(token);
	}
	return tokens;
}

function isIdentifierPath(value: string, start = 0, end = value.length): boolean {
	while (start < end) {
		if (!isIdentifierStart(value[start++])) return false;
		while (start < end && isIdentifierPart(value[start])) start++;
		if (start === end) return true;
		if (value[start++] !== ".") return false;
	}
	return false;
}

function recordOperator(key: string): Token | null | false {
	const start = key.startsWith("search.") ? "search.".length : 0;
	const suffixIndex = key.indexOf("__", start);
	let end = key.length;
	let operator: Token | null = null;
	if (suffixIndex !== -1) {
		const suffix = key.slice(suffixIndex);
		if (!Object.hasOwn(RECORD_OPERATORS, suffix)) return false;
		operator = RECORD_OPERATORS[suffix as keyof typeof RECORD_OPERATORS];
		end = suffixIndex;
	}
	if (key.startsWith("_id", start) && end === start + "_id".length) return operator;
	if (key.startsWith("data.", start) && isIdentifierPath(key, start + "data.".length, end)) return operator;
	if (key.startsWith("confidentialTags", start)) {
		const pathStart = start + "confidentialTags".length;
		if (end === pathStart || (key[pathStart] === "." && isIdentifierPath(key, pathStart + 1, end))) return operator;
	}
	return false;
}

function recordValue(source: string, start: number, end: number, tokens: Token[]): boolean {
	if (start === end) return false;
	while (start < end) {
		if (source[start] === "}") return false;
		if (source[start] === "{") {
			const next = readPlaceholder(source, start);
			if (next === undefined || next > end) return false;
			start = next;
			if (tokens.push("PLACEHOLDER") > MAX_TOKENS) return false;
		} else {
			while (start < end && source[start] !== "{" && source[start] !== "}") start++;
			if (tokens.push("LITERAL") > MAX_TOKENS) return false;
		}
	}
	return true;
}

function recordNumber(source: string, start: number, end: number, tokens: Token[]): boolean {
	if (start === end) return false;
	if (source[start] === "{") {
		if (readPlaceholder(source, start) !== end) return false;
		return tokens.push("PLACEHOLDER") <= MAX_TOKENS;
	}
	while (start < end) if (!isDigit(source[start++])) return false;
	return tokens.push("LITERAL") <= MAX_TOKENS;
}

function tokenizeRecords(source: string): Token[] | undefined {
	if (source[0] === "{") {
		if (readPlaceholder(source, 0) !== source.length) return undefined;
		return ["RECORDS", "(", "TEMPLATE", "=", "PLACEHOLDER", ")"];
	}
	const tokens: Token[] = ["RECORDS", "("];
	let start = 0;
	while (start < source.length) {
		let end = source.indexOf("&", start);
		if (end === -1) end = source.length;
		const equal = source.indexOf("=", start);
		const extraEqual = equal === -1 ? -1 : source.indexOf("=", equal + 1);
		if (equal <= start || equal >= end || equal + 1 === end || (extraEqual !== -1 && extraEqual < end))
			return undefined;
		const key = source.slice(start, equal);
		const valueStart = equal + 1;
		switch (key) {
			case "match": {
				const value = source.slice(valueStart, end);
				if (value !== "any" && value !== "all") return undefined;
				if (tokens.push("MATCH", "=", value === "any" ? "ANY" : "ALL") > MAX_TOKENS) return undefined;
				break;
			}
			case "group": {
				if (end - valueStart > 128 || !isIdentifierPath(source, valueStart, end)) return undefined;
				if (tokens.push("GROUP", "=", "IDENTIFIER") > MAX_TOKENS) return undefined;
				break;
			}
			case "sort": {
				if (tokens.push("SORT", "=", "(") > MAX_TOKENS) return undefined;
				let fieldStart = valueStart;
				let count = 0;
				while (fieldStart < end) {
					let fieldEnd = source.indexOf(",", fieldStart);
					if (fieldEnd === -1 || fieldEnd > end) fieldEnd = end;
					const field = source.slice(fieldStart, fieldEnd).trim();
					const descending = field.startsWith("-");
					const pathStart = descending ? 1 : 0;
					if (++count > 16 || field.length - pathStart > 128 || !isIdentifierPath(field, pathStart))
						return undefined;
					if (tokens.push("IDENTIFIER", descending ? "DESC" : "ASC") > MAX_TOKENS) return undefined;
					if (fieldEnd === end) break;
					if (fieldEnd + 1 === end || tokens.push(",") > MAX_TOKENS) return undefined;
					fieldStart = fieldEnd + 1;
				}
				if (tokens.push(")") > MAX_TOKENS) return undefined;
				break;
			}
			case "limit":
			case "skip":
				if (tokens.push(key === "limit" ? "LIMIT" : "SKIP", "=") > MAX_TOKENS) return undefined;
				if (!recordNumber(source, valueStart, end, tokens)) return undefined;
				break;
			default: {
				const operator = recordOperator(key);
				if (operator === false) return undefined;
				if (tokens.push(key.startsWith("search.") ? "SEARCH" : "FILTER", "IDENTIFIER") > MAX_TOKENS)
					return undefined;
				if (operator !== null && tokens.push(operator) > MAX_TOKENS) return undefined;
				if (tokens.push("=", "VALUE", "(") > MAX_TOKENS || !recordValue(source, valueStart, end, tokens))
					return undefined;
				if (tokens.push(")") > MAX_TOKENS) return undefined;
			}
		}
		if (end === source.length) break;
		if (end + 1 === source.length || tokens.push("&") > MAX_TOKENS) return undefined;
		start = end + 1;
	}
	return tokens.push(")") <= MAX_TOKENS ? tokens : undefined;
}

function isBuiltin(token: Token | undefined): boolean {
	return (
		token === "COUNT" ||
		token === "SUM" ||
		token === "MIN" ||
		token === "MAX" ||
		token === "AVG" ||
		token === "COALESCE" ||
		token === "IFNULL" ||
		token === "LOWER" ||
		token === "UPPER" ||
		token === "TRIM"
	);
}

function isIdentifier(token: Token | undefined): boolean {
	return token === "IDENTIFIER" || isBuiltin(token);
}

class StructureParser {
	#position = 0;
	readonly #output: string[] = [];

	constructor(private readonly tokens: readonly Token[]) {}

	#peek(offset = 0): Token | undefined {
		return this.tokens[this.#position + offset];
	}

	#take(token: Token): boolean {
		if (this.#peek() !== token) return false;
		this.#position++;
		this.#output.push(token === "INTEGER" ? "LITERAL" : token);
		return true;
	}

	#identifier(): boolean {
		if (!isIdentifier(this.#peek())) return false;
		this.#position++;
		this.#output.push("IDENTIFIER");
		return true;
	}

	#identifierPath(): boolean {
		if (!this.#identifier()) return false;
		return !this.#take(".") || this.#identifier();
	}

	#table(): boolean {
		if (!this.#identifierPath()) return false;
		return !this.#take("AS") || this.#identifier();
	}

	#projection(): boolean {
		do {
			let wildcard = this.#take("*");
			if (!wildcard && isIdentifier(this.#peek()) && this.#peek(1) === "." && this.#peek(2) === "*") {
				wildcard = this.#identifier() && this.#take(".") && this.#take("*");
			} else if (!wildcard && !this.#expression(0)) return false;
			if (!wildcard && this.#take("AS") && !this.#identifier()) return false;
		} while (this.#take(","));
		return true;
	}

	#joins(): boolean {
		while (true) {
			let cross = false;
			if (this.#take("CROSS")) cross = true;
			else if (this.#take("LEFT") || this.#take("RIGHT")) this.#take("OUTER");
			else if (!this.#take("INNER") && this.#peek() !== "JOIN") return true;
			if (!this.#take("JOIN") || !this.#table()) return false;
			if (!cross && (!this.#take("ON") || !this.#expression(0))) return false;
		}
	}

	#expressionList(depth: number): boolean {
		do {
			if (!this.#expression(depth)) return false;
		} while (this.#take(","));
		return true;
	}

	#expression(depth: number): boolean {
		if (depth > MAX_DEPTH || !this.#and(depth)) return false;
		while (this.#take("OR")) if (!this.#and(depth)) return false;
		return true;
	}

	#and(depth: number): boolean {
		if (!this.#not(depth)) return false;
		while (this.#take("AND")) if (!this.#not(depth)) return false;
		return true;
	}

	#not(depth: number): boolean {
		if (depth > MAX_DEPTH) return false;
		if (this.#take("NOT")) return this.#not(depth + 1);
		return this.#comparison(depth);
	}

	#comparison(depth: number): boolean {
		if (!this.#additive(depth)) return false;
		if (
			this.#take("=") ||
			this.#take("!=") ||
			this.#take("<>") ||
			this.#take("<") ||
			this.#take("<=") ||
			this.#take(">") ||
			this.#take(">=") ||
			this.#take("<=>")
		) {
			return this.#additive(depth);
		}
		if (this.#take("IS")) {
			this.#take("NOT");
			return this.#take("NULL");
		}
		const negated = this.#take("NOT");
		if (this.#take("IN")) {
			return this.#take("(") && this.#expressionList(depth + 1) && this.#take(")");
		}
		if (this.#take("BETWEEN")) return this.#additive(depth) && this.#take("AND") && this.#additive(depth);
		if (this.#take("LIKE")) return this.#additive(depth);
		return !negated;
	}

	#additive(depth: number): boolean {
		if (!this.#multiplicative(depth)) return false;
		while (this.#take("+") || this.#take("-")) if (!this.#multiplicative(depth)) return false;
		return true;
	}

	#multiplicative(depth: number): boolean {
		if (!this.#unary(depth)) return false;
		while (this.#take("*") || this.#take("/") || this.#take("%")) if (!this.#unary(depth)) return false;
		return true;
	}

	#unary(depth: number): boolean {
		if (depth > MAX_DEPTH) return false;
		if (this.#take("+") || this.#take("-")) return this.#unary(depth + 1);
		return this.#primary(depth);
	}

	#primary(depth: number): boolean {
		if (this.#take("(")) return this.#expression(depth + 1) && this.#take(")");
		if (this.#take("LITERAL") || this.#take("INTEGER") || this.#take("PLACEHOLDER") || this.#take("NULL"))
			return true;
		const builtin = this.#peek();
		if (builtin && isBuiltin(builtin) && this.#peek(1) === "(") return this.#builtin(builtin, depth);
		return this.#identifierPath();
	}

	#builtin(name: Token, depth: number): boolean {
		if (depth >= MAX_DEPTH || !this.#take(name) || !this.#take("(")) return false;
		if (name === "COUNT" && this.#take("*")) return this.#take(")");
		const aggregate = name === "COUNT" || name === "SUM" || name === "MIN" || name === "MAX" || name === "AVG";
		const distinct = aggregate && this.#take("DISTINCT");
		if (!this.#expression(depth + 1)) return false;
		let count = 1;
		while (this.#take(",")) {
			if (!this.#expression(depth + 1)) return false;
			count++;
		}
		if (name === "IFNULL" && count !== 2) return false;
		if (name !== "IFNULL" && name !== "COALESCE" && !(name === "COUNT" && distinct) && count !== 1) return false;
		return this.#take(")");
	}

	parse(): string | undefined {
		if (!this.#take("SELECT")) return undefined;
		this.#take("DISTINCT");
		if (!this.#projection()) return undefined;
		if (this.#take("FROM") && (!this.#table() || !this.#joins())) return undefined;
		if (this.#take("WHERE") && !this.#expression(0)) return undefined;
		if (this.#take("GROUP") && (!this.#take("BY") || !this.#expressionList(0))) return undefined;
		if (this.#take("HAVING") && !this.#expression(0)) return undefined;
		if (this.#take("ORDER")) {
			if (!this.#take("BY")) return undefined;
			do {
				if (!this.#expression(0)) return undefined;
				if (!this.#take("ASC")) this.#take("DESC");
			} while (this.#take(","));
		}
		if (this.#take("LIMIT")) {
			if (!this.#take("INTEGER") && !this.#take("PLACEHOLDER")) return undefined;
			if (this.#take("OFFSET") && !this.#take("INTEGER") && !this.#take("PLACEHOLDER")) return undefined;
		}
		return this.#position === this.tokens.length ? this.#output.join(" ") : undefined;
	}

	records(): string | undefined {
		if (!this.#take("RECORDS") || !this.#take("(")) return undefined;
		if (this.#take("TEMPLATE")) {
			if (!this.#take("=") || !this.#take("PLACEHOLDER") || !this.#take(")")) return undefined;
			return this.#position === this.tokens.length ? this.#output.join(" ") : undefined;
		}
		const controls = new Set<Token>();
		do {
			if (this.#take("FILTER") || this.#take("SEARCH")) {
				if (!this.#take("IDENTIFIER")) return undefined;
				const operator = this.#peek();
				if (operator && RECORD_OPERATOR_TOKENS.includes(operator)) this.#take(operator);
				if (!this.#take("=") || !this.#take("VALUE") || !this.#take("(")) return undefined;
				let segments = 0;
				let literal = false;
				while (true) {
					const next = this.#peek();
					if (next === "LITERAL" || next === "INTEGER") {
						if (literal) return undefined;
						literal = true;
					} else if (next === "PLACEHOLDER") literal = false;
					else break;
					this.#take(next);
					segments++;
				}
				if (segments === 0 || !this.#take(")")) return undefined;
			} else {
				const control = this.#peek();
				if (!control || controls.has(control)) return undefined;
				controls.add(control);
				if (!this.#take(control) || !this.#take("=")) return undefined;
				switch (control) {
					case "MATCH":
						if (!this.#take("ANY") && !this.#take("ALL")) return undefined;
						break;
					case "GROUP":
						if (!this.#take("IDENTIFIER")) return undefined;
						break;
					case "SORT": {
						if (!this.#take("(")) return undefined;
						let fields = 0;
						do {
							if (++fields > 16 || !this.#take("IDENTIFIER")) return undefined;
							if (!this.#take("ASC") && !this.#take("DESC")) return undefined;
						} while (this.#take(","));
						if (!this.#take(")")) return undefined;
						break;
					}
					case "LIMIT":
					case "SKIP":
						if (!this.#take("LITERAL") && !this.#take("INTEGER") && !this.#take("PLACEHOLDER")) return undefined;
						break;
					default:
						return undefined;
				}
			}
		} while (this.#take("&"));
		if (!this.#take(")") || this.#position !== this.tokens.length) return undefined;
		return this.#output.join(" ");
	}
}

function parseStructure(source: string, canonical: boolean, format: "sql" | "records"): string | undefined {
	let tokens: Token[] | undefined;
	try {
		if (
			typeof source !== "string" ||
			source.length > MAX_SOURCE_BYTES ||
			Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES
		)
			return undefined;
		tokens = canonical || format === "sql" ? tokenize(source, canonical) : tokenizeRecords(source);
		source = "";
		if (!tokens) return undefined;
		const parser = new StructureParser(tokens);
		return format === "records" ? parser.records() : parser.parse();
	} catch {
		return undefined;
	} finally {
		source = "";
		if (tokens) tokens.length = 0;
	}
}

export function sanitizeAutomationTemplate(
	source: string,
	stepType?: string,
): { disposition: "sanitized"; structure: string } | { disposition: "withheld" } {
	const format =
		stepType === undefined || stepType === "SQL QUERY"
			? "sql"
			: stepType === "QUERY RECORDS" || stepType === "UPDATE RECORDS"
				? "records"
				: undefined;
	const structure = format === undefined ? undefined : parseStructure(source, false, format);
	source = "";
	return structure === undefined ? { disposition: "withheld" } : { disposition: "sanitized", structure };
}

export function isSafeTemplateStructure(value: unknown): value is string {
	if (typeof value !== "string") return false;
	return parseStructure(value, true, value.startsWith("RECORDS ") ? "records" : "sql") === value;
}
