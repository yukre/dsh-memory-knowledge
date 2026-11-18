/**
 * Store reconciliation against a real temp directory and real node:sqlite.
 * Covers the identity scenarios from the plan: edit, rename/move, deleted id
 * line, copy, hand-merge, delete, and "touch only".
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync, mkdirSync, copyFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { Store, RESTAMP_QUIET_MS } from '../lib/store.js'
import { parseItem, composeItem } from '../lib/item.js'

let root
let clock
let store

/** Build a store whose clock the test controls. */
async function openStore() {
  const config = resolveConfig({ memoryRoot: root })
  const s = new Store(config, { now: () => clock })
  await s.open()
  return s
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mk-store-'))
  clock = Date.now()
  store = await openStore()
})

afterEach(() => {
  store?.close()
  rmSync(root, { recursive: true, force: true })
})

/** Machine-write one memory and return its row. */
function seed(title, area = 'cloudbase', body = '结论：A\n\n为什么：B') {
  const id = store.freshId()
  const path = store.pathFor('memory', area, title)
  return store.writeItem({ id, path, pool: 'memory', area, kind: 'fact', status: 'active', source_sessions: [], confirmed: false }, { title, when: '客户询价时', body })
}

/** Make a file old enough for restamping. */
function age(path) {
  const t = (clock - RESTAMP_QUIET_MS - 5000) / 1000
  utimesSync(path, t, t)
}

test('a machine write round-trips and is not mistaken for a human edit', async () => {
  const row = seed('按量计费口径')
  const summary = await store.scan()
  assert.deepEqual(summary.edited, [])
  assert.equal(store.graph.item(row.id).human_at, null)
  assert.match(readFileSync(row.path, 'utf8'), /<!-- dmk:id=mk_/)
  assert.ok(readFileSync(join(store.config.library, 'cloudbase', 'README.md'), 'utf8').includes('按量计费口径'))
})

test('a human content edit is detected by fingerprint, diffed, and flags edges', async () => {
  const a = seed('按量计费口径')
  const b = seed('套餐对比')
  store.graph.addEdge({ from: a.id, to: b.id, type: 'related', by: 'curator' }, clock)
  clock += 1000
  writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('结论：A', '结论：A（已修正为按 CU 计）'))
  const summary = await store.scan()
  assert.deepEqual(summary.edited, [a.id])
  const row = store.graph.item(a.id)
  assert.equal(row.human_at, clock)
  const record = store.changelog.recent(5).find(r => r.op === 'human-edit')
  assert.match(record.diff, /\{\+（已修正为按 CU 计）\+\}/)
  assert.equal(store.graph.pendingEdges(a.id).length, 1, 'its edge awaits review, not deletion')
  assert.equal(store.graph.neighbors(a.id).length, 1)
})

test('touching a file without changing content is not an edit', async () => {
  const a = seed('口径')
  const later = (clock + 60_000) / 1000
  utimesSync(a.path, later, later)
  writeFileSync(a.path, readFileSync(a.path, 'utf8') + '\n\n   \n')
  const summary = await store.scan()
  assert.deepEqual(summary.edited, [])
})

test('rename and move keep the id and every edge', async () => {
  const a = seed('口径')
  const b = seed('套餐')
  store.graph.addEdge({ from: a.id, to: b.id, type: 'depends-on', by: 'curator' }, clock)
  const target = join(store.config.library, 'pricing', '新名字.md')
  mkdirSync(join(store.config.library, 'pricing'), { recursive: true })
  renameSync(a.path, target)
  const summary = await store.scan()
  assert.deepEqual(summary.moved, [a.id])
  assert.deepEqual(summary.deleted, [])
  const row = store.graph.item(a.id)
  assert.equal(row.path, target)
  assert.equal(row.area, 'pricing')
  assert.equal(store.graph.neighbors(a.id)[0].other, b.id)
})

test('a deleted id line is recovered by path, then restamped after a quiet period', async () => {
  const a = seed('口径')
  const stripped = readFileSync(a.path, 'utf8').replace(/<!--.*-->\n?/, '')
  writeFileSync(a.path, stripped)
  let summary = await store.scan()
  assert.deepEqual(summary.added, [], 'not treated as a new item')
  assert.deepEqual(summary.restamped, [], 'not restamped while recently touched')
  age(a.path)
  summary = await store.scan()
  assert.deepEqual(summary.restamped, [a.id])
  assert.equal(parseItem(readFileSync(a.path, 'utf8')).id, a.id)
  assert.deepEqual(summary.edited, [], 'restamping is not an edit')
})

