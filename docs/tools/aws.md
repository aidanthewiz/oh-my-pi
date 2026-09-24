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
3. Destructive Command Guard applies to every call. Operations outside the explicit read-only allowlist require mutation approval and a verified STS account, ARN, Region, and partition. A changed identity after approval stops execution.
4. When an SSO session has expired, an interactive session can offer one approved sign-in and retry. A noninteractive session returns an explicit login command. An explicit `sso login` call also requires approval.

## Results and limits

The response includes redacted AWS output and details such as profile, service, operation, Region, exit code, and failure code. Large output is capped at 1 MiB and may be available as an output artifact. Authentication, access denial, wrong partition, and unavailable profile have distinct errors. This route uses the employee's IAM permissions and AWS audit logs; MCP-specific IAM condition keys do not apply to direct CLI calls. Do not put secrets in `parameters` or rely on output redaction as a credential store.

The managed AWS Agent Toolkit is a separate route for compatible commercial profiles. It discovers knowledge tools without signing in, then requires `aws_profile` and opens a signed connection on the first authenticated call. Use the native `aws` tool for GovCloud, other partitions, or when managed MCP is unavailable.
