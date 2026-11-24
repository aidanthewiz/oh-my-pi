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
- Cancellation covers service discovery as well as waiting. A pre-aborted call does not discover services or consume queued results; a retired session cannot attach a late subscription or update service ownership.
- Daemon/service discovery failures do not hide in-process results or erase the last known owned-service state. User cancellation and session invalidation still propagate.
- There is no caller-selectable timeout. Idle windows start at5s and use4m for consecutive idle waits; news or a60s gap resets the short window. Top-level interactive waits on owned jobs start at the longer window. Direct-reply waits can use a known prompt-cache lifetime minus a1m margin, bounded between4m and30m.
- With no owned job/service running, a direct reply requested during the current run can justify waiting only while its recipient can still answer. A direct response or accepted result from the original child/job can satisfy it; finished recipients, inline dependencies and waits on the caller's own result cannot justify an indefinite cycle.
- Reply accounting and dependency holds retain the initiating registry generation and transcript. Reused agent ids cannot inherit old questions or accepted-result credit.
- `agent://<id>?progress` is not an answer. After progress, only a direct reply satisfies the question; a broadcast can interrupt an active wait without satisfying it, and queued progress/broadcast chatter alone does not keep later waits alive.
- Otherwise returns immediately with “Nothing to wait for”, naming any agent asked that finished without replying or cannot reply before the caller finishes.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. A wake already queued before execution still lets `wait` drain its message or owned job instead of being skipped; host-owned notices inject at the next boundary after the normal wait result. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.
- A running subagent's row carries its latest progress, e.g. ``- `AcpSurface` [task] — <label> — 5h7m · 90 req · $18.40 · ctx 160K/1M · stage: <stage>``: run time, requests, cost, context fill, self-estimated completion and stage, whichever its progress record reports. Bash and eval rows, and task rows without a progress record, stay ``- `<id>` [<type>] — <label>``. `read proc://` and `read proc://<id>` show the same progress on running task rows.

## Related surfaces

- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; send empty `content`. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers from the main agent only. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
