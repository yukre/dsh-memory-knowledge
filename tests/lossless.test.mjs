import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'

test('every tool result passes the host lossless check (undefined properties are illegal)', async () => {
  const { isJsonValue } = await import('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js')
  const root = mkdtempSync(join(tmpdir(), 'mk-lossless-'))
  const sessions = new Map()
  const store = new Store(resolveConfig({ memoryRoot: root, capture: { includeCwd: ['/tmp/mk-acceptance'] } }), { now: () => Date.now() })
  await store.open()
  const engine = new Engine(store, {
    sessionQuery: () => ({ listSessions: async () => [], readSession: async id => ({ events: sessions.get(id) }) }),
    sessionTitle: async () => 't',
  })
  const ctx = { via: 'curator', actor: 'curator' }
  const budget = { charsLeft: 1e6, sessionsLeft: 9 }

  // 1) a human edit → human-edit unit
  mkdirSync(join(root, 'library', '偏好'), { recursive: true })
  const row = store.writeItem({ id: store.freshId(), path: store.pathFor('memory', '偏好', '四段式'), pool: 'memory', area: '偏好', kind: 'preference', status: 'active', source_sessions: [], confirmed: false }, { title: '四段式', when: '写周报', body: 'A' })
  writeFileSync(row.path, readFileSync(row.path, 'utf8').replace('A', 'B'))
  await store.scan()

  const unit = await engine.next(budget)
  assert.ok(isJsonValue(unit), `mk_next unit is not lossless: ${JSON.stringify(Object.entries(unit.unit ?? unit).filter(([,v]) => v === undefined))}`)
  await engine.done({ unit: { kind: 'human-edit', ref: unit.unit.ref } })

  // 2) recall of every kind
  for (const value of [await engine.recall({}), await engine.recall({ query: '四段式' }), await engine.recall({ id: row.id })]) {
    assert.ok(isJsonValue(value), `recall is not lossless: ${JSON.stringify(Object.entries(value).filter(([,v]) => v === undefined))}`)
  }

  // 3) status
  assert.ok(isJsonValue(engine.status()), 'status is not lossless')

  // 4) all gate refusals (they spread extra into the result)
  const bad = await engine.write({ op: 'add', kind: 'fact', claim: 'x', why: 'y'.repeat(30), scope: 'z', when: 'w', area: '偏好', evidence: [{ kind: 'session', sessionId: 'nope', seq: 2, quote: '不存在' }] }, ctx).catch(e => e)
  assert.ok(bad.code, 'expected a gate refusal')
  assert.ok(isJsonValue({ ok: false, code: bad.code, detail: bad.detail }), 'refusal value is not lossless')

  // 5) a session whose FIRST message is a correction (no assistant reply yet):
  //    the hint's replyTo must be omitted, not undefined.
  {
    const first = { type: 'turn/start', seq: 1, time: Date.now(), data: {} }
    const correction = { type: 'user/message', seq: 2, time: Date.now(), data: { content: [{ type: 'text', text: '不对，那条记错了，应该是 X' }], source: { kind: 'user' } } }
    const reply = { type: 'assistant/message', seq: 3, time: Date.now(), data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的已更正' }] } } }
    const end = { type: 'turn/end', seq: 4, time: Date.now(), data: {} }
    const { digestSession } = await import('../lib/digest.js')
    const digest = digestSession([first, correction, reply, end], {})
    const { isJsonValue } = await import('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js')
    // corrections feed the session unit's hints; every entry must be lossless.
    for (const correction of digest.corrections) {
      assert.ok(isJsonValue(correction), `a correction entry is not lossless: ${JSON.stringify(correction, (k, v) => v === undefined ? '__UNDEF__' : v)}`)
    }
    assert.equal(digest.corrections.length, 0, 'a correction before any assistant reply has no replyTo, so it is not flagged')
  }

  store.close(); rmSync(root, { recursive: true, force: true })
})
