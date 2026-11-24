/**
 * Boundary conditions for the pure functions: every exported helper is fed the
 * empty, oversized, malformed, and adversarial inputs it will meet in a library
 * that people edit by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  newId, isId, normalizeId, normalize, fingerprint, splitFrontmatter, parseItem, essence, fullText,
  composeItem, stampId, composeSkill, slugify, ID_LINE,
} from '../lib/item.js'
import { myers, inlineDiff, renderDiff } from '../lib/diff.js'
import { tokenize, jaccard, SearchIndex } from '../lib/search.js'
import { squeeze, overlapRatio, containsSecret, validArea, checkChecklist, composeBodyText, checkNotTranscription, checkDuplicates, checkResurrection, checkHumanLock, checkEdges, GateError, MAX_BODY_CHARS } from '../lib/gate.js'
import { chunkMarkdown, numberLines, listImportable } from '../lib/importer.js'
import { neutralize, fit, snapshotText, curatorProtocol } from '../lib/prompt.js'
import { redact, textOf, messageOf, lastCompleteSeq, shorten, citedPaths, digestSession, cwdInScope, eligibleSession, messageAt, lastHumanMessage } from '../lib/digest.js'
import { myers as _m } from '../lib/diff.js'
import { resolveConfig, expandPaths, realPath, layout } from '../lib/config.js'
import { tokenize as _t } from '../lib/search.js'

/* ---------------- item format ---------------- */

test('item: empty and whitespace-only input', () => {
  assert.equal(normalize(''), '')
  assert.equal(normalize('   \n\t\n'), '')
  const parsed = parseItem('')
  assert.equal(parsed.id, undefined)
  assert.deepEqual(parsed.ids, [])
  assert.equal(parsed.title, '')
  assert.equal(parsed.when, '')
})

test('item: an id line alone, with no body', () => {
  const parsed = parseItem('<!-- dmk:id=mk_abcdefghij -->\n')
  assert.equal(parsed.id, 'mk_abcdefghij')
  assert.equal(parsed.title, '')
  assert.equal(parsed.fingerprint, fingerprint(''))
})

test('item: several id lines report all and use the first', () => {
  const text = '# T\n<!-- dmk:id=mk_aaaaaaaaaa -->\n中间\n<!-- dmk:id=mk_bbbbbbbbbb -->\n'
  const parsed = parseItem(text)
  assert.deepEqual(parsed.ids, ['mk_aaaaaaaaaa', 'mk_bbbbbbbbbb'])
  assert.equal(parsed.id, 'mk_aaaaaaaaaa')
})

test('item: id lines are parsed leniently but never loosely', () => {
  // Whitespace around the marker is tolerated on purpose: editors and people
  // reformat comments. The id itself must still be well-formed.
  assert.deepEqual(parseItem('# T\n<!--dmk:id=mk_aaaaaaaaaa-->\n').ids, ['mk_aaaaaaaaaa'])
  assert.deepEqual(parseItem('# T\n<!--   dmk:id=mk_aaaaaaaaaa   -->\n').ids, ['mk_aaaaaaaaaa'])
  for (const bad of ['<!-- dmk:id=mk_SHORT -->', '<!-- dmk:id=aaaaaaaaaa -->', '<!-- dmk:id=mk_aaaaaaaaaaa -->', 'dmk:id=mk_aaaaaaaaaa']) {
    assert.deepEqual(parseItem(`# T\n${bad}\n`).ids, [], bad)
  }
})

test('item: normalizeId accepts the shapes a model actually sends', () => {
  const want = 'mk_abcdefghij'
  for (const input of [want, 'abcdefghij', '`mk_abcdefghij`', '[mk_abcdefghij]', 'MK_ABCDEFGHIJ', ' mk_abcdefghij ']) {
    assert.equal(normalizeId(input), want, input)
  }
  assert.equal(normalizeId('not-an-id'), 'not-an-id')
  assert.equal(normalizeId(''), '')
})

