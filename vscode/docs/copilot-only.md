# Copilot-only enterprise operation

Copilot Superagent 0.4 requires GitHub Copilot CLI **1.0.105**, protocol **3**,
SDK **1.0.28**, and an approved Copilot Business or Enterprise account. Other
runtime versions fail before workers or assessments start. Install and sign in
to the official CLI through your organization's approved distribution process.

## Enforced model boundary

- The extension launches the configured installed CLI over stdio. It accepts no
  provider, API key, inference URL, external runtime server, or environment
  override of the executable.
- The child receives an allowlist of OS, credential-store, Git/SSH, corporate
  proxy and CA variables. Ambient model keys, provider overrides, model defaults,
  offline mode, alternate Copilot profiles, environment GitHub tokens and runtime
  injection variables are excluded. The extension host's environment is not
  changed. The CLI uses its standard stored sign-in.
- A private empty provider registry replaces custom provider configuration while
  the CLI retains its standard durable session directory. Workers and assessments disable discovered
  configuration, native file hooks, filesystem skills, plugins, custom agents,
  external MCP servers and embedding retrieval. Team skills configured in
  Supervision remain host-provided prompt content.
- Model IDs must be unqualified Copilot IDs, such as `gpt-5`. Provider-qualified
  IDs (`provider/model`), URLs and malformed IDs are rejected. GitHub determines
  which models the account and organization may use. Actual inference request
  model IDs are checked too, including native child agents.
- Every model HTTP connection and WebSocket handshake is checked before egress,
  including resumed sessions. Only HTTPS/WSS on subdomains of
  `business.githubcopilot.com` or `enterprise.githubcopilot.com` is accepted on
  GitHub.com. Personal-plan and unscoped `api.githubcopilot.com` destinations,
  URL credentials, nonstandard ports and redirects fail closed.

On upgrade, forbidden saved worker/assessment model selections are removed in a new settings revision, the service is disabled, and Supervision shows a recovery message. Prior settings history remains available, but restoring a forbidden selection is rejected. Review the Copilot models before explicitly starting the service again.

There is no opt-out setting. Resuming an old custom-provider session cannot
bypass the model transport checks. Source GitHub/Teams adapters retain their
separate scope and credential checks.

## GitHub Enterprise Cloud with data residency

Set the application/user setting `superagent.copilot.githubHost` to your exact
enterprise host, for example `your-enterprise.ghe.com`. Only `github.com` or one
valid enterprise subdomain on `ghe.com` is accepted. Authentication is pinned to
that host and inference to `https://copilot-api.your-enterprise.ghe.com` or its
WSS equivalent. Other enterprises and GitHub.com inference endpoints are rejected
for that backend. Reload VS Code after changing the host or CLI path. GitHub
Enterprise Server source configuration is separate from Copilot authentication.

## Deployment and verification

Build from `vscode/`; the root package has only dependency-free forwarding
commands. The old Harness runtime, launcher, web panel, Feishu adapter, dependency
declarations and pnpm lockfile are removed. Shared ticket-engine and adapted
instructions retain their upstream MIT attribution. The original DeepSeek
Harness Team copyright remains in both licenses and the VSIX.

Package checks reject Harness dependencies and verify the complete MIT notice.
Unit tests cover environment injection, endpoint lookalikes, custom model IDs,
redirect policy, plan-specific routing, data-residency pinning and CLI versions.
The offline suite tests custom HTTP/WebSocket provider rejection with the
production handler and real pinned CLI. Positive lifecycle fixtures substitute
a loopback-only transport in test code; that substitution is not bundled or
configurable in the extension.

The connection command checks version and sign-in without a model request; it
does not certify enterprise entitlement or routing. Validate an approved model
with your actual account, tenant, proxy and editor before rollout. GitHub
documents [CLI enterprise policy coverage](https://docs.github.com/en/copilot/how-tos/copilot-cli/administer-copilot-cli-for-your-enterprise)
and [plan-specific network routing](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-for-enterprise/manage-access/manage-network-access).

The model boundary assumes a trusted extension host and official CLI. It is not
an OS network sandbox: approved shell tools run as the operator and can execute
network clients. Enforce software distribution, host isolation, network egress,
credential access and account policy through enterprise controls. Other
extensions and users able to replace this extension or CLI are outside this
boundary. Source checks do not certify an organization's security policy.
