/**
 * The write gate: deterministic checks every machine write must pass.
 *
 * The model decides whether something is worth remembering (the checklist is
 * the write tool's required parameters). The gate decides, without a model,
 * whether a write is honest and safe:
 *
 *   1. evidence exists verbatim where it claims to be;
 *   2. a knowledge item is not a transcription of its source;
 *   3. the destination pool is allowed for how the claim was confirmed;
 *   4. a near-duplicate forces an explicit resolution;
 *   5. retired knowledge is not resurrected by old evidence;
 *   6. an item a person edited is not rewritten without newer human evidence;
 *   7. concurrent edits are not clobbered (base fingerprint);
 *   8. edges are valid and bounded;
 *   9. no secrets, sane names and lengths.
 *
 * Every refusal returns a code the curator can act on.
 *
 * @module dsh-memory-knowledge/gate
 */

import { jaccard } from './search.js'
import { EDGE_TYPES, MAX_EDGES_PER_ITEM } from './graph.js'

export const KINDS = Object.freeze(['fact', 'decision', 'method', 'preference'])
export const CONFIRMED_BY = Object.freeze(['user-approved', 'verified', 'consistent', 'user-requested', 'imported', 'inferred'])
export const VALIDITY = Object.freeze(['long-term', 'until-date', 'temporary'])
export const DUPLICATE_THRESHOLD = 0.5
export const TRANSCRIPTION_RATIO = 0.6
export const MAX_BODY_CHARS = 2000
export const MAX_SKILL_DESCRIPTION = 200

/** Secret-looking strings; matching any refuses the write. */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // `\b` only before Latin words: before CJK it never matches at a string start.
  /(?:\b(?:password|passwd|token|secret|api[_-]?key)|密码|口令)\s*[:=：]\s*\S{6,}/i,
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
]

/** Area folder names: no path separators, no reserved or dot names. */
const AREA = /^[^\\/:*?"<>|.\s][^\\/:*?"<>|]{0,39}$/
const RESERVED_AREAS = new Set(['_staging', '_archive', 'skills', 'workspace', 'meta'])

/**
 * Collapse whitespace so evidence matching ignores formatting.
 * @param text - any text.
 * @returns squeezed text.
 */
export function squeeze(text) {
  return String(text ?? '').replace(/\s+/gu, '')
}

/**
 * Ratio of a claim's 8-character shingles that appear in the source.
 * @param claim - written knowledge.
 * @param source - one source message.
 * @returns 0..1.
 */
export function overlapRatio(claim, source) {
  const a = squeeze(claim)
  const b = squeeze(source)
  if (a.length < 16 || b.length < 8) return 0
  const size = 8
  const shingles = new Set()
  for (let i = 0; i + size <= b.length; i++) shingles.add(b.slice(i, i + size))
  let total = 0
  let hit = 0
  for (let i = 0; i + size <= a.length; i += 2) {
    total++
    if (shingles.has(a.slice(i, i + size))) hit++
  }
  return total === 0 ? 0 : hit / total
}

/**
 * @param text - text to scan.
 * @returns whether it looks like it contains a credential.
 */
export function containsSecret(text) {
  return SECRET_PATTERNS.some(pattern => pattern.test(String(text ?? '')))
}

/**
 * @param area - candidate category.
 * @returns whether it is a usable folder name.
 */
export function validArea(area) {
  return typeof area === 'string' && AREA.test(area) && !RESERVED_AREAS.has(area)
}

/** A refusal; `code` is what the curator branches on. */
export class GateError extends Error {
  /**
   * @param code - refusal code.
   * @param detail - human-readable explanation.
   * @param extra - structured data (candidates, …).
   */
  constructor(code, detail, extra = {}) {
    super(`${code}: ${detail}`)
    this.code = code
    this.detail = detail
    this.extra = extra
  }
}

/**
 * Validate the checklist fields of an add/update.
 * @param input - the write arguments.
 * @param options - `{ skill: boolean }`.
 */