test('item: titles and when-lines with markdown lookalikes', () => {
  const body = '# 带 # 号的标题\n> 何时用：含 > 和 —— 的说明\n\n正文'
  const parsed = parseItem(body)
  assert.equal(parsed.title, '带 # 号的标题')
  assert.match(parsed.when, /含 > 和/)
})

test('item: very long single line does not truncate the fingerprint', () => {
  const long = 'x'.repeat(200_000)
  assert.notEqual(fingerprint(long), fingerprint(`${long}y`))
})

test('item: CRLF and CR-only files normalize identically', () => {
  assert.equal(fingerprint('a\r\nb\rc'), fingerprint('a\nb\nc'))
})

test('item: skill frontmatter edge cases', () => {
  // No frontmatter at all → no id, body is the whole text.
  const plain = parseItem('just text', 'skill')
  assert.equal(plain.id, undefined)
  assert.equal(plain.body, 'just text')
  // Unterminated frontmatter → treated as plain text, never a crash.
  assert.equal(parseItem('---\nname: x\n', 'skill').id, undefined)
  // Empty frontmatter is still frontmatter.
  const empty = parseItem('---\n---\nbody', 'skill')
  assert.equal(empty.id, undefined)
  assert.equal(empty.body, 'body')
  // dmk_id outside a metadata block is not an identity.
  assert.equal(parseItem('---\nname: x\ndmk_id: mk_aaaaaaaaaa\n---\n', 'skill').id, undefined)
})

test('item: composeSkill strips newlines and quotes from one-line fields', () => {
  const text = composeSkill({ id: 'mk_aaaaaaaaaa', name: 'n', description: 'a\nb "c"', whenToUse: 'x\ny', body: 'body' })
  assert.doesNotMatch(text.split('---')[1], /a\nb/)
  assert.match(text, /description: "a b 'c'"/)
})

test('item: stampId replaces an existing line instead of appending a second', () => {
  const once = stampId('# T\nbody', 'mk_aaaaaaaaaa')
  const twice = stampId(once, 'mk_bbbbbbbbbb')
  assert.equal(parseItem(twice).ids.length, 1)
  assert.equal(parseItem(twice).id, 'mk_bbbbbbbbbb')
})

test('item: slugify edge cases never yield an unusable name', () => {
  for (const input of ['', '   ', '///', '..', '.hidden', 'a'.repeat(500), '😀😀', '\u0000', '../../etc/passwd']) {
    const slug = slugify(input)
    assert.ok(slug.length > 0, JSON.stringify(input))
    assert.equal(slug.includes('/'), false, `${JSON.stringify(input)} → ${slug}`)
    assert.equal(slug.startsWith('.'), false, `${JSON.stringify(input)} → ${slug}`)
    assert.ok([...slug].length <= 60)
  }
})

test('item: essence and fullText handle missing pieces', () => {
  assert.equal(essence('T', ''), 'T')
  assert.equal(essence('', ''), '')
  assert.equal(fullText('T', '# 标题\n> 何时用：x\n\n结论：y'), 'T 结论：y')
})

/* ---------------- diff ---------------- */

test('diff: identical and empty inputs', () => {
  assert.deepEqual(myers([], []), [])
  assert.deepEqual(myers([], ['a']), [{ op: '+', value: 'a' }])
  assert.deepEqual(myers(['a'], []), [{ op: '-', value: 'a' }])
  assert.equal(renderDiff('', '').changed, false)
  assert.equal(renderDiff('a', 'a').changed, false)
})

test('diff: one side empty is a full add or delete, never a crash', () => {
  const added = renderDiff('', 'a\nb')
  assert.equal(added.added, 2)
  assert.equal(added.removed, 0)
  const removed = renderDiff('a\nb', '')
  assert.equal(removed.removed, 2)
})

