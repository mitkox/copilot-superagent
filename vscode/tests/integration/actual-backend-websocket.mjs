import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fixtureTransport } from './fixture-transport.mjs';
const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(process.env.SUPERAGENT_TEST_SDK, 'dist/index.js')).href);
import { pathToFileURL as fixtureURL } from 'node:url';
const { CopilotBackend } = await import(fixtureURL(process.env.SUPERAGENT_TEST_BACKEND).href);
const root = await mkdtemp(join(tmpdir(), 'copilot-offline-websocket-'));
await Promise.all(['empty', 'data'].map(x => mkdir(join(root, x))));
const frames = [], handshakes = [], rewrites = [], events = [], sockets = new Set();
const frame = body => { const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]); return Buffer.concat([head, data]); };
let sequence = 0;
const server = createServer((req, res) => res.writeHead(500).end());
server.on('upgrade', (req, socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); handshakes.push({ path: req.url, hasAuthorization: !!req.headers.authorization, headerNames: Object.keys(req.headers) }); const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'); socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'); let pending = Buffer.alloc(0); socket.on('data', chunk => { pending = Buffer.concat([pending, chunk]); while (pending.length >= 2) {
    const opcode = pending[0] & 15, masked = !!(pending[1] & 128);
    let len = pending[1] & 127, offset = 2;
    if (len === 126) {
        if (pending.length < 4)
            return;
        len = pending.readUInt16BE(2);
        offset = 4;
    }
    else if (len === 127) {
        if (pending.length < 10)
            return;
        len = Number(pending.readBigUInt64BE(2));
        offset = 10;
    }
    const mask = masked ? pending.subarray(offset, offset + 4) : undefined;
    if (masked)
        offset += 4;
    if (pending.length < offset + len)
        return;
    let payload = Buffer.from(pending.subarray(offset, offset + len));
    pending = pending.subarray(offset + len);
    if (masked)
        for (let i = 0; i < payload.length; i++)
            payload[i] ^= mask[i % 4];
    if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
    }
    if (opcode === 9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
    }
    if (opcode !== 1)
        throw new Error('Unexpected WS fixture opcode ' + opcode);
    const body = JSON.parse(payload.toString());
    frames.push(body);
    if (JSON.stringify(body).includes('ABORT_FIXTURE')) {
        requestStarted();
        continue;
    }
    const index = frames.length;
    const message = { id: `msg_${index}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture websocket done', annotations: [] }] };
    const response = { id: `resp_${index}`, object: 'response', created_at: 1, model: 'fixture-model', status: 'completed', output: [message], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const emit = e => socket.write(frame({ ...e, sequence_number: sequence++ }));
    emit({ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } });
    emit({ type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'fixture websocket done' });
    emit({ type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: 'fixture websocket done' });
    emit({ type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] });
    emit({ type: 'response.output_item.done', output_index: 0, item: message });
    emit({ type: 'response.completed', response });
} }); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const port = server.address().port, sessionId = `ws-fixture-${randomUUID()}`, nonce = `fixture_${randomUUID().replaceAll('-', '')}`;
let revision = 0;
const bounded = async (p, label, ms = 6000) => { let t; try {
    return await Promise.race([p, new Promise((_, r) => t = setTimeout(() => r(new Error(label + ' timeout')), ms))]);
}
finally {
    clearTimeout(t);
} };
let realClient, session, policyRevision = 1, consumed = 0;
let requestStarted;
const pendingRequest = new Promise(resolve => { requestStarted = resolve; });
const backend = new CopilotBackend({ rpcTimeoutMs: 5000, cleanupTimeoutMs: 800, pollMs: 10, onPermissionRequest: () => ({ kind: 'reject' }), clientFactory: options => {
        fixtureTransport(options.requestHandler, `http://127.0.0.1:${port}`);
        realClient = new CopilotClient({ ...options, connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [process.env.SUPERAGENT_TEST_COPILOT] }), mode: 'empty', baseDirectory: join(root, 'data'), workingDirectory: join(root, 'empty'), useLoggedInUser: false, env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COPILOT_DISABLE_KEYTAR: '1', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' } });
        const safe = config => ({ ...config, providers: undefined, models: undefined, workingDirectory: join(root, 'empty'), model: 'fixture-model', provider: { type: 'openai', wireApi: 'responses', transport: 'websockets', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-local-fixture-key' }, availableTools: [], excludedTools: ['builtin:*', 'mcp:*'], enableConfigDiscovery: false, enableFileHooks: false, enableHostGitOperations: false, enableSkills: false, skipCustomInstructions: true, enableOnDemandInstructionDiscovery: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionStore: false, enableSessionTelemetry: false, mcpServers: {}, pluginDirectories: [], customAgents: [], additionalDirectories: [], streaming: false, onEvent: e => { config.onEvent?.(e); events.push({ type: e.type, data: e.type === 'session.error' ? e.data : undefined }); } });
        return { start: () => realClient.start(), stop: () => realClient.stop(), forceStop: () => realClient.forceStop(), listSessions: () => realClient.listSessions(), deleteSession: id => realClient.deleteSession(id), getAuthStatus: () => realClient.getAuthStatus(), getStatus: () => realClient.getStatus(), createSession: async (config) => session = await realClient.createSession(safe(config)), resumeSession: async (id, config) => session = await realClient.resumeSession(id, safe(config)) };
    } });
let error;
try {
    const input = { ticketId: 'ws-product-ticket', sessionId, directory: join(root, 'empty'), prompt: 'Reply once.', systemPrompt: 'LOCAL_FIXTURE_REVISION_0', currentSystemPrompt: () => ({ text: `LOCAL_FIXTURE_REVISION_${policyRevision}`, revision: policyRevision }), onConsumed: () => consumed++, tools: [], signal: new AbortController().signal, onEvent: () => { } };
    await bounded(backend.run(input), 'backend run');
    policyRevision = 2;
    await bounded(backend.run({ ...input, prompt: 'Reply again.' }), 'backend resume');
    assert.deepEqual(frames.map(body => Number(/LOCAL_FIXTURE_REVISION_(\d+)/.exec(body.instructions)?.[1])), [1, 2]);
    assert.ok(handshakes.every(item => item.hasAuthorization), 'Fixture transport preserves WS Authorization');
    const abortRun = backend.run({ ...input, prompt: 'ABORT_FIXTURE pending websocket response' });
    await bounded(pendingRequest, 'pending request');
    const start = performance.now();
    await backend.abort(input.ticketId);
    await assert.rejects(bounded(abortRun, 'aborted run', 3000));
    assert.ok(performance.now() - start < 3000);
}
catch (e) {
    error = String(e);
}
finally {
    await bounded(backend.dispose(), 'backend dispose', 4000);
    for (const socket of sockets)
        socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await writeFile(join(root, 'evidence.json'), JSON.stringify({ error, consumed, handshakes, frames, events }, null, 2));
    console.log(JSON.stringify({ error, consumed, handshakes, frames: frames.map(body => ({ type: body.type, keys: Object.keys(body), marker: /LOCAL_FIXTURE_REVISION_\d+/.exec(body.instructions)?.[0] })), directory: root }, null, 2));
    if (error)
        process.exitCode = 1;
}
