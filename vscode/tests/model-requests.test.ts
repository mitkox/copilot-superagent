import assert from 'node:assert/strict'
import test from 'node:test'
import { bindInstructions, instructionBlock, WorkerModelRequests } from '../src/model-requests.ts'
import type { CopilotRequestContext } from '@github/copilot-sdk'

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
