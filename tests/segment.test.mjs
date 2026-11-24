import assert from 'node:assert/strict'
import test from 'node:test'
import { segmentMessages, pickSegments } from '../lib/segment.js'
import { digestSegments } from '../lib/digest.js'

const user = (seq, text, time = seq * 1000) => ({ seq, time, role: 'user', text })
const assistant = (seq, text, time = seq * 1000) => ({ seq, time, role: 'assistant', text })

test('segment: a new intent starts a new segment, an acknowledgement does not', () => {
  const messages = [
    user(1, '帮我查一下致欧的平台版什么时候到期'),
    assistant(2, '查到了，2026-11-29 到期。'),
    user(3, '好的'),                      // acknowledgement: stays in the segment
    assistant(4, '还需要别的吗？'),
    user(5, '另外看一下它的续费方式'),      // new intent: new segment
    assistant(6, '按月起续。'),
  ]
  const segments = segmentMessages(messages)
  assert.equal(segments.length, 2)
  assert.deepEqual([segments[0].from, segments[0].to], [1, 4])
  assert.deepEqual([segments[1].from, segments[1].to], [5, 6])
  assert.equal(segments[1].userMessages, 1)
  assert.match(segments[1].opener, /续费方式/)
})

test('segment: a reversal is recorded on the segment it happens in', () => {
  const messages = [
    user(1, '用 pnpm 管理依赖'),
    assistant(2, '好，已按 pnpm 配置。'),
    user(3, '不对，改成 npm 吧，团队都用 npm'),
    assistant(4, '已切换为 npm。'),
  ]
  const segments = segmentMessages(messages)
  // The reversal opens its own segment and is flagged.
  const flagged = segments.filter(segment => segment.reversed)
  assert.equal(flagged.length, 1)
  assert.match(flagged[0].opener, /npm/)
})

test('segment: a long silence splits the conversation', () => {
  const day = 24 * 60 * 60 * 1000
  const messages = [
    user(1, '先看看这个方案', 0),
    assistant(2, '看过了，可行。', 1000),
    user(3, '我回来了，继续', 2 * day),
    assistant(4, '继续。', 2 * day + 1000),
  ]
  const segments = segmentMessages(messages, { gapMs: 6 * 60 * 60 * 1000 })
  assert.equal(segments.length, 2)
})

test('segment: an oversized stretch is split so no segment is unbounded', () => {
  const messages = []
  for (let i = 1; i <= 200; i++) messages.push(assistant(i, `步骤 ${i} 的说明`))
  const segments = segmentMessages(messages, { maxMessages: 60 })
  assert.ok(segments.length >= 4, `expected several segments, got ${segments.length}`)
  for (const segment of segments) assert.ok(segment.assistantMessages <= 60)
})

test('pickSegments advances a watermark instead of re-reading', () => {
  const segments = Array.from({ length: 6 }, (_, i) => ({
    from: i * 10 + 1, to: i * 10 + 9, userMessages: 1, assistantMessages: 3, chars: 4000,
    startedAt: 0, opener: `第 ${i} 节`, reversed: false,
  }))
  const first = pickSegments(segments, { fromSeq: 0, maxSegments: 2, maxChars: 12000 })
  assert.equal(first.picked.length, 2)
  assert.equal(first.nextSeq, segments[1].to)

  // The next run starts where the previous one stopped.
  const second = pickSegments(segments, { fromSeq: first.nextSeq, maxSegments: 2, maxChars: 12000 })
  assert.equal(second.picked[0].from, segments[2].from)
  assert.ok(second.nextSeq > first.nextSeq)

  // Nothing left: the watermark does not move.
  const end = pickSegments(segments, { fromSeq: second.picked[1].to, maxSegments: 5, maxChars: 12000 })
  const back = pickSegments(segments, { fromSeq: segments[5].to, maxSegments: 5, maxChars: 12000 })
  assert.equal(back.picked.length, 0)
  assert.equal(back.nextSeq, segments[5].to)
})

test('digestSegments keeps each stretch intact and marks intent', () => {
  const events = []
  let seq = 1
  const push = (type, data) => events.push({ seq: seq++, time: seq * 1000, type, data })
  const humanMessage = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })

  push('turn/start', {})
  push('user/message', humanMessage('我希望加一个删除会话的功能'))
  push('assistant/message', { content: [{ type: 'text', text: '我先调研代码结构。' }] })
  push('assistant/message', { content: [{ type: 'text', text: '发现没有删除会话的接口。' }] })
  push('user/message', humanMessage('另外界面配色也要改'))
  push('assistant/message', { content: [{ type: 'text', text: '配色已调整。' }] })
  push('turn/end', {})

  const digest = digestSegments(events, { fromSeq: 0, humanKinds: ['user'], maxChars: 12000, maxSegments: 5 })
  assert.ok(digest.segments.length >= 2, 'two intents should make two segments')
  for (const segment of digest.segments) {
    assert.equal(segment.hasIntent, true, 'each segment contains a human turn')
    assert.ok(segment.text.includes('用户'), 'the human line is present in the rendered text')
  }
  // Everything consumed.
  assert.ok(digest.toSeq >= 6)
})