test('diff: a complete rewrite is flagged for the caller to send the text whole', () => {
  const result = renderDiff('a\nb\nc', 'x\ny\nz', { maxChars: 5 })
  assert.equal(result.rewrite, true)
})

test('diff: change in the middle keeps context and marks the gap', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n')
  const after = before.replace('line15', 'line15-changed')
  const result = renderDiff(before, after, { context: 1 })
  assert.match(result.text, /…/)
  assert.match(result.text, /\{\+-changed\+\}/)
})

test('diff: unicode and surrogate pairs survive', () => {
  const result = renderDiff('前😀后', '前😀中后')
  assert.equal(result.changed, true)
  assert.ok(result.text.length > 0)
})

/* ---------------- search ---------------- */

test('search: tokenizer edge cases', () => {
  assert.deepEqual(tokenize(''), [])
  assert.deepEqual(tokenize('   '), [])
  assert.deepEqual(tokenize('a'), [])
  assert.deepEqual(tokenize('中'), ['中'])
  assert.deepEqual(tokenize('a中b'), ['a', '中', 'b'])
  assert.deepEqual(tokenize('123'), ['123'])
  assert.deepEqual(tokenize('，，。'), [])
})

test('search: empty index and never-matching queries', () => {
  const index = new SearchIndex()
  assert.deepEqual(index.search('anything'), [])
  assert.equal(index.size, 0)
  index.put('a', { title: 'T', when: '', area: '', body: 'x' })
  assert.deepEqual(index.search(''), [])
  assert.deepEqual(index.search('完全不存在的词'), [])
})

test('search: re-putting the same id replaces it, remove of an unknown id is safe', () => {
  const index = new SearchIndex()
  index.put('a', { title: '甲', when: '', area: '', body: '' })
  index.put('a', { title: '乙乙', when: '', area: '', body: '' })
  assert.equal(index.size, 1)
  assert.equal(index.search('乙乙')[0].id, 'a')
  index.remove('nope')
  assert.equal(index.size, 1)
})

test('search: jaccard is 0 for empty and 1 for identical', () => {
  assert.equal(jaccard('', ''), 0)
  assert.equal(jaccard('甲', ''), 0)
  assert.equal(jaccard('按量计费', '按量计费'), 1)
})

/* ---------------- gate ---------------- */

test('gate: squeeze and overlapRatio boundaries', () => {
  assert.equal(squeeze(''), '')
  assert.equal(squeeze(' a \n b '), 'ab')
  assert.equal(overlapRatio('', ''), 0)
  assert.equal(overlapRatio('短', '短'), 0)           // below the 16-char floor
  assert.equal(overlapRatio('x'.repeat(40), 'x'.repeat(40)), 1)
})

test('gate: containsSecret flags each shape and clears ordinary prose', () => {
  const secrets = [
    'sk-' + 'a'.repeat(20),
    'ghp_' + 'a'.repeat(30),
    'glpat-' + 'a'.repeat(20),
    'AKIA' + 'A'.repeat(16),
    'npm_' + 'a'.repeat(36),
    'AIzaSy' + 'D'.repeat(33),
    'eyJ' + 'a'.repeat(12) + '.' + 'b'.repeat(12) + '.' + 'c'.repeat(12),
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgres://u:' + 'p'.repeat(10) + '@h/d',
    '密码：abc12345',
  ]
  for (const secret of secrets) assert.equal(containsSecret(secret), true, secret.slice(0, 20))
  for (const plain of ['', '按量计费口径', '每 CU 换算 19 元', 'token 过期了要刷新']) {
    assert.equal(containsSecret(plain), false, plain)
  }
})

