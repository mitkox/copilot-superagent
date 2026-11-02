import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import type { CopilotClientOptions, SessionConfig, ResumeSessionConfig, SessionMetadata } from '@github/copilot-sdk'
import { CopilotBackend, type CopilotBackendOptions, type CopilotClientConnection, type CopilotSessionConnection } from '../src/copilot.ts'
import type { AgentEvent, AgentRun } from '../src/agent-backend.ts'

class FakeSession implements CopilotSessionConnection {
  rpc?: CopilotSessionConnection['rpc']
  abortCount = 0
  disconnectCount = 0
  sends = 0
  constructor(readonly sessionId: string, readonly config: SessionConfig | ResumeSessionConfig, private readonly client: FakeClient) {}
  async sendAndWait() { this.sends++; return this.client.send(this.config, this) }
  async abort() { this.abortCount++ }
  async disconnect() { this.disconnectCount++ }
}

class FakeClient implements CopilotClientConnection {
  created: FakeSession[] = []
  resumed: FakeSession[] = []
  deleted: string[] = []
  sessions: SessionMetadata[] = []
  lookupCount = 0
  startCount = 0
  stopCount = 0
  lookupError?: Error
  resumeError?: Error
  createError?: Error
  transientLookups = 0
  send: (config: SessionConfig | ResumeSessionConfig, session: FakeSession) => Promise<unknown> = async () => undefined
  async start() { this.startCount++ }
  async stop() { this.stopCount++; return [] }
  async getAuthStatus() { return { isAuthenticated: true, login: 'test-user' } }
  async getStatus() { return { version: '1.0.105', protocolVersion: 3 } }
  async listSessions() {
    this.lookupCount++
    if (this.transientLookups-- > 0) throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })
    if (this.lookupError) throw this.lookupError
    return this.sessions
  }
  async createSession(config: SessionConfig) {
    if (this.createError) throw this.createError
    const session = new FakeSession(config.sessionId!, config, this)
    this.created.push(session)
    this.sessions.push({ sessionId: session.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
      context: { workingDirectory: config.workingDirectory! } })
    return session
  }
  async resumeSession(sessionId: string, config: ResumeSessionConfig) {
    if (this.resumeError) throw this.resumeError
    const session = new FakeSession(sessionId, config, this)
    this.resumed.push(session)
    return session
  }
  async deleteSession(sessionId: string) { this.deleted.push(sessionId) }
}

function fixture(t: TestContext, options: Partial<CopilotBackendOptions> = {}) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'superagent-copilot-test-')))
  const client = new FakeClient()
  let clientOptions: CopilotClientOptions | undefined
  const backend = new CopilotBackend({
    cliPath: '/installed/copilot',
    onPermissionRequest: () => ({ kind: 'reject' }),
    ...options,
    clientFactory: config => { clientOptions = config; return client },
  })
  const events: AgentEvent[] = []
  const input: AgentRun = {
    ticketId: 'ticket-a', sessionId: 'stable-ticket-a', directory,
    prompt: 'Implement the scoped task', systemPrompt: 'Worker instructions v1',
    tools: [], signal: new AbortController().signal, onEvent: event => events.push(event),
  }
  t.after(async () => { await backend.dispose(); rmSync(directory, { recursive: true, force: true }) })
  return { backend, client, input, events, clientOptions: () => clientOptions! }
}

async function parkedShell(t: TestContext) {
  const f = fixture(t)
  let running = true, cancellations = 0
  const rpc = {
    tasks: {
      list: async () => ({ tasks: [{ id: 'retained-shell', type: 'shell', status: running ? 'running' : 'cancelled' }] }),
      cancel: async () => { running = false; cancellations++ },
    },
    metadata: { isProcessing: async () => ({ processing: false }) },
  } as unknown as CopilotSessionConnection['rpc']
  f.client.send = async (_config, session) => { session.rpc = rpc; f.backend.handoff(f.input.ticketId) }
  await f.backend.run(f.input)
  return { ...f, session: f.client.created[0]!, running: () => running, cancellations: () => cancellations }
}

