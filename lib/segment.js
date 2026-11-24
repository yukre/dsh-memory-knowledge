/**
 * Mechanical segmentation of a session log into conversation segments.
 *
 * A segment is one stretch of conversation that belongs together: a question
 * and its answer, a decision and the work that followed it, a correction and
 * its fix. Curating per segment rather than per line keeps the meaning that
 * made the line worth reading — the reason a 120-character quote could look
 * like a conclusion when it was really a question.
 *
 * Segmentation is deliberately mechanical. The largest log in the library is
 * 43 MB with 395 user messages, which no reading pass can swallow whole, so the
 * splitting has to be free and deterministic; the model only judges what to
 * keep, segment by segment.
 */

/** Openers that start something new rather than continue the current thread. */
const NEW_INTENT = /(^(帮我|请帮我|帮忙|去|给我|现在|接下来|那么|另外|还有|顺便|再)|我想(问|要|做|确认)|能不能|可不可以|是不是|要不要|你觉得|为什么|怎么(样|办|做)?[？?]|^(改成|改成用|换成|改为)|记住|以后都|别再|我习惯)/

/** Text that corrects or reverses something said earlier. */
const REVERSAL = /(不对|错了|不是这样|不是的|改成|改为|换成|其实是|已经不|不再|搞错|纠正|应该是|不应该|反过来|之前说的不算|我改主意)/i

/** A user message carrying real substance, as opposed to an acknowledgement. */
const ACK = /^(嗯+|哦+|啊+|好的?|行|可以|对|是的?|ok|okay|收到|明白|了解|继续|接着|然后呢?|在吗|测试)[。.!！?？…\s]*$/i

/**
 * @typedef {object} Segment
 * @property {number} from - first seq in the segment.
 * @property {number} to - last seq in the segment.
 * @property {number} userMessages - how many human messages it contains.
 * @property {number} assistantMessages - how many replies it contains.
 * @property {number} chars - approximate size of the readable text.
 * @property {number} startedAt - timestamp of the first message.
 * @property {string} opener - the first substantive human message, truncated.
 * @property {boolean} reversed - whether the human reversed an earlier point.
 */

/**
 * Split normalized messages into conversation segments.
 *
 * Boundaries: a substantive human message that opens a new intent, a reversal,
 * a long silence, or a segment growing past `maxMessages`. Acknowledgements
 * never start a segment — "好的" belongs to the stretch it approves.
 * @param messages - `{ seq, time, role, text }[]` in log order.
 * @param options - `{ maxMessages, gapMs, maxChars }`.
 * @returns Segment list covering the input.
 */
export function segmentMessages(messages, options = {}) {
  const maxMessages = options.maxMessages ?? 60
  const gapMs = options.gapMs ?? 6 * 60 * 60 * 1000
  const maxChars = options.maxChars ?? 40000

  const segments = []
  let current
  const flush = () => {
    if (current !== undefined && current.count > 0) segments.push(current)
    current = undefined
  }

  for (const message of messages) {
    const text = String(message.text ?? '')
    const substantive = message.role === 'user' && text.trim().length > 0 && !ACK.test(text.trim())
    // Two substantive human messages with no reply between them are two
    // separate intents: the person asked again or added a second request. Only
    // an acknowledgement continues the stretch.
    const previousWasHuman = current !== undefined && current.lastRole === 'user'
    const startsNew = substantive
      && (NEW_INTENT.test(text.trim()) || REVERSAL.test(text) || previousWasHuman)

    if (current !== undefined) {
      // A single message can exceed the whole budget on its own (real logs carry
      // 200k-byte replies). Comparing 'chars + this message' still lets that one
      // message through, so a stretch that is already at the cap also starts a
      // new segment — and the oversized message then becomes its own segment,
      // which the per-segment renderer trims.
      const tooLong = current.count >= maxMessages
        || current.chars >= maxChars
        || (current.chars + text.length > maxChars && current.count > 0)
      const tooLate = typeof message.time === 'number' && typeof current.lastTime === 'number'
        && message.time - current.lastTime > gapMs
      if (startsNew || tooLong || tooLate) flush()
    }

    if (current === undefined) {
      current = {
        from: message.seq,
        to: message.seq,
        count: 0,
        userMessages: 0,
        assistantMessages: 0,
        chars: 0,
        startedAt: message.time,
        lastTime: message.time,
        opener: message.role === 'user' ? shortenOpener(text) : '',
        reversed: false,
      }
    }
    current.to = message.seq
    current.lastRole = message.role
    current.count += 1
    current.chars += text.length
    current.lastTime = message.time
    if (message.role === 'user') {
      current.userMessages += 1
      if (current.opener === '') current.opener = shortenOpener(text)
      if (REVERSAL.test(text)) current.reversed = true
    } else {
      current.assistantMessages += 1
    }
  }
  flush()

  return segments.map(segment => ({
    from: segment.from,
    to: segment.to,
    userMessages: segment.userMessages,
    assistantMessages: segment.assistantMessages,
    chars: segment.chars,
    startedAt: segment.startedAt,
    opener: segment.opener,
    reversed: segment.reversed,
  }))
}

/**
 * @param text - human message.
 * @returns a short label for the segment, single line.
 */
function shortenOpener(text) {
  const line = String(text).replace(/\s+/g, ' ').trim()
  const chars = [...line]
  return chars.length <= 80 ? line : `${chars.slice(0, 80).join('')}…`
}

/**
 * Pick the segments still to process, oldest first, within a work budget.
 *
 * Incremental by design: progress is a seq watermark per session, so each run
 * advances the frontier instead of re-reading a 43 MB log. Segments that are
 * entirely before the watermark are already done; the run takes as many
 * unprocessed ones as the budget allows.
 * @param segments - Segment list.
 * @param options - `{ fromSeq, maxSegments, maxChars }`.
 * @returns `{ picked, nextSeq }` — the segments to curate and the new watermark.
 */
export function pickSegments(segments, options = {}) {
  const fromSeq = options.fromSeq ?? 0
  const maxSegments = options.maxSegments ?? 3
  const maxChars = options.maxChars ?? 12000

  const pending = segments.filter(segment => segment.to > fromSeq)
  const picked = []
  let chars = 0
  for (const segment of pending) {
    if (picked.length >= maxSegments) break
    if (picked.length > 0 && chars + segment.chars > maxChars) break
    picked.push(segment)
    chars += segment.chars
  }
  return { picked, nextSeq: picked.length === 0 ? fromSeq : picked[picked.length - 1].to }
}