test('gate: validArea refuses separators, dots, reserved and empty', () => {
  for (const bad of ['', ' ', '.x', '..', 'a/b', 'a\\b', '_staging', '_archive', 'skills', 'workspace', 'meta', 'a'.repeat(41), 'a\nb']) {
    assert.equal(validArea(bad), false, JSON.stringify(bad))
  }
  // A space is legal on disk but hostile to shells and scripts, so it is refused.
  for (const good of ['cloudbase', 'preferences', '中文分类', 'a-1', 'a_b']) {
    assert.equal(validArea(good), true, good)
  }
  assert.equal(validArea('a b'), false)
})

test('gate: checklist rejects each missing field and oversized bodies', () => {
  const base = { kind: 'fact', claim: 'c', why: 'w'.repeat(20), scope: 's', when: 'x', area: 'a' }
  for (const field of ['claim', 'why', 'scope', 'when']) {
    assert.throws(() => checkChecklist({ ...base, [field]: '' }), (e) => e.code === 'CHECKLIST_INCOMPLETE', field)
  }
  assert.throws(() => checkChecklist({ ...base, kind: 'unknown' }), (e) => e.code === 'CHECKLIST_INCOMPLETE')
  assert.throws(() => checkChecklist({ ...base, details: 'x'.repeat(MAX_BODY_CHARS * 2) }), (e) => e.code === 'TOO_LONG')
  assert.throws(() => checkChecklist({ ...base, validity: 'temporary' }), (e) => e.code === 'TEMPORARY')
})

test('gate: duplicates need an explicit resolution', () => {
  const similar = [{ id: 'a', title: 't', pool: 'memory', status: 'active', similarity: 0.9 }]
  assert.throws(() => checkDuplicates(similar, undefined), (e) => e.code === 'NEEDS_RESOLUTION')
  assert.deepEqual(checkDuplicates(similar, 'update'), similar)
  assert.deepEqual(checkDuplicates([], undefined), [])
})

test('gate: resurrection only fires on old evidence', () => {
  const tombstones = [{ id: 'x', title: 'T', text: 'T 结论', retired_at: 1000 }]
  const oldEv = [{ kind: 'session', time: 500, role: 'user' }]
  const newEv = [{ kind: 'session', time: 2000, role: 'user' }]
  assert.throws(() => checkResurrection('T 结论', tombstones, oldEv, 0), (e) => e.code === 'RESURRECTION')
  checkResurrection('T 结论', tombstones, newEv, 0)   // newer evidence may overturn
  // bestLive only excuses a candidate that is *more* similar to a living item
  // than to the tombstone. Identical text (similarity 1) is never excused, so a
  // high bestLive below 1 must still be refused.
  assert.throws(() => checkResurrection('T 结论', tombstones, oldEv, 0.99), (e) => e.code === 'RESURRECTION')
  // A genuinely closer living item (bestLive 1) wins, leaving it to the duplicate check.
  checkResurrection('T 结论', tombstones, oldEv, 1)
})

test('gate: human lock requires newer human evidence', () => {
  assert.doesNotThrow(() => checkHumanLock(undefined, []))
  assert.doesNotThrow(() => checkHumanLock({ human_at: null }, []))
  const row = { human_at: 1000 }
  assert.throws(() => checkHumanLock(row, [{ kind: 'session', role: 'user', time: 500 }]), (e) => e.code === 'LOCKED')
  checkHumanLock(row, [{ kind: 'session', role: 'user', time: 2000 }])
})

test('gate: edges refuse self-links, unknown targets and bad types', () => {
  const graph = { edgeCount: () => 0, item: (id) => (id === 'b' ? { id: 'b', title: 'B' } : undefined), supersedesCycle: () => false }
  assert.throws(() => checkEdges([{ to: 'a', type: 'related' }], 'a', graph), (e) => e.code === 'BAD_EDGE')
  assert.throws(() => checkEdges([{ to: 'zzz', type: 'related' }], 'a', graph), (e) => e.code === 'BAD_EDGE')
  assert.throws(() => checkEdges([{ to: 'b', type: 'nope' }], 'a', graph), (e) => e.code === 'BAD_EDGE')
  assert.doesNotThrow(() => checkEdges([{ to: 'b', type: 'related' }], 'a', graph))
  assert.doesNotThrow(() => checkEdges(undefined, 'a', graph))
})

