import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = process.env.HOME ?? process.env.USERPROFILE!;
const mode = process.argv[2] ?? "fixture-complete";
const stdinClosed = Promise.withResolvers<void>();
process.stdin.once("end", stdinClosed.resolve);
process.stdin.resume();

if (mode === "--fixture-child") {
	await Bun.write(path.join(root, "session-helper-descendant.pid"), String(process.pid));
	setInterval(() => {}, 1000);
	await Promise.withResolvers<void>().promise;
}

await fs.appendFile(path.join(root, "session-helper.calls"), `${JSON.stringify({ mode, pid: process.pid })}\n`);
await Bun.write(path.join(root, "session-helper.pid"), String(process.pid));
const inputState = await Promise.race([
	stdinClosed.promise.then(() => "closed" as const),
	Bun.sleep(120).then(() => "open" as const),
]);
if (inputState === "closed") {
	console.log("Cannot perform start session: EOF");
	process.exit(0);
}

if (mode === "fixture-hang") {
	Bun.spawn(
		process.platform === "win32"
			? [process.execPath, "--fixture-child"]
			: [process.execPath, process.argv[1]!, "--fixture-child"],
		{ env: process.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" },
	);
}
await Bun.write(path.join(root, "session-helper.started"), JSON.stringify({ mode, pid: process.pid }));
if (mode === "fixture-hang") {
	await stdinClosed.promise;
	console.log("Cannot perform start session: EOF");
	process.exit(0);
}
if (mode === "fixture-fail") {
	console.error("fixture helper failure");
	process.exit(23);
}
if (mode === "fixture-zero-error") {
	console.log("Cannot perform start session: fixture helper failure");
	process.exit(0);
}

const completion = await Promise.race([
	stdinClosed.promise.then(() => "closed" as const),
	Bun.sleep(120).then(() => "remote-complete" as const),
]);
if (completion === "closed") {
	console.log("Cannot perform start session: EOF");
	process.exit(0);
}
console.log("Starting session with SessionId: fixture");
if (mode === "fixture-remote-diagnostic") {
	console.log("Cannot perform start session: historical application log entry");
}
console.log("REMOTE_COMMAND_OK");
console.log("SessionToken: fixture-token");
process.exit(0);
