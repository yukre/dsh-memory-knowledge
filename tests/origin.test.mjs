import assert from 'node:assert/strict'
import test from 'node:test'
import { originOf, votesRequired } from '../lib/origin.js'

const session = (role, quote) => ({ kind: 'session', role, quote })

test('origin: the person stating something is tier A, asking is tier B', () => {
  assert.equal(originOf({ confirmedBy: 'user-requested', evidence: [] }).tier, 'A')
  assert.equal(originOf({ confirmedBy: 'user-approved', evidence: [] }).tier, 'B')

  // Statements and decisions.
  for (const quote of ['周报以后按四段写', '这个改成用 npm', '统一用中文', '只记交易型的买卖', '必须跑回归测试', '别再派给别人']) {
    assert.equal(originOf({ confirmedBy: 'verified', evidence: [session('user', quote)] }).tier, 'A', quote)
  }
  // Questions are the person thinking, not concluding — 应该 inside a question is
  // exactly the confusion this tiering exists to remove.
  for (const quote of ['你觉得这样行不行？', '嗯', '好的', '是不是应该这样', '为什么要这样', '能不能改成四段']) {
    assert.equal(originOf({ confirmedBy: 'verified', evidence: [session('user', quote)] }).tier, 'B', quote)
  }

  assert.equal(originOf({ confirmedBy: 'imported', evidence: [{ kind: 'file', path: '/a.md' }] }).tier, 'C')
  assert.equal(originOf({ confirmedBy: 'verified', evidence: [session('assistant', '我推测是这样')] }).tier, 'D')
  assert.equal(originOf({}).tier, 'D')
})

test('origin: the threshold rises as the source weakens', () => {
  // The person said "remember this": waiting for a citation contradicts the
  // request that created the item.
  assert.equal(votesRequired('A', 2), 0)
  assert.equal(votesRequired('B', 2), 1)
  assert.equal(votesRequired('C', 2), 1)
  // A model's inference should be reached independently more than a person needs.
  assert.equal(votesRequired('D', 2), 3)
  // The configuration still moves the baseline.
  assert.equal(votesRequired('A', 3), 0)
  assert.equal(votesRequired('D', 3), 4)
})

test('origin: a tier is read back from the recorded changelog', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-origin-'))
  const note = join(root, 'n.md')
  writeFileSync(note, '统一用中文，代码和专有名词保留原文\n')
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const engine = new Engine(store, {})

  const fromPerson = await engine.write({
    op: 'add', kind: 'preference', claim: '回复统一用中文，代码和专有名词保留原文',
    why: '用户明确要求过，混用语言会增加阅读成本', scope: '所有回复',
    when: '准备输出回复时', area: 'preferences', title: '统一用中文', pool: 'staging',
    evidence: [{ kind: 'file', path: note, line: 1, quote: '统一用中文，代码和专有名词保留原文' }],
    confirmedBy: 'user-requested',
  }, { via: 'curator', actor: 'curator' })
  assert.equal(engine.origin(fromPerson.id).tier, 'A')

  const fromModel = await engine.write({
    op: 'add', kind: 'fact', claim: '微笑曲线两端最厚、中游制造最薄是产业链价值分配的规律',
    why: '多次调研都指向同一结论，中游议价能力弱', scope: '看产业链时',
    when: '判断代工厂商价值时', area: 'finance', title: '产业链价值分配', pool: 'staging',
    evidence: [{ kind: 'file', path: note, line: 1, quote: '统一用中文，代码和专有名词保留原文' }],
    confirmedBy: 'verified',
  }, { via: 'curator', actor: 'curator' })
  assert.equal(engine.origin(fromModel.id).tier, 'C', 'a file source, not the person speaking')

  store.close(); rmSync(root, { recursive: true, force: true })
})

test('a reversal segment names the items it appears to overturn', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-rev2-'))
  const note = join(root, 'n.md')
  writeFileSync(note, '发布前必须跑完整的回归测试套件\n')
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const engine = new Engine(store, {})
  await engine.write({
    op: 'add', kind: 'method', claim: '发布前必须跑完整的回归测试套件，不能只跑改动相关的用例',
    why: '曾经跳过回归测试导致线上事故，需要完整覆盖', scope: '任何发布前',
    when: '准备发布插件时', area: 'dsh', title: '发布前跑回归测试', pool: 'staging',
    evidence: [{ kind: 'file', path: note, line: 1, quote: '发布前必须跑完整的回归测试套件' }],
  }, { via: 'curator', actor: 'curator' })

  // A reversal that shares real vocabulary is found…
  const hits = engine.reversalTargets('不对，发布前改成只跑改动相关的回归测试套件就行了，完整跑太慢', 3)
  assert.equal(hits.length, 1)
  assert.match(hits[0].row.title, /回归测试/)
  assert.ok(hits[0].shared.length >= 3)

  // …and an unrelated statement finds nothing, so a redirect never archives
  // half the library.
  assert.deepEqual(engine.reversalTargets('今天天气不错，适合出去走走散散心', 3), [])
  assert.deepEqual(engine.reversalTargets('短', 3), [])

  store.close(); rmSync(root, { recursive: true, force: true })
})

test('promotion is gated by origin tier, not one flat number', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-gate-'))
  const note = join(root, 'n.md')
  writeFileSync(note, '这个必须统一用中文表述，不要中英混写\n')
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const engine = new Engine(store, {})

  // Tier A: the person stated it. Zero citations, and promotion still works.
  const stated = await engine.write({
    op: 'add', kind: 'preference', claim: '所有对外表述统一用中文，不要中英混写',
    why: '混写会增加阅读成本，用户明确要求过', scope: '所有对外表述',
    when: '写技术文档时', area: 'preferences', title: '统一用中文', pool: 'staging',
    evidence: [{ kind: 'file', path: note, line: 1, quote: '这个必须统一用中文表述，不要中英混写' }],
    confirmedBy: 'user-requested',
  }, { via: 'curator', actor: 'curator' })
  assert.equal(engine.origin(stated.id).tier, 'A')
  await engine.write({ op: 'promote', target: stated.id, reason: '用户明确陈述' }, { via: 'curator', actor: 'curator' })

  // Tier D: only a model's inference. The same zero citations must not promote,
  // and the error has to say which tier and how many votes it needs.
  const inferred = await engine.write({
    op: 'add', kind: 'fact', claim: '微笑曲线两端最厚、中游制造最薄是产业链的普遍规律',
    why: '多次调研指向同一结论，中游议价能力最弱', scope: '看产业链时',
    when: '判断代工商价值时', area: 'finance', title: '产业链价值分配', pool: 'staging',
    evidence: [{ kind: 'file', path: note, line: 1, quote: '这个必须统一用中文表述，不要中英混写' }],
    confirmedBy: 'verified',
  }, { via: 'curator', actor: 'curator' })
  const tier = engine.origin(inferred.id).tier
  assert.notEqual(tier, 'A', 'a file-backed model inference is not the person speaking')
  // Whatever the tier, zero citations must not open the door the way A did.
  await assert.rejects(
    engine.write({ op: 'promote', target: inferred.id, reason: '试试' }, { via: 'curator', actor: 'curator' }),
    (error) => error.code === 'NOT_ENOUGH_VOTES',
    'only tier A promotes without citations',
  )

  // Tier D specifically — a model's inference with no human and no file — needs
  // more citations than a person's statement ever does.
  assert.equal(votesRequired('D', 2), 3)

  store.close(); rmSync(root, { recursive: true, force: true })
})
