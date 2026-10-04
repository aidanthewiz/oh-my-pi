import { describe, expect, it } from "bun:test";
import type { Message } from "@oh-my-pi/pi-ai";
import {
	deobfuscateToolArguments,
	obfuscateMessages,
	obfuscateToolArguments,
} from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import {
	SecretValueSet,
	sanitizedLabelCollidesWithSecret,
	sanitizeForCollisionCheck,
} from "@oh-my-pi/pi-coding-agent/secrets/placeholder";

describe("SecretObfuscator batch scans", () => {
	it("rescans a string after a mint earlier in the same batch resolves the placeholder key", () => {
		// Collection scans both messages before the key exists, so the second
		// one is literal-free then. Redacting the first mints a placeholder,
		// which resolves the key and registers it as a literal; the second
		// message must be rescanned, not reported clean from the stale scan.
		const key = "lazy-placeholder-key-0123456789";
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }], () => key);
		const messages: Message[] = [
			{ role: "user", content: "use tok_abc123 here", timestamp: 1 },
			{ role: "user", content: `the key is ${key}`, timestamp: 2 },
		];

		const output = JSON.stringify(obfuscateMessages(obfuscator, messages));

		expect(output).not.toContain("tok_abc123");
		expect(output).not.toContain(key);
	});

	it("protects a credential added after the same text was scanned clean in one batch", () => {
		const credential = "synthetic-new-managed-credential";
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "tok_[a-z0-9]+" }], "batch-key");
		obfuscator.batch(() => {
			expect(obfuscator.obfuscate(credential)).toBe(credential);
			obfuscator.addPlainEntries([{ type: "plain", content: credential, alwaysOn: true }]);
			const output = obfuscator.obfuscate(credential);
			expect(output).not.toContain(credential);
			expect(obfuscator.deobfuscate(output)).toBe(credential);
		});
	});

	it("uses a changed replacement and its new collision values in the same batch", () => {
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
				{ type: "plain", content: "replace-me", mode: "replace", replacement: "safe" },
				{ type: "regex", content: "tok_[a-z0-9]+" },
			],
			"replacement-key",
		);
		const input = "OTHERSECRET replace-me";
		obfuscator.batch(() => {
			const before = obfuscator.obfuscate(input);
			expect(before).toContain("TOKABC123_");
			expect(before).toContain("safe");
			obfuscator.addPlainEntries([
				{ type: "plain", content: "replace-me", mode: "replace", replacement: "tok_abc123" },
			]);
			const after = obfuscator.obfuscate(input);
			expect(after).not.toContain("TOKABC123_");
			expect(after).not.toContain("tok_abc123");
			expect(after).not.toContain("safe");
			expect(obfuscator.deobfuscate(after)).toBe("OTHERSECRET tok_abc123");
		});
	});

	it("rescans optional regex secrets when enabled inside a batch while retaining mandatory protection", () => {
		const mandatory = "synthetic-mandatory-credential";
		const optional = "tok_abc123";
		const input = `${mandatory} ${optional}`;
		const obfuscator = new SecretObfuscator(
			[
				{ type: "plain", content: mandatory, alwaysOn: true },
				{ type: "regex", content: "tok_[a-z0-9]+" },
			],
			"toggle-key",
		);
		obfuscator.batch(() => {
			obfuscator.setObfuscating(false);
			const disabled = obfuscator.obfuscate(input);
			expect(disabled).not.toContain(mandatory);
			expect(disabled).toContain(optional);
			obfuscator.setObfuscating(true);
			const enabled = obfuscator.obfuscate(input);
			expect(enabled).not.toContain(mandatory);
			expect(enabled).not.toContain(optional);
			expect(obfuscator.deobfuscate(enabled)).toBe(input);
			obfuscator.setObfuscating(false);
			expect(obfuscator.obfuscate(input)).toBe(disabled);
			expect(obfuscator.deobfuscate(enabled)).toBe(input);
		});
	});

	it("keeps tool argument redaction and restoration isolated between fresh registries", () => {
		const credential = "synthetic-fresh-credential";
		const path = "/private/synthetic/session-12345";
		const args = { old_string: credential, nested: [{ path }] };
		const clean = new SecretObfuscator([], "fresh-key");
		expect(obfuscateToolArguments(clean, args)).toBe(args);
		const protectedRegistry = new SecretObfuscator(
			[
				{ type: "plain", content: credential },
				{ type: "regex", content: "/private/synthetic/session-[0-9]+" },
			],
			"fresh-key",
		);
		const output = obfuscateToolArguments(protectedRegistry, args);
		expect(JSON.stringify(output)).not.toContain(credential);
		expect(JSON.stringify(output)).not.toContain(path);
		expect(deobfuscateToolArguments(protectedRegistry, output)).toEqual(args);
		expect(deobfuscateToolArguments(clean, output)).toBe(output);
		expect(obfuscateToolArguments(new SecretObfuscator([], "fresh-key"), args)).toBe(args);
	});

	it("uses the current registry when the same chat history is redacted after credential replacement", () => {
		const previous = "synthetic-previous-credential";
		const current = "synthetic-current-credential";
		const messages: Message[] = [{ role: "user", content: `${previous} ${current}`, timestamp: 1 }];
		const oldRegistry = new SecretObfuscator([{ type: "plain", content: previous }], "chat-key");
		const oldOutput = JSON.stringify(obfuscateMessages(oldRegistry, messages));
		expect(oldOutput).not.toContain(previous);
		expect(oldOutput).toContain(current);
		const newRegistry = new SecretObfuscator([{ type: "plain", content: current }], "chat-key");
		const newOutput = JSON.stringify(obfuscateMessages(newRegistry, messages));
		expect(newOutput).toContain(previous);
		expect(newOutput).not.toContain(current);
		expect(newRegistry.deobfuscate(newOutput)).toContain(`${previous} ${current}`);
		expect(messages[0]!.content).toBe(`${previous} ${current}`);
	});
});

