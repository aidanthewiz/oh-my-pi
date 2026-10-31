import assert from "node:assert/strict";
import path from "node:path";

function replaceOne(text: string, before: string, after: string): string {
	assert.equal(text.split(before).length, 2, `Expected one adaptation boundary: ${before}`);
	return text.replace(before, after);
}

function replaceBlock(text: string, start: string, end: string, replacement: string): string {
	const at = text.indexOf(start),
		until = text.indexOf(end, at);
	assert(at >= 0 && until >= at, `Missing adaptation block: ${start}`);
	assert.equal(text.indexOf(start, at + start.length), -1);
	return text.slice(0, at) + replacement + text.slice(until);
}

export function adaptFixture(id: string, raw: string, checkout: string): string {
	let text = raw;
	// These fixtures intentionally import after binding private HOME and transport guards.
	text = text.replace(
		/(["'])\.\.\/\.\.\/(packages\/[^"']+)\1/g,
		(_match, quote, relative) => quote + path.join(checkout, relative) + quote,
	);
	if (["auth", "auth-adjacent", "mcp"].includes(id)) {
		text = text.replace(
			/assert\.equal\(path\.dirname\(home\), ['"]\/private\/tmp['"]\);\s*assert(?:\.match\(path\.basename\(home\), \/\^cf-\[A-Za-z0-9\]\+\$\/\)|\(\/\^cf-\[A-Za-z0-9\]\+\$\/\.test\(path\.basename\(home\)\)\));/g,
			"assert(home.startsWith(process.env.CF_QUAL_WORK + path.sep));",
		);
		text = text.replace("path.resolve(import.meta.dirname, '../..')", JSON.stringify(checkout));
		const start = "async function unchanged()";
		text = replaceBlock(
			text,
			start,
			"await unchanged();",
			`async function unchanged() {
  assert.equal(manifest.engineHead, process.env.CF_QUAL_SOURCE_SHA);
  assert.equal(manifest.native.sha256, process.env.CF_QUAL_NATIVE_SHA256);
  assert.equal(createHash('sha256').update(await fs.readFile(process.env.CF_QUAL_NATIVE_PATH)).digest('hex'), manifest.native.sha256);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.records)).digest('hex'), manifest.sourceDigest);
  for (const relative of ${id === "auth" ? "criticalPaths" : id === "auth-adjacent" ? "critical" : "files"}) {
    const recorded = manifest.records.find(row => row.path === relative);
    assert(recorded && typeof recorded.sha256 === 'string');
    const sourceFile = path.join(engine, relative);
    if (process.env.PI_COMPILED === 'true') {
      assert.equal(process.env.CF_QUAL_SOURCE_DENIED, 'true');
      await assert.rejects(fs.readFile(sourceFile), { code: 'ENOENT' });
    } else {
      assert.equal(createHash('sha256').update(await fs.readFile(sourceFile)).digest('hex'), recorded.sha256, relative);
    }
  }
}
`,
		);
		text = text.replace("externalNetworkDeniedByParent: true", "externalFetchIntercepted: true");
	}
	if (id === "provider") {
		text = replaceOne(
			text,
			'assert.equal(binding.mode, mode); assert.equal(binding.version, "18.12.2");',
			"assert.equal(binding.mode, mode); assert.equal(binding.version, process.env.CF_QUAL_VERSION);",
		);
		text = replaceOne(
			text,
			'assert.equal(path.dirname(home), "/private/tmp"); assert(/^cf-[A-Za-z0-9]+$/.test(path.basename(home)));',
			"assert(home.startsWith(process.env.CF_QUAL_WORK! + path.sep));",
		);
		text = replaceOne(
			text,
			'assert.equal(binding.engineHead, "6f2e6a8de28f26ecd668da3f3f8e1edb9006963d"); assert.equal(binding.mergeHead, "1d5aff90b057ce7dbfe32ea557a527c1b3144b72");',
			"assert.equal(binding.engineHead, process.env.CF_QUAL_SOURCE_SHA); assert.equal(binding.mergeHead, null);",
		);
		text = replaceOne(
			text,
			"assert((await fs.realpath(process.env.PI_NATIVES_DIR!)).startsWith(home + path.sep));",
			"assert.equal(sha(await fs.readFile(process.env.CF_QUAL_NATIVE_PATH!)), binding.nativeSha256);",
		);
	}
	if (id === "broker") {
		text = replaceOne(text, "import { plugin } from 'bun';\n", "");
		text = replaceOne(
			text,
			"assert.equal(binding.version, '18.12.0');",
			"assert.equal(binding.version, process.env.CF_QUAL_VERSION);",
		);
		text = replaceBlock(
			text,
			"if (binding.variant === 'frozen-incoming') {",
			"const ai =",
			"assert.equal(binding.variant, 'current');\n\n",
		);
		text = text.replace(
			/import\(path\.join\(engine, '([^']+)'\)\)/g,
			(_match, relative) => `import(${JSON.stringify(path.join(checkout, relative))})`,
		);
		text = replaceOne(
			text,
			"['--no-env-file', import.meta.path, bindingFile, 'cli-child', config]",
			"[...(process.env.PI_COMPILED === 'true' ? [] : ['--no-env-file', import.meta.path]), bindingFile, 'cli-child', config]",
		);
	}
	if (id === "browser") {
		text = replaceOne(
			text,
			'from "puppeteer-core"',
			`from ${JSON.stringify(Bun.resolveSync("puppeteer-core", checkout))}`,
		);
		text = replaceOne(text, 'import { createReadStream, createWriteStream } from "node:fs";\n', "");
		text = replaceOne(text, 'import { StringDecoder } from "node:string_decoder";\n', "");
		text = replaceOne(text, 'import type { Readable, Writable } from "node:stream";\n', "");
		text = replaceBlock(
			text,
			"assert.equal(context.binding.version, '18.12.2');",
			"const { work,",
			"assert.equal(context.binding.version, process.env.CF_QUAL_VERSION);\nassert.equal(context.binding.engineHead, process.env.CF_QUAL_SOURCE_SHA);\n",
		);
		text = replaceOne(
			text,
			"assert.equal(context.browserHost.freshProfileVerified, true);",
			'assert.equal(await fs.stat(profile).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }), false);',
		);
		text = replaceBlock(
			text,
			" launch = context.browserHost;",
			" for (const scenario of scenarios) {",
			` browser = await bounded(puppeteer.launch({ executablePath: executable, userDataDir: profile,
  headless: true, pipe: true, defaultViewport: { width: 1000, height: 850 }, protocolTimeout: 5000,
  args: ['--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
 }), 15000, 'CI Chromium launch');
 const child = browser.process(); assert(child && child.pid);
 const spawnargs = child.spawnargs;
 assert(!spawnargs.some(arg => /no-sandbox|disable-setuid-sandbox|ignore-certificate-errors|allow-file-access|remote-debugging-port/i.test(arg)));
 assert(spawnargs.includes('--headless=new') || spawnargs.includes('--headless'));
 launch = { pid: child.pid, spawnfile: child.spawnfile, spawnargs, headless: true, nativeSandboxEnabled: true, freshProfileVerified: true };
 await retain('launch.json', JSON.stringify(launch, null, 2) + '\\n');
`,
		);
		text = replaceOne(
			text,
			'  if (browser) await bounded(browser.close(), 5000, "browser close");',
			`  if (browser) {
   const child = browser.process(); assert(child);
   const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()));
   await bounded(browser.close(), 5000, 'browser close');
   await bounded(exited, 5000, 'Chromium process exit');
   await fs.rm(profile, { recursive: true });
  }`,
		);
		text = replaceOne(
			text,
			'processAndProfileClosureAuthority: "host guardian verifies actual Chrome exit and private singleton metadata; fenced consumer never removes the profile"',
			"processExited: Boolean(browser), privateProfileRemoved: Boolean(browser)",
		);
	}
	assert(!text.includes("/private/tmp"));
	assert(!text.includes("/Users/"));
	assert(!text.includes("'../../packages/") && !text.includes('"../../packages/'));
	return text;
}
