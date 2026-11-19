import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { resolveConfig } from '../lib/config.js'
import { Store } from '../lib/store.js'

test('rewriting a file in place (no id line) edits the existing item, no UNIQUE crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mk-rewrite-'))
  const store = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await store.open()
  const path = store.pathFor('staging', 'preferences', '部署前检查清单')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '# 部署前检查清单\n> 何时用：发布前\n\n结论：检查配置\n\n<!-- dmk:id=mk_aaaaaaaaa0 -->\n')
  await store.scan()  // → human-add
  const id = store.graph.itemByPath(path).id
  // The person replaces the whole content, no id line, completely different text.
  writeFileSync(path, '# 全新的标题\n> 何时用：别的场景\n\n结论：完全不同的内容，且没有 ID 行')
  const summary = await store.scan()
  assert.deepEqual(summary.added, [], 'not a new item')
  assert.deepEqual(summary.edited, [id], 'it is the same item, edited')
  const row = store.graph.item(id)
  assert.equal(row.title, '全新的标题')
  assert.notEqual(row.human_at, null)
  const record = store.changelog.recent(5).find(r => r.op === 'human-edit')
  assert.ok(record, 'a human-edit was recorded')
  store.close(); rmSync(root, { recursive: true, force: true })
})

test('a corrupt graph database is rebuilt from the Markdown files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mk-corrupt-recover-'))
  const first = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await first.open()
  const path = first.pathFor('memory', 'preferences', '幸存条目')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '# 幸存条目\n> 何时用：x\n\n结论：内容\n\n<!-- dmk:id=mk_aaaaaaaaa0 -->\n')
  await first.scan()
  assert.ok(first.graph.item('mk_aaaaaaaaa0'))
  first.close()
  // Corrupt the database beyond repair.
  writeFileSync(join(root, 'meta', 'graph.sqlite'), 'garbage that is definitely not sqlite')
  const second = new Store(resolveConfig({ memoryRoot: root }), { now: () => Date.now() })
  await second.open()
  const row = second.graph.item('mk_aaaaaaaaa0')
  assert.ok(row, 'the item was rebuilt from its file')
  assert.equal(row.title, '幸存条目')
  assert.ok(second.index.search('幸存')[0]?.id === 'mk_aaaaaaaaa0')
  second.close()
  rmSync(root, { recursive: true, force: true })
})
