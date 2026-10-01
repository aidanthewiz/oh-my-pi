Invoke an AWS CLI operation through the trusted native route.

Provide an explicit profile, service, operation, and structured parameters. Supply a region when the selected profile has no configured region. The route never uses a shell, a repository PATH, or ambient credentials.

Use AWS CLI operation names such as `get-caller-identity`, not managed MCP's Smithy PascalCase names.

On an authentication failure, the interactive runtime can offer one approved sign-in and retry the original operation once. Without an interactive surface, the tool returns an explicit login command instead. Do not add automatic sign-in loops. Use `service: "sso", operation: "login"` only for an explicitly requested sign-in.

Read calls are identified through AWS's public service authorization reference. Missing mappings and known stateful IAM reads, including SQS ReceiveMessage, require approval. Read-only queries can still incur charges.

Mutations require verified STS Account, ARN, Region, and partition in approval details. Identity changes after approval reject execution.
