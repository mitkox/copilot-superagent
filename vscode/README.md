# Copilot Superagent for VS Code

Source, issues, and contributions: [mitkox/copilot-superagent](https://github.com/mitkox/copilot-superagent). See [Contributing](https://github.com/mitkox/copilot-superagent/blob/main/CONTRIBUTING.md) for development and validation.

Continuous repository agents inside VS Code, using the MIT-licensed ticket engine adapted from dsh-superagent and the official GitHub Copilot SDK, GitHub and **Microsoft Teams**.

An authorized request is assessed, assigned a persistent Copilot session and isolated Git worktree, and worked through implementation and verification. Source follow-ups, reviews and CI reach the same ticket. Acknowledgements, questions and results return to the original conversation when delivery is enabled. Supervision shows work needing attention, sources, triggers, decisions, execution, transcripts and versioned settings.

The service requires a running VS Code workspace extension host. Closing that host stops its workers; reopening resumes an enabled service and recovers durable assignments. It does not install an operating-system daemon.

## Install

Requirements: VS Code **1.144+**, Git, Node **22.19+**, and an installed **GitHub Copilot CLI 1.0.105**, protocol **3**, authenticated with an approved **Copilot Business or Enterprise** account. The SDK is pinned to **1.0.28**. The SDK uses the CLI’s standard stored sign-in; environment authentication overrides and custom model providers are disabled. Organization policies and subscription permissions apply. Other CLI versions fail closed. See [Copilot-only enforcement](docs/copilot-only.md).

Clone the repository and build the extension:

```sh
git clone https://github.com/mitkox/copilot-superagent.git
cd copilot-superagent/vscode
npm ci --ignore-scripts
npm run package
code-insiders --install-extension dist/vsc-superagent.vsix
```

Use `code` instead for a supported stable build. The publisher `superagent-local` is a local package identity; the extension ID `superagent-local.vsc-superagent` and VSIX filename are retained for existing local installations. SDK JavaScript and attributed, adapted prompts are bundled; the reviewed CLI runs through stdio. There is no extension HTTP listener or runtime download. Set `superagent.copilot.cliPath` when the executable is not on the extension host's PATH.

## Start work

1. Open one trusted, file-backed Git repository. Multi-root and virtual workspaces are unsupported.
2. Run **Superagent: Apply Local Privacy Settings**, then reload. Known VS Code/Copilot exporters must be disabled before work tools become available.
3. Configure the source scopes and allowed requester identities below.
4. Run **Superagent: Check Copilot Connection** to check CLI protocol and login without a model request.
5. Run **Superagent: Start Service**. Choose per-tool confirmation or execution within approved ticket mandates, and whether source replies are enabled. Complete Microsoft sign-in for Teams.
6. Select **Superagent** in the Copilot agent picker and state the work, use **@superagent**, or submit a request in an enabled source conversation.
7. Use **Superagent: Open Supervision** to answer questions, add follow-ups, inspect transcripts, pause, stop, retry or change policy.

The native agent delegates the unchanged request rather than implementing a duplicate task in the routing chat. `@superagent /status` reads state and `/panel` opens supervision. Model-tool dispatch always shows a native confirmation containing the exact request and target ticket before creating authority. Dispatch supports an explicit ticket ID for an in-scope follow-up. The previous manual New Ticket / Review / Continue workflow remains available.

Workers start from the primary checkout's committed HEAD, preserving dirty files. Each ticket retains its worktree, branch and Copilot session. Inspection opens a separate window when the service is active. Ticket authorization covers unattended shell commands only when the operator chooses that mode. These commands run as the operator; a worktree is not an OS sandbox. Managed approvals, sandbox bypasses, unknown tools and paths outside the ticket still require native confirmation.

## GitHub

Configure application/user settings, never repository settings:

```json
{
  "superagent.github.origin": "https://api.github.com",
  "superagent.github.repository": "your-org/your-repo",
  "superagent.github.account": "your-agent-account",
  "superagent.github.allowedActors": ["approved-requester"],
  "superagent.github.allowedBots": ["github-actions[bot]"],
  "superagent.github.observe": false
}
```

GitHub Enterprise Server supports an explicitly configured HTTPS `/api/v3` base. **Configure Source Credential** stores a fine-grained token in VS Code SecretStorage, bound to the exact origin/repository. Intake needs Issues, Pull requests and Metadata read; CI needs Checks and Commit statuses read. Replies/review resolution need the corresponding write permissions. Worker Git/gh publishing uses its CLI identity and ticket delivery instructions independently.

Allowed people can mention the agent to request work. With `github.observe` enabled, unaddressed activity can be assessed under proactive rules. Subscribed threads deliver human/bot context without repeated mentions. Bots never grant explicit authority. Reviews have an independent resumable scan because edits lack a reliable PR-update cursor. Reported PRs are verified against the actual source PR or the configured agent's `superagent/<ticket-id>` branch. Own PR discovery and actual provider close/merge readback update completion.

## Microsoft Teams

Use Entra tenant/user **object UUIDs**, not display names:

```json
{
  "superagent.teams.tenantId": "11111111-1111-1111-1111-111111111111",
  "superagent.teams.chatIds": ["19:your-chat-id@thread.v2"],
  "superagent.teams.channels": [
    { "teamId": "22222222-2222-2222-2222-222222222222", "channelId": "19:your-channel-id@thread.tacv2" }
  ],
  "superagent.teams.allowedActors": ["33333333-3333-3333-3333-333333333333"]
}
```

The built-in Microsoft provider selects the configured tenant. Delegated scopes are `User.Read` for sender identity, `Chat.Read` and/or `ChannelMessage.Read.All` for intake. Replies add `ChatMessage.Send` and/or `ChannelMessage.Send`. Membership sync adds `ChatMember.Read`. Administrator consent and conditional-access policy may apply. No app secret, bot registration, webhook or token pasted into settings is required. Only public-cloud `https://graph.microsoft.com/v1.0` is supported.

To synchronize requesters from a chat's members, set `superagent.teams.syncChatId` to one of the approved `chatIds`, then run **Superagent: Sync Teams Members** and review the replacement allowlist. Enable `superagent.teams.syncMembership` only when that chat's ongoing membership should authorize future requests.

Channel replies target the original root; chat replies use `replyWithQuote`. Context retains tenant, chat/team/channel, root, message, quote references, sender, edit time and URL. Sender identity is resolved through `/me` to exclude the service's own messages. Each configured chat's `chatType` is verified through Graph: one-to-one messages are direct requests; group and meeting chats use mentions or configured proactive rules. HTML is reduced to text; attachments are not automatically downloaded or sent to a model.

## Policy, prompts and delivery

Supervision Settings contains the versioned policy. Explicit allowed requests work in every proactive mode. `off` ignores inferred candidates; `observe` records what rules would accept; `auto` starts work matching enabled rules. Start with observe and inspect decisions before enabling proactive acceptance. Admission tables, actors/bots, worker concurrency, human priority, unqualified Copilot model IDs, poll interval and retry limits are configurable. Saves use revision checks and history supports restoration. Unsaved drafts retain their original revision across navigation and updates; rejected saves preserve the draft.

Original worker, communication, scope, delivery and GitHub instructions are packaged with Teams guidance. Team sections, built-in part overrides and team skills are editable. Overrides retain their original default; upgrades identify changed defaults. Worker/assessment previews are separate. Assessments receive source facts and a structured outcome tool without repository execution tools. Policy changes revalidate pending/running authority against the exact currently configured provider namespace. Every actual HTTP or WebSocket model request receives current worker instructions, including native child agents; an obsolete cached SDK prompt cannot retain revoked authority.

Useful acknowledgements, questions and ready results are relayed; routine progress stays internal. Core reply gates enforce source-thread ownership. Replies are queued durably before sending. Uncertain HTTP outcomes reconcile authenticated receipt markers instead of blindly repeating POSTs. A missing receipt leaves an actionable failed operation; Retry operation checks it again. Publishing and merging follow worker permissions, the immutable mandate, delivery requirements and server-side protections. Original default auto-merge conditions require a separately named merge CLI; none is configured by default.

## Storage and verification

Private state is keyed by canonical Git common directory, with checksums, atomic commits and an exclusive writer lock. Events and source cursors commit together. State retains source context, tickets, assignments, settings/prompts history, transcripts and pending operations, without credentials. Back up state and worktrees together. Corrupt/incompatible state fails closed; preserve it during lock recovery. Branches/worktrees are retained.

Confirmed dead owners on the same host can be recovered automatically. Active or unverifiable owners stay protected. A crash during the short acquisition guard can leave `state.lock.acquire`; inspect owner processes before recovering that guard. Small state remains a checksummed version-1 file. Above 8 MiB an atomic version-2 manifest references immutable checksummed one-MiB chunks in `archive/`; ticket, assignment, deduplication and delivery identities remain intact beyond the former 16-MiB limit. Back up the manifest and its complete archive together. This format cannot be opened by older extensions. Transcript views retain at most 500 events and 256 KiB per session under a shared two-MiB budget; omitted counts are recorded. Copilot maintains its own persistent conversation separately. Storage remains a single-host embedded store; disk exhaustion fails the transaction without discarding committed records.

Requests have ten-second deadlines and one-MiB response caps. Most lists/context reads have five-page bounds. Own-PR discovery, reviews and channel-root scans retain continuation checkpoints. PR-discovery failures do not block already tracked lifecycle/CI checks. Large histories take multiple cycles; oversized individual threads need operator attention. Successful independent sources can commit despite another source failing.

`npm run check` runs typechecking, behavioral tests, shared core tests, bundling and package checks. `npm run audit:production` checks runtime advisories. `npm run test:offline` exercises SDK 1.0.28 with CLI 1.0.105 using dummy-key local HTTP/Responses/WebSocket servers; Linux seccomp denies native CLI networking, and forwarding accepts only the fixture server. It covers live steering, fresh policy, child completion, shell handoff, abort and disposal without hosted inference. `npm run test:editor` runs native registration and supervision in a disposable VS Code profile (use `xvfb-run -a` on headless Linux). CI also packages on Linux, macOS and Windows. See [parity and acceptance evidence](docs/parity-validation.md). These checks establish adapter/scheduler behavior; tenant permissions, deployment-scale pagination, Copilot policy and OS/remote-host combinations need live acceptance. See [SECURITY.md](SECURITY.md).
