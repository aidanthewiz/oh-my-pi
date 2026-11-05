Inspect one approved automation template through an isolated memory-only native AWS database scope.

Read `xd://aws_db/schema` first. It returns the full immutable JSON envelope `{"name":"aws_db","inputSchema":<actual registered schema>}`. Parse the actual model-visible Read result and compare the entire registered input schema before writing `{"action":"capabilities"}` to `xd://aws_db`. Do not substitute a manifest-derived descriptor or fallback schema.

Outer host output limits still apply. If the model-visible schema is incomplete, truncated, or spilled, stop preflight before any capability call or write. Do not use a fallback.

The root `xd://aws_db` TypeScript display is human documentation, not the full JSON Schema. Use the exact `xd://aws_db/schema` topic for executable discovery.

The capability call performs no profile lookup, credential resolution, authentication, access approval, or service request. Verify the entire compatible capability manifest and digest before authentication or inspection approval.

The loaded host must prove its actual dispatcher cleanup support, non-null session identity, early disposal, and session-change invalidation. A matching worker module alone is insufficient. Older embedding hosts fail before approval or provider work.

The capability pins actual loaded partition-specific Amazon RDS TLS trust and qualified regions. Unknown or uncovered regions fail before approval or provider work. No ambient or caller-selected CA is accepted.

`inspect-automation-template` requires the exact capability, explicit launcher-configured profile, exact expected identity/resource/version binding, distinct agency ID, automation ID, step ID, and bounded limits. Native approval applies to this exact immutable read only. Session grants do not replace that approval. Every internal AWS step retains native tool policy and command guards.

The operation supports explicit static credentials and an existing unexpired SSO token. It never signs in, refreshes tokens, assumes roles, executes credential_process, uses ambient credential chains, or retries. Unsupported profiles fail closed.

The scope verifies identity, resource tags, exact Aurora MySQL reader node, credential-resource version, and database binding. It reads only the stored `automation_steps.query_text` definition through its fixed policy. It never executes the saved template. It returns validated generic structure or withholds unsupported syntax. Secret material, raw definitions, causes, and driver diagnostics never enter tool output.

No credential files, capturePath, shell AWS fallback, arbitrary SQL, custom endpoint, or sanitizer callback exist. Source delivery does not publish the runtime, update an installed skill, authorize production access, or collect SRI-704 evidence. Owned references and processes are released; GC copies, SDK/driver buffers, privileged OS access, swap, and crash memory prevent secure-erasure guarantees.
