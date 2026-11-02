# Documentation map

## Copilot Superagent

Start with the [project README](../README.md), then use:

- [VS Code extension guide](../vscode/README.md) for installation, Copilot workers, GitHub and Microsoft Teams configuration, supervision, and recovery.
- [Extension security boundaries](../vscode/SECURITY.md) for execution privileges, credentials, privacy, and deployment validation.
- [Contributing](../CONTRIBUTING.md) for the repository layout and development checks.
- [Security reporting](../SECURITY.md) for private vulnerability reports.

The VS Code extension runs with the official Copilot SDK and an installed Copilot CLI. It does not use the DSH runtime, web panel, Feishu integration, or the legacy setup procedure below.

## Original dsh-superagent prototype

The original DeepSeek Harness Team prototype is retained under its MIT license. These documents describe that implementation. Shared ticket, policy, and prompt concepts inform the extension, but DSH commands, permission presets, deployment settings, web APIs, and Feishu instructions apply to the original runtime.

Read the numbered documents in order:

- [000 Philosophy](000-philosophy.md)
- [001 Domain model](001-domain.md)
- [002 Authorization](002-authorization.md)
- [003 Execution](003-execution.md)
- [004 Prompts](004-prompts.md)
- [005 Panel](005-panel.md)
- [006 Deployment](006-deployment.md)
- [007 Architecture](007-architecture.md)
- [008 Cookbook](008-cookbook.md)

[SETUP.md](../SETUP.md) is the agent-assisted setup procedure for the original DSH runtime. Use the extension guide above to install Copilot Superagent in VS Code.
