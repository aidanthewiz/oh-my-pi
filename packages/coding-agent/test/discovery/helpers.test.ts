import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { expandEnvVarsDeepForConfigLevel } from "../../src/discovery/helpers";

describe("parseFrontmatter", () => {
	const parse = (content: string) => parseFrontmatter(content, { source: "tests:frontmatter", level: "off" });

	test("parses simple key-value pairs", () => {
		const content = `---
name: test
enabled: true
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({ name: "test", enabled: true });
		expect(result.body).toBe("Body content");
	});

	test("parses YAML list syntax", () => {
		const content = `---
tags:
  - javascript
  - typescript
  - react
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			tags: ["javascript", "typescript", "react"],
		});
		expect(result.body).toBe("Body content");
	});

	test("parses multi-line string values", () => {
		const content = `---
description: |
  This is a multi-line
  description block
  with several lines
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			description: "This is a multi-line\ndescription block\nwith several lines\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("parses nested objects", () => {
		const content = `---
config:
  server:
    port: 3000
    host: localhost
  database:
    name: mydb
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			config: {
				server: { port: 3000, host: "localhost" },
				database: { name: "mydb" },
			},
		});
		expect(result.body).toBe("Body content");
	});

	test("parses mixed complex YAML", () => {
		const content = `---
name: complex-test
version: 1.0.0
tags:
  - prod
  - critical
metadata:
  author: tester
  created: 2024-01-01
description: |
  Multi-line description
  with formatting
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			name: "complex-test",
			version: "1.0.0",
			tags: ["prod", "critical"],
			metadata: {
				author: "tester",
				created: "2024-01-01",
			},
			description: "Multi-line description\nwith formatting\n",
		});
		expect(result.body).toBe("Body content");
	});

	test("handles missing frontmatter", () => {
		const content = "Just body content";
		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Just body content");
	});

	test("handles invalid YAML in frontmatter", () => {
		const content = `---
invalid: [unclosed array
---
Body content`;

		const result = parse(content);
		// Simple fallback parser extracts key:value pairs it can parse
		expect(result.frontmatter).toEqual({ invalid: "[unclosed array" });
		// Body is still extracted even with invalid YAML
		expect(result.body).toBe("Body content");
	});

	test("handles empty frontmatter", () => {
		const content = `---
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({});
		expect(result.body).toBe("Body content");
	});

	test("normalizes kebab-case keys to camelCase", () => {
		const content = `---
thinking-level: medium
output-schema: json
nested-field:
  inner-key: value
---
Body content`;

		const result = parse(content);
		expect(result.frontmatter).toEqual({
			thinkingLevel: "medium",
			outputSchema: "json",
			nestedField: { innerKey: "value" },
		});
		expect(result.body).toBe("Body content");
	});
});

describe("configuration environment expansion", () => {
	test("keeps process credentials out of project-owned config", () => {
		const secretName = `OMP_TEST_CONFIG_SECRET_${crypto.randomUUID().replaceAll("-", "")}`;
		const previous = Bun.env[secretName];
		Bun.env[secretName] = "managed-test-secret";
		try {
			const input = {
				// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config placeholder under test
				home: "${HOME}",
				secret: `\${${secretName}}`,
			};
			expect(expandEnvVarsDeepForConfigLevel(input, "project")).toEqual({
				home: Bun.env.HOME ?? input.home,
				secret: `\${${secretName}}`,
			});
			expect(expandEnvVarsDeepForConfigLevel(input, "user").secret).toBe("managed-test-secret");
		} finally {
			if (previous === undefined) delete Bun.env[secretName];
			else Bun.env[secretName] = previous;
		}
	});

	test("normalizes allowlisted environment names for Windows-style casing", () => {
		const previousPath = Bun.env.PATH;
		const previousMixedPath = Bun.env.Path;
		delete Bun.env.PATH;
		Bun.env.Path = "C:\\Coreforge\\bin";
		try {
			// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config placeholders under test
			expect(expandEnvVarsDeepForConfigLevel({ upper: "${PATH}", mixed: "${Path}" }, "project")).toEqual({
				upper: "C:\\Coreforge\\bin",
				mixed: "C:\\Coreforge\\bin",
			});
		} finally {
			if (previousPath === undefined) delete Bun.env.PATH;
			else Bun.env.PATH = previousPath;
			if (previousMixedPath === undefined) delete Bun.env.Path;
			else Bun.env.Path = previousMixedPath;
		}
	});
});