describe("SecretObfuscator probe gating", () => {
	it("redacts a case-insensitive unicode match whose probe only appears after lower-casing", () => {
		// U+212A KELVIN SIGN lower-cases to "k", and a `u`-flag case-insensitive
		// regex matches it, but a non-unicode `i` probe scan would not: the
		// probe gate must not skip this non-ASCII text.
		const obfuscator = new SecretObfuscator([
			{ type: "regex", content: "kelvin[0-9]{8}", flags: "iu", literalPrefixes: ["kelvin"] },
		]);
		const secret = "\u212Aelvin12345678";

		const output = obfuscator.obfuscate(`token ${secret} here`);

		expect(output).not.toContain(secret);
		expect(obfuscator.deobfuscate(output)).toBe(`token ${secret} here`);
	});

	it.each([
		{ content: "secret[0-9]{8}", probe: "secret", secret: "\u017Fecret12345678" },
		{ content: "\u017Fecret[0-9]{8}", probe: "\u017Fecret", secret: "secret12345678" },
		{ content: "\u03C3token[0-9]{8}", probe: "\u03C3token", secret: "\u03C2token12345678" },
	])(
		"redacts Unicode case equivalents for $probe without trusting lowercase equality",
		({ content, probe, secret }) => {
			const obfuscator = new SecretObfuscator(
				[{ type: "regex", content, flags: "iu", literalPrefixes: [probe] }],
				"unicode-probe-key",
			);
			const input = `token ${secret} here`;
			const output = obfuscator.obfuscate(input);
			expect(output).not.toContain(secret);
			expect(obfuscator.deobfuscate(output)).toBe(input);
		},
	);
});

