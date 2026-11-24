/**
 * Pure building blocks: item format, fingerprint, diff, search, config.
 * These run under plain Node (no DSH host needed).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newId, isId, normalize, fingerprint, parseItem, composeItem, stampId, composeSkill, slugify,
} from '../lib/item.js'
import { myers, inlineDiff, renderDiff } from '../lib/diff.js'
import { tokenize, jaccard, SearchIndex, stripQuestionWords } from '../lib/search.js'
import { resolveConfig } from '../lib/config.js'

test('ids have the expected grammar and are distinct', () => {
  const ids = new Set(Array.from({ length: 2000 }, () => newId()))
  assert.equal(ids.size, 2000)
  for (const id of ids) assert.ok(isId(id), id)
  assert.equal(isId('mk_short'), false)
  assert.equal(isId('MK_ABCDEFGHIJ'), false)
})

test('fingerprint ignores trailing whitespace and newline style, not content', () => {
  assert.equal(fingerprint('a\r\nb  \n\n'), fingerprint('a\nb'))
  assert.notEqual(fingerprint('a\nb'), fingerprint('a\nc'))
  assert.equal(normalize('x \t\ny\n\n\n'), 'x\ny')
})

test('the identity line sits at the end and is excluded from the fingerprint', () => {
  const id = newId()
  const text = composeItem({ id, title: '按量计费的 CU 换算口径', when: '客户询价时', body: '结论：…\n\n为什么：…' })
  const lines = text.trimEnd().split('\n')
  assert.match(lines.at(-1), /^<!-- dmk:id=mk_[a-z0-9]{10} -->$/)
  assert.equal(lines[0], '# 按量计费的 CU 换算口径')
  assert.equal(lines[1], '> 何时用：客户询价时')
  const parsed = parseItem(text)
  assert.equal(parsed.id, id)
  assert.equal(parsed.title, '按量计费的 CU 换算口径')
  assert.equal(parsed.when, '客户询价时')
  // Same body with the id line removed has the same fingerprint.
  assert.equal(parseItem(text.replace(/<!--.*-->\n?/, '')).fingerprint, parsed.fingerprint)
})

test('restamping keeps the body byte-identical and finds merged ids', () => {
  const id = newId()
  const body = '# 标题\n> 何时用：x\n\n正文第一行\n正文第二行'
  const stamped = stampId(body, id)
  assert.equal(parseItem(stamped).fingerprint, parseItem(body).fingerprint)
  const merged = `${stamped}\n更多内容\n<!-- dmk:id=${newId()} -->\n`
  const parsed = parseItem(merged)
  assert.equal(parsed.ids.length, 2)
  assert.equal(parsed.id, id)
})

test('skills carry the id in frontmatter metadata, never at the head', () => {
  const id = newId()
  const text = composeSkill({ id, name: 'publish-dsh-plugin', description: '发布 "DSH" 插件到市场', whenToUse: '要发布插件时', body: '1. 检查\n2. 提交' })
  assert.ok(text.startsWith('---\nname: publish-dsh-plugin\n'))
  const parsed = parseItem(text, 'skill')
  assert.equal(parsed.id, id)
  assert.equal(parsed.title, 'publish-dsh-plugin')
  assert.equal(parsed.when, '要发布插件时')
  assert.ok(!text.includes('"DSH"'), 'double quotes inside values are neutralized')
})

test('slugify keeps CJK, strips path characters, caps length', () => {
  assert.equal(slugify('按量计费/CU:换算?'), '按量计费-CU-换算')
  assert.equal(slugify('   '), 'untitled')
  assert.ok([...slugify('长'.repeat(200))].length <= 60)
})

test('myers produces a minimal script that rebuilds both sides', () => {
  const a = 'ABCABBA'.split('')
  const b = 'CBABAC'.split('')
  const ops = myers(a, b)
  assert.deepEqual(ops.filter(o => o.op !== '+').map(o => o.value), a)
  assert.deepEqual(ops.filter(o => o.op !== '-').map(o => o.value), b)
  assert.equal(ops.filter(o => o.op !== '=').length, 5)
})

test('inline diff marks only the changed characters of a Chinese line', () => {
  assert.equal(inlineDiff('套餐价格是每月 19 元', '套餐价格是每月 29 元'), '套餐价格是每月 [-1-]{+2+}9 元')
})

test('renderDiff pairs changed lines, keeps context, flags rewrites', () => {
  const before = ['标题', '甲', '乙', '丙', '丁', '戊', '己'].join('\n')
  const after = ['标题', '甲', '乙改', '丙', '丁', '戊', '己', '庚'].join('\n')
  const out = renderDiff(before, after, { context: 1 })
  assert.equal(out.changed, true)
  assert.match(out.text, /~ 乙\{\+改\+\}/)
  assert.match(out.text, /\+ 庚/)
  assert.equal(renderDiff('same', 'same').changed, false)
  assert.equal(renderDiff('a', 'b'.repeat(5000), { maxChars: 100 }).rewrite, true)
})

test('tokenizer splits CJK into bigrams and keeps Latin words', () => {
  assert.deepEqual(tokenize('CU换算'), ['cu', '换算'])
  assert.deepEqual(tokenize('按量计费'), ['按量', '量计', '计费'])
  assert.deepEqual(tokenize('价'), ['价'])
  assert.deepEqual(tokenize('DSH plugin v2'), ['dsh', 'plugin', 'v2'])
})

test('jaccard is symmetric and bounded', () => {
  assert.equal(jaccard('按量计费', '按量计费'), 1)
  assert.equal(jaccard('', 'x'), 0)
  const s = jaccard('CloudBase 按量计费口径', '按量计费的 CU 换算')
  assert.ok(s > 0 && s < 1)
  assert.equal(s, jaccard('按量计费的 CU 换算', 'CloudBase 按量计费口径'))
})

test('BM25 ranks title matches above body mentions', () => {
  const index = new SearchIndex()
  index.put('a', { title: '按量计费的 CU 换算口径', when: '客户询价', area: 'cloudbase', body: '……' })
  index.put('b', { title: '周报模板', when: '写周报', area: 'cloudbase', body: '偶尔提到按量计费' })
  index.put('c', { title: '无关', when: '', area: 'finance', body: '股票' })
  const hits = index.search('按量计费怎么算', { limit: 3 })
  assert.equal(hits[0].id, 'a')
  assert.ok(hits.some(h => h.id === 'b'))
  assert.ok(!hits.some(h => h.id === 'c'))
  index.remove('a')
  assert.equal(index.search('按量计费')[0].id, 'b')
  assert.equal(index.size, 2)
})

test('config fills defaults and rejects dangerous values', () => {
  const warnings = []
  const cfg = resolveConfig({ injectTag: 'x"><script', curator: { time: '25:00', maxCharsPerRun: 0 }, memoryRoot: 'relative/path' }, w => warnings.push(w))
  assert.equal(cfg.injectTag, 'dmk')
  assert.equal(cfg.curator.time, '00:30')
  assert.equal(cfg.curator.maxCharsPerRun, 120000)
  assert.ok(cfg.root.endsWith('memory-knowledge'))
  assert.ok(cfg.library.endsWith('memory-knowledge/library'))
  assert.ok(warnings.length >= 3)
  assert.equal(resolveConfig({ injectTag: 'kb_mem' }).injectTag, 'kb_mem')
})

test('search: question framing does not outrank the subject', () => {
  const index = new SearchIndex()
  const add = (id, title) => index.put(id, { title, when: '', area: '', body: '' })
  add('weekly-1', '周报收录门槛：只收 P0/P1')
  add('weekly-2', '周报收入：只写一个总值折后实收')
  add('writing-1', '怎么写技术文档：让 Agent 越来越懂你')
  add('writing-2', '怎么写周报的模板与禁忌')
  add('other-1', '完全无关的条目')

  // Without stripping, 「怎么写」 carries more IDF than 周报 and retrieves the
  // writing note. With it, the subject decides.
  const hits = index.search('周报怎么写', { limit: 3 })
  assert.ok(hits.length >= 2)
  assert.match(hits[0].id, /^weekly-/, `expected 周报 entries first, got ${hits[0].id}`)

  assert.equal(stripQuestionWords('周报怎么写'), '周报')
  assert.equal(stripQuestionWords('记忆插件怎么用'), '记忆插件 用')
  // A query made only of question words has to survive untouched.
  assert.equal(stripQuestionWords('为什么'), '为什么')
  assert.equal(stripQuestionWords('？'), '？')
})
