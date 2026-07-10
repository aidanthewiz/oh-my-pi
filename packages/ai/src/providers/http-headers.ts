/** Header plumbing shared by transports that rewrite/sign request headers. */

export function headerInitToRecord(init: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!init) return out;
	if (init instanceof Headers) {
		init.forEach((value, key) => {
			out[key] = value;
		});
		return out;
	}
	if (Array.isArray(init)) {
		for (const [key, value] of init) out[key] = value;
		return out;
	}
	for (const [key, value] of Object.entries(init)) out[key] = String(value);
	return out;
}

export function deleteHeaderCaseInsensitive(headers: Record<string, string>, name: string): void {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) delete headers[key];
	}
}
