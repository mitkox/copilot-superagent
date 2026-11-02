import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const root = JSON.parse(await readFile('../package.json', 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  assert.equal(Object.keys(root[field] ?? {}).length, 0, 'Root is a dependency-free extension command launcher')
}
assert.equal(root.dsh, undefined, 'No legacy Harness bundle')
assert.equal(root.engines?.dsh, undefined, 'No legacy Harness engine')
const manifest = JSON.parse(await readFile('package.json', 'utf8'))
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'))
assert.ok(!Object.keys(lock.packages).some(name => name.includes('@deepseek-ai/')), 'No Harness dependencies in the extension lockfile')
assert.equal(manifest.dependencies['@github/copilot-sdk'], '1.0.28', 'Pin the reviewed Copilot SDK')
assert.equal(manifest.dependencies.zod, '4.6.6', 'Pin patched schema validation')
assert.equal(manifest.overrides.zod, '4.6.6')
assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false)
assert.equal(manifest.capabilities.virtualWorkspaces, false)
assert.ok(!manifest.enabledApiProposals, 'Only stable VS Code APIs permitted')
for (const property of Object.values(manifest.contributes.configuration.properties)) assert.equal(property.scope, 'application')
const agent = await readFile('agents/superagent.agent.md', 'utf8')
for (const tool of manifest.contributes.languageModelTools) {
  const qualified = `${manifest.publisher}.${manifest.name}/${tool.toolReferenceName}`
  assert.ok(agent.includes(`'${qualified}'`), `Agent must use the canonical extension tool reference: ${qualified}`)
}
const bundle = await readFile('dist/extension.cjs', 'utf8')
assert.ok(!/deepseek-ai|createTelemetryLogger|applicationinsights|sentry|posthog|http\.createServer/.test(bundle), 'Unexpected runtime or telemetry surface')
assert.ok(bundle.includes('forStdio'), 'Use the installed authenticated Copilot CLI over stdio')
assert.ok(bundle.includes('Copilot-only:'), 'Bundle enterprise inference enforcement')
const license = await readFile('LICENSE', 'utf8')
assert.equal(license, await readFile('../LICENSE', 'utf8'), 'Retain the complete upstream MIT notice')
assert.match(license, /Copyright \(c\) 2026 DeepSeek Harness Team/)
const worker = await readFile('dist/prompts/worker.md', 'utf8')
assert.ok(worker.includes('Microsoft Teams'))
assert.ok(!/DSH_SUPERAGENT|dsh-superagent|Feishu|lark-cli/.test(worker), 'No retired runtime commands in worker instructions')
console.log('Package checks passed: Copilot-only inference, pinned SDK, no Harness dependencies, original MIT attribution retained.')
