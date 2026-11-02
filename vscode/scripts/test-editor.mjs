import { runTests } from '@vscode/test-electron'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'superagent-editor-'))
try {
  // Desktop hosts can inherit CLI IPC variables that bypass a separate test instance.
  for (const key of ['VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE', 'VSCODE_CLI']) delete process.env[key]
  const workspace = join(directory, 'repo'), profile = join(directory, 'profile')
  await mkdir(workspace); await mkdir(join(profile, 'User'), { recursive: true })
  execFileSync('git', ['init', '-q', workspace])
  await writeFile(join(profile, 'User/settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'github.copilot.chat.agentDebugLog.fileLogging.enabled': false,
    'github.copilot.chat.otel.enabled': false, 'chat.agentHost.otel.enabled': false,
    'superagent.service.enabled': false,
  }))
  await runTests({ version: '1.144.0', extensionDevelopmentPath: root, extensionTestsPath: join(root, 'scripts/editor-smoke.cjs'),
    ...(process.env.SUPERAGENT_TEST_EDITOR ? { vscodeExecutablePath: process.env.SUPERAGENT_TEST_EDITOR } : {}),
    launchArgs: [workspace, '--user-data-dir', profile, '--extensions-dir', join(directory, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-gpu', '--no-sandbox'],
    extensionTestsEnv: { SUPERAGENT_SMOKE_OUTPUT: join(directory, 'evidence.json') },
  })
  console.log(await readFile(join(directory, 'evidence.json'), 'utf8'))
} finally { await rm(directory, { recursive: true, force: true }) }
