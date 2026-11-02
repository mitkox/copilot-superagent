import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const { CopilotBackend } = await import(pathToFileURL(process.env.SUPERAGENT_TEST_BACKEND).href);
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(process.env.SUPERAGENT_TEST_SDK, 'dist/index.js')).href);
const directory = await mkdtemp(join(tmpdir(), 'copilot-provider-boundary-'));
const workspace = join(directory, 'empty');
await mkdir(workspace);
let requests = 0, upgrades = 0;
const server = createServer((request, response) => { requests++; response.writeHead(500).end(); });
server.on('upgrade', (request, socket) => { upgrades++; socket.destroy(); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider-boundary fixture timed out')), 10000); })]); }
    finally { clearTimeout(timer); }
};
const summary = [];
try {
    for (const [wireApi, transport] of [['completions', 'http'], ['responses', 'http'], ['responses', 'websockets']]) {
        const data = join(directory, `${wireApi}-${transport}`);
        await mkdir(data);
        let created = 0, resumed = 0;
        const backend = new CopilotBackend({ rpcTimeoutMs: 6000, cleanupTimeoutMs: 1000, pollMs: 10,
            onPermissionRequest: () => ({ kind: 'reject' }),
            clientFactory: options => {
                // Keep the production request handler completely unchanged. Force
                // an unsafe provider through the test adapter to prove egress fails.
                const real = new CopilotClient({ ...options,
                    connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [process.env.SUPERAGENT_TEST_COPILOT] }),
                    mode: 'empty', baseDirectory: data, workingDirectory: workspace, useLoggedInUser: false,
                    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COPILOT_DISABLE_KEYTAR: '1', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' },
                });
                const unsafe = config => ({ ...config, model: 'fixture-model', providers: undefined, models: undefined,
                    provider: { type: 'openai', wireApi, transport, baseUrl: `${origin}/v1`, apiKey: 'dummy-local-fixture-key' },
                    availableTools: [], excludedTools: ['builtin:*', 'mcp:*'], streaming: false,
                });
                return { start: () => real.start(), stop: () => real.stop(), forceStop: () => real.forceStop(),
                    listSessions: () => real.listSessions(),
                    deleteSession: id => real.deleteSession(id), getAuthStatus: () => real.getAuthStatus(), getStatus: () => real.getStatus(),
                    createSession: config => { created++; return real.createSession(unsafe(config)); },
                    resumeSession: (id, config) => { resumed++; return real.resumeSession(id, unsafe(config)); },
                };
            },
        });
        try {
            const input = { ticketId: `boundary-${wireApi}-${transport}`, sessionId: `boundary-${randomUUID()}`, directory: workspace,
                model: 'fixture-model', prompt: 'Do not execute tools.', systemPrompt: 'Fixture prompt', tools: [],
                signal: new AbortController().signal, onEvent() {},
            };
            await assert.rejects(bounded(backend.run(input)), /Copilot-only/);
            await assert.rejects(bounded(backend.run(input)), /Copilot-only/);
            assert.equal(created, 1, 'First run creates one actual CLI session');
            assert.equal(resumed, 1, 'Second run uses actual SDK resume with the unsafe provider');
            assert.equal(requests, 0, 'Custom HTTP provider receives no prompt or credentials');
            assert.equal(upgrades, 0, 'Custom WebSocket provider receives no handshake or credentials');
            summary.push({ wireApi, transport, created, resumed, requests, upgrades });
        } finally { await bounded(backend.dispose()); }
    }
    console.log(JSON.stringify({ passed: true, productionProviderBoundary: summary }, null, 2));
} finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
}
