import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pathToFileURL as fixtureURL } from 'node:url';
const { CopilotBackend } = await import(fixtureURL(process.env.SUPERAGENT_TEST_BACKEND).href);
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const sdkDirectory = resolve(process.env.SUPERAGENT_TEST_SDK);
const cliPath = resolve(process.env.SUPERAGENT_TEST_COPILOT);
const { version } = JSON.parse(await readFile(join(sdkDirectory, 'package.json'), 'utf8'));
assert.equal(version, '1.0.28', 'Fixture qualification is pinned to SDK 1.0.28');
const { CopilotClient, RuntimeConnection, CopilotRequestHandler } = await import(pathToFileURL(join(sdkDirectory, 'dist/index.js')).href);
const bounded = async (work, label, ms = 8000) => {
    let timer;
    try {
        return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]);
    }
    finally {
        clearTimeout(timer);
    }
};
async function exercise(wireApi) {
    const directory = await mkdtemp(join(tmpdir(), `copilot-offline-${wireApi}-`));
    const workspace = join(directory, 'empty');
    await Promise.all(['empty', 'data', 'config'].map(name => mkdir(join(directory, name))));
    const sessionId = `fixture-${randomUUID()}`;
    const events = [], sent = [], received = [], children = new Set();
    let revision = 0, toolCalls = 0, steerId;
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request)
            raw += chunk;
        const body = JSON.parse(raw);
        const instructions = wireApi === 'responses' ? body.instructions : body.messages.filter(row => row.role === 'system' || row.role === 'developer').map(row => row.content).join('\n');
        received.push({ path: request.url, revision: Number(/LOCAL_FIXTURE_REVISION_(\d+)/.exec(instructions)?.[1]), body });
        const tool = body.tools?.some(row => (row.function?.name ?? row.name) === 'fixture_tick');
        const hasResult = wireApi === 'responses' ? body.input?.some(row => row.type === 'function_call_output') : body.messages.some(row => row.role === 'tool');
        const call = tool && !hasResult;
        const index = received.length;
        // Give the host time to observe the child while its fake response is pending.
        if (JSON.stringify(body).includes('BACKGROUND_FIXTURE'))
            await new Promise(resolve => setTimeout(resolve, 100));
        response.writeHead(200, { 'content-type': 'application/json' });
        if (wireApi === 'responses') {
            response.end(JSON.stringify({ id: `resp_${index}`, object: 'response', created_at: 1, status: 'completed', model: body.model,
                output: call ? [{ type: 'function_call', id: `fc_${index}`, call_id: 'fixture-call', name: 'fixture_tick', arguments: '{}', status: 'completed' }]
                    : [{ type: 'message', id: `msg_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'fixture done', annotations: [] }] }],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
        }
        else {
            response.end(JSON.stringify({ id: `chatcmpl_${index}`, object: 'chat.completion', created: 1, model: body.model,
                choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call
                            ? { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'fixture_tick', arguments: '{}' } }] }
                            : { role: 'assistant', content: 'fixture done' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let realClient, session, promptRevision = 1, initialConsumed = 0, accepted = 0, consumed = 0, steerError;
    let runSettled = false, childRunning = false, rootIdleWithChild = 0;
    const applied = [];
    const safe = config => ({ ...config,
        provider: { type: 'openai', wireApi, baseUrl: `${origin}/v1`, apiKey: 'dummy-local-fixture-key' },
        availableTools: config.tools.map(tool => `custom:${tool.name}`), excludedTools: ['builtin:*', 'mcp:*'],
        configDirectory: join(directory, 'config'),
        enableConfigDiscovery: false, enableFileHooks: false, enableHostGitOperations: false, enableSkills: false, skipCustomInstructions: true,
        enableOnDemandInstructionDiscovery: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: 'in-memory', enableSessionStore: false, enableSessionTelemetry: false,
        mcpServers: {}, pluginDirectories: [], additionalDirectories: [], infiniteSessions: { enabled: false }, streaming: false,
        customAgents: [{ name: 'fixture-agent', description: 'Harmless no-tool child', prompt: 'Reply with fixture done', tools: [], mcpServers: {}, model: 'fixture-model', modelPolicy: 'required' }],
        onEvent: event => { if (event.type === 'subagent.completed')
            childRunning = false; if (event.type === 'assistant.idle' && !event.agentId && childRunning) {
            assert.equal(runSettled, false, 'Lease must survive root idle with active child');
            rootIdleWithChild++;
        } events.push(event); config.onEvent?.(event); },
    });
    const backend = new CopilotBackend({ rpcTimeoutMs: 6000, cleanupTimeoutMs: 1000, pollMs: 10, backgroundTimeoutMs: 4000,
        onPermissionRequest: () => ({ kind: 'approve-once' }),
        clientFactory: options => {
            const handler = options.requestHandler;
            const send = handler.sendRequest.bind(handler);
            handler.sendRequest = (request, context) => { assert.equal(new URL(request.url).origin, origin); return send(request, context); };
            realClient = new CopilotClient({ ...options,
                connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [cliPath] }),
                mode: 'empty', baseDirectory: join(directory, 'data'), workingDirectory: workspace, useLoggedInUser: false,
                env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, COPILOT_DISABLE_KEYTAR: '1', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' },
            });
            return { start: () => realClient.start(), stop: () => realClient.stop(), forceStop: () => realClient.forceStop(), listSessions: () => realClient.listSessions(),
                deleteSession: id => realClient.deleteSession(id), getAuthStatus: () => realClient.getAuthStatus(), getStatus: () => realClient.getStatus(),
                createSession: async (config) => { session = await realClient.createSession(safe(config)); return session; },
                resumeSession: async (id, config) => { session = await realClient.resumeSession(id, safe(config)); return session; },
            };
        },
    });
    try {
        let task;
        const controller = new AbortController();
        const input = { ticketId: 'fixture-ticket', sessionId, directory: workspace, prompt: 'Run fixture_tick once, then reply', systemPrompt: 'LOCAL_FIXTURE_REVISION_0',
            currentSystemPrompt: () => ({ text: `LOCAL_FIXTURE_REVISION_${promptRevision}`, revision: promptRevision }), onPromptApplied: revision => applied.push(revision),
            onConsumed: () => { initialConsumed++; }, signal: controller.signal, onEvent: () => { },
            tools: [{ name: 'fixture_tick', description: 'Harmless fixture counter', schema: { type: 'object', properties: {}, additionalProperties: false },
                    invoke: async () => {
                        toolCalls++;
                        promptRevision = 2;
                        try {
                            await backend.steer({ ticketId: 'fixture-ticket', requestId: 'human-1', prompt: 'STEER_FIXTURE human continuation', signal: controller.signal,
                                onAccepted: () => { accepted++; }, onConsumed: () => { consumed++; } });
                        }
                        catch (error) {
                            steerError = String(error);
                        }
                        task = await session.rpc.tasks.startAgent({ agentType: 'fixture-agent', prompt: 'BACKGROUND_FIXTURE reply done', name: 'fixture-child', model: 'fixture-model' });
                        childRunning = true;
                        assert.equal(runSettled, false, 'Worker lease must outlive active background task');
                        return 'fixture tool done';
                    } }],
        };
        const running = backend.run(input).finally(() => { runSettled = true; });
        await bounded(running, 'product worker run', 10000);
        const status = await bounded(realClient.getStatus(), 'status');
        assert.deepEqual(status, { version: '1.0.105', protocolVersion: 3 });
        assert.equal(toolCalls, 1);
        assert.equal(steerError, undefined);
        assert.equal(accepted, 1);
        assert.equal(consumed, 1);
        assert.equal(initialConsumed, 1);
        assert.ok(rootIdleWithChild > 0, 'Observed root idle before child completion while lease remained held');
        assert.equal(steerError, undefined);
        assert.equal(accepted, 1);
        assert.equal(consumed, 1);
        const captured = received.map(row => row.revision);
        assert.equal(captured[0], 1);
        assert.ok(captured.slice(1).every(value => value === 2), 'Root tool continuation, child, and completion wakeup receive current revision');
        assert.ok(events.some(event => event.type === 'system.notification' && event.data.kind?.type === 'agent_idle'));
        promptRevision = 3;
        await bounded(backend.run({ ...input, prompt: 'Reply without tools', tools: [] }), 'resume human turn', 10000);
        assert.equal(received.at(-1).revision, 3);
        const finished = { wireApi, status, rootIdleWithChild, steerError, accepted, consumed, initialConsumed, applied, revisions: received.map(row => row.revision), taskId: task?.agentId,
            events: events.filter(event => ['user.message', 'system.notification', 'assistant.idle', 'session.idle'].includes(event.type)) };
        await writeFile(join(directory, 'product-evidence.json'), JSON.stringify(finished, null, 2));
        return { wireApi, rootIdleWithChild, steerError, accepted, consumed, applied, revisions: received.map(row => row.revision), directory };
    }
    finally {
        await bounded(backend.dispose(), 'backend dispose', 5000);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
const summary = [];
for (const format of ['completions', 'responses'])
    summary.push(await exercise(format));
console.log(JSON.stringify({ passed: true, summary }, null, 2));
