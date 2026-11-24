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
	const boundPaths = [checkout];
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
	if (id === "mcp") {
		const oldHttpPath = "packages/coding-agent/src/mcp/transports/http.ts";
		assert.equal(text.split(oldHttpPath).length, 3);
		text = text.replaceAll(oldHttpPath, "packages/coding-agent/src/mcp/host/http-upstream.ts");
		text = replaceOne(text, "const { HttpTransport } =", "const { HttpUpstream } =");
		text = replaceOne(
			text,
			"new HttpTransport(config)",
			"new HttpUpstream({ transport: 'http', url: config.url, headers: {}, timeoutMs: config.timeout }, 'legacy')",
		);
		text = replaceOne(
			text,
			"real HttpTransport/client/MCPTool serialization and retry code",
			"real HttpUpstream legacy binding/client/MCPTool serialization and retry code",
		);
	}
	if (id === "stream") {
		text = replaceOne(
			text,
			"o/run/daemons/0000000000000000/stream.sock",
			"o/run/daemon/streams/0000000000000000/stream.sock",
		);
		text = replaceOne(text, "setAgentDir, getDaemonRuntimeDir", "setAgentDir, getDaemonDir");
		text = replaceOne(
			text,
			'path.join(getDaemonRuntimeDir(await fs.realpath(cwd)), "stream.sock")',
			'path.join(getDaemonDir(), "streams", Bun.hash.wyhash(await fs.realpath(cwd)).toString(16).padStart(16, "0"), "stream.sock")',
		);
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
		text = replaceOne(
			text,
			"  await runAuthBrokerCommand({ action: 'serve', flags: { bind: '127.0.0.1:0' } });",
			"  utils.postmortem.installProcessHandlers();\n  await runAuthBrokerCommand({ action: 'serve', flags: { bind: '127.0.0.1:0' } });",
		);
	}
	if (id === "browser") {
		const puppeteerPath = Bun.resolveSync("puppeteer-core", checkout);
		boundPaths.push(puppeteerPath);
		text = replaceOne(text, 'from "puppeteer-core"', `from ${JSON.stringify(puppeteerPath)}`);
		text = replaceOne(
			text,
			'import { createReadStream, createWriteStream } from "node:fs";',
			`import { spawn, type ChildProcess } from "node:child_process";
import { createQualificationBrowserPipe } from ${JSON.stringify(path.join(checkout, "scripts/qualification/controls/browser-pipe.ts"))};
import { BROWSER_PROTOCOL_TIMEOUT_MS } from ${JSON.stringify(path.join(checkout, "packages/coding-agent/src/tools/browser/launch.ts"))};`,
		);
		text = replaceOne(text, 'import { StringDecoder } from "node:string_decoder";\n', "");
		text = replaceOne(
			text,
			"let browser: Browser | undefined;",
			`let browser: Browser | undefined;
let browserChild: ChildProcess | undefined;
let browserExited: Promise<void> | undefined;
let closeTransport: (() => void) | undefined;
let browserStderr = "";`,
		);
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
			` const spawnargs = await puppeteer.defaultArgs({ userDataDir: profile, headless: true,
  args: ['--remote-debugging-pipe', '--disable-background-networking', '--disable-component-update', '--disable-default-apps', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
 });
 assert(!spawnargs.some(arg => /no-sandbox|disable-setuid-sandbox|ignore-certificate-errors|allow-file-access|remote-debugging-port/i.test(arg)));
 assert(spawnargs.includes('--headless=new') || spawnargs.includes('--headless'));
 assert(spawnargs.includes(\`--user-data-dir=\${profile}\`));
 const child = browserChild = spawn(executable, spawnargs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
 child.stderr!.on('data', (chunk: Buffer) => { browserStderr = (browserStderr + chunk.toString()).slice(-65536); });
 launch = { pid: child.pid, spawnfile: child.spawnfile, spawnargs: child.spawnargs, headless: true, nativeSandboxEnabled: true, freshProfileVerified: true };
 const pipe = createQualificationBrowserPipe(child.stdio[3] as Writable, child.stdio[4] as Readable);
 closeTransport = () => pipe.transport.close();
 const exited = Promise.withResolvers<void>();
 browserExited = exited.promise;
 child.once('close', (code, signal) => {
  pipe.fail(new Error(\`Owned Chromium exited (code=\${code}, signal=\${signal})\`));
  exited.resolve();
 });
 child.once('error', error => pipe.fail(error));
 await retain('launch.json', JSON.stringify(launch, null, 2) + '\\n');
 await pipe.waitUntilReady(BROWSER_PROTOCOL_TIMEOUT_MS);
 browser = await puppeteer.connect({ transport: pipe.transport, defaultViewport: { width: 1000, height: 850 }, protocolTimeout: 5000 });
 await retain('browser-process.json', JSON.stringify(launch, null, 2) + '\\n');
`,
		);
		text = replaceBlock(
			text,
			"finally {\n try {\n  if (browser)",
			"const report =",
			`finally {
 let browserCloseCompleted = false, processExited = false, privateProfileRemoved = false;
 const cleanupErrors: unknown[] = [];
 try {
  if (browser) { await bounded(browser.close(), 5000, 'browser close'); browserCloseCompleted = true; }
 } catch (error) { fatal ??= serializeError(error); cleanupErrors.push(serializeError(error)); }
 closeTransport?.();
 try {
  if (browserChild && browserExited) {
   if (browserChild.exitCode === null && browserChild.signalCode === null) browserChild.kill('SIGTERM');
   try { await bounded(browserExited, 5000, 'Chromium process exit'); }
   catch { browserChild.kill('SIGKILL'); await bounded(browserExited, 5000, 'Chromium forced process exit'); }
   processExited = true;
   assert.equal(await fs.readFile(path.join(work, '.owner'), 'utf8'), owner);
   await fs.rm(profile, { recursive: true, force: true });
   assert.equal(await fs.stat(profile).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; }), false);
   privateProfileRemoved = true;
  }
 } catch (error) { fatal ??= serializeError(error); cleanupErrors.push(serializeError(error)); }
 finally { server.stop(true); }
 cleanup = { browserCloseCompleted, fixtureServerStopped: true, processExited, privateProfileRemoved, cleanupErrors };
 await retain('chromium-stderr.txt', browserStderr);
}
`,
		);
	}
	let unboundText = text;
	for (const bound of boundPaths) unboundText = unboundText.replaceAll(bound, "<bound-path>");
	assert(!unboundText.includes("/private/tmp"));
	assert(!unboundText.includes("/Users/"));
	assert(!text.includes("'../../packages/") && !text.includes('"../../packages/'));
	return text;
}
