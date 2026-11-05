const command = await Bun.stdin.text();
const argv = process.argv.slice(2);
const expected = [
	"--robot",
	"test",
	"--stdin",
	"--agent",
	"omp",
	"--dialect",
	"posix",
	"--format",
	"json",
	"--omp-bridge-output",
];
if (!Bun.deepEquals(argv, expected)) {
	console.log(JSON.stringify({ decision: "deny", rule_id: "fixture.argv", reason: "Invalid guard invocation" }));
	process.exit(1);
}
const decision = command.includes("smoke-guard-deny") ? "deny" : command.includes("smoke-guard-ask") ? "ask" : "allow";
console.log(JSON.stringify({ decision, rule_id: "fixture.aws-db", reason: "Synthetic database guard policy" }));
process.exit(decision === "allow" ? 0 : 1);
