import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { fixtureTransport } from './fixture-transport.mjs';

const { CopilotBackend } = await import(pathToFileURL(process.env.SUPERAGENT_TEST_BACKEND).href);
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(process.env.SUPERAGENT_TEST_SDK, 'dist/index.js')).href);
const directory = await mkdtemp(join(tmpdir(), 'copilot-backend-restart-'));
const data = join(directory, 'data'), workspace = join(directory, 'workspace');
await Promise.all([data, workspace].map(path => mkdir(path)));
const sessionId = `restart-${randomUUID()}`;
const userMarker = `PERSISTED_USER_${randomUUID()}`, assistantMarker = `PERSISTED_ASSISTANT_${randomUUID()}`;
const received = [];
const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    received.push(body);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: `chatcmpl_${received.length}`, object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: assistantMarker } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const bounded = async promise => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Backend restart fixture timed out')), 10000); })]); }
    finally { clearTimeout(timer); }
};
const makeBackend = () => {
    const evidence = { created: 0, resumed: 0, listed: [], restoredUser: false, restoredAssistant: false };
    let real;
    const backend = new CopilotBackend({ rpcTimeoutMs: 6000, cleanupTimeoutMs: 1000, pollMs: 10,
        onPermissionRequest: () => ({ kind: 'reject' }),
        clientFactory: options => {
            evidence.registry = options.env.COPILOT_PROVIDERS_CONFIG;
            assert.deepEqual(JSON.parse(readFileSync(evidence.registry, 'utf8')), { providers: [], models: [] });
            fixtureTransport(options.requestHandler, origin);
            real = new CopilotClient({ ...options,
                connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [process.env.SUPERAGENT_TEST_COPILOT] }),
                mode: 'empty', baseDirectory: data, workingDirectory: workspace, useLoggedInUser: false,
                env: { ...options.env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COPILOT_DISABLE_KEYTAR: '1' },
            });
            const local = config => {
                assert.equal(config.configDirectory, undefined, 'Session history must retain its durable CLI directory');
                return { ...config, model: 'fixture-model', providers: undefined, models: undefined,
                    provider: { type: 'openai', wireApi: 'completions', baseUrl: `${origin}/v1`, apiKey: 'dummy-local-fixture-key' },
                    availableTools: [], excludedTools: ['builtin:*', 'mcp:*'], streaming: false,
                };
            };
            return { start: () => real.start(), stop: () => real.stop(), forceStop: () => real.forceStop(),
                listSessions: async () => { const rows = await real.listSessions(); evidence.listed = rows.map(row => row.sessionId); return rows; },
                deleteSession: id => real.deleteSession(id), getAuthStatus: () => real.getAuthStatus(), getStatus: () => real.getStatus(),
                createSession: config => { evidence.created++; return real.createSession(local(config)); },
                resumeSession: async (id, config) => {
                    evidence.resumed++;
                    const session = await real.resumeSession(id, local(config));
                    const events = JSON.stringify(await session.getEvents());
                    evidence.restoredUser = events.includes(userMarker);
                    evidence.restoredAssistant = events.includes(assistantMarker);
                    return session;
                },
            };
        },
    });
    return { backend, evidence };
};
const input = { ticketId: 'restart-ticket', sessionId, directory: workspace, model: 'fixture-model',
    prompt: userMarker, systemPrompt: 'Local restart fixture', tools: [], signal: new AbortController().signal, onEvent() {},
};
const transcript = join(data, 'session-state', sessionId, 'events.jsonl');
let first, second;
try {
    first = makeBackend();
    await bounded(first.backend.run(input));
    assert.equal(first.evidence.created, 1);
    await bounded(first.backend.dispose());
    assert.equal(existsSync(first.evidence.registry), false, 'Disposal cleans the temporary provider registry');
    const persisted = await readFile(transcript, 'utf8');
    assert.ok(persisted.includes(userMarker) && persisted.includes(assistantMarker), 'Registry cleanup preserves both transcript roles');

    second = makeBackend();
    assert.notEqual(second.evidence.registry, first.evidence.registry, 'Restart creates a fresh empty provider registry');
    await bounded(second.backend.run({ ...input, prompt: 'Continue the prior conversation.' }));
    assert.ok(second.evidence.listed.includes(sessionId), 'Fresh CLI process discovers the durable prior session');
    assert.equal(second.evidence.created, 0, 'Restart must not replace the prior conversation');
    assert.equal(second.evidence.resumed, 1);
    assert.equal(second.evidence.restoredUser, true);
    assert.equal(second.evidence.restoredAssistant, true);
    assert.ok(JSON.stringify(received[1].messages).includes(userMarker) && JSON.stringify(received[1].messages).includes(assistantMarker), 'The next model turn receives prior user and assistant history');
    await bounded(second.backend.dispose());
    assert.equal(existsSync(second.evidence.registry), false);
    assert.equal(existsSync(transcript), true);
    const evidence = { passed: true, first: first.evidence, second: second.evidence, modelRequests: received.length, transcript, directory };
    await writeFile(join(directory, 'restart-evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
} finally {
    await bounded(first?.backend.dispose() ?? Promise.resolve());
    await bounded(second?.backend.dispose() ?? Promise.resolve());
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
