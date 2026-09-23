/** Parse the documented jq-style field syntax used by agent://...?q=. */
export function parseQuery(query: string): Array<string | number> {
	let input = query.trim();
	if (!input) return [];
	if (input.startsWith(".")) input = input.slice(1);
	if (!input) return [];

	const tokens: Array<string | number> = [];
	let index = 0;
	while (index < input.length) {
		const character = input[index];
		if (character === ".") {
			index++;
			continue;
		}
		if (character === "[") {
			const closeIndex = input.indexOf("]", index + 1);
			if (closeIndex === -1) throw new Error(`Invalid query: missing ] in ${query}`);
			const raw = input.slice(index + 1, closeIndex).trim();
			if (!raw) throw new Error(`Invalid query: empty [] in ${query}`);
			const quote = raw[0];
			if ((quote === '"' || quote === "'") && raw.endsWith(quote)) {
				const inner = raw.slice(1, -1).replace(/\\(["'\\])/g, "$1");
				tokens.push(inner);
			} else if (/^\d+$/.test(raw)) {
				tokens.push(Number(raw));
			} else {
				tokens.push(raw);
			}
			index = closeIndex + 1;
			continue;
		}

		const start = index;
		while (index < input.length && /[A-Za-z0-9_-]/.test(input[index])) index++;
		if (start === index) throw new Error(`Invalid query: unexpected token '${input[index]}' in ${query}`);
		tokens.push(input.slice(start, index));
	}
	return tokens;
}

/** Apply one agent URL query to a parsed JSON output value. */
export function applyQuery(data: unknown, query: string): unknown {
	let current = data;
	for (const token of parseQuery(query)) {
		if (current === null || current === undefined) return undefined;
		if (typeof token === "number") {
			if (!Array.isArray(current)) return undefined;
			current = current[token];
			continue;
		}
		if (typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[token];
	}
	return current;
}