export function checkChecklist(input, options = {}) {
  const required = ['claim', 'why', 'scope', 'when']
  for (const key of required) {
    if (typeof input[key] !== 'string' || input[key].trim().length === 0) {
      throw new GateError('CHECKLIST_INCOMPLETE', `「${key}」不能为空`)
    }
  }
  if (!KINDS.includes(input.kind)) throw new GateError('CHECKLIST_INCOMPLETE', `kind 必须是 ${KINDS.join('/')}`)
  if (input.confirmedBy !== undefined && !CONFIRMED_BY.includes(input.confirmedBy)) {
    throw new GateError('CHECKLIST_INCOMPLETE', `confirmedBy 必须是 ${CONFIRMED_BY.join('/')}`)
  }
  if (input.validity === 'temporary') throw new GateError('TEMPORARY', '临时性内容不写入记忆')
  if (input.validity !== undefined && !VALIDITY.includes(input.validity)) {
    throw new GateError('CHECKLIST_INCOMPLETE', `validity 必须是 long-term 或 until-date`)
  }
  if (/对话中(提到|说过)|用户说过|as mentioned/i.test(input.why) && squeeze(input.why).length < 20) {
    throw new GateError('WHY_TOO_THIN', '「为什么」需要写出推理或验证过程，不能只写“对话中提到”')
  }
  const body = composeBodyText(input)
  if (body.length > MAX_BODY_CHARS) throw new GateError('TOO_LONG', `正文超过 ${MAX_BODY_CHARS} 字，请拆分`)
  if (containsSecret(body) || containsSecret(input.title)) throw new GateError('SECRET', '内容疑似包含密钥或身份信息')
  if (options.skill) {
    if (typeof input.description !== 'string' || input.description.trim().length === 0) {
      throw new GateError('CHECKLIST_INCOMPLETE', 'Skill 需要 description')
    }
    if ([...input.description].length > MAX_SKILL_DESCRIPTION) {
      throw new GateError('SKILL_DESCRIPTION_TOO_LONG', `Skill 描述不超过 ${MAX_SKILL_DESCRIPTION} 字`)
    }
  }
}

/**
 * The body text an add/update will store (used for size and secret checks and
 * for writing).
 * @param input - write arguments.
 * @returns Markdown body (title and when lines excluded).
 */
export function composeBodyText(input) {
  const parts = [`**结论**：${String(input.claim ?? '').trim()}`, '', `**为什么**：${String(input.why ?? '').trim()}`, '', `**边界**：${String(input.scope ?? '').trim()}`]
  if (typeof input.details === 'string' && input.details.trim().length > 0) parts.push('', input.details.trim())
  return parts.join('\n')
}

/**
 * Check that every evidence quote exists where it claims.
 * @param evidence - `{ kind:'session', sessionId, seq, quote } | { kind:'file', path, line, quote }` list.
 * @param lookup - `{ sessionText(sessionId, seq) → string|undefined, fileLines(path) → string[]|undefined }`.
 * @returns normalized evidence, each with `role` for session quotes ('user'|'assistant').
 */
