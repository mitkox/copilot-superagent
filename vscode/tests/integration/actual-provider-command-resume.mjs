import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const { CopilotBackend } = await import(pathToFileURL(process.env.SUPERAGENT_TEST_BACKEND).href);
const { CopilotClient, RuntimeConnection, CopilotRequestHandler } = await import(pathToFileURL(join(process.env.SUPERAGENT_TEST_SDK, 'dist/index.js')).href);
const directory = await mkdtemp(join(tmpdir(), 'copilot-provider-command-resume-'));
const data = join(directory, 'data'), workspace = join(directory, 'workspace'), marker = join(directory, 'provider-command-marker');
await Promise.all([data, workspace].map(path => mkdir(path)));
const sessionId = `provider-command-${randomUUID()}`;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = quote(process.execPath) + ' -e ' + quote(`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('dummy-fixture-key')`);
let requests = 0, upgrades = 0;
const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: `chatcmpl_${requests}`, object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Harmless fixture seed completed.' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
server.on('upgrade', (_request, socket) => { upgrades++; socket.destroy(); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
class SeedTransport extends CopilotRequestHandler {
    sendRequest(request, context) {
        assert.equal(new URL(request.url).origin, origin);
        return super.sendRequest(new Request(request, { redirect: 'error' }), context);
    }
}
const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider command resume fixture timed out')), 10000); })]); }
    finally { clearTimeout(timer); }
};
const client = options => new CopilotClient({ ...options,
    connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [process.env.SUPERAGENT_TEST_COPILOT] }),
    mode: 'empty', baseDirectory: data, workingDirectory: workspace, useLoggedInUser: false,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COPILOT_DISABLE_KEYTAR: '1', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' },
});
const seed = client({ requestHandler: new SeedTransport() });
const summary = [];
try {
    await bounded(seed.start());
    const session = await bounded(seed.createSession({ sessionId, name: 'Harmless legacy provider fixture', workingDirectory: workspace, model: 'fixture-model',
        provider: { type: 'openai', wireApi: 'completions', baseUrl: `${origin}/v1`, apiKeyCommand: command },
        availableTools: [], excludedTools: ['builtin:*', 'mcp:*'], tools: [], streaming: false,
        enableConfigDiscovery: false, enableFileHooks: false, enableHostGitOperations: false, enableSkills: false, skipCustomInstructions: true,
        enableOnDemandInstructionDiscovery: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionStore: false, enableSessionTelemetry: false,
        mcpServers: {}, pluginDirectories: [], customAgents: [], additionalDirectories: [], onPermissionRequest: () => ({ kind: 'reject' }),
    }));
    await bounded(session.sendAndWait({ prompt: 'Seed the harmless legacy provider fixture.' }, 8000));
    assert.equal(await readFile(marker, 'utf8'), 'ran', 'Seed proves the pinned CLI supports the provider key command');
    assert.equal(requests, 1);
    await session.disconnect();
    await rm(marker);
    for (const mode of ['resident', 'cold']) {
        let real, resumed = 0, submitted = 0, discovered = false;
        const backend = new CopilotBackend({ rpcTimeoutMs: 6000, cleanupTimeoutMs: 1000, pollMs: 10,
            onPermissionRequest: () => ({ kind: 'reject' }),
            clientFactory: options => {
                if (mode === 'resident') {
                    real = seed;
                    // Test-local SDK injection changes only the transport owner:
                    // the old resident runtime now uses the unmodified production handler.
                    real.requestHandler = options.requestHandler;
                } else real = client(options);
                return { start: () => real.start(), stop: () => real.stop(), forceStop: () => real.forceStop(),
                    listSessions: async () => { const rows = await real.listSessions(); discovered = rows.some(row => row.sessionId === sessionId); return rows; },
                    deleteSession: id => real.deleteSession(id), getAuthStatus: () => real.getAuthStatus(), getStatus: () => real.getStatus(),
                    createSession: () => { throw new Error('The legacy fixture must be discovered and resumed'); },
                    resumeSession: async (id, config) => {
                        resumed++;
                        assert.equal(config.provider, undefined);
                        assert.deepEqual(config.providers, []);
                        assert.deepEqual(config.models, []);
                        const session = await real.resumeSession(id, { ...config, availableTools: [], excludedTools: ['builtin:*', 'mcp:*'], streaming: false });
                        const send = session.send.bind(session);
                        session.send = (...args) => { submitted++; return send(...args); };
                        return session;
                    },
                };
            },
        });
        try {
            // No GitHub credential is supplied. Requiring GitHub auth proves the
            // resumed turn selected Copilot instead of its old singular provider.
            await assert.rejects(bounded(backend.run({ ticketId: 'provider-command-ticket', sessionId, directory: workspace,
                model: 'fixture-model', prompt: `Attempt ${mode} resume without provider configuration.`, systemPrompt: 'Harmless local fixture', tools: [],
                signal: new AbortController().signal, onEvent() {},
            })), /No GitHub OAuth token or Copilot HMAC key provided/);
            assert.equal(discovered, true);
            assert.equal(resumed, 1);
            assert.equal(submitted, 1, 'The assertion must reach an actual native model-turn submission');
            assert.equal(existsSync(marker), false, 'The old provider key command must not execute before endpoint enforcement');
            assert.equal(requests, 1, 'Neither resume sends another custom-provider HTTP request');
            assert.equal(upgrades, 0, 'Neither resume sends a custom-provider WebSocket handshake');
            summary.push({ mode, discovered, resumed, submitted, commandExecuted: false, newCustomRequests: requests - 1, upgrades });
        } finally { await bounded(backend.dispose()); }
    }
    const evidence = { passed: true, summary, directory };
    await writeFile(join(directory, 'provider-command-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    await bounded(seed.stop()).catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
