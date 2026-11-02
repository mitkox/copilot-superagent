# Copilot Superagent

[![VS Code extension checks](https://github.com/mitkox/copilot-superagent/actions/workflows/vscode.yml/badge.svg)](https://github.com/mitkox/copilot-superagent/actions/workflows/vscode.yml)

Continuous repository agents inside VS Code, powered by GitHub Copilot. Turn authorized requests from Copilot Chat, GitHub, and Microsoft Teams into persistent coding sessions with isolated Git worktrees, then review their work in one supervision panel.

The project lives at **[mitkox/copilot-superagent](https://github.com/mitkox/copilot-superagent)**. It adapts the original MIT-licensed dsh-superagent research prototype for VS Code and the official GitHub Copilot SDK.

## What it does

- Routes authorized requests into tickets with persistent Copilot sessions and a separate Git worktree for each ticket.
- Follows GitHub issues, pull requests, reviews, and CI, plus approved Microsoft Teams chats and channels.
- Returns acknowledgements, questions, and results to the original conversation when source replies are enabled.
- Shows source context, decisions, transcripts, pending operations, and versioned policy and prompts in supervision.
- Supports per-tool confirmation or execution within operator-approved ticket mandates. Proactive work requires configured rules.

The service runs while its VS Code workspace extension host is open. An enabled service resumes when that host reopens. Worktrees preserve the primary checkout's dirty files; commands still run with the operator's OS privileges.

## Build and install

You need VS Code **1.144+**, Git, Node.js **22.19+**, and the reviewed **GitHub Copilot CLI 1.0.105** (protocol **3**) and a **Copilot Business or Enterprise** account, with SDK **1.0.28**. Organization policies and Copilot subscription permissions apply. The extension uses existing Copilot sign-in; no separate model API key or DSH installation is required.

```sh
git clone https://github.com/mitkox/copilot-superagent.git
cd copilot-superagent/vscode
npm ci --ignore-scripts
npm run package
code --install-extension dist/vsc-superagent.vsix
```

Use `code-insiders` if your supported editor build is VS Code Insiders. This is a source build and local VSIX installation; the package uses the local publisher identity `superagent-local`. The extension ID remains `superagent-local.vsc-superagent` and the VSIX filename remains `vsc-superagent.vsix` so existing local installations keep their identity.

Open a trusted Git repository, run **Superagent: Apply Local Privacy Settings**, reload the editor, then run **Superagent: Check Copilot Connection** and **Superagent: Start Service**. Select **Superagent** in the Copilot agent picker or use **@superagent** to request work. Configure source scopes and allowed requesters before enabling GitHub or Teams intake.

Follow the [extension guide](vscode/README.md) for source configuration, permissions, policy, delivery, storage, and recovery. Read the [security boundaries](vscode/SECURITY.md) before enabling unattended execution or deploying in an organization.

The extension enforces [Copilot-only inference](vscode/docs/copilot-only.md): custom provider settings and inherited model credentials are excluded, and inference destinations are checked before HTTP or WebSocket connections. Personal-plan endpoints are blocked.

## Documentation and development

- [Extension guide](vscode/README.md): installation and daily operation.
- [Documentation map](docs/README.md): current guides and validation reference.
- [Contributing](CONTRIBUTING.md): development commands, validation, and pull requests.
- [Security reporting](SECURITY.md): private vulnerability reports.

The VS Code extension is under `vscode/`. It bundles the shared ticket engine from `src/core/` and adapted instructions from `prompts/` and `skills/`. The legacy DeepSeek Harness runtime, Feishu integration, web panel, launcher, and their dependencies have been removed. No DeepSeek Harness installation, runtime package, account, API key, or model is required.

From `vscode/`, `npm run check` runs typechecking, tests, bundling, and package checks. `npm run package` also builds the installable VSIX. The dependency-free root package forwards these commands to `vscode/`; install extension dependencies with `npm run install:extension` from the root. GitHub Actions runs the extension dependency audit and packaging checks.

## Project status and attribution

This is research software. Local tests and CI do not establish production readiness or approval for a particular organization, tenant, editor, or operating system. Validate those environments before rollout.

The retained ticket engine and adapted instructions originate from the MIT-licensed dsh-superagent prototype by the **DeepSeek Harness Team**. Their copyright and MIT permission notice are preserved in [LICENSE](LICENSE) and the packaged extension. Runtime independence does not change that source provenance. This adaptation is an independent project, not an official GitHub, Microsoft, or DeepSeek product.

## License

[MIT](LICENSE). The extension also includes its [MIT license](vscode/LICENSE).
