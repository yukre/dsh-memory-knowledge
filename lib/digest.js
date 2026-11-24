/**
 * Read conversations for curation without copying them.
 *
 * The session log is DSH's single source of truth; this module reads it on
 * demand through `ctx.sessionQuery` (never the on-disk projection cache) and
 * produces a bounded digest for the curator:
 *
 *   - only top-level sessions, outside the memory workspace;
 *   - only human messages (source.kind in humanSourceKinds) and the text blocks
 *     of assistant replies — no tool results, reasoning, or injected context;
 *   - only complete turns, from the stored progress seq onwards;
 *   - secrets redacted, assistant replies shortened, total size capped;
 *   - hints: possible corrections (with the reply they answer) and citations
 *     of memory files (with the next human message, for vote verification).
 *
 * @module dsh-memory-knowledge/digest
 */

import { segmentMessages, pickSegments } from './segment.js'

const CORRECTION = /(不对|错了|不是这样|不是的|改成|改为|其实是|已经不|不再|搞错|纠正|应该是|不应该|wrong|not right|actually)/i

const REDACTIONS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'github_pat_***'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-***'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'ASIA***'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'npm_***'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, 'stripe_***'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'AIza***'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'jwt.***.***'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, 'Bearer ***'],
  // Credentials embedded in a URL (postgres://user:pw@host, https://token@host).
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1***:***@'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9._~+/-]{16,}@/gi, '$1***@'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[\u79c1\u94a5\u5df2\u9690\u53bb]'],
  // Password-like assignments; Latin keys carry \b so a CJK key still matches.
  [/((?:\bpassword|\bpasswd|\bpwd|\u5bc6\u7801|\u53e3\u4ee4|\btoken|\bsecret|\bapi[_-]?key|\bapikey|\baccess[_-]?key)\s*[:=：]\s*)[^\s,;'"]{4,}/gi, '$1***'],
  [/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '[\u8eab\u4efd\u8bc1\u53f7\u5df2\u9690\u53bb]'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[\u624b\u673a\u53f7\u5df2\u9690\u53bb]'],
]


/**
 * Replace credentials and personal identifiers.
 * @param text - any text.
 * @returns redacted text.
 */
export function redact(text) {
  let out = String(text ?? '')
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement)
  return out
}

/**
 * Concatenated text blocks of a message's content.
 * @param content - content block array.
 * @returns text.
 */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
}

/**
 * Normalize one stored event to `{ seq, time, role, text, turn }` when it is
 * curation material, else undefined.
 * @param event - SessionEvent.
 * @param humanKinds - accepted human source kinds.
 * @returns message or undefined.
 */
export function messageOf(event, humanKinds) {
  if (event?.type === 'user/message') {
    const kind = event.data?.source?.kind
    if (!humanKinds.includes(kind)) return undefined
    // An injected context also carries kind 'user' only in old logs; a `form`
    // marks injected material in current ones.
    if (event.data?.source?.form !== undefined) return undefined
    const text = textOf(event.data?.content)
    if (text.trim().length === 0) return undefined
    return { seq: event.seq, time: event.time, role: 'user', text }
  }
  if (event?.type === 'assistant/message') {
    const message = event.data?.message ?? event.data
    const text = textOf(message?.content)
    if (text.trim().length === 0) return undefined
    return { seq: event.seq, time: event.time, role: 'assistant', text, turn: event.data?.turn }
  }
  return undefined
}

/**
 * Seq of the last `turn/end` in a log; material after it is in a live turn.
 * @param events - SessionEvent list.
 * @returns seq or 0.
 */
export function lastCompleteSeq(events) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'turn/end') return events[i].seq
  return 0
}

/**
 * Shorten an assistant reply: keep the opening, mark the cut.
 * @param text - reply text.
 * @param limit - max characters.
 * @returns shortened text.
 */
export function shorten(text, limit) {
  const chars = [...text]
  if (chars.length <= limit) return text
  return `${chars.slice(0, limit).join('')}…［已截断，原文 ${chars.length} 字，可用 mk_excerpt 取全文］`
}

/**
 * Find memory-file citations in a reply: any absolute path under the library.
 * @param text - assistant text.
 * @param library - absolute library path.
 * @returns cited paths (deduplicated).
 */
export function citedPaths(text, library) {
  const out = new Set()
  const escaped = library.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}/[^\\s)>\\]"'|]+?\\.md`, 'g')
  for (const match of String(text).matchAll(pattern)) out.add(match[0])
  return [...out]
}

/**
 * Build the digest of one session's new material.
 * @param events - SessionEvent list (whole log).
 * @param options - `{ fromSeq, humanKinds, maxChars, library, assistantChars, lastAssistantChars }`.
 * @returns `{ text, messages, toSeq, corrections, citations }`; `toSeq` is the
 *   seq through which material was consumed (store it as progress).
 */
