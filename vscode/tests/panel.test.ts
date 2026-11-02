import assert from 'node:assert/strict'
import { test } from 'node:test'
import { panelContent } from '../src/panel-content.ts'

test('supervision panel isolates scripts and never interpolates untrusted ticket content as HTML', () => {
  const html = panelContent('test-nonce')
  assert.match(html, /default-src 'none'/)
  assert.match(html, /script-src 'nonce-test-nonce'/)
  assert.doesNotMatch(html, /https?:\/\//)
  assert.match(html, /textContent/)
  assert.doesNotMatch(html, /innerHTML|eval\(|new Function/)
  for (const tab of ['Overview', 'Sources', 'Triggers', 'Eval', 'Execution', 'Settings']) assert.ok(html.includes(tab))
})


import { JSDOM } from 'jsdom'

function panel() {
  const sent: Record<string, any>[] = []
  const dom = new JSDOM(panelContent('test-nonce'), { runScripts: 'dangerously', beforeParse(window) {
    Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (message: Record<string, any>) => sent.push(message) }) })
  } })
  const state = (revision: number, actors = ['original']) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'state', value: { settings: { revision, value: { actors } } } },
  }))
  const tab = (name: string) => (dom.window.document.querySelector(`[data-tab="${name}"]`) as HTMLElement).click()
  const edit = (value: string) => { const el = dom.window.document.getElementById('settings') as HTMLTextAreaElement; el.value = value; el.dispatchEvent(new dom.window.Event('input')) }
  const save = () => [...dom.window.document.querySelectorAll('button')].find(el => el.textContent === 'Save settings')!.click()
  return { dom, sent, state, tab, edit, save, value: () => (dom.window.document.getElementById('settings') as HTMLTextAreaElement).value }
}

test('a dirty draft retains its base revision when a newer settings snapshot arrives', () => {
  const p = panel()
  try {
    p.state(1); p.tab('Settings'); p.edit('{"actors":["draft"]}')
    p.state(2, ['revoked']); p.save()
    assert.equal(p.sent.at(-1)?.revision, 1)
    assert.equal(JSON.stringify(p.sent.at(-1)?.value), JSON.stringify({ actors: ['draft'] }))
  } finally { p.dom.window.close() }
})

test('settings drafts survive navigation and rejected saves until a matching success', () => {
  const p = panel()
  try {
    p.state(1); p.tab('Settings'); p.edit('{"actors":["draft"]}')
    p.tab('Execution'); p.state(2); p.tab('Settings')
    assert.equal(p.value(), '{"actors":["draft"]}')
    p.save(); const request = p.sent.at(-1)!
    p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: { type: 'saveSettingsResult', requestId: request.requestId, success: false } }))
    p.state(3); assert.equal(p.value(), '{"actors":["draft"]}')
    p.save(); const next = p.sent.at(-1)!
    p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: { type: 'saveSettingsResult', requestId: next.requestId + 1, success: true, revision: 4 } }))
    p.state(4); assert.equal(p.value(), '{"actors":["draft"]}')
    p.dom.window.dispatchEvent(new p.dom.window.MessageEvent('message', { data: { type: 'saveSettingsResult', requestId: next.requestId, success: true, revision: 5 } }))
    p.state(5, ['saved']); assert.match(p.value(), /saved/)
  } finally { p.dom.window.close() }
})
