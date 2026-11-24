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

import { jaccard, tokenize } from './search.js'
import { EDGE_TYPES, MAX_EDGES_PER_ITEM } from './graph.js'

export const KINDS = Object.freeze(['fact', 'decision', 'method', 'preference'])
export const CONFIRMED_BY = Object.freeze(['user-approved', 'verified', 'consistent', 'user-requested', 'imported', 'inferred'])
export const VALIDITY = Object.freeze(['long-term', 'until-date', 'temporary'])
export const DUPLICATE_THRESHOLD = 0.5
export const TRANSCRIPTION_RATIO = 0.6
export const MAX_BODY_CHARS = 2000
export const MAX_SKILL_DESCRIPTION = 200
/**
 * How much of a claim must already appear in a skill before it is refused as a
 * verbatim copy.
 */
export const SKILL_DUPLICATE_RATIO = 0.55

/**
 * Whether a claim restates a rule that a skill already owns.
 *
 * Verbatim overlap alone is not enough: people (and models) paraphrase. A rule
 * copied from a skill scores 1.0 on the original wording but only ~0.32 once
 * restated in other words, so an overlap threshold either misses the
 * paraphrase or fires on everything. Two signals are used instead:
 *
 *   - the claim shares the skill's subject (its distinctive terms appear), and
 *   - it reads like a rule (instructional phrasing), not a fact about the world.
 *
 * A fact that merely mentions the skill's domain stays out: "CloudBase 平台版
 * 1 万元/月" mentions CloudBase but prescribes nothing.
 * @param claim - the candidate text.
 * @param skill - `{ name, description, body }`.
 * @returns `{ copied, reason }`.
 */