test('stdio uses the installed CLI and suppresses inherited telemetry exporters', async t => {
  const f = fixture(t)
  const config = f.clientOptions()
  assert.deepEqual(config.connection, { kind: 'stdio', path: '/installed/copilot', args: undefined, env: undefined })
  assert.equal(config.telemetry, undefined)
  assert.equal(config.env?.COPILOT_GITHUB_TELEMETRY_DISABLED, 'true')
  assert.equal(config.env?.OTEL_SDK_DISABLED, 'true')
  assert.equal(config.env?.OTEL_EXPORTER_OTLP_ENDPOINT, undefined)
  assert.deepEqual(await f.backend.check(), { authenticated: true, cliVersion: '1.0.105', protocolVersion: 3, login: 'test-user' })
  assert.equal(f.client.created.length, 0)
})

test('ambient custom-provider, model, injection and alternate-profile configuration never reaches the CLI', async t => {
  const unsafe = {
    COPILOT_PROVIDER_BASE_URL: 'https://custom.example/v1', COPILOT_PROVIDER_API_KEY: 'fixture-secret',
    COPILOT_PROVIDERS_CONFIG: '/untrusted/providers.json', COPILOT_HOME: '/untrusted/profile',
    COPILOT_MODEL: 'custom/model', COPILOT_OFFLINE: 'true', COPILOT_CLI_PATH: '/untrusted/copilot',
    COPILOT_API_URL: 'https://custom.example', COPILOT_GH_HOST: 'custom.example',
    OPENAI_API_KEY: 'fixture-secret', DEEPSEEK_API_KEY: 'fixture-secret',
    NODE_OPTIONS: '--import=/untrusted/loader.js', LD_PRELOAD: '/untrusted/library.so',
  }
  for (const [name, value] of Object.entries(unsafe)) { const previous = process.env[name]; process.env[name] = value; t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous }) }
  const f = fixture(t)
  const env = f.clientOptions().env!
  for (const name of Object.keys(unsafe).filter(name => !['COPILOT_PROVIDERS_CONFIG', 'COPILOT_GH_HOST'].includes(name))) assert.equal(env[name], undefined, name)
  assert.equal(env.COPILOT_GH_HOST, 'github.com')
  assert.notEqual(env.COPILOT_PROVIDERS_CONFIG, unsafe.COPILOT_PROVIDERS_CONFIG)
  const registry = env.COPILOT_PROVIDERS_CONFIG!
  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')), { providers: [], models: [] })
  await f.backend.run(f.input)
  const config = f.client.created[0]!.config
  assert.equal(config.enableConfigDiscovery, false)
  assert.equal(config.enableFileHooks, false)
  assert.equal(config.enableSkills, false)
  assert.deepEqual(config.pluginDirectories, [])
  assert.deepEqual(config.customAgents, [])
  assert.deepEqual(config.mcpServers, {})
  assert.deepEqual(config.providers, [])
  assert.deepEqual(config.models, [])
  await f.backend.dispose()
  assert.equal(existsSync(registry), false)
})

test('provider-qualified models cannot create, resume or assess a session', async t => {
  const f = fixture(t)
  await assert.rejects(f.backend.run({ ...f.input, model: 'local/deepseek-r1' }), /Copilot-only/)
  await assert.rejects(f.backend.assess('Facts', new AbortController().signal, 'local/deepseek-r1'), /Copilot-only/)
  assert.equal(f.client.created.length, 0)
  assert.equal(f.client.resumed.length, 0)
  await f.backend.run(f.input)
  await assert.rejects(f.backend.run({ ...f.input, model: 'local/deepseek-r1' }), /Copilot-only/)
  assert.equal(f.client.resumed.length, 0)
})

test('unreviewed CLI versions and arbitrary authentication hosts fail closed', async t => {
  assert.throws(() => fixture(t, { githubHost: 'custom.example' }), /Copilot-only/)
  const f = fixture(t)
  f.client.getStatus = async () => ({ version: '1.0.106', protocolVersion: 3 })
  await assert.rejects(f.backend.run(f.input), /requires reviewed Copilot CLI/)
  assert.equal(f.client.created.length, 0)
  assert.equal(f.client.resumed.length, 0)
})

test('cancelling one ticket does not poison shared CLI startup for another caller', async t => {
  const f = fixture(t), controller = new AbortController()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const starting = new Promise<void>(resolve => { started = resolve })
  f.client.start = async () => { started(); await gate }
  const ticket = f.backend.run({ ...f.input, signal: controller.signal })
  const rejected = assert.rejects(ticket, /abort/i)
  await starting
  const independent = f.backend.check()
  controller.abort()
  await rejected
  release()
  assert.equal((await independent).authenticated, true)
  await f.backend.run({ ...f.input, ticketId: 'ticket-b', sessionId: 'stable-ticket-b' })
  assert.equal(f.client.created.length, 1)
  assert.equal(f.client.created[0]!.sessionId, 'stable-ticket-b')
})