test('a copied file gets a fresh id; the original keeps its own', async () => {
  const a = seed('口径')
  const copy = join(store.config.library, 'cloudbase', '口径-副本.md')
  copyFileSync(a.path, copy)
  age(copy)
  const summary = await store.scan()
  assert.equal(summary.copies.length, 1)
  const copyId = summary.copies[0]
  assert.notEqual(copyId, a.id)
  assert.equal(store.graph.item(a.id).path, a.path)
  assert.equal(parseItem(readFileSync(copy, 'utf8')).id, copyId)
})

test('a hand-merged file aliases the second id and moves its edges', async () => {
  const a = seed('口径')
  const b = seed('套餐')
  const c = seed('第三条')
  store.graph.addEdge({ from: b.id, to: c.id, type: 'related', by: 'curator' }, clock)
  writeFileSync(a.path, readFileSync(a.path, 'utf8') + '\n' + readFileSync(b.path, 'utf8'))
  unlinkSync(b.path)
  const summary = await store.scan()
  assert.deepEqual(summary.merged, [{ id: a.id, alias: b.id }])
  assert.equal(store.graph.canonical(b.id), a.id)
  assert.equal(store.graph.neighbors(a.id).find(n => n.type === 'related').other, c.id)
  assert.deepEqual(summary.deleted, [], 'the merged-away item is not tombstoned')
})

test('deleting a file tombstones it and ends its edges', async () => {
  const a = seed('口径')
  const b = seed('套餐')
  store.graph.addEdge({ from: a.id, to: b.id, type: 'related', by: 'curator' }, clock)
  unlinkSync(a.path)
  const summary = await store.scan()
  assert.deepEqual(summary.deleted, [a.id])
  assert.equal(store.graph.item(a.id), undefined)
  assert.equal(store.graph.tombstones()[0].id, a.id)
  assert.equal(store.graph.neighbors(b.id).length, 0)
})

test('a new hand-written file becomes a memory owned by the person', async () => {
  mkdirSync(join(store.config.library, 'finance'), { recursive: true })
  const path = join(store.config.library, 'finance', '止损规则.md')
  writeFileSync(path, '# 止损规则\n> 何时用：买入前\n\n结论：买入前写好止损位')
  const summary = await store.scan()
  assert.equal(summary.added.length, 1)
  const row = store.graph.item(summary.added[0])
  assert.equal(row.pool, 'memory')
  assert.equal(row.area, 'finance')
  assert.notEqual(row.human_at, null)
})

test('writeItem refuses a stale base fingerprint', () => {
  const a = seed('口径')
  writeFileSync(a.path, readFileSync(a.path, 'utf8').replace('结论：A', '结论：人改过'))
  assert.throws(
    () => store.writeItem({ ...a }, { title: '口径', when: 'x', body: '机器版本' }, { baseFingerprint: a.fingerprint }),
    /STALE_BASE/,
  )
})

test('undo restores the previous version and clears the tombstone', async () => {
  const a = seed('口径', 'cloudbase', '版本一')
  clock += 10
  store.writeItem({ ...store.graph.item(a.id) }, { title: '口径', when: '客户询价时', body: '版本二' })
  clock += 10
  store.restoreVersion(a.id)
  assert.match(readFileSync(a.path, 'utf8'), /版本一/)
  assert.equal(parseItem(readFileSync(a.path, 'utf8')).id, a.id)
})

test('the graph survives a reopen; rebuilding from files restores items', async () => {
  const a = seed('口径')
  store.close()
  store = await openStore()
  assert.equal(store.graph.item(a.id).title, '口径')
  // Lose the database entirely: the next open rebuilds rows from the files' ids.
  store.close()
  rmSync(store.config.graphFile, { force: true })
  rmSync(store.config.graphFile + '-wal', { force: true })
  rmSync(store.config.graphFile + '-shm', { force: true })
  store = await openStore()
  assert.equal(store.graph.item(a.id).path, a.path)
  assert.equal(store.index.search('口径')[0].id, a.id)
})

test('composeItem output parses back to the same parts', () => {
  const id = store.freshId()
  const text = composeItem({ id, title: 'T', when: 'W', body: 'B1\nB2' })
  const parsed = parseItem(text)
  assert.deepEqual([parsed.id, parsed.title, parsed.when], [id, 'T', 'W'])
})