/* ---------------- importer ---------------- */

test('importer: chunking never loses content and never emits an empty chunk', () => {
  assert.deepEqual(chunkMarkdown(''), [])
  const text = ['# A', 'x'.repeat(5000), '# B', 'y'.repeat(5000), '# C', 'z'].join('\n')
  const chunks = chunkMarkdown(text)
  assert.ok(chunks.length >= 2)
  for (const chunk of chunks) {
    assert.ok(chunk.text.trim().length > 0)
    assert.ok(chunk.startLine >= 1)
  }
  const joined = chunks.map(c => c.text).join('\n')
  for (const line of ['# A', '# B', '# C', 'z']) assert.ok(joined.includes(line), line)
})

test('importer: numbering is exact for a chunk', () => {
  const numbered = numberLines({ startLine: 5, text: 'a\nb' })
  assert.equal(numbered, '5| a\n6| b')
})

test('importer: listImportable refuses missing paths and non-text files', () => {
  assert.deepEqual(listImportable('/definitely/not/here'), [])
})

/* ---------------- prompt ---------------- */

test('prompt: neutralize removes boundary-breaking characters only', () => {
  assert.equal(neutralize('a<b>c'), 'a‹b>c')  // only '<' can open a tag
  assert.equal(neutralize('a\nb'), 'a b')
  assert.equal(neutralize('正常中文'), '正常中文')
  assert.equal(neutralize(undefined), '')
})

test('prompt: fit truncates with an explicit note instead of silently dropping', () => {
  assert.equal(fit([], 100), '')
  assert.equal(fit(['ab'], 100), 'ab')
  const cut = fit(['a'.repeat(50), 'b'.repeat(50)], 20)
  assert.match(cut, /还有 \d+ 项/)
})

test('prompt: snapshot always renders, even with nothing to say', () => {
  const text = snapshotText({ tag: 'dmk', root: '/r', areas: [], preferences: [], directoryMaxChars: 400, profileMaxChars: 600, subagent: false })
  assert.match(text, /^<dmk>/)
  assert.match(text, /<\/dmk>$/)
  // The empty index now points at mk_recall rather than claiming to be empty.
  assert.match(text, /mk_recall/)
  assert.doesNotMatch(text, /暂无分类/)
  const sub = snapshotText({ tag: 'dmk', root: '/r', areas: [], preferences: [], directoryMaxChars: 400, profileMaxChars: 600, subagent: true })
  assert.doesNotMatch(sub, /mk_remember/, 'a sub-agent does not get the write instructions')
})

test('prompt: an invalid tag cannot break out of the wrapper', () => {
  const text = snapshotText({ tag: 'dmk', root: '/r<script>', areas: [{ area: '<b>x</b>', description: '<i>y</i>', count: 1 }], preferences: [], directoryMaxChars: 400, profileMaxChars: 600, subagent: false })
  assert.equal(text.includes('<script>'), false)
  assert.equal(text.includes('<b>'), false)
})

test('prompt: curator protocol includes the user extra and stays wrapped', () => {
  const text = curatorProtocol({ extra: '  ' })
  assert.match(text, /^<memory-curator/)
  assert.doesNotMatch(text, /补充要求/)
  assert.match(curatorProtocol({ extra: '多关注定价' }), /多关注定价/)
})

/* ---------------- digest ---------------- */

test('digest: redact is stable on empty and already-clean text', () => {
  assert.equal(redact(''), '')
  assert.equal(redact('普通中文内容'), '普通中文内容')
})

test('digest: textOf and shorten handle non-string content', () => {
  assert.equal(textOf(undefined), '')
  assert.equal(textOf([{ type: 'text', text: 'a' }, { type: 'tool-call' }]), 'a')
  assert.equal(shorten('abc', 10), 'abc')
  assert.match(shorten('a'.repeat(100), 10), /已截断/)
})