test('a stable ticket creates once then resumes in its worktree with current instructions and model', async t => {
  const f = fixture(t, { model: 'configured-model' })
  await f.backend.run(f.input)
  await f.backend.run({ ...f.input, prompt: 'An authorized follow-up', systemPrompt: 'Worker instructions v2', model: 'selected-model' })
  assert.equal(f.client.created.length, 1)
  assert.equal(f.client.resumed.length, 1)
  assert.equal(f.client.created[0]!.sessionId, f.input.sessionId)
  assert.equal(f.client.created[0]!.config.model, 'configured-model')
  const resumed = f.client.resumed[0]!
  assert.equal(resumed.config.workingDirectory, f.input.directory)
  assert.deepEqual(resumed.config.additionalDirectories, [])
  assert.equal(resumed.config.systemMessage?.mode, 'append')
  assert.match(String(resumed.config.systemMessage?.content), /Worker instructions v2/)
  assert.equal(resumed.config.model, 'selected-model')
  assert.equal('continuePendingWork' in resumed.config && resumed.config.continuePendingWork, false)
  assert.equal('allowTranscriptRecovery' in resumed.config && resumed.config.allowTranscriptRecovery, false)
  assert.equal(resumed.disconnectCount, 1)
  assert.deepEqual(f.client.deleted, [])
})

test('a new backend resumes a verified persistent session without relying on process memory', async t => {
  const f = fixture(t)
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: f.input.directory } })
  await f.backend.run(f.input)
  assert.equal(f.client.resumed.length, 1)
  assert.equal(f.client.created.length, 0)
})

test('provider lookup and resume errors never create replacement conversations', async t => {
  const f = fixture(t)
  f.client.lookupError = new Error('Authentication required')
  await assert.rejects(f.backend.run(f.input), /Authentication required/)
  assert.equal(f.client.lookupCount, 1)
  assert.equal(f.client.created.length, 0)
  f.client.lookupError = undefined
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: f.input.directory } })
  f.client.resumeError = new Error('Service unavailable during resume')
  await assert.rejects(f.backend.run(f.input), /Service unavailable/)
  assert.equal(f.client.created.length, 0)
})

for (const failure of ['lookup', 'resume'] as const) test(`a failed ${failure} retains the parked shell lease for a later stop`, async t => {
  const f = await parkedShell(t)
  f.client[failure === 'lookup' ? 'lookupError' : 'resumeError'] = new Error('Fixture attachment failure')
  await assert.rejects(f.backend.run(f.input), /Fixture attachment failure/)
  assert.equal(f.running(), true)
  assert.equal(f.session.disconnectCount, 0)
  await f.backend.abort(f.input.ticketId)
  assert.equal(f.running(), false)
  assert.equal(f.cancellations(), 1)
  assert.equal(f.session.abortCount, 1)
})

test('a successful continuation transfers the parked lease without detaching the resumed session', async t => {
  const f = await parkedShell(t)
  f.client.sessions = [] // The native session list can omit an attached in-memory session.
  await f.backend.run(f.input)
  assert.equal(f.client.resumed.length, 1)
  assert.equal(f.session.disconnectCount, 0)
  assert.equal(f.running(), true)
  await f.backend.abort(f.input.ticketId)
  assert.equal(f.running(), false)
  assert.equal(f.cancellations(), 1)
  assert.equal(f.client.resumed[0]!.abortCount, 1)
})

test('a parked lease cannot be transferred to a different stable session', async t => {
  const f = await parkedShell(t)
  await assert.rejects(f.backend.run({ ...f.input, sessionId: 'another-session' }), /Parked Copilot session does not match/)
  assert.equal(f.running(), true)
  assert.equal(f.client.resumed.length, 0)
  await f.backend.abort(f.input.ticketId)
  assert.equal(f.running(), false)
})

test('a continuation reserves its ticket before any asynchronous lease transition', async t => {
  const f = await parkedShell(t)
  let release!: () => void, lookedUp!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const lookup = new Promise<void>(resolve => { lookedUp = resolve })
  f.client.listSessions = async () => { lookedUp(); await gate; return f.client.sessions }
  const first = f.backend.run(f.input)
  try {
    await assert.rejects(f.backend.run(f.input), /already owns/)
    await lookup
  } finally { release(); await first }
  assert.equal(f.client.resumed.length, 1)
})

