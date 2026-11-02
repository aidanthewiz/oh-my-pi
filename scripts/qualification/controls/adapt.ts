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
		const puppeteerPath = Bun.resolveSync("puppeteer-core", checkout);
		boundPaths.push(puppeteerPath);
		text = replaceOne(text, 'from "puppeteer-core"', `from ${JSON.stringify(puppeteerPath)}`);
		text = replaceOne(
			text,
			'import { createReadStream, createWriteStream } from "node:fs";',
			'import { spawn, type ChildProcess } from "node:child_process";',
		);
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
 // Chromium pipe creation precedes CDP readiness.
 const child = browserChild = spawn(executable, spawnargs, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
 const ready = Promise.withResolvers<void>();
 void ready.promise.catch(() => undefined);
 browserExited = new Promise<void>(resolve => child.once('close', () => {
  ready.reject(new Error('Owned Chromium closed before CDP readiness'));
  resolve();
 }));
 child.once('error', error => ready.reject(error));
 child.stderr!.on('data', (chunk: Buffer) => { browserStderr = (browserStderr + chunk.toString()).slice(-65536); });
 launch = { pid: child.pid, spawnfile: child.spawnfile, spawnargs: child.spawnargs, headless: true, nativeSandboxEnabled: true, freshProfileVerified: true };
 const writer = child.stdio[3] as Writable, reader = child.stdio[4] as Readable;
 const decoder = new StringDecoder('utf8');
 let pending = "", closed = false, startupComplete = false, notifiedClosed = false;
 let receive: ((message: string) => void) | undefined;
 const inbox: string[] = [];
 const transport: { send(message: string): void; close(): void; onmessage?: (message: string) => void; onclose?: () => void } = {
  send(message) { assert(!closed && !notifiedClosed, 'Owned CDP transport is closed'); writer.write(message + '\\0'); },
  close() { if (closed) return; closed = true; writer.end(); reader.destroy(); },
  get onmessage() { return receive; },
  set onmessage(callback: ((message: string) => void) | undefined) {
   receive = callback;
   if (callback) for (const message of inbox.splice(0)) callback(message);
  },
 };
 closeTransport = () => transport.close();
 const disconnected = () => {
  if (notifiedClosed) return;
  notifiedClosed = true;
  ready.reject(new Error('Owned Chromium CDP pipe closed before readiness'));
  transport.onclose?.();
 };
 reader.on('data', (chunk: Buffer) => {
  pending += decoder.write(chunk);
  let boundary;
  while ((boundary = pending.indexOf('\\0')) !== -1) {
   const message = pending.slice(0, boundary); pending = pending.slice(boundary + 1);
   if (!startupComplete) {
    try {
     const response = JSON.parse(message);
     if (response.id === 0) {
      if (response.error) ready.reject(new Error(JSON.stringify(response.error)));
      else { assert.equal(typeof response.result?.product, 'string'); startupComplete = true; ready.resolve(); }
      continue;
     }
    } catch (error) { ready.reject(error); return; }
   }
   if (receive) receive(message); else inbox.push(message);
  }
 });
 reader.on('close', disconnected);
 reader.on('end', disconnected);
 reader.on('error', error => { ready.reject(error); disconnected(); });
 writer.on('error', error => { ready.reject(error); disconnected(); });
 browser = await bounded((async () => {
  await retain('launch.json', JSON.stringify(launch, null, 2) + '\\n');
  transport.send(JSON.stringify({ id: 0, method: 'Browser.getVersion' }));
  await ready.promise;
  return await puppeteer.connect({ transport, defaultViewport: { width: 1000, height: 850 }, protocolTimeout: 5000 });
 })(), 15000, 'CI Chromium launch');
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
 finally { closeTransport?.(); server.stop(true); }
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