test('digest: messageOf ignores every injected source and keeps real humans', () => {
  const human = { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }
  assert.ok(messageOf(human, ['user']))
  for (const kind of ['runtime-context', 'time-context', 'skill-catalog', 'agent-instructions', 'schedule', 'tool-jobs']) {
    const injected = { type: 'user/message', seq: 2, time: 2, data: { source: { kind, form: 'notice' }, content: [{ type: 'text', text: 'x' }] } }
    assert.equal(messageOf(injected, ['user']), undefined, kind)
  }
  // Empty text is not material.
  assert.equal(messageOf({ type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '   ' }] } }, ['user']), undefined)
})

test('digest: lastCompleteSeq ignores a live turn', () => {
  assert.equal(lastCompleteSeq([]), 0)
  assert.equal(lastCompleteSeq([{ type: 'turn/end', seq: 5 }, { type: 'turn/start', seq: 6 }]), 5)
})

test('digest: citedPaths only matches paths under the library', () => {
  const library = '/home/u/.dsh/memory-knowledge/library'
  const text = `看 [a](<${library}/x/a.md>) 和 [b](</etc/passwd>) 和 ${library}/y/b.md`
  const paths = citedPaths(text, library)
  assert.ok(paths.includes(`${library}/x/a.md`))
  assert.ok(paths.includes(`${library}/y/b.md`))
  assert.equal(paths.some(p => p.startsWith('/etc')), false)
})

test('digest: an empty session produces no text and advances nothing', () => {
  const digest = digestSession([], {})
  assert.equal(digest.text, '')
  assert.equal(digest.messages, 0)
  assert.equal(digest.toSeq, 0)
})

test('digest: scope matching handles prefixes without false positives', () => {
  const options = { includeCwd: ['/tmp/mk-acceptance'], excludeCwd: ['/tmp/mk-acceptance/skip'] }
  assert.equal(cwdInScope('/tmp/mk-acceptance', options), true)
  assert.equal(cwdInScope('/tmp/mk-acceptance/sub', options), true)
  assert.equal(cwdInScope('/tmp/mk-acceptance/skip', options), false)
  assert.equal(cwdInScope('/tmp/mk-acceptance-other', options), false, 'a sibling prefix is not inside')
  assert.equal(cwdInScope('', options), false)
  assert.equal(cwdInScope(undefined, options), false)
})

test('digest: subagent sessions and the curator workspace are excluded', () => {
  const options = { workspace: '/w', includeCwd: [], excludeCwd: [] }
  assert.equal(eligibleSession(undefined, options), false)
  assert.equal(eligibleSession({ origin: 'subagent' }, options), false)
  assert.equal(eligibleSession({ delegationDepth: 2 }, options), false)
  assert.equal(eligibleSession({ cwd: '/w' }, options), false)
  assert.equal(eligibleSession({ cwd: '/w/sub' }, options), false)
  assert.equal(eligibleSession({ cwd: '/elsewhere' }, options), true)
})

test('digest: messageAt and lastHumanMessage on a session with no humans', () => {
  const events = [{ type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'only assistant' }] } } }]
  // humanKinds filters user/message sources only; assistant replies are always material.
  assert.equal(messageAt(events, 1, ['user'])?.role, 'assistant')
  assert.equal(messageAt(events, 99, ['user']), undefined)
  assert.equal(lastHumanMessage(events, ['user']), undefined, 'there is no human message here')
})

/* ---------------- config ---------------- */

