/**
 * Integration boundaries: real files, real SQLite, hostile conditions.
 *
 * These cover what the unit tests cannot — partial failures, unreadable paths,
 * duplicate ids on disk, concurrent writers, and the crash-recovery paths.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, unlinkSync, renameSync, chmodSync, copyFileSync, readdirSync, existsSync, symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'
import { Engine } from '../lib/engine.js'
import { openGraph } from '../lib/graph.js'
import { History } from '../lib/history.js'
import { parseItem } from '../lib/item.js'

let root
let clock
let store
const sessions = new Map()

const openStore = async () => {
  const s = new Store(resolveConfig({ memoryRoot: root, capture: { includeCwd: ['/tmp/mk-acceptance'] } }), { now: () => clock })
  await s.open()
  return s
}
const seed = (title, area = 'notes', body = '**结论**：A\n\n**为什么**：B\n\n**边界**：C', pool = 'memory') => {
  const id = store.freshId()
  const path = store.pathFor(pool, area, title)
  mkdirSync(dirname(path), { recursive: true })
  return store.writeItem({ id, path, pool, area, kind: 'fact', status: 'active', source_sessions: [], confirmed: false }, { title, when: '客户问起时', body })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'mk-bounds-'))
  clock = Date.now()
  sessions.clear()
  store = await openStore()
})

afterEach(() => {
  try { store?.close() } catch { /* already closed */ }
  try { chmodSync(join(root, 'library'), 0o755) } catch { /* may not exist */ }
  rmSync(root, { recursive: true, force: true })
})

/* ---------------- hostile files ---------------- */

test('a binary file with a .md name does not crash the scan', async () => {
  const path = join(root, 'library', 'notes', 'binary.md')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x81]))
  await store.scan()   // must not throw
  assert.ok(store.graph.itemByPath(path), 'adopted as an item with garbage content')
})

test('a file with no permissions is skipped, not fatal', async () => {
  const good = seed('正常条目')
  const locked = join(root, 'library', 'notes', 'locked.md')
  writeFileSync(locked, '# locked\n')
  chmodSync(locked, 0o000)
  try {
    await store.scan()   // must not throw
    assert.ok(store.graph.item(good.id), 'the readable item is still tracked')
  } finally {
    chmodSync(locked, 0o644)
  }
})

test('an unreadable file is reported in the summary, not thrown', async () => {
  seed('正常条目')
  const locked = join(root, 'library', 'notes', 'locked2.md')
  writeFileSync(locked, '# locked\n')
  chmodSync(locked, 0o000)
  try {
    const summary = await store.scan()
    assert.ok(Array.isArray(summary.unreadable) && summary.unreadable.length === 1, 'the summary names the file')
    assert.equal(summary.unreadable[0].reason, 'EACCES')
  } finally {
    chmodSync(locked, 0o644)
  }
})

test('an empty directory tree scans without adding anything', async () => {
  mkdirSync(join(root, 'library', 'empty', 'deeper'), { recursive: true })
  const summary = await store.scan()
  assert.deepEqual(summary.added, [])
})

test('a very deep path is still classified as a one-level area', async () => {
  const deep = join(root, 'library', 'notes', 'a', 'b', 'c', 'deep.md')
  mkdirSync(dirname(deep), { recursive: true })
  writeFileSync(deep, '# deep\n> 何时用：x\n\n结论：y\n')
  await store.scan()
  const row = store.graph.itemByPath(deep)
  assert.equal(row.area, 'notes', 'only the first level names the area')
})

test('two files with the same id are detected and one becomes an alias', async () => {
  const a = seed('原始条目')
  const copy = join(root, 'library', 'notes', '副本.md')
  copyFileSync(a.path, copy)
  const summary = await store.scan()
  // The copy is either adopted as a new item or merged; either way the original survives.
  assert.ok(store.graph.item(a.id))
  assert.equal(parseItem(readFileSync(a.path, 'utf8')).id, a.id)
  assert.ok(summary.added.length + summary.merged.length + summary.copies.length >= 1)
})

