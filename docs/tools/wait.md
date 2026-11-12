# wait

> Block until the next background result, peer message, or steering interrupt when there is no other work to do.

## Source

- Entry: `packages/coding-agent/src/tools/wait.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wait.md`
- Job delivery: `packages/coding-agent/src/async/job-manager.ts`

## Input and availability

`wait` has no arguments. It is an essential, read-approved, interruptible tool available when async jobs, peer messaging, or supervised services are enabled; it does not select a particular peer or job.

## Behavior

- Returns on the first settled caller-owned job or incoming peer message. Job results delivered by this call are consumed so no duplicate async-result follows.
- Each settled job's `Delivery:` line distinguishes four cases: already consumed by an earlier call; delivered by this call (the job was not settled when the call began); handed over by this snapshot, which superseded the job's queued completion push so no duplicate result follows; and a genuinely late result, which keeps the "not auto-delivered" wording and adds how long before the call it had finished. Entry state comes from `settledJobIds()` (membership, not a timestamp comparison), and `JobSnapshot.settledAtMs` carries the finish time.
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- Interruption and cancellation cover service discovery as well as the blocked wait. Already-aborted calls do not discover services or consume queued results.
- Cancelled, switched, or disposed discovery cannot attach a later broker subscription or update service ownership. Pending completions remain available when the owning session resumes.
- Broker failures do not hide in-process job results or erase the last known owned-service state. User cancellation and session invalidation still propagate.
- There is no caller-selectable timeout. With nothing new, a wait returns a still-running snapshot (`useless`) after a window that climbs 5s → 10s → 30s → 1m → 5m across consecutive idle waits. News or a 60-second gap resets it to 5s. From the 10-second window, elapsed waits append a `<system-notice>` reporting idle time and directing the agent to continue independent work.
- With no owned job or service running, `wait` can block for a direct reply requested during the caller's current run. The recipient must still be able to answer. An explicit reply or an accepted result from the original child/job can satisfy it. A finished recipient, a recipient blocked on the caller's result, or a recipient waiting on the user cannot justify indefinite waiting. Inline task dependencies and untimed eval-handle waits participate in cycle detection.
- Reply accounting and dependency holds retain their initiating registry generation and transcript. Accepted results must retain their original child and parent identities. Reusing an agent id cannot inherit an old question or dependency.
- A `?progress` message from an agent asked is not its answer: it ends the current wait like any message, but a later `wait` keeps blocking for that agent while it is still live (even idle), and from then on only an explicit message answers — not a settled job of the turn that sent the progress.
- Otherwise returns immediately with “Nothing to wait for”, naming any agent asked that finished without replying or cannot reply before the caller finishes.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. A wake already queued before execution still lets `wait` drain its message or owned job instead of being skipped; host-owned notices inject at the next boundary after the normal wait result. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.
- A running subagent's row carries its latest progress, e.g. ``- `AcpSurface` [task] — <label> — 5h7m · 90 req · $18.40 · ctx 160K/1M · stage: <stage>``: run time, requests, cost, context fill, self-estimated completion and stage, whichever its progress record reports. Bash and eval rows, and task rows without a progress record, stay ``- `<id>` [<type>] — <label>``. `read proc://` and `read proc://<id>` show the same progress on running task rows.

## Related surfaces

- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers from the main agent only. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