test('config: every malformed section falls back to defaults', () => {
  const warnings = []
  const cfg = resolveConfig({
    memoryRoot: 123,
    injectTag: '',
    curator: { time: 'abc', maxCharsPerRun: -5, enabled: 'yes' },
    capture: { includeCwd: 'not-an-array', excludeCwd: [1, 2] },
    recall: { limit: 0, snippetChars: -1 },
    pools: { promoteVotes: 0, stagingExpireDays: -3 },
    history: { keepVersions: -1 },
    skills: { maxSkills: -1, linkTargets: 'x' },
  }, message => warnings.push(message))
  assert.ok(cfg.root.endsWith('memory-knowledge'))
  assert.equal(cfg.injectTag, 'dmk')
  assert.equal(cfg.curator.time, '00:30')
  assert.equal(cfg.curator.enabled, true)
  assert.ok(cfg.curator.maxCharsPerRun > 0)
  assert.deepEqual(cfg.capture.includeCwd, [])
  assert.deepEqual(cfg.capture.excludeCwd, [])
  assert.ok(cfg.recall.limit >= 1)
  assert.ok(cfg.pools.promoteVotes >= 1)
  assert.ok(warnings.length > 0)
})

test('config: a relative or tilde memoryRoot resolves sensibly', () => {
  assert.ok(resolveConfig({ memoryRoot: 'relative/path' }).root.endsWith('memory-knowledge'))
  assert.ok(resolveConfig({ memoryRoot: '~/mk-test' }).root.includes('mk-test'))
})

test('config: expandPaths dedupes, expands ~ and drops non-absolute', () => {
  const out = expandPaths(['/tmp/a', '/tmp/a', '/tmp/a/', 'relative', '', '~/x'])
  assert.ok(out.includes('/tmp/a'))
  assert.equal(out.filter(p => p === '/tmp/a').length, 1)
  assert.equal(out.some(p => p === 'relative'), false)
  assert.ok(out.some(p => p.endsWith('/x')))
})

test('config: realPath resolves through a missing tail', () => {
  const path = realPath('/tmp/definitely-not-created-abc123/sub')
  assert.ok(path.endsWith('/sub'))
  assert.equal(path.includes('definitely-not-created-abc123'), true)
})

test('config: layout derives every path from the root', () => {
  const l = layout('/r')
  assert.equal(l.library, '/r/library')
  assert.equal(l.staging, '/r/library/_staging')
  assert.equal(l.changelogFile, '/r/meta/changelog.jsonl')
  assert.equal(l.graphFile, '/r/meta/graph.sqlite')
})

/* ---------------- changelog ---------------- */