export function digestSession(events, options) {
  const humanKinds = options.humanKinds ?? ['user']
  const limit = lastCompleteSeq(events)
  const fromSeq = options.fromSeq ?? 0
  const maxChars = options.maxChars ?? 12000
  const assistantChars = options.assistantChars ?? 400
  const lastAssistantChars = options.lastAssistantChars ?? 1200
  const all = []
  for (const event of events) {
    if (typeof event?.seq !== 'number' || event.seq <= fromSeq || event.seq > limit) continue
    const message = messageOf(event, humanKinds)
    if (message !== undefined) all.push(message)
  }
  // The last assistant message before each user message (or the end) closes a turn.
  const lastOfTurn = new Set()
  for (let i = 0; i < all.length; i++) {
    if (all[i].role !== 'assistant') continue
    const next = all[i + 1]
    if (next === undefined || next.role === 'user') lastOfTurn.add(i)
  }
  const corrections = []
  const citations = []
  const lines = []
  let used = 0
  let consumedThrough = fromSeq
  for (let i = 0; i < all.length; i++) {
    const message = all[i]
    const redacted = redact(message.text)
    const body = message.role === 'user' ? redacted : shorten(redacted, lastOfTurn.has(i) ? lastAssistantChars : assistantChars)
    const line = `[#${message.seq} ${message.role === 'user' ? '用户' : '助手'}] ${body}`
    if (used + line.length > maxChars && lines.length > 0) break
    lines.push(line)
    used += line.length
    consumedThrough = message.seq
    if (message.role === 'user' && CORRECTION.test(message.text)) {
      const previous = [...all.slice(0, i)].reverse().find(m => m.role === 'assistant')
      // replyTo must never be undefined: a user correction can precede any
      // assistant reply (first turn), and an undefined property value makes the
      // whole tool result "not lossless JSON" for the host.
      if (previous !== undefined) corrections.push({ seq: message.seq, replyTo: previous.seq })
    }
    if (message.role === 'assistant' && options.library) {
      for (const path of citedPaths(message.text, options.library)) {
        const nextUser = all.slice(i + 1).find(m => m.role === 'user')
        citations.push({ seq: message.seq, path, nextUserSeq: nextUser?.seq ?? null, nextUserText: nextUser === undefined ? null : shorten(redact(nextUser.text), 300) })
      }
    }
  }
  // Nothing new but the log advanced (tools only, or injected context): move past it.
  if (all.length === 0) consumedThrough = Math.max(fromSeq, limit)
  else if (lines.length === all.length) consumedThrough = Math.max(consumedThrough, limit)
  return { text: lines.join('\n\n'), messages: all.length, toSeq: consumedThrough, corrections, citations }
}

/**
 * Build a segment-aware digest: the session's new material split into
 * conversation segments, rendered one segment at a time with its human turns
 * marked as carrying intent.
 *
 * This replaces the flat "take lines until the character budget runs out"
 * approach, which produced isolated quotes: a 120-character slice of a question
 * reads like a conclusion once the surrounding discussion is gone. A segment
 * keeps the stretch that gives it meaning, and the human's own words stay
 * visible as the thing that expressed intent.
 * @param events - SessionEvent list (whole log).
 * @param options - `{ fromSeq, humanKinds, maxChars, maxSegments, library }`.
 * @returns `{ segments, toSeq, corrections, citations }`, each segment carrying
 *   its own rendered `text`, bounds and `hasIntent` flag; `toSeq` is the new
 *   progress watermark.
 */
