import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.HOME ?? process.env.USERPROFILE!;
const argv = process.argv.slice(2);
if (argv.includes("--fixture-child")) {
	writeFileSync(join(root, "descendant.pid"), String(process.pid));
	setInterval(() => {}, 1000);
} else if (argv.includes("--stdin")) {
	const command = await Bun.stdin.text();
	appendFileSync(join(root, "dcg.calls"), `${command}\n`);
	const decision = command.includes("delete-bucket")
		? "deny"
		: command.includes("terminate-instances")
			? "ask"
			: "allow";
	console.log(JSON.stringify({ decision, rule_id: "fixture.aws", reason: "fixture guard policy" }));
	process.exitCode = decision === "allow" ? 0 : 1;
} else {
	const profile = argv[argv.indexOf("--profile") + 1];
	const region = argv[argv.indexOf("--region") + 1];
	const offset = argv[0]?.startsWith("-") ? argv.indexOf("--region") + 2 : 0;
	const service = argv[offset];
	const operation = argv[offset + 1];
	const group = profile.replace(/-peer$/, "");
	const token = join(root, `authenticated-${group}`);
	appendFileSync(
		join(root, "aws.calls"),
		`${JSON.stringify({ argv, env: process.env, cwd: process.cwd(), pid: process.pid })}\n`,
	);
	if (service === "sso" && operation === "login") {
		if (profile === "failed-login") {
			console.error("SSO login failed");
			process.exitCode = 254;
		} else {
			if (profile === "automatic") {
				console.log("Open https://fixture.invalid/device and enter FAKE-CODE");
				const deadline = Date.now() + 5000;
				while (!existsSync(join(root, "device-instructions-shown"))) {
					if (Date.now() >= deadline)
						throw new Error("Device instructions were not shown before login completion");
					await Bun.sleep(10);
				}
			}
			if (profile === "mutating-changed") writeFileSync(join(root, "changed-identity"), "yes");
			writeFileSync(token, "yes");
			console.log("Login complete");
		}
	} else if (
		profile === "still-expired" ||
		(profile === "mutation-reexpires" && service !== "sts") ||
		(profile === "mutating-changed" && existsSync(join(root, "expire-mutation")) && !existsSync(token)) ||
		((profile.startsWith("expired") ||
			[
				"automatic",
				"parallel",
				"parallel-peer",
				"failed-login",
				"firstuse-declined",
				"government-expired",
				"mutating-expired",
				"mutation-reexpires",
			].includes(profile)) &&
			!existsSync(token))
	) {
		console.error("SSO token expired; login required");
		process.exitCode = 254;
	} else if (service === "configure" && operation === "export-credentials") {
		console.log(
			JSON.stringify({
				Version: 1,
				AccessKeyId: "fixture-model-access",
				SecretAccessKey: "fixture-model-secret",
				SessionToken: "fixture-model-token",
				Expiration: "2099-01-01T00:00:00Z",
			}),
		);
	} else if (service === "sts") {
		const account = existsSync(join(root, "changed-identity")) ? "999999999999" : "123456789012";
		const partition = profile === "mismatched" || region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
		console.log(
			JSON.stringify({ Account: account, Arn: `arn:${partition}:iam::${account}:user/fixture`, UserId: "fixture" }),
		);
	} else if (
		(service === "ecs" && operation === "execute-command") ||
		(service === "ssm" && operation === "start-session")
	) {
		const helper = Bun.spawnSync(["session-manager-plugin", "--version"], { env: process.env });
		if (helper.exitCode !== 0 || helper.stdout.toString().trim() !== Bun.version) {
			console.error("SessionManagerPlugin is not found or the wrong executable was selected");
			process.exitCode = 1;
		} else {
			console.log("Starting session with SessionId: fixture");
			console.log("REMOTE_COMMAND_OK");
			console.log("SessionToken: fixture-token");
		}
	} else if (argv.includes("--prefix=hang")) {
		Bun.spawn(
			process.platform === "win32"
				? [process.execPath, "--fixture-child"]
				: [process.execPath, process.argv[1]!, "--fixture-child"],
			{ env: process.env, stdout: "inherit", stderr: "inherit" },
		);
		setInterval(() => {}, 1000);
	} else if (argv.includes("--prefix=malformed-json")) {
		console.log('{"SecretString":"fixture-secret-compound","partial":');
	} else if (argv.includes("--prefix=prefixed-json")) {
		console.log('notice: {"SecretString":"fixture-secret-compound","partial":');
	} else if (argv.includes("--prefix=truncated-json")) {
		console.log(`{"SecretString":"fixture-secret-compound","rows":"${"x".repeat(1024 * 1024)}"}`);
	} else {
		console.log(
			JSON.stringify({
				profile,
				region,
				operation,
				SecretAccessKey: "fixture-secret",
				SessionToken: "fixture-token",
				rows: argv.includes("--prefix=large") ? "x".repeat(100_000) : "ok",
			}),
		);
	}
}