export async function checkEvidence(evidence, lookup) {
  if (!Array.isArray(evidence) || evidence.length === 0) throw new GateError('EVIDENCE_MISSING', '至少需要 1 条依据')
  const out = []
  for (const item of evidence) {
    const quote = String(item?.quote ?? '')
    if (squeeze(quote).length < 4) throw new GateError('EVIDENCE_MISSING', '依据原话至少 4 个字')
    if (squeeze(quote).length > 300) throw new GateError('EVIDENCE_TOO_LONG', '依据原话不超过 300 字，只摘关键句')
    if (item.kind === 'session') {
      const found = await lookup.sessionText(String(item.sessionId), Number(item.seq))
      if (found === undefined || !squeeze(found.text).includes(squeeze(quote))) {
        throw new GateError('EVIDENCE_NOT_FOUND', `会话 ${item.sessionId} 第 ${item.seq} 条里找不到这段原话`)
      }
      out.push({ kind: 'session', sessionId: String(item.sessionId), seq: Number(item.seq), quote, role: found.role, time: found.time })
    } else if (item.kind === 'file') {
      const lines = await lookup.fileLines(String(item.path))
      const line = Number(item.line)
      const window = lines === undefined ? undefined : lines.slice(Math.max(0, line - 3), line + 3).join('\n')
      if (window === undefined || !squeeze(window).includes(squeeze(quote))) {
        throw new GateError('EVIDENCE_NOT_FOUND', `文件 ${item.path} 第 ${line} 行附近找不到这段原话`)
      }
      out.push({ kind: 'file', path: String(item.path), line, quote })
    } else {
      throw new GateError('EVIDENCE_MISSING', '依据 kind 必须是 session 或 file')
    }
  }
  return out
}

/**
 * Knowledge must be written as a conclusion, not copied from its source.
 * @param input - write arguments.
 * @param sources - full texts of the evidence messages.
 */
export function checkNotTranscription(input, sources) {
  if (input.kind === 'preference') return
  // Check each content-bearing field on its own. Joining them first would let
  // legitimate boilerplate in one field dilute copied text in another: a
  // verbatim claim plus a generic "适用于…" scope scored 0.44 and passed,
  // while the claim alone scored 0.89. Refuse when any single field copies.
  const fields = ['claim', 'why', 'details', 'steps', 'description']
  for (const source of sources) {
    for (const field of fields) {
      const value = input[field]
      if (typeof value !== 'string' || squeeze(value).length < 16) continue
      if (overlapRatio(value, source) > TRANSCRIPTION_RATIO) {
        throw new GateError('TRANSCRIPTION', `「${field}」与原话高度重合，请改写成“结论 / 为什么 / 边界”`)
      }
    }
  }
}

/**
 * Where a write may land.
 * @param input - `{ pool, confirmedBy, kind }`.
 * @param evidence - normalized evidence.
 * @param context - `{ via: 'curator'|'remember'|'promote'|'import' }`.
 * @returns the pool to use.
 */
export function checkPool(input, evidence, context) {
  const wanted = input.pool === 'memory' ? 'memory' : 'staging'
  if (wanted === 'staging') return 'staging'
  // Only the person's own in-conversation request writes straight to memory;
  // that path is mk_remember, which attaches the user's last message itself.
  if (context.via === 'remember' || context.via === 'promote') return 'memory'
  if (input.confirmedBy === 'user-requested' || input.confirmedBy === 'user-approved') {
    if (!evidence.some(item => item.kind === 'session' && item.role === 'user')) {
      throw new GateError('POOL_NOT_ALLOWED', '直接进记忆区需要用户本人的原话作为依据')
    }
    // The curator labels its own evidence. It may claim user-requested, but a
    // bare user quote is not the same as the user asking for this to be kept:
    // require the quote itself to read like a retention request.
    if (context.via === 'curator' && !KEEP_REQUEST.test(evidence.find(item => item.kind === 'session' && item.role === 'user')?.quote ?? '')) {
      throw new GateError('POOL_NOT_ALLOWED', '用户原话里没有要求长期保留，这条应先进预备区')
    }
    return 'memory'
  }
  throw new GateError('POOL_NOT_ALLOWED', '只有用户明确要求保留的内容可以直接进记忆区，其余先进预备区')
}

/** A user quote that actually asks for something to be kept. */
const KEEP_REQUEST = /(记住|记一下|记录|以后都|以后要|下次|别再|不要再|习惯|偏好|长期|一直|always|remember|from now on)/i

/**
 * Near-duplicate detection. Similarities are computed by the caller on
 * comparable essences (title + conclusion) of live items.
 * @param similar - `{ id, title, pool, status, similarity }[]`, best first.
 * @param resolution - 'update'|'supersede'|'distinct'|'noop'|undefined.
 * @returns duplicates above threshold.
 */