export function digestSegments(events, options) {
  const humanKinds = options.humanKinds ?? ['user']
  const limit = lastCompleteSeq(events)
  const fromSeq = options.fromSeq ?? 0
  const messages = []
  for (const event of events) {
    if (typeof event?.seq !== 'number' || event.seq <= fromSeq || event.seq > limit) continue
    const message = messageOf(event, humanKinds)
    if (message !== undefined) messages.push(message)
  }
  if (messages.length === 0) return { segments: [], toSeq: Math.max(fromSeq, limit), corrections: [], citations: [] }

  const all = segmentMessages(messages, { maxMessages: options.maxMessages ?? 80, maxChars: options.maxChars ?? 40000 })
  const { picked, nextSeq } = pickSegments(all, {
    fromSeq,
    maxSegments: options.maxSegments ?? 3,
    maxChars: options.maxChars ?? 12000,
  })

  const corrections = []
  const citations = []
  const rendered = []
  let used = 0
  for (const shape of picked) {
    const inside = messages.filter(message => message.seq >= shape.from && message.seq <= shape.to)
    // The last reply before each human message closes that turn; keep all of it,
    // trim earlier replies, so the conclusion of a stretch is never cut off.
    const lastOfTurn = new Set()
    for (let i = 0; i < inside.length; i++) {
      if (inside[i].role !== 'assistant') continue
      const next = inside[i + 1]
      if (next === undefined || next.role === 'user') lastOfTurn.add(i)
    }
    const lines = []
    for (let i = 0; i < inside.length; i++) {
      const message = inside[i]
      const redacted = redact(message.text)
      // The person's words carry intent, so they are kept in full — up to a
      // generous cap. Real logs contain pasted tickets and logs of 200k bytes;
      // handing one to the curator whole consumes the entire run budget and
      // leaves nothing for the other twenty-nine sessions.
      const body = message.role === 'user'
        ? shorten(redacted, options.userChars ?? 6000)
        : shorten(redacted, lastOfTurn.has(i) ? (options.lastAssistantChars ?? 1200) : (options.assistantChars ?? 400))
      lines.push(`[#${message.seq} ${message.role === 'user' ? '用户' : '助手'}] ${body}`)
      if (message.role === 'user' && CORRECTION.test(message.text)) {
        const previous = [...inside.slice(0, i)].reverse().find(m => m.role === 'assistant')
        if (previous !== undefined) corrections.push({ seq: message.seq, replyTo: previous.seq })
      }
      if (message.role === 'assistant' && options.library) {
        for (const path of citedPaths(message.text, options.library)) {
          const nextUser = inside.slice(i + 1).find(m => m.role === 'user')
          citations.push({ seq: message.seq, path, nextUserSeq: nextUser?.seq ?? null, nextUserText: nextUser === undefined ? null : shorten(redact(nextUser.text), 300) })
        }
      }
    }
    const text = lines.join('\n\n')
    // Budget is checked before accepting the segment, not after: a segment that
    // alone exceeds the run budget would otherwise be pushed through whole.
    if (rendered.length > 0 && used + text.length > (options.maxChars ?? 12000) * 2) break
    used += text.length
    rendered.push({
      from: shape.from,
      to: shape.to,
      userMessages: shape.userMessages,
      assistantMessages: shape.assistantMessages,
      chars: text.length,
      opener: shape.opener,
      reversed: shape.reversed,
      // A segment where the human drove it — asked, decided, corrected — is where
      // intent lives. A segment with no human turn is just execution.
      hasIntent: shape.userMessages > 0,
      text,
    })
  }
  return {
    segments: rendered,
    toSeq: rendered.length === 0 ? Math.max(fromSeq, limit) : rendered[rendered.length - 1].to,
    corrections,
    citations,
  }
}

/**
 * Whether a working directory is inside the plugin's scope.
 * @param cwd - session cwd.
 * @param options - `{ includeCwd, excludeCwd }` (already expanded).
 * @returns true when the plugin applies there.
 */
export function cwdInScope(cwd, options) {
  const value = typeof cwd === 'string' ? cwd : ''
  const under = prefix => value === prefix || value.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  if ((options.excludeCwd ?? []).some(under)) return false
  if ((options.includeCwd ?? []).length > 0 && !(options.includeCwd ?? []).some(under)) return false
  return true
}

/**
 * Whether a session belongs in curation.
 * @param header - SessionHeader.
 * @param options - `{ workspace, includeCwd, excludeCwd }`.
 * @returns true when its conversations may be read.
 */
export function eligibleSession(header, options) {
  if (header === undefined) return false
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return false
  const cwd = typeof header.cwd === 'string' ? header.cwd : ''
  if (options.workspace && (cwd === options.workspace || cwd.startsWith(`${options.workspace}/`))) return false
  return cwdInScope(cwd, options)
}

/**
 * Text of one message by seq, for evidence verification.
 * @param events - SessionEvent list.
 * @param seq - target seq.
 * @param humanKinds - accepted human kinds.
 * @returns `{ text, role, time }` or undefined.
 */
export function messageAt(events, seq, humanKinds) {
  const event = events.find(e => e?.seq === seq)
  if (event === undefined) return undefined
  const message = messageOf(event, humanKinds)
  return message === undefined ? undefined : { text: message.text, role: message.role, time: message.time }
}

/**
 * The last human message in a log (the evidence for an in-conversation
 * "remember" call).
 * @param events - SessionEvent list.
 * @param humanKinds - accepted human kinds.
 * @returns `{ seq, text, time }` or undefined.
 */
export function lastHumanMessage(events, humanKinds) {
  for (let i = events.length - 1; i >= 0; i--) {
    const message = messageOf(events[i], humanKinds)
    if (message !== undefined && message.role === 'user') return message
  }
  return undefined
}
