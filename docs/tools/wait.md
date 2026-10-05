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
- A steering/tool interrupt returns `Wait interrupted by message.` with `details.interrupted=true`; other aborts propagate. Handle the incoming notice before calling `wait` again.
- Interruption and cancellation cover service discovery as well as the blocked wait. Already-aborted calls do not discover services or consume queued results.
- Cancelled, switched, or disposed discovery cannot attach a later broker subscription or update service ownership. Pending completions remain available when the owning session resumes.
- Broker failures do not hide in-process job results or erase the last known owned-service state. User cancellation and session invalidation still propagate.
- An owned-job or owned-service wait has a 30-minute safety cap. There is no caller-selectable timeout.
- Without a queued message or an owned job/service, reports a “Nothing to wait for” error. A running peer alone does not sustain a wait.
- With no owned jobs, a service finishing returns a notice directing the caller to `proc://` for status/output; with jobs, the call returns their current snapshot/result instead.
- Results and peer messages also auto-deliver without calling `wait`. Continue useful work instead of polling.
- Queued peer messages are checked first. Already-settled but undelivered owned jobs are returned without another wait. If a peer message wins a race with job completion, that job remains eligible for normal async delivery.
- Job waits emit progress snapshots every 500 ms when an update callback is present. Job results/snapshots use `details: { op: "wait", jobs: ... }`; peer-message results use the messaging result shape.

## Related surfaces
- `read proc://` lists caller-visible jobs and project services; `read proc://<id>` inspects state/output without consuming delivery.
- `write proc://<id>/kill` cancels a job or owned subagent, or stops a service; no `content` needed. Bare `proc://<id>` writes send stdin only to a service, including empty input.
- `write agent://<id>` sends a peer message; `agent://all` broadcasts to visible live peers. Bare `read history://` discovers registered agent transcripts. The final result of a subagent is delivered to its parent automatically.
- Start supervised services with `bash` `name` and optional `ready`; inspect and control them through `proc://`.
