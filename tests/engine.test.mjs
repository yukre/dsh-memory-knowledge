/**
 * Engine behavior with synthetic sessions (a fake sessionQuery over in-memory
 * events). No real DSH session is read or written.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'

let root
let clock
let store
let engine
const sessions = new Map()

/** Build one synthetic session from alternating messages. */
function session(id, turns, { cwd = '/tmp/mk-acceptance', startTime } = {}) {
  const events = []
  let seq = 0
  let t = startTime ?? clock
  turns.forEach((turn, index) => {
    events.push({ type: 'turn/start', seq: ++seq, time: t, data: { turn: index + 1 } })
    events.push({ type: 'user/message', seq: ++seq, time: ++t, data: { role: 'user', content: [{ type: 'text', text: turn.user }], source: { kind: 'user' } } })
    if (turn.inject) events.push({ type: 'user/message', seq: ++seq, time: ++t, data: { role: 'user', content: [{ type: 'text', text: turn.inject }], source: { kind: 'runtime-context', form: 'snapshot' } } })
    events.push({ type: 'assistant/message', seq: ++seq, time: ++t, data: { turn: index + 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考过程' }, { type: 'text', text: turn.assistant }] } } })
    if (turn.open !== true) events.push({ type: 'turn/end', seq: ++seq, time: ++t, data: { turn: index + 1, reason: { kind: 'completed' } } })
    t += 1000
  })
  sessions.set(id, { header: { id, cwd, createdAt: startTime ?? clock, isSeeded: false, version: 4 }, events })
  return events
}

const fakeQuery = {
  async listSessions() { return [...sessions.values()].map(s => ({ header: s.header, live: false, persisted: true })) },
  async readSession(id) { const s = sessions.get(id); if (!s) throw new Error('not found'); return { session: s.header, inheritedEventCount: 0, events: s.events } },
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mk-engine-'))
  clock = 1_800_000_000_000
  sessions.clear()
  store = new Store(resolveConfig({ memoryRoot: root, capture: { includeCwd: ['/tmp/mk-acceptance'] } }), { now: () => clock })
  await store.open()
  engine = new Engine(store, { sessionQuery: () => fakeQuery, sessionTitle: async id => `标题-${id}` })
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A valid checklist for the curator. */
function checklist(extra = {}) {
  return {
    kind: 'decision',
    claim: '客户询价时先给套餐对比，再讲 CU 换算',
    why: '按量付费的换算关系客户最容易算错，先给套餐能让客户先建立价格区间，之后再解释 CU 不会被误解为更贵',
    scope: '适用于第一次询价的中小客户；大客户直接走商务报价',
    when: '客户第一次询问 CloudBase 价格时',
    confirmedBy: 'verified',
    validity: 'long-term',
    area: 'cloudbase',
    title: '询价时的讲解顺序',
    ...extra,
  }
}

test('mk_remember writes straight into memory with the last human message as evidence', async () => {
  session('s1', [{ user: '记住：以后回答我都要结论前置，先说结论再展开', assistant: '好的，已记住。' }])
  const result = await engine.remember({ kind: 'preference', claim: '回答结论前置，先给结论再展开', why: '用户明确要求以后所有回答都先说结论，便于快速判断要不要往下读', scope: '所有回答', when: '每次回答用户时', area: 'preferences', title: '结论前置' }, { sessionId: 's1' })
  assert.equal(result.ok, true)
  assert.equal(result.pool, 'memory')
  const row = store.graph.item(result.id)
  assert.equal(row.area, 'preferences')
  assert.match(readFileSync(row.path, 'utf8'), /\*\*结论\*\*：回答结论前置/)
  assert.match(result.cite, /^参考：\[结论前置\]\(<.+preferences\/结论前置\.md>\)（记忆 · 依据：会话「标题-s1」/)
})

test('the curator cannot invent evidence', async () => {
  session('s1', [{ user: '套餐能不能先比较一下', assistant: '可以' }])
  await assert.rejects(
    engine.write({ op: 'add', ...checklist(), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '这句话根本不存在于会话里' }] }, { via: 'curator', actor: 'curator' }),
    error => error.code === 'EVIDENCE_NOT_FOUND',
  )
})

test('inferred knowledge lands in staging; memory needs the human\'s own words', async () => {
  session('s1', [{ user: '客户总是问 CU 怎么换算，每次都讲不清楚', assistant: '先给套餐对比再讲 CU 换算会更清楚' }])
  const staged = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户总是问 CU 怎么换算' }] }, { via: 'curator', actor: 'curator' })
  assert.equal(staged.pool, 'staging')
  assert.match(staged.path, /_staging\/cloudbase\//)
  await assert.rejects(
    engine.write({ op: 'add', ...checklist({ title: '另一条', claim: '完全不同的结论甲乙丙丁', pool: 'memory', confirmedBy: 'verified' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 3, quote: '先给套餐对比再讲' }] }, { via: 'curator', actor: 'curator' }),
    error => error.code === 'POOL_NOT_ALLOWED',
  )
})

test('copying the source verbatim is refused as transcription', async () => {
  const long = '客户询价时先给套餐对比，再讲 CU 换算，因为按量付费的换算关系客户最容易算错，先给套餐能让客户先建立价格区间'
  session('s1', [{ user: long, assistant: '明白' }])
  await assert.rejects(
    engine.write({ op: 'add', ...checklist({ claim: long.slice(0, 26), why: long.slice(20) }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' }),
    error => error.code === 'TRANSCRIPTION',
  )
})

test('temporary content and thin reasons are refused by the checklist', async () => {
  session('s1', [{ user: '端口现在是 58237', assistant: '收到' }])
  const evidence = [{ kind: 'session', sessionId: 's1', seq: 2, quote: '端口现在是 58237' }]
  await assert.rejects(engine.write({ op: 'add', ...checklist({ validity: 'temporary' }), evidence }, { via: 'curator', actor: 'curator' }), e => e.code === 'TEMPORARY')
  await assert.rejects(engine.write({ op: 'add', ...checklist({ why: '对话中提到' }), evidence }, { via: 'curator', actor: 'curator' }), e => e.code === 'WHY_TOO_THIN')
  await assert.rejects(engine.write({ op: 'add', ...checklist({ claim: '测试库登录密码：' + ['zz', 'Fake', '9', 'Value'].join('') }), evidence }, { via: 'curator', actor: 'curator' }), e => e.code === 'SECRET')
})

test('a near-duplicate forces an explicit resolution, and update keeps the id', async () => {
  session('s1', [{ user: '客户询价时先给套餐对比再讲换算', assistant: '好' }])
  session('s2', [{ user: '询价讲解顺序要补充：大客户直接走商务', assistant: '好' }])
  const first = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  const dupArgs = { op: 'add', ...checklist({ confirmedBy: 'inferred', scope: '中小客户适用；大客户直接走商务报价，不讲 CU' }), evidence: [{ kind: 'session', sessionId: 's2', seq: 2, quote: '大客户直接走商务' }] }
  await assert.rejects(engine.write(dupArgs, { via: 'curator', actor: 'curator' }), error => {
    assert.equal(error.code, 'NEEDS_RESOLUTION')
    assert.equal(error.extra.candidates[0].id, first.id)
    return true
  })
  const updated = await engine.write({ ...dupArgs, op: 'update', target: first.id }, { via: 'curator', actor: 'curator' })
  assert.equal(updated.id, first.id)
  assert.match(readFileSync(updated.path, 'utf8'), /大客户直接走商务报价/)
  assert.deepEqual(store.graph.item(first.id).source_sessions.sort(), ['s1', 's2'])
})

test('supersede archives the old item and old evidence cannot resurrect it', async () => {
  clock = 1_800_000_000_000
  session('old', [{ user: '套餐价格是每月 19 元', assistant: '记下了' }], { startTime: clock })
  const old = await engine.remember({ kind: 'fact', claim: '基础套餐每月 19 元', why: '用户提供的报价单价格，用于给客户报价时直接引用', scope: '2026 年报价单', when: '客户问基础套餐价格时', area: 'cloudbase', title: '基础套餐价格' }, { sessionId: 'old' })
  clock += 86_400_000
  session('new', [{ user: '不对，基础套餐已经调成每月 29 元了', assistant: '已更正' }], { startTime: clock })
  const replaced = await engine.remember({ kind: 'fact', claim: '基础套餐每月 29 元', why: '用户纠正了旧报价，价格已上调，旧的 19 元不再适用', scope: '调价之后的报价', when: '客户问基础套餐价格时', area: 'cloudbase', title: '基础套餐价格', replaces: old.id }, { sessionId: 'new' })
  assert.equal(replaced.superseded, old.id)
  const archived = store.graph.item(old.id)
  assert.equal(archived.pool, 'archive')
  assert.equal(archived.status, 'retired')
  assert.ok(store.graph.neighbors(replaced.id).some(edge => edge.type === 'supersedes' && edge.other === old.id))
  // Curating the old session again must not bring the 19 yuan back.
  await assert.rejects(
    engine.write({ op: 'add', kind: 'fact', claim: '基础套餐每月 19 元', why: '报价单写明的价格，用于报价时直接引用', scope: '2026 年报价单', when: '客户问基础套餐价格时', confirmedBy: 'inferred', area: 'cloudbase', title: '基础套餐价格', resolution: 'distinct', evidence: [{ kind: 'session', sessionId: 'old', seq: 2, quote: '套餐价格是每月 19 元' }] }, { via: 'curator', actor: 'curator' }),
    error => error.code === 'RESURRECTION',
  )
})

test('a human-edited item is locked until newer human evidence arrives', async () => {
  session('s1', [{ user: '客户询价时先给套餐对比', assistant: '好' }])
  const item = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  clock += 1000
  writeFileSync(item.path, readFileSync(item.path, 'utf8').replace('中小客户', '所有客户'))
  await store.scan()
  assert.notEqual(store.graph.item(item.id).human_at, null)
  const args = { op: 'update', target: item.id, ...checklist({ confirmedBy: 'inferred', scope: '机器想改回中小客户' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }
  await assert.rejects(engine.write(args, { via: 'curator', actor: 'curator' }), error => error.code === 'LOCKED')
  clock += 1000
  session('s9', [{ user: '询价顺序那条，中小客户才这样，大客户不用', assistant: '明白' }], { startTime: clock })
  const ok = await engine.write({ ...args, evidence: [{ kind: 'session', sessionId: 's9', seq: 2, quote: '中小客户才这样' }] }, { via: 'curator', actor: 'curator' })
  assert.equal(ok.ok, true)
})

test('feedback: wrong disputes, forget archives with a tombstone, confirm counts', async () => {
  session('s1', [{ user: '记住我习惯用 pnpm 而不是 npm', assistant: '好' }])
  const pref = await engine.remember({ kind: 'preference', claim: '包管理用 pnpm，不用 npm', why: '用户明确表示长期习惯使用 pnpm，统一工具避免锁文件冲突', scope: '新建或维护 JS 项目时', when: '需要安装依赖时', area: 'preferences', title: '用 pnpm' }, { sessionId: 's1' })
  session('s2', [{ user: '这条不对，我现在用 bun 了', assistant: '收到' }])
  const disputed = await engine.feedback({ id: pref.id, verdict: 'outdated' }, { sessionId: 's2' })
  assert.equal(disputed.status, 'disputed')
  const recall = await engine.recall({ query: 'pnpm' })
  assert.equal(recall.items[0].status, 'disputed')
  assert.match(recall.items[0].cite, /⚠️有争议/)
  session('s3', [{ user: '忘掉 pnpm 那条', assistant: '好' }])
  const forgotten = await engine.feedback({ id: pref.id, verdict: 'forget' }, { sessionId: 's3' })
  assert.equal(forgotten.status, 'retired')
  assert.equal(store.graph.item(pref.id).pool, 'archive')
  assert.equal(store.graph.tombstones()[0].id, pref.id)
})

test('recall: query hits, browse by area, open by id with one-hop relations', async () => {
  session('s1', [{ user: '客户询价时先给套餐对比', assistant: '好' }, { user: '套餐里资源点怎么计费', assistant: '按 CU' }])
  const a = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  const b = await engine.write({ op: 'add', kind: 'fact', claim: '资源点按 CU 计费，1 CU 对应固定资源量', why: '计费文档确认 CU 是统一计量单位，所有资源点都折算成 CU', scope: '按量付费模式', when: '解释资源点计费时', confirmedBy: 'inferred', area: 'cloudbase', title: 'CU 计费单位', relations: [{ to: a.id, type: 'depends-on' }], evidence: [{ kind: 'session', sessionId: 's1', seq: 6, quote: '资源点怎么计费' }] }, { via: 'curator', actor: 'curator' })
  const hits = await engine.recall({ query: 'CU 计费' })
  assert.equal(hits.items[0].id, b.id)
  assert.equal(hits.items[0].pool, 'staging')
  assert.match(hits.items[0].cite, /待验证/)
  assert.equal(hits.items[0].related[0].id, a.id)
  const browse = await engine.recall({ area: 'cloudbase' })
  assert.equal(browse.kind, 'browse')
  assert.equal(browse.items.length, 2)
  const opened = await engine.recall({ id: b.id })
  assert.equal(opened.kind, 'item')
  assert.match(opened.body, /1 CU 对应固定资源量/)
  assert.equal(opened.evidence[0].quote, '资源点怎么计费')
})

test('curation queue: digest skips injected context, open turns, and other workspaces', async () => {
  session('s1', [
    { user: '第一轮问题', inject: '这是注入的运行时上下文，不该出现', assistant: '第一轮回答' },
    { user: '还在进行中的一轮', assistant: '未完成', open: true },
  ])
  session('elsewhere', [{ user: '别的工作区', assistant: '不该被读' }], { cwd: '/Users/someone/other' })
  engine.beginRun()
  const budget = { charsLeft: 100000, sessionsLeft: 10 }
  const { unit } = await engine.next(budget)
  assert.equal(unit.kind, 'session')
  assert.equal(unit.sessionId, 's1')
  assert.match(unit.text, /第一轮问题/)
  assert.doesNotMatch(unit.text, /注入的运行时上下文/)
  assert.doesNotMatch(unit.text, /思考过程/)
  assert.doesNotMatch(unit.text, /还在进行中/)
  await engine.done({ unit: { kind: 'session', ref: 's1', toSeq: unit.toSeq } })
  const after = await engine.next(budget)
  assert.equal(after.done, true, 'nothing else: the other workspace is excluded and s1 is consumed')
})

test('votes: citations from other sessions, verified, then promotion', async () => {
  session('src', [{ user: '客户询价时先给套餐对比', assistant: '好' }])
  const staged = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 'src', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  const path = staged.path
  // Two other sessions cite it; the next human message does not object.
  for (const id of ['u1', 'u2']) session(id, [
    { user: '客户问价格怎么讲', assistant: `先给套餐对比。\n参考：[询价](<${path}>)（待验证）` },
    { user: '好的谢谢', assistant: '不客气' },
  ])
  // The source session citing itself must not count.
  session('src2', [{ user: '再说一次', assistant: `参考：[询价](<${path}>)` }, { user: '嗯', assistant: '好' }])
  store.graph.patchItem(staged.id, { source_sessions: ['src', 'src2'] })
  engine.beginRun()
  const budget = { charsLeft: 100000, sessionsLeft: 10 }
  for (;;) {
    const step = await engine.next(budget)
    if (step.done) break
    const unit = step.unit
    if (unit.kind === 'session') {
      await engine.done({ unit: { kind: 'session', ref: unit.ref, toSeq: unit.toSeq }, useVerdicts: unit.citedUses.map(u => ({ id: u.id, verdict: u.sourceSession ? 'excluded' : 'accepted' })) })
    } else if (unit.kind === 'promote') {
      assert.equal(unit.id, staged.id)
      assert.equal(unit.votes, 2)
      const promoted = await engine.write({ op: 'promote', target: unit.id, reason: '两次被引用无异议' }, { via: 'curator', actor: 'curator' })
      assert.match(promoted.path, /library\/cloudbase\//)
      await engine.done({ unit: { kind: 'promote', ref: unit.ref } })
    } else {
      await engine.done({ unit: { kind: unit.kind, ref: unit.ref } })
    }
  }
  assert.equal(store.graph.item(staged.id).pool, 'memory')
  assert.equal(engine.votes(staged.id), 2)
})

test('done refuses a session unit whose citations were not judged', async () => {
  session('src', [{ user: '客户询价时先给套餐对比', assistant: '好' }])
  const staged = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 'src', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  session('u1', [{ user: '怎么讲价格', assistant: `参考：[x](<${staged.path}>)` }, { user: '好', assistant: '嗯' }])
  engine.beginRun()
  let unit
  for (;;) { const step = await engine.next({ charsLeft: 1e6, sessionsLeft: 9 }); unit = step.unit; if (unit.kind === 'session' && unit.ref === 'u1') break; await engine.done({ unit: { kind: unit.kind, ref: unit.ref, toSeq: unit.toSeq }, useVerdicts: [] }) }
  await assert.rejects(engine.done({ unit: { kind: 'session', ref: 'u1', toSeq: unit.toSeq } }), error => error.code === 'UNIT_INCOMPLETE')
})

test('a human edit becomes the first curation unit, with its diff and edges to review', async () => {
  session('s1', [{ user: '客户询价时先给套餐对比', assistant: '好' }, { user: 'CU 怎么计费', assistant: '按资源点' }])
  const a = await engine.write({ op: 'add', ...checklist({ confirmedBy: 'inferred' }), evidence: [{ kind: 'session', sessionId: 's1', seq: 2, quote: '客户询价时先给套餐对比' }] }, { via: 'curator', actor: 'curator' })
  const b = await engine.write({ op: 'add', kind: 'fact', claim: '资源点按 CU 计费', why: '计费文档说明所有资源点都折算为 CU 统一计量', scope: '按量付费', when: '解释计费时', confirmedBy: 'inferred', area: 'cloudbase', title: 'CU 计费', relations: [{ to: a.id, type: 'related' }], evidence: [{ kind: 'session', sessionId: 's1', seq: 6, quote: 'CU 怎么计费' }] }, { via: 'curator', actor: 'curator' })
  clock += 5000
  writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('中小客户', '所有新客户'))
  await store.scan()
  engine.beginRun()
  const { unit } = await engine.next({ charsLeft: 1e6, sessionsLeft: 9 })
  assert.equal(unit.kind, 'human-edit')
  assert.equal(unit.id, a.id)
  assert.match(unit.diff, /\[-中小-\]\{\+所有新\+\}/)
  assert.equal(unit.pendingEdges.length, 1)
  assert.ok(unit.related.some(r => r.id === b.id))
  await assert.rejects(engine.done({ unit: { kind: 'human-edit', ref: unit.ref } }), e => e.code === 'UNIT_INCOMPLETE')
  await engine.done({ unit: { kind: 'human-edit', ref: unit.ref }, edgeReviews: [{ ...unit.pendingEdges[0], decision: 'keep' }] })
  assert.equal(store.graph.pendingEdges(a.id).length, 0)
  assert.equal(store.graph.neighbors(a.id).length, 1)
})

test('undo reverts an update and restores an archived item', async () => {
  session('s1', [{ user: '记住基础套餐每月 19 元', assistant: '好' }])
  const item = await engine.remember({ kind: 'fact', claim: '基础套餐每月 19 元', why: '用户给出的报价单价格，报价时直接引用不用再查', scope: '当前报价单', when: '客户问基础套餐时', area: 'cloudbase', title: '基础套餐' }, { sessionId: 's1' })
  clock += 1000
  session('s2', [{ user: '忘掉基础套餐那条', assistant: '好' }])
  const forgot = await engine.feedback({ id: item.id, verdict: 'forget' }, { sessionId: 's2' })
  assert.equal(store.graph.item(item.id).pool, 'archive')
  clock += 1000
  await engine.undo({ change: forgot.change })
  const row = store.graph.item(item.id)
  assert.equal(row.pool, 'memory')
  assert.equal(row.status, 'active')
  assert.ok(existsSync(row.path))
})

test('skill upgrade needs evidence from three sessions and links back to its sources', async () => {
  for (const id of ['k1', 'k2', 'k3']) session(id, [{ user: '发布插件先跑官方校验脚本再开 PR', assistant: '好' }])
  const method = await engine.write({ op: 'add', kind: 'method', claim: '发布插件：校验 bundle、跑官方脚本、再开 PR', why: '三次发布都按这个顺序，跳过校验曾导致 PR 被打回', scope: '发布到 awesome-dsh-plugin 时', when: '要发布 DSH 插件时', confirmedBy: 'consistent', area: 'dsh', title: '发布插件流程', evidence: [{ kind: 'session', sessionId: 'k1', seq: 2, quote: '先跑官方校验脚本' }] }, { via: 'curator', actor: 'curator' })
  const evidence = ['k1', 'k2', 'k3'].map(id => ({ kind: 'session', sessionId: id, seq: 2, quote: '先跑官方校验脚本再开 PR' }))
  await assert.rejects(engine.write({ op: 'skill', name: 'publish-dsh-plugin', description: '发布 DSH 插件到插件中心', when: '要发布插件时', steps: '1. 检查\n2. 校验\n3. PR', evidence: evidence.slice(0, 2) }, { via: 'curator', actor: 'curator' }), e => e.code === 'SKILL_THRESHOLD')
  await assert.rejects(engine.write({ op: 'skill', name: 'publish-dsh-plugin', description: '很长'.repeat(120), steps: 'x', evidence }, { via: 'curator', actor: 'curator' }), e => e.code === 'SKILL_DESCRIPTION_TOO_LONG')
  const skill = await engine.write({ op: 'skill', name: 'publish-dsh-plugin', description: '发布 DSH 插件到插件中心', when: '要发布插件时', steps: '1. 检查 dsh.bundle\n2. 跑 check-submission\n3. 开 PR', from: [method.id], evidence }, { via: 'curator', actor: 'curator' })
  const text = readFileSync(skill.path, 'utf8')
  assert.ok(text.startsWith('---\nname: publish-dsh-plugin\n'))
  assert.match(text, /dmk_id: mk_/)
  assert.equal(store.graph.item(method.id).pool, 'archive')
  assert.ok(store.graph.neighbors(skill.id).some(edge => edge.type === 'derived-from' && edge.other === method.id))
  assert.equal(store.graph.tombstones().some(stone => stone.id === method.id), false, 'an upgraded method is not a retired truth')
})

test('a memory created from speech is not a manual edit, so it does not lock itself', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-lock-'))
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const sessions = new Map([['s1', [
    { type: 'turn/start', seq: 1, time: 1000, data: {} },
    { type: 'user/message', seq: 2, time: 2000, data: { content: [{ type: 'text', text: '记住：部署前必须过检查清单' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 4, time: 4000, data: { content: [{ type: 'text', text: '再补一条，部署前还要做回滚演练' }], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 5, time: 5000, data: {} },
  ]]])
  const engine = new Engine(store, {
    sessionQuery: () => ({ readSession: async id => ({ events: sessions.get(id) }) }),
    sessionTitle: async () => 't',
  })
  const first = await engine.remember({
    kind: 'method', claim: '部署前必须过检查清单',
    why: '之前漏过检查出过事故所以要固化', scope: '任何部署前', when: '准备部署时',
    area: 'dsh', title: '部署检查',
  }, { sessionId: 's1' })

  // human_at means a hand edit. A spoken sentence is not one: stamping it here
  // made checkHumanLock refuse the very next correction as LOCKED, so the person
  // could state something and then be unable to amend it.
  assert.equal(store.graph.item(first.id).human_at, null, 'a spoken memory is not a hand edit')

  const second = await engine.remember({
    kind: 'method', claim: '部署前必须过检查清单并做回滚演练',
    why: '补充回滚演练这一环，之前只过清单不够', scope: '任何部署前', when: '准备部署时',
    area: 'dsh', title: '部署检查', target: first.id, resolution: 'update',
  }, { sessionId: 's1' })
  assert.equal(second.id, first.id, 'the follow-up correction is accepted')
  store.close(); rmSync(root, { recursive: true, force: true })
})

test('a crashed curation run does not leave the page saying 整理中 forever', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-running-'))
  let clock = Date.now()
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => clock })
  await store.open()
  const engine = new Engine(store, {})

  assert.equal(engine.status().running, false, 'idle by default')

  // A run starts and then dies — beginRun set the marker, next() never reached
  // done, so nothing cleared it. This is what left the settings page showing
  // 整理中… with no curator actually running.
  engine.beginRun()
  assert.equal(engine.status().running, true, 'a fresh run reads as running')

  // Still within the window: reported as running (a real run can take a while).
  clock += 30 * 60 * 1000
  assert.equal(engine.status().running, true, 'within the window it still counts')

  // Past the window with no completion: not running any more.
  clock += 40 * 60 * 1000
  assert.equal(engine.status().running, false, 'a stale marker expires instead of hanging')

  // The schedule service's own flag wins when it is available.
  assert.equal(engine.isRunning({ executing: true }), true, 'the service knows better than the marker')
  assert.equal(engine.isRunning({ executing: false, windowMs: 10 * 365 * 24 * 3600 * 1000 }), false,
    'an explicit "not executing" overrides a fresh marker')

  store.close(); rmSync(root, { recursive: true, force: true })
})

test('a human-edit unit always carries a diff and text field, never undefined', async () => {
  const { Store } = await import('../lib/store.js')
  const { Engine } = await import('../lib/engine.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-hu-'))
  mkdirSync(join(root, 'library', 'notes'), { recursive: true })
  writeFileSync(join(root, 'library', 'notes', '手工.md'),
    '# 手工\n> 何时用：x\n\n**结论**：手工写的\n\n**为什么**：理由够长\n\n**边界**：无\n')

  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const engine = new Engine(store, {})
  const unit = engine.pendingHumanEdit()
  assert.ok(unit !== undefined, 'the hand-written file is queued as a human edit')

  // A tool result carrying an undefined property is rejected by the host as
  // "not lossless JSON". `record.diff` is absent for a whole-file add, so the
  // unit shipped undefined and the curator could not process the edit at all.
  assert.ok('diff' in unit, 'diff is present')
  assert.notEqual(unit.diff, undefined, 'diff is never undefined')
  assert.equal(unit.diff, null, 'and is null when there is nothing to diff')
  assert.ok('text' in unit)
  assert.notEqual(unit.text, undefined, 'text is never undefined')

  // The same for a unit whose record has no rewrite flag: the old
  // `a || b ? x : y` precedence returned the body for any record, regardless.
  for (const value of [unit.diff, unit.text]) {
    assert.ok(value === null || typeof value === 'string', 'both fields are null or a string')
  }

  store.close(); rmSync(root, { recursive: true, force: true })
})