export function looksLikeSkillRule(claim, skill) {
  const haystack = `${skill.name} ${skill.description ?? ''} ${skill.body ?? ''}`
  if (overlapRatio(claim, haystack) > SKILL_DUPLICATE_RATIO) {
    return { copied: true, reason: '原文高度重合' }
  }
  // Chinese claims tokenize into overlapping bigrams, so dividing shared terms
  // by the claim's token count punishes a long, specific sentence. But requiring
  // only a coverage ratio misfires the other way: "回答结论前置" matched a
  // session-status skill on 回答/结论 alone. Shared terms must therefore be
  // *distinctive* — terms that the skill has but ordinary prose does not — and
  // generic connective words are dropped before measuring.
  // Two independent ways to be "about the same thing", because neither alone is
  // trustworthy:
  //   (a) the skill's own domain terms appear in the claim — a skill named
  //       'cloudbase-revenue-analysis' owns vocabulary like 收入/口径/定稿, and
  //       a claim using several of those is about that skill's subject;
  //   (b) enough of the claim's distinctive vocabulary lives in the skill.
  const claimTokens = [...new Set(tokenize(claim))].filter(token => token.length >= 2 && !GENERIC_TERM.has(token))
  const skillTokens = new Set(tokenize(haystack))
  const shared = claimTokens.filter(token => skillTokens.has(token))
  const coverage = claimTokens.length === 0 ? 0 : shared.length / claimTokens.length
  const distinctive = shared.filter(token => !GENERIC_TERM.has(token))
  // Domain terms: the skill's name decomposed, minus generic words.
  const nameTerms = [...new Set(tokenize(skill.name.replace(/[-_]/g, ' ')))].filter(token => token.length >= 2 && !GENERIC_TERM.has(token))
  const nameHits = nameTerms.filter(token => claimTokens.includes(token))
  const subjectMatch = (distinctive.length >= 4 && coverage >= 0.35)
    || (nameHits.length >= 2 && distinctive.length >= 3)
  const readsLikeRule = PRESCRIPTIVE.test(claim)
  if (subjectMatch && readsLikeRule) {
    return { copied: true, reason: '与 skill 主题一致且是可执行规则' }
  }

  // A skill states its rules as headings and bullet points, so the line the
  // claim came from is often sitting in the file verbatim even when the claim
  // was reworded. Compare against those lines rather than the prose around them.
  const claimSqueezed = squeeze(claim)
  if (claimSqueezed.length >= 16) {
    for (const line of haystack.split('\n')) {
      const candidate = squeeze(line.replace(/^[\s\-*#>\d.]+/, ''))
      if (candidate.length < 12) continue
      if (overlapRatio(claim, line) >= 0.5) return { copied: true, reason: '与 skill 中的规则条目重合' }
    }
  }
  return { copied: false }
}

/**
 * Words that appear in almost any work rule, so sharing them says nothing about
 * whether a claim restates *this* skill. Chinese bigrams make the problem acute:
 * 结论/回答/先给 occur everywhere, and counting them let an unrelated
 * preference match a session-status skill.
 */
const GENERIC_TERM = new Set([
  '回答', '结论', '前提', '问题', '内容', '情况', '时候', '可以', '需要', '应该',
  '使用', '调用', '执行', '进行', '完成', '确认', '判断', '处理', '方式', '方法',
  '步骤', '流程', '顺序', '格式', '模板', '要求', '规则', '标准', '注意', '避免',
  '先给', '给结', '论再', '再展', '展开', '先说', '然后', '接着', '最后',
  '用户', '建议', '直接', '具体', '明确', '相关', '对应', '结果', '原因',
  // Found by running skillAffinity over the live library: these appear in a
  // skill's description as ordinary connective language yet matched unrelated
  // notes, pushing the real duplicate down the list.
  '什么', '是什么', '不同', '可以', '需要', '信息', '任务', '状态', '支持', '查询',
  '提供', '管理', '处理', '问题', '内容', '情况', '能力', '功能', '工具', '数据',
])

/**
 * Whether a token is too common to indicate shared subject matter.
 * @param token - tokenized word.
 * @returns true when it carries no distinguishing signal.
 */
export function isGenericTerm(token) {
  return GENERIC_TERM.has(token)
}

/**
 * Phrasing that prescribes a procedure rather than stating a fact. Chinese
 * sources put a procedure in the imperative almost every time ("先…再…",
 * "要…", "不要…", "按…"), which is what separates a rule copy from a fact.
 */
const PRESCRIPTIVE = /(先.{0,8}再|第[一二三四五1-5]步|步骤|流程|顺序|按.{0,10}(做|来|执|写)|要(用|先|按|在)|不要|别(用|把)|必须|应该|调用|执行|改成|写成|格式是|模板|怎么写|如何做)/

/**
 * Secret-looking strings; matching any refuses the write.
 *
 * These must stay in step with `redact()` in digest.js: a shape that redaction
 * scrubs but this list accepts would still be written into a memory file, and
 * one that redaction misses but this list refuses would block a legitimate
 * note. Both sides cover the same credential families.
 */
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Password-like assignments; Latin keys carry \b so a CJK key still matches.
  /(?:\bpassword|\bpasswd|\bpwd|密码|口令|\btoken|\bsecret|\bapi[_-]?key|\bapikey|\baccess[_-]?key)\s*[:=：]\s*\S{4,}/i,
  /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
]

/** Area folder names: no path separators, no reserved or dot names. */
// No separators, no leading dot, no whitespace anywhere (a newline would make
// the folder name a path fragment on some systems), max 40 characters.
const AREA = /^[^\\/:*?"<>|.\s][^\\/:*?"<>|\s]{0,39}$/
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
 * Whether the content is knowledge at all.
 *
 * Every other check asks "is this written correctly" — evidence real, not
 * copied, not a duplicate, not resurrected, not overwriting a person's edit.
 * This one asks the earlier question: does this belong in a knowledge base,
 * or somewhere else (an agent's role instructions, a one-off task, a live
 * state)? It runs first, for every write path including mk_remember, because
 * a sentence the person says in conversation is not automatically knowledge.
 *
 * @param input - the write arguments.
 * @param context - `{ via, workspaceInstructions }`.
 * @returns nothing; throws a GateError naming the right destination.
 */
export function checkIsKnowledge(input, context = {}) {
  const text = [input.title, input.claim, input.why, input.scope, input.when, input.details, input.description, input.steps]
    .filter(part => typeof part === 'string' && part.length > 0).join('\n')
  if (text.trim().length === 0) throw new GateError('NOT_KNOWLEDGE', '内容为空')

  // A claim of 「好」, 「12345」 or 「。。。！？」 passes every structural check —
  // the fields are non-empty strings — while carrying no proposition at all.
  // Requiring real words keeps placeholders out of the library, where they would
  // occupy a title, a snapshot slot and a curator unit.
  const claimOnly = String(input.claim ?? '').trim()
  if (claimOnly.length > 0) {
    const words = claimOnly.match(/[A-Za-z][A-Za-z0-9]{1,}|[\u4e00-\u9fa5]{2,}/g) ?? []
    const digits = claimOnly.match(/\d+/g) ?? []
    if (words.length === 0) {
      throw new GateError('NOT_KNOWLEDGE', '结论里没有实际的词：只有数字、标点或单个汉字的内容不算知识')
    }
    // A URL is a pointer, not a conclusion. Checked before counting words, since
    // a URL's own segments (https, example, com) read as words.
    if (/^https?:\/\//i.test(claimOnly)) {
      const withoutUrl = claimOnly.replace(/https?:\/\/\S+/gi, '').trim()
      const rest = withoutUrl.match(/[A-Za-z][A-Za-z0-9]{1,}|[\u4e00-\u9fa5]{2,}/g) ?? []
      if (rest.length < 2) throw new GateError('NOT_KNOWLEDGE', '结论只有链接，没有说明它是什么；请把结论本身写出来')
    }
    if (words.length + digits.length === 0) throw new GateError('NOT_KNOWLEDGE', '结论过于空泛')
  }

  // 1. Role and workflow instructions for an agent belong to the agent's own
  //    instruction file. They are read by DSH automatically and cost nothing in
  //    every prompt; storing them as memories duplicates them and pays tokens
  //    for a second copy that only loads when recalled.
  if (ROLE_INSTRUCTION.test(text)) {
    throw new GateError('ROLE_INSTRUCTION', '这看起来是给 agent 的角色/工作方式设定，应写进工作区的 AGENTS.md（DSH 会自动加载），不要存成记忆')
  }

  // 2. Live state changes on its own; remembering it guarantees staleness.
  if (LIVE_STATE.test(text)) {
    throw new GateError('LIVE_STATE', '这看起来是随时会变的临时状态（端口、进程、排队、今天的数字），不适合长期记忆')
  }

  // 3. A one-off errand is not knowledge. Knowledge is reusable by definition.
  //    A rewritten claim often drops the original "帮我", so the test cannot
  //    rely on the opening alone: an errand is an action verb with no stated
  //    outcome, and that is what is refused.
  const hasOutcome = OUTCOME_STATEMENT.test(text)
  const isErrand = ONE_OFF_TASK.test(text) || (ERRAND_VERB.test(text) && !hasOutcome)
  if (isErrand && !hasOutcome) {
    throw new GateError('ONE_OFF_TASK', '这看起来是一次性任务，没有可复用的结论；如果它产出了结论，请把结论本身写成记忆')
  }

  // 4. Already固化 in a skill. A skill is the canonical home for a procedure:
  //    it is loaded on demand, versioned with the plugin or project, and the
  //    model follows it directly. A memory that restates a skill's rule gets
  //    written, then retired by the curator the next night as a duplicate — a
  //    write, a curation unit, and the tokens for both, wasted. Refuse it at
  //    the door and name the skill to edit instead.
  // Duplication with an installed skill is NOT refused here. Judging "the same
  // rule, differently worded" needs meaning, and every lexical measure tried
  // failed: the true positive scored 0.63 against a 0.57 false positive on the
  // live library, and a large skill shares vocabulary with almost any Chinese
  // technical note (11-22 false positives). Refusing on that basis would block
  // real knowledge, which costs more than a duplicate that only wastes space.
  // The curator reports suspects instead; a person decides (see suspectSkills).

  // 5. Already covered by the workspace's own instructions: storing it again
  //    would give the model two copies that can drift apart.
  if (typeof context.workspaceInstructions === 'string' && context.workspaceInstructions.length > 0) {
    const claimText = String(input.claim ?? '')
    if (claimText.length >= 12 && squeeze(context.workspaceInstructions).includes(squeeze(claimText).slice(0, 40))) {
      throw new GateError('ALREADY_IN_INSTRUCTIONS', '这条内容已经在工作区的 AGENTS.md 里了；记忆库不需要第二份，改 AGENTS.md 即可')
    }
  }
}

/**
 * Text that assigns an agent a role or working style. Covers both the second
 * person DSH's own instructions use ("你是管家…") and the first person a model
 * writes when it records the arrangement itself ("我是「管家」会话…"), plus the
 * routing vocabulary that only makes sense as an agent instruction.
 */
const ROLE_INSTRUCTION = new RegExp([
  '(我|你)(是|作为|充当).{0,16}(管家|助手|负责人|协调者|调度)',
  '管家(模式|会话|角色)',
  '本会话(默认|是|当作|作为|负责)',
  '(你|我)(以后|默认|都)(要|会|应该)?[^。\\n]{0,20}(派|转交|优先|先做|先查)',
  '以后(在这个|本)会话',
  '(你|我)的(角色|职责|定位|工作方式)',
  '角色设定|工作方式|工作原则',
  '(派|转交|转发)给(其他|别的|相关)(的)?会话',
].join('|'), 'i')

/** Values that change without anyone editing the memory. */
const LIVE_STATE = /(端口.{0,6}(是|为|变成)\s*\d{2,5}|进程.{0,4}(在|不在|已)运行|排队中|今天(已经|共).{0,6}\d+\s*(次|个|条)|当前(余额|库存|价格)\s*(是|为)\s*\d|正在运行|此刻)/i

/**
 * Action verbs that describe carrying out an errand rather than recording a
 * reusable conclusion. Paired with the absence of an outcome statement.
 */
const ERRAND_VERB = /(查一下|查下|查查|看一下|找一下|跑一下|写一份|发一下|同步一下|更新一下|统计一下|整理一下|派给|转给)/

/**
 * A request to do one thing now, rather than a reusable conclusion. Anchored to
 * the start because that is where a model writes the request it was given.
 */
const ONE_OFF_TASK = /^(帮我|请帮我|帮忙|去|给我)(查|看|找|改|写|发|跑|执行|更新|同步|整理|派|算|列|统计)/

/** Text that states an outcome, which may still be worth keeping. */
const OUTCOME_STATEMENT = /(结论|因此|所以|结果(是|为)|确认|验证|发现|口径是|规则是|应该|必须|不要)/

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

/**
 * A deliberately loose "might restate this skill" signal, for reporting rather
 * than enforcement.
 *
 * Compared with looksLikeSkillRule this accepts much weaker evidence, because
 * the cost of a wrong listing is one glance and the cost of a miss is a
 * duplicate that nobody ever learns about. It answers "is this item about the
 * thing this skill defines", not "is this item a copy".
 * @param claim - the item's concluding claim.
 * @param skill - `{ name, description, body }`.
 * @returns `{ strength, reason }`, or undefined when unrelated.
 */
export function skillAffinity(claim, skill) {
  const claimSqueezed = squeeze(claim)
  const strongest = []

  // What the skill exists to handle is stated in its `description` (the
  // trigger), and its H1. The name and body are excluded on purpose: every
  // skill's body mentions tooling words like "skill", so any note that says
  // "skill" matched everything and the real duplicate ranked second behind an
  // unrelated web-search skill.
  const description = String(skill.description ?? '')
  const title = (skill.body ?? '').match(/^#\s+(\S.{0,40})$/m)?.[1] ?? ''
  const phrases = [
    ...(title.match(/[\u4e00-\u9fa5]{3,}|[A-Za-z][A-Za-z0-9]{4,}/g) ?? []),
    ...(description.match(/[\u4e00-\u9fa5]{3,}/g) ?? []).slice(0, 12),
  ].filter(phrase => !GENERIC_TERM.has(phrase))

  for (const phrase of phrases) {
    // Chinese: try the phrase and its leading/trailing halves, so an unbroken
    // 「技术文案说人话」still matches a claim that only says 「说人话」.
    const candidates = /^[\u4e00-\u9fa5]+$/.test(phrase) && phrase.length > 4
      ? [phrase, phrase.slice(0, 2), phrase.slice(2), phrase.slice(-2), phrase.slice(-3)]
      : [phrase]
    for (const candidate of candidates) {
      if (candidate.length < 2 || GENERIC_TERM.has(candidate)) continue
      const hit = /^[\u4e00-\u9fa5]+$/.test(candidate)
        ? claimSqueezed.includes(squeeze(candidate))
        : new RegExp(`\\b${candidate}\\b`, 'i').test(claim)
      if (hit) strongest.push(candidate)
    }
  }
  if (strongest.length === 0) return undefined
  const unique = [...new Set(strongest)].sort((a, b) => b.length - a.length)
  // Longer shared phrases mean a more specific overlap. Two or more shared
  // phrases rank above a single lucky word.
  // Rank by how many distinct phrases matched first — two real phrase hits mean
  // more than one long coincidence.
  return {
    strength: unique.length * 100 + unique.reduce((sum, phrase) => sum + phrase.length, 0),
    reason: `与该 skill 的说明用词相同：${unique.slice(0, 3).join('、')}`,
  }
}
