# Copilot and Teams parity validation

Baseline: `deepseek-ai/dsh-superagent-prototype` commit
`6337fc823ce20251c8de8085948165c81aaa701e`. The shared domain engine and original
prompt sources remain unchanged. This extension adapts the execution, identity,
consent and conversation boundaries to Copilot SDK 1.0.28 / CLI 1.0.105 and
Microsoft Graph delegated Teams access.

## Review repairs

The original review used twelve confirmed findings plus an unresolved local
model-routing authorization gate. Numbers below preserve that review's IDs.

| ID | Result | Regression evidence |
| --- | --- | --- |
| 1 | Own-PR discovery checkpoints five-page batches; discovery errors leave tracked PR/CI supervision available. | `sources.test.ts`: large own-PR history; host discovery cursor and separate error boundary. |
| 2 (gate) | Model-tool routing requires an unconditional native modal confirmation showing the exact request and ticket; cancellation is checked again before authority is created. | `extension.test.ts`: decline, cancellation and exact approved request. |
| 3 | Active corrections use native immediate input on the same session. Acceptance and consumption are distinct, correlated events. | `orchestration.test.ts`: active correction; real offline CLI acceptance/consumption and root continuation. |
| 4 | Setup, lookup, resume, abort, disconnect, delete and shutdown RPCs are bounded; late setup cannot send work. | `copilot.test.ts`: pending lookup/create cancellation; real WebSocket abort and handoff fixtures. |
| 5 | Router can read paginated existing work and attach an explicitly referenced trigger to an authorized existing or completed ticket. Stopped/revoked tickets remain protected. | `orchestration.test.ts`: cross-conversation attachment, stopped-ticket rejection, status and notes. |
| 6 | Pending tools and every actual inference request revalidate the mandate against live exact provider namespaces. | `orchestration.test.ts`: namespace removal; `model-requests.test.ts`: revoked owners and unknown child rejection. |
| 7 | Transcript byte budgets protect control writes; authoritative records use immutable checksummed chunks beyond the old 16-MiB ceiling. | `runtime.test.ts`: escaped/multibyte transcripts, stop, >16-MiB reopen, receipt retention, corrupt archive preservation and partial-write recovery. |
| 8 | Production prompt assembly includes runtime/execution migration and packaged skills; inaccessible DSH identity/loader instructions are replaced at build time. | `orchestration.test.ts`: assembled execution prompt; package inspection. |
| 9 | `orchestrator_report` accepts documented `pr_number: null`. | `orchestration.test.ts`: actual tool schema and no-PR invocation. |
| 10 | Same-conversation outbox delivery preserves enqueue order while independent conversations remain runnable. | `orchestration.test.ts`: blocked acknowledgement holds later result. |
| 11 | A draft submits the revision at which editing began; newer snapshots cannot silently overwrite another policy revision. | `panel.test.ts`: execute real panel script with a newer snapshot. |
| 12 | Navigation and rejected saves retain drafts; only a matching successful save acknowledges them. | `panel.test.ts`: navigation, failure, unmatched and matching acknowledgements. |
| 13 | Native and automated PR references share the canonical provider namespace and numeric PR ID; exact legacy bindings migrate atomically. | `runtime.test.ts`: migration, matching and close/merge. |

## Original runtime capabilities

- Normal worker capacity plus one configurable human-continuation overflow;
  waiting human continuations are scheduled before new launches.
- Persistent ticket/worktree/session identity, crash recovery, source follow-ups,
  inline review context, CI, owned-PR discovery and close/merge readback.
- Router attachment, status wakeups, context-only notes and stop-only judgment of
  messages already owned by workers. Worker acknowledgements preserve domain
  ownership and prevent completed work being routed again.
- Live input steering and per-inference current instructions for root and native
  child agents, over completions, Responses and WebSocket transports. SDK prompt
  transforms are cached and cannot provide this guarantee alone.
- Attached native background work stays leased until truly quiet; child
  completion wakes the root. A thirty-minute bound prevents an abandoned lease.
- Completion/handoff cancels child agents and blocks further inference while
  leaving attached native shell jobs available to an operator. Explicit abort,
  pause, stop and disposal cancel those jobs.
- Teams delegated identity, verified one-to-one direct requests, configured
  group/channel sources, quote chains, membership sync, original-conversation
  replies and uncertain-write reconciliation.
- Versioned policy, prompt parts, team skills, drafts, history and restoration;
  native inspection, status, pause, stop, retry and context views.

## Repair review regressions

Independent review of the repair added coverage for reportless retry assignments,
live corrections during resumed turns, explicit pause/disable/service-stop/ticket-stop
after handoff, retryable pre-send history reads, released model ownership, portable
fixture paths and interrupted chunk writes. Only complete fsynced chunks become
visible under their hash names; an in-process retry can recover after disk writes
resume without deleting committed data. Model ownership is released after a run;
only sessions with running native non-agent tasks remain parked for an operator.

## Repeatable checks

From `vscode/`:

```sh
npm ci --ignore-scripts
npm run package
npm audit --audit-level=low
npm exec --yes --package=@github/copilot@1.0.105 -- npm run test:offline
xvfb-run -a npm exec --yes --package=@github/copilot@1.0.105 -- npm run test:editor
```

The offline suite uses the production backend with the real pinned SDK/CLI,
empty fixture worktrees, dummy credentials and scripted loopback model responses.
A Linux seccomp launcher denies native network syscalls; forwarding rejects any
origin except that fixture's local server. It does not consume hosted inference
or send GitHub/Teams messages. HTTP fixtures cover root/child instruction updates,
steering, completion wakeup and resume. WebSocket fixtures assert authentication
headers and bounded abort. Separate shell fixtures exercise handoff followed by
both abort and disposal. Unit tests retain malformed-input and policy negatives.
CI runs package checks on Linux, macOS and Windows, with separate Linux CLI and
native-editor jobs.

## Deployment acceptance still required

Local tests and green CI establish source behavior. An enterprise rollout must
also retain evidence for the actual organization: Copilot entitlement/policy,
Entra consent and conditional access, a real Teams one-to-one and channel
roundtrip, GitHub Enterprise identity and permissions, required CI and independent review branch protections, restart/reconciliation in
the intended remote extension host, and expected storage/load/backup scale.
Those checks need an authorized tenant and deployment; this PR does not claim
that source validation supplies that qualification. Execution uses the operator's
OS account, so enterprise host isolation and repository/server protections remain
necessary.
