import assert from 'node:assert/strict'
import test from 'node:test'
import { bindInstructions, instructionBlock, WorkerModelRequests } from '../src/model-requests.ts'
import type { CopilotRequestContext } from '@github/copilot-sdk'

class Transport extends WorkerModelRequests {
  send(request: Request, context: CopilotRequestContext) { return this.sendRequest(request, context) }
  connect(context: CopilotRequestContext) { return this.openWebSocket(context) }
}
const contextFor = (url: string, transport: 'http' | 'websocket' = 'http') => ({
  url, transport, sessionId: 'root', headers: {}, signal: new AbortController().signal,
}) as CopilotRequestContext

test('custom, personal, insecure and lookalike model endpoints are blocked before any connection', async t => {
  let sent = 0
  t.mock.method(globalThis, 'fetch', async () => { sent++; return new Response('{}') })
  const handler = new Transport(() => ({ signal: new AbortController().signal, assertCurrent() {} }))
  for (const url of [
    'https://api.deepseek.com/chat/completions', 'http://127.0.0.1:11434/v1/responses',
    'https://api.githubcopilot.com/responses', 'https://api.individual.githubcopilot.com/responses',
    'https://api.enterprise.githubcopilot.com.evil.example/responses',
    'https://evil.example/api.enterprise.githubcopilot.com',
    'https://api.enterprise.githubcopilot.com:8443/responses',
    'http://api.enterprise.githubcopilot.com/responses',
  ]) await assert.rejects(handler.send(new Request(url, { method: 'POST', body: JSON.stringify({ model: 'gpt-5' }) }), contextFor(url)), /Copilot-only/)
  const approved = 'https://api.enterprise.githubcopilot.com/responses'
  await assert.rejects(handler.send(new Request(approved, { method: 'POST', body: '{}' }), contextFor('https://user:password@api.enterprise.githubcopilot.com/responses')), /Copilot-only/)
  for (const url of ['ws://127.0.0.1:8080/responses', 'wss://api.deepseek.com/responses', 'wss://api.individual.githubcopilot.com/responses']) {
    await assert.rejects(handler.connect(contextFor(url, 'websocket')), /Copilot-only/)
  }
  assert.equal(sent, 0)
})

test('data-residency inference is pinned to the selected GitHub enterprise host', async t => {
  const sent: Request[] = []
  t.mock.method(globalThis, 'fetch', async (request: Request) => { sent.push(request); return new Response('{}') })
  const handler = new Transport(() => ({ signal: new AbortController().signal, assertCurrent() {} }), 'example.ghe.com')
  const url = 'https://copilot-api.example.ghe.com/responses'
  await handler.send(new Request(url, { method: 'POST', body: '{"model":"gpt-5"}' }), contextFor(url))
  for (const wrong of ['https://copilot-api.other.ghe.com/responses', 'https://api.enterprise.githubcopilot.com/responses']) {
    await assert.rejects(handler.send(new Request(wrong, { method: 'POST', body: '{}' }), contextFor(wrong)), /Copilot-only/)
  }
  assert.equal(sent.length, 1)
})

test('approved Copilot inference forwards with redirects forbidden and rejects provider-qualified models', async t => {
  const sent: Request[] = []
  t.mock.method(globalThis, 'fetch', async (request: Request) => { sent.push(request); return new Response('{}') })
  const handler = new Transport(() => ({ signal: new AbortController().signal, assertCurrent() {} }))
  for (const host of ['api.business.githubcopilot.com', 'api.enterprise.githubcopilot.com']) {
    const url = `https://${host}/responses`
    await handler.send(new Request(url, { method: 'POST', body: JSON.stringify({ model: 'gpt-5' }) }), contextFor(url))
  }
  assert.equal(sent.length, 2)
  assert.ok(sent.every(request => request.redirect === 'error'))
  const url = 'https://api.enterprise.githubcopilot.com/responses'
  for (const model of ['local/deepseek-r1', 'https://custom.example/model', ' provider-model ', '']) {
    await assert.rejects(handler.send(new Request(url, { method: 'POST', body: JSON.stringify({ model }) }), contextFor(url)), /Copilot-only/)
  }
  assert.equal(sent.length, 2)
})

const nonce = 'a'.repeat(32)
test('each model request replaces only the trusted instruction block and preserves source messages', () => {
  const original = instructionBlock(nonce, 'old policy')
  const body = { messages: [{ role: 'system', content: `Native prefix\n${original}\nNative suffix` }, { role: 'user', content: original }] }
  bindInstructions(body, nonce, 'current policy', false)
  assert.equal(body.messages[0]!.content, `Native prefix\n${instructionBlock(nonce, 'current policy')}\nNative suffix`)
  assert.equal(body.messages[1]!.content, original)
  const responses = { instructions: original }
  bindInstructions(responses, nonce, 'next revision', false)
  assert.equal(responses.instructions, instructionBlock(nonce, 'next revision'))
})

test('missing, duplicate, malformed, and unsupported host instructions fail closed', () => {
  const block = instructionBlock(nonce, 'policy')
  for (const body of [
    { messages: [{ role: 'user', content: block }] },
    { instructions: 'native root without host instructions' },
    { instructions: block + block },
    { instructions: `<superagent-${nonce}>truncated` },
    { instructions: block + `</superagent-${nonce}>` },
    { messages: [{ role: 'system', content: [{ type: 'text', text: block }] }] },
  ]) assert.throws(() => bindInstructions(body, nonce, 'new', false))
  assert.throws(() => bindInstructions({ instructions: `</superagent-${nonce}>` }, nonce, 'new', true))
  const child = { instructions: 'Native child instructions' }
  bindInstructions(child, nonce, 'fresh child policy', true)
  assert.match(child.instructions, /fresh child policy/)
})

test('actual inference binding rejects revoked owners and unproven native children', () => {
  const signal = new AbortController(), cancelled = new AbortController()
  let allowed = true, applied = 0
  const handler = new WorkerModelRequests(() => ({ signal: signal.signal,
    assertCurrent() { if (!allowed) throw new Error('Source revoked') },
    instructions: { nonce, current: () => 'fresh', bound: () => applied++ },
  }))
  const context = { sessionId: 'root', signal: cancelled.signal } as CopilotRequestContext
  handler.rewrite({ instructions: instructionBlock(nonce, 'old') }, context)
  assert.equal(applied, 1)
  assert.throws(() => handler.rewrite({ instructions: 'child' }, { ...context, agentId: 'unknown' }), /ownership/)
  allowed = false
  assert.throws(() => handler.rewrite({ instructions: instructionBlock(nonce, 'old') }, context), /revoked/)
  allowed = true; signal.abort()
  assert.throws(() => handler.rewrite({ instructions: instructionBlock(nonce, 'old') }, context), /abort/i)
  assert.equal(applied, 1)
})
