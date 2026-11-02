import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'linux') throw new Error('The network-denied CLI fixture requires Linux seccomp')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), require = createRequire(import.meta.url)
const directory = await mkdtemp(join(tmpdir(), 'superagent-offline-build-'))
const cli = process.env.SUPERAGENT_TEST_COPILOT || execFileSync('which', ['copilot'], { encoding: 'utf8' }).trim()
const sdk = dirname(dirname(fileURLToPath(import.meta.resolve('@github/copilot-sdk'))))
try {
  execFileSync('cc', ['-O2', '-o', join(directory, 'deny-network'), join(root, 'tests/integration/deny-network.c')])
  await build({ entryPoints: [join(root, 'src/copilot.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: join(directory, 'backend.mjs'),
    plugins: [{ name: 'shared-sdk-identity', setup(api) { api.onResolve({ filter: /^(@github\/copilot-sdk|ws)$/ }, args => ({ path: args.path === '@github/copilot-sdk' ? join(sdk, 'dist/index.js') : require.resolve(args.path), external: true })) } }],
  })
  for (const [name, mode] of [['actual-provider-boundary.mjs'], ['actual-provider-command-resume.mjs'], ['actual-backend-restart.mjs'], ['actual-backend-http.mjs'], ['actual-backend-websocket.mjs'], ['actual-backend-handoff.mjs', 'abort'], ['actual-backend-handoff.mjs', 'dispose']]) execFileSync(process.execPath, [join(root, 'tests/integration', name), ...(mode ? [mode] : [])], {
    stdio: 'inherit', timeout: 60000,
    env: { ...process.env, SUPERAGENT_TEST_SDK: sdk, SUPERAGENT_TEST_COPILOT: cli, SUPERAGENT_TEST_BACKEND: join(directory, 'backend.mjs'), SUPERAGENT_TEST_LAUNCHER: join(directory, 'deny-network') },
  })
} finally { await rm(directory, { recursive: true, force: true }) }
