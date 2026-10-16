# aws

> Run an AWS CLI operation through Coreforge's trusted native route. Use this tool for GovCloud and other partitions the managed AWS MCP endpoint cannot reach.

## Source

- Entry: `packages/coding-agent/src/tools/aws.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/aws.md`
- Managed commercial alternative: `packages/coding-agent/src/mcp/tool-bridge.ts`

## Inputs

| Field        | Type                      | Required          | Description                                                                                                                             |
| ------------ | ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`    | `string`                  | Yes               | Explicit employee AWS profile from the local catalog. The managed `coreforge` identity is excluded.                                     |
| `service`    | `string`                  | Yes               | AWS CLI service name, such as `sts` or `rds`.                                                                                           |
| `operation`  | `string`                  | Yes               | AWS CLI command name, such as `get-caller-identity` or `describe-db-clusters`. Do not use MCP's PascalCase names.                       |
| `region`     | `string`                  | If not configured | Region for this call. It must match the selected profile's partition.                                                                   |
| `parameters` | `Record<string, unknown>` | No                | Operation parameters encoded as CLI flags; use JSON values. Profile, region, endpoint, and CLI control flags cannot be overridden here. |
| `timeout`    | `number`                  | No                | Request timeout in seconds, subject to the tool's configured limit.                                                                     |

For example, `{"profile":"employee-gov","service":"sts","operation":"get-caller-identity","region":"us-gov-west-1"}` identifies the selected caller without changing cloud state.

## Operation

1. The launcher captures a trusted AWS CLI executable and profile file paths. Discovery reads profile metadata, not credentials or remote STS identity.
2. The tool validates the explicit profile, Region, partition, parameters, and credential-process path. It runs the executable directly with a minimal environment and temporary configuration. Generic Bash does not inherit operational AWS credentials.
3. Destructive Command Guard applies to every call. Mutations and unclassified operations require verified STS account, ARN, Region, and partition checks. A changed identity after approval stops execution.
4. Ordinary approvals offer **Deny**, approval for one call, or **Allow for the rest of this session**. The session grant covers later native AWS operations and profiles, including SSO renewal. It remains in memory, survives tool reconstruction within that session, and does not apply to another session or managed MCP commands.
5. Session approval never overrides explicit tool-policy denies, mandatory per-command Destructive Command Guard asks or denies, identity checks, or provider safety checks. Guard asks still require approval for the exact command and cannot grant session access.
6. When SSO credentials expire, an interactive session can renew authentication and retry the operation once. Native and managed MCP calls share pending sign-ins for the same SSO group. Each call has one automatic recovery budget across identity checks, operation retries, and managed reconnects.
7. A declined or failed sign-in pauses automatic recovery for that SSO group. A user-requested `sso login` can retry after a decline, failure, or earlier successful sign-in. A pending sign-in prevents duplicate login processes. Without an interactive surface, the tool returns an explicit login command.

The session grant removes ordinary command consent prompts; it does not authenticate to AWS. The user must still complete browser SSO authentication when required. Grants are not saved to configuration or restored in a new process.

ECS `execute-command` and SSM `start-session` require the Session Manager plugin.
Install `session-manager-plugin` on your employee PATH, then restart Coreforge.
The launcher captures its absolute path before adding repository tools.
Each session call exposes only that helper through a private temporary PATH.
The native route does not inherit the repository PATH or ambient credentials.

## Results and limits

The result includes redacted AWS output, profile, operation, Region, exit code, and failure code.
Output and artifacts are capped at 1 MiB. Invalid or truncated JSON is withheld.
Session commands preserve redacted terminal text instead of requiring JSON.

This route uses the employee's IAM permissions and AWS audit logs.
Direct CLI calls do not carry MCP-specific IAM condition keys.
Do not put secrets in `parameters` or rely on output redaction as a credential store.

The managed AWS Agent Toolkit is a separate route for compatible commercial profiles. It discovers knowledge tools without signing in, then requires `aws_profile` and opens a signed connection on the first authenticated call. Use the native `aws` tool for GovCloud, other partitions, or when managed MCP is unavailable.