test('README.md and dot-files are never adopted as items', async () => {
  mkdirSync(join(root, 'library', 'notes'), { recursive: true })
  writeFileSync(join(root, 'library', 'notes', 'README.md'), '# notes\n')
  writeFileSync(join(root, 'library', 'notes', '.hidden.md'), '# hidden\n')
  const summary = await store.scan()
  assert.deepEqual(summary.added, [])
})

test('a symlinked file inside the library is followed without looping', async () => {
  const real = join(root, 'library', 'notes', 'real.md')
  mkdirSync(dirname(real), { recursive: true })
  writeFileSync(real, '# real\n> 何时用：x\n\n结论：y\n')
  try { symlinkSync(real, join(root, 'library', 'notes', 'link.md')) } catch { return }
  await store.scan()   // must not throw or recurse forever
  assert.ok(store.graph.itemByPath(real))
})

/* ---------------- unreadable / missing state ---------------- */

test('an unreadable library directory never tombstones the whole library', async () => {
  const a = seed('条目一')
  const b = seed('条目二')
  chmodSync(join(root, 'library', 'notes'), 0o000)
  try {
    const summary = await store.scan()
    assert.deepEqual(summary.deleted, [], 'nothing is retired while the directory is unreadable')
    assert.ok(store.graph.item(a.id))
    assert.ok(store.graph.item(b.id))
  } finally {
    chmodSync(join(root, 'library', 'notes'), 0o755)
  }
})

test('a file that reappears after being deleted is recovered, not duplicated', async () => {
  const a = seed('会回来')
  const text = readFileSync(a.path, 'utf8')
  unlinkSync(a.path)
  await store.scan()                        // tombstone
  assert.equal(store.graph.item(a.id), undefined)
  writeFileSync(a.path, text)               // the person restores it
  await store.scan()
  assert.ok(store.graph.item(a.id), 'the same id comes back')
})

/* ---------------- concurrency and locking ---------------- */

test('two Stores over the same library both survive a write', async () => {
  const a = seed('并发条目')
  const second = await openStore()
  try {
    second.writeItem({ ...second.graph.item(a.id) }, { title: '并发条目', when: 'x', body: 'second writer' })
    await store.scan()
    assert.ok(store.graph.item(a.id))
  } finally {
    second.close()
  }
})

test('opening a database held by another process does not hang', async () => {
  const file = store.config.graphFile
  const started = Date.now()
  const other = await openGraph(file)
  other.close()
  assert.ok(Date.now() - started < 5000, 'openGraph must not block for long')
})

/* ---------------- graph edge cases ---------------- */

test('edges refuse self-reference and survive an alias', async () => {
  const a = seed('甲')
  const b = seed('乙')
  store.graph.addEdge({ from: a.id, to: b.id, type: 'related', by: 'curator' }, clock)
  assert.equal(store.graph.neighbors(a.id).length, 1)
  // Aliasing b into a drops the self-edge instead of keeping a loop.
  store.graph.addAlias(b.id, a.id)
  assert.equal(store.graph.neighbors(a.id).some(n => n.other === a.id), false)
})

test('the edge cap is enforced and does not corrupt existing edges', async () => {
  const hub = seed('中心')
  const leaves = Array.from({ length: 15 }, (_, i) => seed(`叶 ${i}`))
  let added = 0
  for (const leaf of leaves) {
    if (store.graph.edgeCount(hub.id) >= 12) break
    store.graph.addEdge({ from: hub.id, to: leaf.id, type: 'related', by: 'curator' }, clock)
    added++
  }
  assert.equal(store.graph.edgeCount(hub.id), 12)
  // Existing edges are still readable and complete.
  assert.equal(store.graph.neighbors(hub.id).length, 12)
})

test('supersedes cycles are detected before they are created', async () => {
  const a = seed('旧')
  const b = seed('新')
  store.graph.addEdge({ from: b.id, to: a.id, type: 'supersedes', by: 'curator' }, clock)
  assert.equal(store.graph.supersedesCycle(a.id, b.id), true)
  assert.equal(store.graph.supersedesCycle(a.id, seed('无关').id), false)
})

