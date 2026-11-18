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

const CORRECTION = /(不对|错了|不是这样|不是的|改成|改为|其实是|已经不|不再|搞错|纠正|应该是|不应该|wrong|not right|actually)/i

const REDACTIONS = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{30,}/g, 'github_pat_***'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已隐去]'],
  [/((?:password|passwd|密码|口令|token|secret|api[_-]?key)\s*[:=：]\s*)\S+/gi, '$1***'],
  [/\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g, '[身份证号已隐去]'],
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已隐去]'],
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
      corrections.push({ seq: message.seq, replyTo: previous?.seq })
    }
    if (message.role === 'assistant' && options.library) {
      for (const path of citedPaths(message.text, options.library)) {
        const nextUser = all.slice(i + 1).find(m => m.role === 'user')
        citations.push({ seq: message.seq, path, nextUserSeq: nextUser?.seq, nextUserText: nextUser === undefined ? undefined : shorten(redact(nextUser.text), 300) })
      }
    }
  }
  // Nothing new but the log advanced (tools only, or injected context): move past it.
  if (all.length === 0) consumedThrough = Math.max(fromSeq, limit)
  else if (lines.length === all.length) consumedThrough = Math.max(consumedThrough, limit)
  return { text: lines.join('\n\n'), messages: all.length, toSeq: consumedThrough, corrections, citations }
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
