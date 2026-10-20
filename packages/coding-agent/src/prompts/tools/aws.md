Invoke an AWS CLI operation through the trusted native route.

Provide an explicit profile, service, operation, and structured parameters. Supply a region when the selected profile has no configured region. The route never uses a shell, a repository PATH, or ambient credentials.

Use AWS CLI operation names such as `get-caller-identity`, not managed MCP's Smithy PascalCase names.

On an authentication failure, the interactive runtime can offer one approved sign-in and retry the original operation once. Later credential expiry can renew authentication again. A declined or failed sign-in pauses automatic recovery for that SSO group. Without an interactive surface, the tool returns an explicit login command. Do not add automatic sign-in loops. Use `service: "sso", operation: "login"` only for a user-requested sign-in, including retries after an earlier decline, failure, or completed login.

Read calls are identified through AWS's public service authorization reference. Missing mappings and known stateful IAM reads, including SQS consumption, workload invocation, and credential issuance, require approval. Read-only queries can still incur charges.

Ordinary approval offers **Allow for the rest of this session** alongside one-call approval and denial. This explicit grant covers later native AWS commands and profiles, not other sessions or managed MCP command approvals. It is not persisted. Do not infer a grant from an earlier one-call approval. Browser SSO authentication still requires the user when necessary.

Mutations require verified STS Account, ARN, Region, and partition checks even with session approval. Identity changes after approval reject execution. Explicit tool-policy denies, mandatory per-command Destructive Command Guard asks or denies, and provider safety checks remain enforced.