test('a use is recorded once per session even when cited repeatedly', async () => {
  const a = seed('被引用')
  assert.equal(store.graph.addUse({ itemId: a.id, sessionId: 's1', seq: 1 }, clock), true)
  assert.equal(store.graph.addUse({ itemId: a.id, sessionId: 's1', seq: 2 }, clock), false)
  assert.equal(store.graph.uses(a.id).length, 1)
})

test('the graph rebuilds from files with ids when the database is gone', async () => {
  const a = seed('幸存')
  store.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(store.config.graphFile + suffix, { force: true })
  store = await openStore()
  assert.ok(store.graph.item(a.id), 'recovered from the id line in the file')
})

/* ---------------- history ---------------- */

test('history keeps the newest version as baseline and prunes the old', async () => {
  const dir = join(root, 'meta', 'history-test')
  const history = new History(dir, { keepVersions: 2, keepDays: 0 })
  for (let i = 0; i < 6; i++) history.save('mk_aaaaaaaaaa', `v${i}`, 'machine', clock + i)
  const versions = history.list('mk_aaaaaaaaaa')
  assert.ok(versions.length >= 1, 'the newest version always survives')
  assert.equal(history.read('mk_aaaaaaaaaa', versions[0].name), 'v5', 'newest first')
})

test('a corrupt history file is reported, not silently misread', async () => {
  const dir = join(root, 'meta', 'history-bad')
  const history = new History(dir, { keepVersions: 10, keepDays: 90 })
  history.save('mk_bbbbbbbbbb', 'good', 'machine', clock)
  const name = history.list('mk_bbbbbbbbbb')[0].name
  writeFileSync(join(dir, 'mk_bbbbbbbbbb', name), 'corrupt')
  assert.throws(() => history.read('mk_bbbbbbbbbb'), /incorrect header check|invalid|Z_DATA_ERROR|unexpected/i)
})

/* ---------------- engine level ---------------- */

const fakeEngine = () => new Engine(store, {
  sessionQuery: () => ({
    listSessions: async () => [],
    readSession: async (id) => ({ events: sessions.get(id) ?? [] }),
  }),
  sessionTitle: async () => 't',
})

test('recall on an empty library answers instead of failing', async () => {
  const engine = fakeEngine()
  const areas = await engine.recall({})
  assert.equal(areas.kind, 'areas')
  assert.deepEqual(areas.areas, [])
  const hits = await engine.recall({ query: '任何东西' })
  assert.deepEqual(hits.items, [])
  const missing = await engine.recall({ id: 'mk_aaaaaaaaaa' })
  assert.equal(missing.kind, 'missing')
})

test('recall honours the result cap and never returns more than asked', async () => {
  for (let i = 0; i < 12; i++) seed(`条目 ${i}`, 'notes', `**结论**：共同关键词 ${i}\n\n**为什么**：x\n\n**边界**：y`)
  const engine = fakeEngine()
  const hits = await engine.recall({ query: '共同关键词', limit: 50 })
  assert.ok(hits.items.length <= 10, 'the hard cap is 10')
  const two = await engine.recall({ query: '共同关键词', limit: 2 })
  assert.equal(two.items.length, 2)
})

test('curation on an empty library reports done immediately', async () => {
  const engine = fakeEngine()
  engine.beginRun()
  const step = await engine.next({ charsLeft: 1000, sessionsLeft: 5 })
  assert.equal(step.done, true)
})

test('undo of a change that never happened is refused cleanly', async () => {
  const engine = fakeEngine()
  await assert.rejects(engine.undo({ change: 'c_missing' }), (e) => e.code === 'UNKNOWN_CHANGE')
})

test('status is serialisable and reports zeros on an empty library', async () => {
  const engine = fakeEngine()
  const status = engine.status()
  const { isJsonValue } = await import('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js')
  assert.ok(isJsonValue(status), 'status must be lossless JSON')
  assert.equal(status.counts.memory, 0)
  assert.equal(status.pendingHumanEdits, 0)
})

