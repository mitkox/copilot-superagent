# Contributing to Copilot Superagent

Use [mitkox/copilot-superagent](https://github.com/mitkox/copilot-superagent) for issues and pull requests. Report security vulnerabilities through the [private reporting process](SECURITY.md).

## Work on the VS Code extension

Install Git, Node.js 22.19 or later, and a VS Code build satisfying the version in `vscode/package.json`.

```sh
git clone https://github.com/mitkox/copilot-superagent.git
cd copilot-superagent
git switch -c your-change
cd vscode
npm ci --ignore-scripts
npm run check
npm audit --audit-level=low
npm run package
```

Tests use local fixtures and do not require Copilot or Teams credentials. To try actual workers, install and authenticate the Copilot CLI, install the generated `dist/vsc-superagent.vsix`, and follow the [extension guide](vscode/README.md). Use a test repository and approved test conversations for source integration checks.

## Repository layout

| Path | Purpose |
| --- | --- |
| `vscode/src/`, `vscode/tests/` | VS Code host, Copilot workers, GitHub/Teams adapters, supervision, and tests |
| `src/core/` | Shared ticket engine, policy, and reply rules |
| `prompts/`, `skills/` | Original instructions adapted and bundled by the extension build |
| `tests/core-engine.spec.ts` | Shared ticket-engine behavioral tests, run by the extension checks |
| `docs/`, `vscode/docs/` | Current documentation and validation evidence |

The root `package.json` has no dependencies and forwards development commands to `vscode/package.json`. Install the extension dependencies from the root with `npm run install:extension`, or run `npm ci --ignore-scripts` from `vscode/`. Keep the extension's existing ID and qualified agent tool references consistent when changing package metadata.

After dependency installation, the following root commands also validate shared engine changes:

```sh
npm run check
npm run audit:production
npm run package
```

The retired DeepSeek Harness runtime, root pnpm dependencies, Feishu integration, and web panel are not part of the supported build. Preserve the MIT notice for the retained shared engine and adapted instructions.

## Submit a change

Keep changes focused and include behavioral tests when behavior changes. Update the relevant guides when commands, configuration, or user-visible behavior change. Keep generated dependencies, VSIX files, credentials, local settings, and ticket/session data out of commits. Preserve existing copyright and license notices.

In your pull request, explain the problem, the resulting behavior, and the checks you ran. Distinguish fixture tests and package validation from live Copilot, GitHub, or Teams acceptance; record any live environment checks separately.