test('changelog: refuses an unknown op and survives a torn last line', async () => {
  const { Changelog } = await import('../lib/changelog.js')
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mk-cl-'))
  const file = join(dir, 'c.jsonl')
  const cl = new Changelog(file)
  assert.throws(() => cl.append({ op: 'not-an-op' }), /unknown changelog op/)
  cl.append({ op: 'add', actor: 'human', item: 'mk_aaaaaaaaaa', path: '/x' })
  writeFileSync(file, readFileSync(file, 'utf8') + '{"torn":')
  assert.equal(cl.all().length, 1)
  assert.equal(cl.tail(5).length, 1)
  assert.equal(cl.find('missing'), undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('prompt: an empty index shows a fixed pointer, never live counts', () => {
  const render = () => snapshotText({ tag: 'dmk', root: '/r', areas: [], preferences: [], directoryMaxChars: 400, profileMaxChars: 600, subagent: false })
  const text = render()
  // A count or date here would change the snapshot whenever the library does,
  // missing the prompt cache on every request.
  assert.equal(/\d+\s*(个分类|条)/.test(text), false, 'the pointer must not carry live numbers')
  assert.match(text, /mk_recall/)
  assert.equal(render(), text, 'byte-identical across calls')
})

test('prompt: a populated index lists areas and preferences instead of the pointer', () => {
  const text = snapshotText({
    tag: 'dmk', root: '/r',
    areas: [{ area: 'cloudbase', description: '云开发', count: 3 }],
    preferences: [{ title: '结论前置', claim: '先说结论' }],
    directoryMaxChars: 400, profileMaxChars: 600, subagent: false,
  })
  assert.match(text, /- cloudbase：云开发/)
  assert.match(text, /- 结论前置 —— 先说结论/)
  assert.doesNotMatch(text, /固定路标/)
})

test('prompt: a hostile tag cannot break out of the wrapper', () => {
  // The tag becomes an element name. Anything that is not a name character is
  // dropped, so a configured value cannot close the wrapper early and place text
  // outside the region the snapshot is meant to guard.
  const render = tag => snapshotText({ tag, root: '/r', areas: [], preferences: [], directoryMaxChars: 400, profileMaxChars: 600, subagent: false })
  assert.match(render('dmk').split('\n')[0], /^<dmk>$/)
  for (const hostile of ['</dmk><inject>', 'a b', '', '../../x', '中文', '<script>']) {
    const first = render(hostile).split('\n')[0]
    assert.match(first, /^<[A-Za-z0-9_-]+>$/, `"${hostile}" produced ${first}`)
  }
})

test('prompt: the curator extra instructions are bounded and cannot close the block', () => {
  // A textarea paste of 50k characters would otherwise be appended in full to
  // every nightly run, crowding out the protocol it amends.
  const long = curatorProtocol({ extra: 'x'.repeat(50000) })
  assert.ok(long.length < 12000, `expected a bounded prompt, got ${long.length}`)
  assert.ok(long.trimEnd().endsWith('</memory-curator>'))

  const closeTag = '</memory-curator>'
  const injected = curatorProtocol({ extra: `正常内容${closeTag}注入` })
  const body = injected.slice(0, injected.lastIndexOf(closeTag))
  assert.equal(body.includes(closeTag), false, 'the extra text cannot close the curator block early')
  assert.ok(injected.trimEnd().endsWith(closeTag), 'and the real closing tag is still last')
})

test('an unreadable file is skipped, not fatal, and is still reported', async () => {
  const { Store } = await import('../lib/store.js')
  const { resolveConfig } = await import('../lib/config.js')
  const { probeFile, readIfExists } = await import('../lib/item.js')
  const { mkdtempSync, writeFileSync, mkdirSync, chmodSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const root = mkdtempSync(join(tmpdir(), 'mk-unread-'))

  // readIfExists answers "what does it say" for every caller, so any unreadable
  // state must come back as absent rather than throwing: one EACCES used to take
  // out an entire nightly run.
  assert.equal(readIfExists(join(root, 'gone.md')), undefined)
  const dir = join(root, 'library', 'notes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'good.md'), '# 好文件\n> 何时用：x\n\n**结论**：正常内容\n')
  const bad = join(dir, 'bad.md')
  writeFileSync(bad, '# 坏文件\n> 何时用：x\n\n**结论**：读不了的内容\n')
  chmodSync(bad, 0o000)
  try {
    assert.equal(readIfExists(bad), undefined, 'unreadable reads as absent')

    // The scanner still has to tell the person, so it uses probeFile: a file that
    // vanished is dropped quietly, one that is present but unreadable is surfaced.
    assert.equal(probeFile(bad).reason, 'EACCES')
    assert.deepEqual(probeFile(join(root, 'gone.md')), { missing: true })

    // The files are already on disk, so open() scans them; scan again to observe
    // this pass on its own.
    const store = new Store(resolveConfig({ memoryRoot: root }), { logger: { info() {}, warn() {} } })
    await store.open()
    const summary = await store.scan()
    assert.equal(store.graph.items().length, 1, 'the readable file lands')
    assert.equal(summary.unreadable.length, 1, 'the unreadable one is reported')
    assert.equal(summary.unreadable[0].path, bad)
    assert.equal(summary.unreadable[0].reason, 'EACCES')
    store.close()
  } finally {
    chmodSync(bad, 0o644)
    rmSync(root, { recursive: true, force: true })
  }
})