describe("SecretObfuscator text that is only placeholders", () => {
	// "TOKABC123" is OTHERSECRET's friendly label and also the normalized form
	// of `tok_abc123`, which the regex protects.
	const entries: SecretEntry[] = [
		{ type: "plain", content: "OTHERSECRET", friendlyName: "TOKABC123" },
		{ type: "regex", content: "tok_[a-z0-9]+" },
	];

	it("leaves already-redacted text unchanged", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		expect(redacted).toMatch(/^use \$\$TOKABC123_[A-Z0-9]+:U\$\$ now$/);
		expect(obfuscator.obfuscate(redacted)).toBe(redacted);
	});

	it("still strips a friendly prefix that a shared collision value makes unsafe", () => {
		const obfuscator = new SecretObfuscator(entries);
		const output = obfuscator.obfuscate("see $$TOKABC123_OLDHASH:L$$ here", new SecretValueSet(["tok_abc123"]));
		expect(output).toBe("see $$OLDHASH:L$$ here");
	});

	it("drops removed shared collision values before reusing the placeholder-only path", () => {
		const obfuscator = new SecretObfuscator(entries);
		const input = "see $$TOKABC123_OLDHASH:L$$ here";
		const shared = new SecretValueSet(["tok_abc123"]);
		expect(obfuscator.obfuscate(input, shared)).toBe("see $$OLDHASH:L$$ here");
		shared.delete("tok_abc123");
		shared.add("other-value");
		expect(obfuscator.obfuscate(input, shared)).toBe(input);
		shared.add("tok_abc123");
		expect(obfuscator.obfuscate(input, shared)).toBe("see $$OLDHASH:L$$ here");
		shared.clear();
		expect(obfuscator.obfuscate(input, shared)).toBe(input);
	});

	it("still redacts a configured literal next to existing placeholders", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		const output = obfuscator.obfuscate(`${redacted} and OTHERSECRET again`);
		expect(output).not.toContain("OTHERSECRET");
	});

	it("still redacts a regex match next to existing placeholders", () => {
		const obfuscator = new SecretObfuscator(entries);
		const redacted = obfuscator.obfuscate("use OTHERSECRET now");
		const output = obfuscator.obfuscate(`${redacted} and tok_abcdef12`);
		expect(output).not.toContain("tok_abcdef12");
		expect(obfuscator.deobfuscate(output)).toBe("use OTHERSECRET now and tok_abcdef12");
	});
});

describe("SecretValueSet.collidesWithLabel", () => {
	function naive(values: ReadonlySet<string>, label: string): boolean {
		for (const value of values) {
			if (sanitizedLabelCollidesWithSecret(label, sanitizeForCollisionCheck(value))) return true;
		}
		return false;
	}

	it("tracks values sharing one normalized form across delete", () => {
		const values = new SecretValueSet(["ab-c", "ABC"]);
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ab-c");
		expect(values.collidesWithLabel("XABCX")).toBe(true);
		values.delete("ABC");
		expect(values.collidesWithLabel("XABCX")).toBe(false);
	});

	it("never matches values that normalize to nothing", () => {
		const values = new SecretValueSet(["---", "__"]);
		expect(values.collidesWithLabel("ANYLABEL")).toBe(false);
		expect(values.collidesWithLabel("")).toBe(false);
	});

	it("flags a display-capped label that is a prefix of a longer secret", () => {
		const secret = "A".repeat(20) + "B".repeat(20);
		const values = new SecretValueSet([secret]);
		expect(values.collidesWithLabel(secret.slice(0, 31))).toBe(false);
		expect(values.collidesWithLabel(secret.slice(0, 32))).toBe(true);
		expect(values.collidesWithLabel(secret.slice(0, 33))).toBe(true);
		expect(values.collidesWithLabel(`${secret.slice(0, 32)}Z`)).toBe(false);
	});

	it("matches the per-member check across random add, delete and clear", () => {
		let seed = 0x5eed;
		const random = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const alphabet = ["A", "B", "1", "_", "-", "a", "b"];
		const word = (length: number) =>
			Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");

		for (let round = 0; round < 500; round++) {
			const values = new SecretValueSet();
			const plain = new Set<string>();
			for (let step = 0; step < 12; step++) {
				const action = random();
				if (action < 0.6) {
					const value = word(Math.floor(random() * 45));
					values.add(value);
					plain.add(value);
				} else if (action < 0.9 && plain.size > 0) {
					const value = [...plain][Math.floor(random() * plain.size)]!;
					values.delete(value);
					plain.delete(value);
				} else if (action >= 0.97) {
					values.clear();
					plain.clear();
				}
				// Labels straddle the 32-char display cap where the prefix rule applies.
				const label = sanitizeForCollisionCheck(word(28 + Math.floor(random() * 10)));
				expect(values.collidesWithLabel(label)).toBe(naive(plain, label));
				const short = sanitizeForCollisionCheck(word(Math.floor(random() * 8)));
				expect(values.collidesWithLabel(short)).toBe(naive(plain, short));
			}
		}
	});
});
