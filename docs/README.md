# Documentation map

## Copilot Superagent

Start with the [project README](../README.md), then use:

- [VS Code extension guide](../vscode/README.md) for installation, Copilot workers, GitHub and Microsoft Teams configuration, supervision, and recovery.
- [Extension security boundaries](../vscode/SECURITY.md) for execution privileges, credentials, privacy, and deployment validation.
- [Copilot-only enterprise enforcement](../vscode/docs/copilot-only.md) for model routing and bypass prevention.
- [Contributing](../CONTRIBUTING.md) for the repository layout and development checks.
- [Security reporting](../SECURITY.md) for private vulnerability reports.

The VS Code extension runs with the official Copilot SDK and an installed Copilot CLI. The legacy DeepSeek Harness runtime, web panel, Feishu integration, launcher, and their dependency graph have been removed.

## Validation and provenance

- [Parity and acceptance evidence](../vscode/docs/parity-validation.md) records fixture, offline CLI, and editor validation separately from live tenant acceptance.
- [MIT license and attribution](../LICENSE) covers the retained ticket engine and adapted instructions originating from the DeepSeek Harness Team's dsh-superagent prototype.

The current extension guide is the installation and operation reference. Shared code provenance remains documented even though the original runtime and its setup guides are retired.