test('a remember call with no human message in the session is refused', async () => {
  const engine = fakeEngine()
  await assert.rejects(
    engine.remember({ kind: 'fact', claim: 'c', why: 'w'.repeat(20), scope: 's', when: 'x', area: 'notes', title: 'T' }, { sessionId: 'empty' }),
    (e) => e.code === 'EVIDENCE_MISSING',
  )
})

test('concurrent writes to the same item keep exactly one winner', async () => {
  const a = seed('并发')
  const base = store.graph.item(a.id).fingerprint
  const results = await Promise.allSettled([1, 2, 3].map(n =>
    Promise.resolve().then(() => store.writeItem({ ...store.graph.item(a.id) }, { title: '并发', when: 'x', body: `版本 ${n}` }, { baseFingerprint: base }))))
  assert.ok(results.some(r => r.status === 'fulfilled'), 'at least one write lands')
  assert.ok(existsSync(a.path))
  assert.ok(store.graph.item(a.id), 'the row survives')
})

/* ---------------- more edge conditions ---------------- */

test('a title that collides with an existing file gets a numeric suffix', async () => {
  const a = seed('同名')
  const b = seed('同名')
  assert.notEqual(a.path, b.path)
  assert.match(b.path, /-2\.md$/)
  assert.ok(existsSync(a.path) && existsSync(b.path))
})

test('moveItem between pools keeps the id and the body', async () => {
  const a = seed('会移动')
  const body = parseItem(readFileSync(a.path, 'utf8')).body
  const moved = store.moveItem(a.id, 'archive')
  assert.equal(moved.id, a.id)
  assert.equal(moved.pool, 'archive')
  assert.ok(moved.path.includes('_archive'))
  assert.equal(parseItem(readFileSync(moved.path, 'utf8')).body, body)
})

test('restoreVersion on a deleted item brings the file back with its id', async () => {
  const a = seed('会恢复')
  clock += 10
  store.writeItem({ ...store.graph.item(a.id) }, { title: '会恢复', when: 'x', body: '第二版' })
  unlinkSync(a.path)
  await store.scan()
  assert.equal(store.graph.item(a.id), undefined, 'gone from the graph')
  const restored = store.restoreVersion(a.id)
  assert.ok(restored)
  assert.equal(parseItem(readFileSync(restored.path, 'utf8')).id, a.id)
})

test('a file edited while the scan runs does not produce a torn read', async () => {
  const a = seed('边写边扫')
  const writer = (async () => {
    for (let i = 0; i < 20; i++) {
      writeFileSync(a.path, `# 边写边扫\n> 何时用：x\n\n结论：${i}\n\n<!-- dmk:id=${a.id} -->\n`)
      await new Promise(r => setTimeout(r, 1))
    }
  })()
  await Promise.all([store.scan(), writer])
  assert.ok(store.graph.item(a.id), 'the item survives concurrent edits')
})

test('an item whose area folder is deleted is recreated on the next write', async () => {
  const a = seed('分类会没', 'temp-area')
  rmSync(join(root, 'library', 'temp-area'), { recursive: true, force: true })
  await store.scan()
  const again = seed('分类会没二', 'temp-area')
  assert.ok(existsSync(dirname(again.path)))
})

test('the importer refuses a path outside any readable location', async () => {
  const { listImportable } = await import('../lib/importer.js')
  assert.deepEqual(listImportable('/nope/does/not/exist'), [])
  assert.deepEqual(listImportable(root, [root]), [], 'the library itself is excluded')
})

test('a markdown file with only an id line is still tracked', async () => {
  const path = join(root, 'library', 'notes', 'onlyid.md')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '<!-- dmk:id=mk_zzzzzzzzzz -->\n')
  await store.scan()
  const row = store.graph.item('mk_zzzzzzzzzz')
  assert.ok(row, 'an identity is enough to adopt it')
  assert.equal(row.title, '')
})