test('a continuation stays fenced while cancellation of the parked shell is pending', async t => {
  const f = await parkedShell(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  f.session.rpc!.tasks.cancel = async () => { await gate; return {} as never }
  const stopping = f.backend.abort(f.input.ticketId)
  try { await assert.rejects(f.backend.run(f.input), /already owns/) }
  finally { release(); await stopping }
})

for (const control of ['abort', 'signal', 'dispose'] as const) test(`${control} during continuation lookup cancels the parked shell and fences late attachment`, async t => {
  const f = await parkedShell(t)
  let release!: () => void, lookedUp!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const lookup = new Promise<void>(resolve => { lookedUp = resolve })
  f.client.listSessions = async () => { lookedUp(); await gate; return f.client.sessions }
  const controller = new AbortController()
  const continued = f.backend.run({ ...f.input, signal: controller.signal })
  const rejected = assert.rejects(continued, /abort/i)
  await lookup
  if (control === 'signal') controller.abort()
  else if (control === 'abort') await f.backend.abort(f.input.ticketId)
  else await f.backend.dispose()
  release()
  await rejected
  assert.equal(f.running(), false)
  assert.equal(f.cancellations(), 1)
  assert.equal(f.client.resumed.length, 0)
  assert.equal(f.client.created.length, 1)
})

test('read-only lookups retry transient failures within a bound', async t => {
  const f = fixture(t)
  f.client.transientLookups = 2
  await f.backend.run(f.input)
  assert.equal(f.client.lookupCount, 3)
  assert.equal(f.client.created.length, 1)
  f.client.transientLookups = 9
  await assert.rejects(f.backend.run(f.input), /Connection reset/)
  assert.equal(f.client.lookupCount, 6)
  assert.equal(f.client.resumed.length, 0)
})

test('persisted remote or mismatched worktree sessions fail before execution', async t => {
  const f = fixture(t)
  f.client.sessions.push({ sessionId: f.input.sessionId, startTime: new Date(), modifiedTime: new Date(), isRemote: false,
    context: { workingDirectory: '/another/worktree' } })
  await assert.rejects(f.backend.run(f.input), /does not match/)
  f.client.sessions[0]!.context = { workingDirectory: f.input.directory }
  f.client.sessions[0]!.isRemote = true
  await assert.rejects(f.backend.run(f.input), /does not match/)
  assert.equal(f.client.resumed.length + f.client.created.length, 0)
})

test('a stable session cannot be assigned to another ticket', async t => {
  const f = fixture(t)
  await f.backend.run(f.input)
  await assert.rejects(f.backend.run({ ...f.input, ticketId: 'ticket-b' }), /another ticket/)
})

test('worker custom tools report through host handlers and transcript streams nested assistant output', async t => {
  const f = fixture(t)
  let reports = 0
  f.input.tools = [{ name: 'superagent_report', description: 'Report progress', schema: { type: 'object' }, invoke: async args => { reports++; return args } }]
  f.client.send = async config => {
    const tool = config.tools![0]!
    assert.equal(tool.skipPermission, undefined)
    assert.deepEqual(await tool.handler!({ summary: 'Implemented' }, { sessionId: f.input.sessionId, toolCallId: 'call-a', toolName: tool.name, arguments: {} }), { summary: 'Implemented' })
    config.onEvent!({ type: 'assistant.message_delta', id: 'event-a', parentId: null, timestamp: '2026-11-01T00:00:00Z', ephemeral: true,
      agentId: 'nested-agent', data: { deltaContent: 'Working', messageId: 'message-a' } })
  }
  await f.backend.run(f.input)
  assert.equal(reports, 1)
  assert.deepEqual(f.events, [{ type: 'assistant.message_delta', text: '[nested-agent] Working', at: '2026-11-01T00:00:00Z' }])
})

test('sent turn failures abort once without replaying custom external writes', async t => {
  const f = fixture(t)
  let writes = 0
  f.client.send = async () => { writes++; throw Object.assign(new Error('connection reset after external write'), { code: 'ECONNRESET' }) }
  await assert.rejects(f.backend.run(f.input), /after external write/)
  assert.equal(writes, 1)
  assert.equal(f.client.created[0]!.abortCount, 1)
})

for (const fail of [false, true]) test(`native worker submission waits for its own consumed message and ${fail ? 'propagates a correlated failure' : 'settles without an SDK wait timer'}`, async t => {
  const f = fixture(t, { pollMs: 1 })
  let submitted!: () => void
  const submission = new Promise<void>(resolve => { submitted = resolve })
  const create = f.client.createSession.bind(f.client)
  f.client.createSession = async config => {
    const session = await create(config)
    Object.assign(session, {
      send: async () => { submitted(); return 'current-message' },
      rpc: { tasks: { list: async () => ({ tasks: [] }) }, metadata: { isProcessing: async () => ({ processing: false }) } },
    })
    return session
  }
  let settled = false
  const run = f.backend.run(f.input).finally(() => { settled = true })
  const outcome = fail ? assert.rejects(run, /Current request failed/) : run
  await submission
  const config = f.client.created[0]!.config
  config.onEvent!({ type: 'user.message', id: 'unrelated', parentId: null, timestamp: new Date().toISOString(), data: { content: 'Other input', messageId: 'other-message' } })
  config.onEvent!({ type: 'session.error', id: 'unrelated-error', parentId: null, timestamp: new Date().toISOString(), data: { message: 'Previous request failed', errorType: 'query', originatingMessageId: 'other-message' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false)
  if (fail) config.onEvent!({ type: 'session.error', id: 'current-error', parentId: null, timestamp: new Date().toISOString(), data: { message: 'Current request failed', errorType: 'query', originatingMessageId: 'current-message' } })
  else config.onEvent!({ type: 'user.message', id: 'current', parentId: null, timestamp: new Date().toISOString(), data: { content: f.input.prompt, messageId: 'current-message' } })
  await outcome
  assert.equal(f.client.created[0]!.sends, 0, 'Native workers do not create SDK sendAndWait timers')
  assert.equal(f.client.created[0]!.abortCount, fail ? 1 : 0)
})

test('host permission denials and managed interactive one-time approval are enforced', async t => {
  let decision: Awaited<ReturnType<CopilotBackendOptions['onPermissionRequest']>> = { kind: 'reject' }
  const f = fixture(t, { onPermissionRequest: (request, context) => {
    assert.equal(context.ticketId, 'ticket-a')
    assert.equal(context.rootSessionId, 'stable-ticket-a')
    assert.equal(context.sessionId, 'native-child-session')
    assert.equal(context.directory, f.input.directory)
    assert.equal(request.kind, 'read')
    return decision
  } })
  f.client.send = async config => {
    const request = { kind: 'read' as const, intention: 'Inspect', path: f.input.directory, managedApprovalRequired: true }
    const invocation = { sessionId: 'native-child-session', managedSettingsEnabled: true }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'reject')
    decision = { kind: 'approve-once' }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'reject')
    decision = { kind: 'approve-once', approvedInteractively: true }
    assert.equal((await config.onPermissionRequest!(request, invocation)).kind, 'approve-once')
  }
  await f.backend.run(f.input)
})

test('abort revokes nested hooks, permission requests, and custom tool handlers before stopping the turn', async t => {
  const f = fixture(t, { onPermissionRequest: () => ({ kind: 'approve-once' }) })
  let started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  let config!: SessionConfig | ResumeSessionConfig
  f.input.tools = [{ name: 'report', description: 'Report', schema: {}, invoke: async () => { throw new Error('must not invoke') } }]
  f.client.send = async current => { config = current; started(); return new Promise(() => {}) }
  const run = f.backend.run(f.input)
  await running
  await f.backend.abort('ticket-a')
  await assert.rejects(run, /abort/i)
  assert.equal(f.client.created[0]!.abortCount, 1)
  assert.deepEqual(await config.hooks!.onPreToolUse!({ toolName: 'bash', toolArgs: {}, agentId: 'child', sessionId: 'child-session', timestamp: new Date(), workingDirectory: f.input.directory }, { sessionId: 'child-session' }), {
    permissionDecision: 'deny', permissionDecisionReason: 'Ticket authority has ended',
  })
  assert.equal((await config.onPermissionRequest!({ kind: 'read', path: f.input.directory, intention: 'Read' }, { sessionId: 'child-session' })).kind, 'reject')
  await assert.rejects(Promise.resolve().then(() => config.tools![0]!.handler!({}, { sessionId: 'child-session', toolCallId: 'late', toolName: 'report', arguments: {} })), /abort|authority/i)
})

test('an already aborted signal never starts the SDK', async t => {
  const f = fixture(t)
  await assert.rejects(f.backend.run({ ...f.input, signal: AbortSignal.abort() }), /abort/i)
  assert.equal(f.client.startCount, 0)
})

test('cancellation while creating a session aborts the returned session before any prompt is sent', async t => {
  const f = fixture(t)
  let created!: () => void
  let release!: () => void
  const creation = new Promise<void>(resolve => { created = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const create = f.client.createSession.bind(f.client)
  f.client.createSession = async config => { const session = await create(config); created(); await gate; return session }
  const controller = new AbortController()
  const running = f.backend.run({ ...f.input, signal: controller.signal })
  await creation
  controller.abort()
  release()
  await assert.rejects(running, /abort/i)
  assert.equal(f.client.created[0]!.sends, 0)
  assert.equal(f.client.created[0]!.abortCount, 1)
})

test('a permission approval that arrives after cancellation is rejected', async t => {
  let allow!: () => void
  const approval = new Promise<void>(resolve => { allow = resolve })
  const f = fixture(t, { onPermissionRequest: async () => { await approval; return { kind: 'approve-once', approvedInteractively: true } } })
  let requested!: () => void
  const request = new Promise<void>(resolve => { requested = resolve })
  let result: Promise<unknown> | undefined
  f.client.send = async config => {
    result = Promise.resolve(config.onPermissionRequest!({ kind: 'read', path: f.input.directory, intention: 'Read' }, { sessionId: f.input.sessionId }))
    requested()
    return new Promise(() => {})
  }
  const running = f.backend.run(f.input)
  await request
  await f.backend.abort(f.input.ticketId)
  allow()
  await assert.rejects(running, /abort/i)
  assert.deepEqual(await result, { kind: 'reject', feedback: 'Ticket authority has ended' })
})

test('assessment has an isolated empty worktree and exactly one structured terminal tool', async t => {
  const f = fixture(t)
  f.client.send = async config => {
    assert.notEqual(config.workingDirectory, f.input.directory)
    assert.deepEqual(config.availableTools, ['custom:superagent_assessment_outcome'])
    assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*'])
    assert.equal(config.enableFileHooks, false)
    assert.equal(config.enableConfigDiscovery, false)
    assert.equal(config.enableHostGitOperations, false)
    assert.equal(config.enableSkills, false)
    const tool = config.tools![0]!
    assert.equal(tool.isTerminal, true)
    assert.equal((await config.onPermissionRequest!({ kind: 'read', path: '/etc/passwd', intention: 'Read' }, { sessionId: 'assessment' })).kind, 'reject')
    const blocked = await config.hooks!.onPreToolUse!({ toolName: 'bash', toolArgs: {}, sessionId: 'assessment', timestamp: new Date(), workingDirectory: config.workingDirectory! }, { sessionId: 'assessment' })
    assert.equal(blocked?.permissionDecision, 'deny')
    assert.throws(() => tool.handler!({ kind: 'accept', title: 'Missing scope', reason: 'Requested' }, { sessionId: 'assessment', toolCallId: 'invalid', toolName: tool.name, arguments: {} }))
    await tool.handler!({ kind: 'accept', title: 'Repair the form', scope: 'Form validation', reason: { code: 'said', values: { text: 'Requested explicitly' } }, rules: ['explicit'] },
      { sessionId: 'assessment', toolCallId: 'valid', toolName: tool.name, arguments: {} })
    assert.throws(() => tool.handler!({ kind: 'ignore', reason: 'Second outcome' }, { sessionId: 'assessment', toolCallId: 'duplicate', toolName: tool.name, arguments: {} }), /no longer/)
  }
  assert.deepEqual(await f.backend.assess('Candidate facts', new AbortController().signal, 'assessor-model'), {
    kind: 'accept', title: 'Repair the form', scope: 'Form validation', reason: { code: 'said', values: { text: 'Requested explicitly' } }, rules: ['explicit'],
  })
  assert.equal(f.client.created[0]!.config.model, 'assessor-model')
  assert.deepEqual(f.client.deleted, [f.client.created[0]!.sessionId])
  assert.equal(f.client.resumed.length, 0)
})

test('assessment refuses unstructured text and malformed terminal outcomes', async t => {
  const f = fixture(t)
  f.client.send = async () => ({ data: { content: '{"kind":"accept","reason":"Guess"}' } })
  await assert.rejects(f.backend.assess('Candidate', new AbortController().signal), /without a valid structured outcome/)
  assert.equal(f.client.created[0]!.abortCount, 1)
  assert.equal(f.client.deleted.length, 1)
})

test('dispose revokes active work and rejects future runs', async t => {
  const f = fixture(t)
  await f.backend.dispose()
  await assert.rejects(f.backend.run(f.input), /disposed/)
  await assert.rejects(f.backend.assess('Facts', new AbortController().signal), /disposed/)
  assert.equal(f.client.stopCount, 1)
})


test('cancelled SDK lookup settles promptly and a late session can never send a request', async t => {
  const f = fixture(t, { rpcTimeoutMs: 40, cleanupTimeoutMs: 30 })
  let release!: (value: SessionMetadata[]) => void
  f.client.listSessions = () => new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const run = f.backend.run({ ...f.input, signal: controller.signal }).then(() => 'resolved', () => 'rejected')
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  controller.abort()
  const result = await Promise.race([run, new Promise(resolve => setTimeout(() => resolve('hung'), 120))])
  release([])
  assert.equal(result, 'rejected')
  assert.equal(f.client.created.length, 0)
})


test('a timed-out create is fenced until the late session is aborted without sending', { timeout: 2000 }, async t => {
  const f = fixture(t, { rpcTimeoutMs: 20, cleanupTimeoutMs: 20 })
  let release!: (session: FakeSession) => void
  f.client.createSession = () => new Promise(resolve => { release = resolve })
  const keepAlive = setTimeout(() => {}, 1500)
  try {
    await assert.rejects(f.backend.run(f.input), /timeout/i)
    await assert.rejects(f.backend.run(f.input), /owns/)
    const session = new FakeSession(f.input.sessionId, { sessionId: f.input.sessionId }, f.client)
    release(session)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(session.sends, 0); assert.equal(session.abortCount, 1); assert.equal(session.disconnectCount, 1)
  } finally { clearTimeout(keepAlive) }
})

test('hanging SDK shutdown falls back to bounded forceStop', { timeout: 2000 }, async t => {
  const f = fixture(t, { cleanupTimeoutMs: 20 })
  let forced = 0
  f.client.stop = () => new Promise(() => {})
  Object.assign(f.client, { forceStop: async () => { forced++ } })
  const keepAlive = setTimeout(() => {}, 1500)
  try { await f.backend.dispose(); assert.equal(forced, 1) }
  finally { clearTimeout(keepAlive) }
})


test('a transient steering history read can retry the same durable input without replaying a send', async t => {
  const f = fixture(t)
  let release!: () => void, reads = 0, sends = 0, accepted = 0
  f.client.send = async (_config, session) => {
    Object.assign(session, { getEvents: async () => { if (++reads === 1) throw new Error('Temporary history failure'); return [] }, send: async () => { sends++; return 'input-message' } })
    await new Promise<void>(resolve => { release = resolve })
  }
  const running = f.backend.run(f.input)
  while (!release) await new Promise(resolve => setTimeout(resolve, 1))
  const input = { ticketId: f.input.ticketId, requestId: 'same-durable-input', prompt: 'A correction', signal: f.input.signal, onAccepted() { accepted++ }, onConsumed() {} }
  try {
    await assert.rejects(f.backend.steer(input), /Temporary history failure/)
    await f.backend.steer(input); await f.backend.steer(input)
    assert.equal(reads, 2); assert.equal(sends, 1); assert.equal(accepted, 1)
  } finally { release(); await running }
})

test('completed and failed workers release model ownership and reject late inference', async t => {
  const f = fixture(t)
  for (let i = 0; i < 4; i++) await f.backend.run({ ...f.input, ticketId: 'ticket-' + i, sessionId: 'session-' + i })
  f.client.send = async () => { throw new Error('Failed turn') }
  await assert.rejects(f.backend.run({ ...f.input, ticketId: 'failed-ticket', sessionId: 'failed-session' }))
  const handler = f.clientOptions().requestHandler as unknown as { rewrite(body: unknown, context: unknown): void }
  assert.throws(() => handler.rewrite({}, { sessionId: 'session-1', signal: f.input.signal }), /Unknown model session/)
  assert.equal((f.backend as unknown as { modelOwners: Map<string, unknown> }).modelOwners.size, 0)
  await f.backend.dispose()
  assert.equal((f.backend as unknown as { modelOwners: Map<string, unknown> }).modelOwners.size, 0)
})
