import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const { CopilotBackend } = await import(pathToFileURL(process.env.SUPERAGENT_TEST_BACKEND).href);
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
    const shortMarker = join(workspace, 'short-shell-finished');
    const longMarker = join(workspace, 'long-shell-finished');
    const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = (seconds, marker) => quote(process.execPath) + ' -e ' + quote(`setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), ${seconds * 1000})`);
    const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request)
            raw += chunk;
        const body = JSON.parse(raw);
        received.push({ path: request.url, body, at: performance.now() });
        const hasBash = body.tools?.some(row => row.function?.name === 'bash');
        const hasResult = body.messages.some(row => row.role === 'tool');
        let message = { role: 'assistant', content: 'fixture child done' };
        if (hasBash && !hasResult)
            message = { role: 'assistant', content: null, tool_calls: [
                    { id: 'short-bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: command(0.8, shortMarker), description: 'Short harmless shell for handoff', mode: 'async', shellId: 'fixture-short', detach: false }) } },
                    { id: 'long-bash', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: command(12, longMarker), description: 'Long harmless shell cancelled by fixture', mode: 'async', shellId: 'fixture-long', detach: false }) } },
                ] };
        else if (hasBash)
            message = { role: 'assistant', content: null, tool_calls: [{ id: 'handoff-call', type: 'function', function: { name: 'fixture_handoff', arguments: '{}' } }] };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: `chatcmpl_${received.length}`, object: 'chat.completion', created: 1, model: body.model,
            choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    let realClient, session, lookupError, resumeError, promptRevision = 1, initialConsumed = 0, accepted = 0, consumed = 0, steerError;
    let runSettled = false, childRunning = false, rootIdleWithChild = 0;
    const applied = [];
    const safe = config => ({ ...config,
        provider: { type: 'openai', wireApi, baseUrl: `${origin}/v1`, apiKey: 'dummy-local-fixture-key' },
        availableTools: ['builtin:bash', ...config.tools.map(tool => `custom:${tool.name}`)], excludedTools: ['mcp:*'],
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
            const handler = options.requestHandler, send = handler.sendRequest.bind(handler);
            handler.sendRequest = (request, context) => { assert.equal(new URL(request.url).origin, origin); return send(request, context); };
            realClient = new CopilotClient({ ...options,
                connection: RuntimeConnection.forStdio({ path: process.env.SUPERAGENT_TEST_LAUNCHER, args: [cliPath] }),
                mode: 'empty', baseDirectory: join(directory, 'data'), workingDirectory: workspace, useLoggedInUser: false,
                env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, XDG_DATA_HOME: join(directory, 'data'), XDG_CONFIG_HOME: join(directory, 'config'), COPILOT_DISABLE_KEYTAR: '1', COPILOT_GITHUB_TELEMETRY_DISABLED: 'true', COPILOT_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true' },
            });
            return { start: () => realClient.start(), stop: () => realClient.stop(), forceStop: () => realClient.forceStop(), listSessions: () => lookupError ? Promise.reject(lookupError) : realClient.listSessions(),
                deleteSession: id => realClient.deleteSession(id), getAuthStatus: () => realClient.getAuthStatus(), getStatus: () => realClient.getStatus(),
                createSession: async (config) => { session = await realClient.createSession(safe(config)); return session; },
                resumeSession: async (id, config) => { if (resumeError) throw resumeError; session = await realClient.resumeSession(id, safe(config)); return session; },
            };
        },
    });
    try {
        let task, beforeHandoff, handoffAt;
        const controller = new AbortController();
        const input = { ticketId: 'fixture-ticket', sessionId, directory: workspace, prompt: 'Start the harmless native bash fixtures then hand control to the operator', systemPrompt: 'LOCAL_FIXTURE_REVISION_1',
            currentSystemPrompt: () => ({ text: 'LOCAL_FIXTURE_REVISION_1', revision: 1 }), signal: controller.signal, onEvent: () => { },
            tools: [{ name: 'fixture_handoff', description: 'Host fixture report: hand control to operator', schema: { type: 'object', properties: {}, additionalProperties: false },
                    invoke: async () => {
                        beforeHandoff = await session.rpc.tasks.list();
                        task = await session.rpc.tasks.startAgent({ agentType: 'fixture-agent', prompt: 'BACKGROUND_FIXTURE no external authority', name: 'fixture-child', model: 'fixture-model' });
                        handoffAt = performance.now();
                        backend.handoff('fixture-ticket');
                        return 'Operator owns the shell fixtures';
                    } }],
        };
        await bounded(backend.run(input), 'product handoff', 10000);
        assert.ok(handoffAt, 'Host handoff tool executed');
        const parked = await bounded(session.rpc.tasks.list(), 'parked tasks');
        const shellRows = parked.tasks.filter(row => row.type === 'shell');
        assert.equal(shellRows.length, 2, 'Both native attached shells tracked');
        assert.ok(shellRows.every(row => row.attachmentMode === 'attached'));
        assert.equal(shellRows.find(row => row.id.includes('fixture-long') || row.command?.includes(longMarker))?.status, 'running', 'Long shell survives operator handoff');
        const childStatus = parked.tasks.find(row => row.id === task.agentId)?.status;
        assert.equal(childStatus, 'cancelled', 'Native child cancelled at handoff');
        const forwardedAtPark = received.length;
        const until = Date.now() + 3000;
        while (Date.now() < until) {
            try {
                await readFile(shortMarker);
                break;
            }
            catch {
                await new Promise(resolve => setTimeout(resolve, 40));
            }
        }
        assert.equal(await readFile(shortMarker, 'utf8'), 'done', 'Short shell survives handoff to completion');
        await new Promise(resolve => setTimeout(resolve, 150));
        assert.equal(received.length, forwardedAtPark, 'Background completion cannot forward a model request after handoff');
        const afterCompletion = await bounded(session.rpc.tasks.list(), 'post completion tasks');
        const originalSession = session;
        lookupError = new Error('Fixture continuation lookup failure');
        await assert.rejects(bounded(backend.run(input), 'failed continuation lookup'), /Fixture continuation lookup failure/);
        lookupError = undefined;
        resumeError = new Error('Fixture continuation resume failure');
        await assert.rejects(bounded(backend.run(input), 'failed continuation resume'), /Fixture continuation resume failure/);
        resumeError = undefined;
        assert.equal(session, originalSession, 'Failed continuations preserve the parked connection');
        const afterFailures = await bounded(session.rpc.tasks.list(), 'retained tasks after attachment failures');
        assert.equal(afterFailures.tasks.find(row => row.command?.includes(longMarker))?.status, 'running', 'Failed continuations retain the attached shell');
        await bounded(backend.run({ ...input, prompt: 'Resume the retained native shells and hand control back to the operator' }), 'successful native continuation', 10000);
        assert.notEqual(session, originalSession, 'Continuation attaches a replacement SDK session');
        const afterResume = await bounded(session.rpc.tasks.list(), 'resumed retained tasks');
        assert.equal(afterResume.tasks.find(row => row.command?.includes(longMarker))?.status, 'running', 'Successful continuation retains the original attached shell');
        let afterAbort, afterDispose;
        if (stopMode === 'abort') {
            await bounded(backend.abort('fixture-ticket'), 'explicit operator stop', 3000);
            afterAbort = await bounded(session.rpc.tasks.list(), 'aborted tasks');
            assert.ok(afterAbort.tasks.filter(row => row.type === 'shell').every(row => !['running', 'idle'].includes(row.status)), 'Explicit abort cancels remaining operator shells');
        }
        else {
            const pid = shellRows.find(row => row.command?.includes(longMarker))?.pid;
            assert.ok(pid, 'Attached shell reports a process ID');
            await bounded(backend.dispose(), 'explicit dispose parked shell', 3000);
            const deadline = Date.now() + 2000;
            let alive = true;
            while (Date.now() < deadline) {
                try {
                    process.kill(pid, 0);
                    await new Promise(resolve => setTimeout(resolve, 30));
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        throw error;
                    alive = false;
                    break;
                }
            }
            assert.equal(alive, false, 'Dispose terminates parked attached shell process');
            afterDispose = { pid, alive };
        }
        await assert.rejects(readFile(longMarker), { code: 'ENOENT' });
        const evidence = { stopMode, beforeHandoff, parked, afterCompletion, afterFailures, afterResume, afterAbort, afterDispose, forwardedAtPark, forwardedAfterCompletion: received.length, handoffAt,
            events: events.filter(event => ['system.notification', 'session.error', 'assistant.idle', 'session.idle', 'session.background_tasks_changed'].includes(event.type)) };
        await writeFile(join(directory, 'handoff-evidence.json'), JSON.stringify(evidence, null, 2));
        return { passed: true, stopMode, shellCount: shellRows.length, childStatus,
            forwardedAtPark, forwardedAfterCompletion: received.length, directory };
    }
    finally {
        await bounded(backend.dispose(), 'backend dispose', 5000);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
const stopMode = process.argv[2] ?? 'abort';
assert.ok(['abort', 'dispose'].includes(stopMode));
const summary = [];
for (const format of ['completions'])
    summary.push(await exercise(format));
console.log(JSON.stringify({ passed: true, summary }, null, 2));