export function checkDuplicates(similar, resolution) {
  const hits = similar.filter(candidate => candidate.similarity >= DUPLICATE_THRESHOLD).slice(0, 5)
  if (hits.length > 0 && resolution === undefined) {
    throw new GateError('NEEDS_RESOLUTION', '存在相似条目，请明确选择 update / supersede / distinct / noop', {
      candidates: hits.map(hit => ({ id: hit.id, title: hit.title, pool: hit.pool, status: hit.status, similarity: Number(hit.similarity.toFixed(2)) })),
    })
  }
  return hits
}

/**
 * Refuse knowledge that restates a retired claim on old evidence.
 *
 * A candidate closer to some living item than to the tombstone is that item's
 * duplicate (for example a correction restated later), not a resurrection; the
 * duplicate check handles it. Only evidence newer than the retirement can
 * overturn it.
 * @param text - candidate essence.
 * @param tombstones - tombstone rows (`text` holds the retired essence).
 * @param evidence - normalized evidence (session items carry `time`).
 * @param bestLive - highest similarity of the candidate to any living item.
 */
export function checkResurrection(text, tombstones, evidence, bestLive = 0) {
  const newest = Math.max(0, ...evidence.map(item => (typeof item.time === 'number' ? item.time : 0)))
  for (const stone of tombstones) {
    const similarity = jaccard(text, stone.text || stone.title)
    if (similarity < DUPLICATE_THRESHOLD || similarity <= bestLive) continue
    // File evidence carries no time; it cannot overturn a retirement on its own.
    if (newest <= stone.retired_at) {
      throw new GateError('RESURRECTION', `这条与已作废的「${stone.title}」相似，且依据都早于作废时间`, { tombstone: stone.id })
    }
  }
}

/**
 * An item a person edited may only change with newer human evidence.
 * @param row - target item row.
 * @param evidence - normalized evidence.
 */
export function checkHumanLock(row, evidence) {
  if (row === undefined || row.human_at === null || row.human_at === undefined) return
  const newer = evidence.some(item => item.kind === 'session' && item.role === 'user' && typeof item.time === 'number' && item.time > row.human_at)
  if (!newer) {
    throw new GateError('LOCKED', '这条被人工修改过，只有晚于修改时间的用户原话才能改写它；可以改为标记争议或提出建议')
  }
}

/**
 * Validate edges to add.
 * @param edges - `{ to, type }[]` from the item being written.
 * @param id - the item's id.
 * @param graph - Graph instance.
 */
export function checkEdges(edges, id, graph) {
  if (edges === undefined) return
  if (!Array.isArray(edges)) throw new GateError('BAD_EDGE', 'edges 必须是数组')
  let count = id === undefined ? 0 : graph.edgeCount(id)
  for (const edge of edges) {
    if (!EDGE_TYPES.includes(edge?.type)) throw new GateError('BAD_EDGE', `关系类型必须是 ${EDGE_TYPES.join('/')}`)
    const target = graph.item(String(edge.to))
    if (target === undefined) throw new GateError('BAD_EDGE', `关系目标 ${edge.to} 不存在`)
    if (target.id === id) throw new GateError('BAD_EDGE', '不能和自己建立关系')
    if (graph.edgeCount(target.id) >= MAX_EDGES_PER_ITEM) throw new GateError('EDGE_LIMIT', `「${target.title}」的关系已达上限 ${MAX_EDGES_PER_ITEM}`)
    count++
    if (count > MAX_EDGES_PER_ITEM) throw new GateError('EDGE_LIMIT', `每条记忆最多 ${MAX_EDGES_PER_ITEM} 条关系`)
    if (edge.type === 'supersedes' && id !== undefined && graph.supersedesCycle(id, target.id)) {
      throw new GateError('BAD_EDGE', '取代关系不能形成环')
    }
  }
}
