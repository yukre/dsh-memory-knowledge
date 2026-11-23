/**
 * The memory engine: every operation on the library, shared by the agent tools
 * and the settings page so both callers get the same behavior.
 *
 * @module dsh-memory-knowledge/engine
 */

import { join, dirname } from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { parseItem, readIfExists, composeSkill, writeAtomic, essence, fullText, normalizeId, slugify, splitFrontmatter } from './item.js'
import { basename } from 'node:path'
import { jaccard } from './search.js'
import {
  GateError, checkChecklist, checkEvidence, checkNotTranscription, checkPool, checkDuplicates,
  checkResurrection, checkHumanLock, checkEdges, checkIsKnowledge, looksLikeSkillRule, skillAffinity, composeBodyText, validArea,
} from './gate.js'
import { digestSession, eligibleSession, messageAt, messageOf, lastHumanMessage, redact } from './digest.js'
import { squeeze } from './gate.js'
import { renderDiff } from './diff.js'
import { EDGE_TYPES } from './graph.js'

/** Days → ms. */
const DAY = 86_400_000

/** Engine bound to one store and its host services. */
export class Engine {
  /**
   * @param store - open Store.
   * @param host - `{ sessionQuery(), sessionTitle(id) }`; functions returning services lazily.
   */
  constructor(store, host = {}) {
    this.store = store
    this.host = host
    this.config = store.config
    /** Cached skill indexes per cwd (`Map<cwd, { at, skills }>`), one minute each. */
    this.skillCache = undefined
  }

  get graph() { return this.store.graph }
  now() { return this.store.now() }

  /**
   * Skill roots DSH actually scans, in its own priority order.
   *
   * A memory that duplicates a skill wastes a write and a curation unit, and
   * the skill that owns the rule is usually a PROJECT skill (a workflow the
   * person built for one workspace), not a user-level one. Scanning only
   * ~/.agents/skills missed every project skill, so the gate never fired on the
   * real duplicates it was built for.
   * @param cwd - the session's working directory, for project-level roots.
   * @returns absolute directories.
   */
  skillRoots(cwd) {
    const roots = []
    const push = dir => { if (typeof dir === 'string' && dir.length > 0 && !roots.includes(dir)) roots.push(dir) }
    if (typeof cwd === 'string' && cwd.length > 0) {
      // The project root is the nearest ancestor holding .git; without one, cwd
      // itself (mirrors dsh-skill-filesystem).
      let root = cwd
      for (let dir = cwd; ; dir = dirname(dir)) {
        if (existsSync(join(dir, '.git'))) { root = dir; break }
        if (dirname(dir) === dir) break
      }
      push(join(root, '.dsh', 'skills'))
      push(join(root, '.agents', 'skills'))
      if (root !== cwd) {
        push(join(cwd, '.dsh', 'skills'))
        push(join(cwd, '.agents', 'skills'))
      }
    }
    for (const extra of this.config.skills.linkTargets) push(extra.startsWith('~/') ? join(homedir(), extra.slice(2)) : extra)
    push(join(homedir(), '.agents', 'skills'))
    push(join(homedir(), '.dsh', 'skills'))
    return roots
  }

  /**
   * The skills installed for a session, for the "already固化 in a skill" gate.
   * Cached per cwd for a minute because it touches the filesystem.
   * @param cwd - the session's working directory.
   * @returns `{ name, description, body }[]` (empty when unreadable).
   */
  installedSkills(cwd) {
    const key = typeof cwd === 'string' ? cwd : ''
    this.skillCache ??= new Map()
    const now = this.now()
    const cached = this.skillCache.get(key)
    if (cached !== undefined && now - cached.at < 60_000) return cached.skills
    const skills = []
    const seen = new Set()
    for (const root of this.skillRoots(cwd)) {
      let names
      try { names = readdirSync(root) } catch { continue }
      for (const name of names) {
        if (name.startsWith('.')) continue
        for (const file of [join(root, name, 'SKILL.md'), join(root, `${name}.md`)]) {
          const text = readIfExists(file)
          if (text === undefined) continue
          const { front, body } = splitFrontmatter(text)
          const skillName = front === null ? name : (/^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front)?.[1] ?? name)
          if (seen.has(skillName)) break
          seen.add(skillName)
          const description = front === null ? '' : (/^description:\s*["']?([^\n]*?)["']?\s*$/m.exec(front)?.[1] ?? '')
          // Full body: truncating at a fixed size silently hid three quarters of
          // a 16 KB skill, which is exactly the rule the gate needs to recognise.
          skills.push({ name: skillName, description, body })
          break
        }
      }
    }
    this.skillCache.set(key, { at: now, skills })
    return skills
  }

  /**
   * Read a session's raw events through ctx.sessionQuery.
   * @param sessionId - session id.
   * @returns SessionEvent[] or undefined.
   */
  async sessionEvents(sessionId) {
    const query = this.host.sessionQuery?.()
    if (query === undefined) return undefined
    try {
      const snapshot = await query.readSession(sessionId)
      return Array.isArray(snapshot?.events) ? snapshot.events : undefined
    } catch {
      return undefined
    }
  }

  /**
   * @param sessionId - session id.
   * @returns title or ''.
   */
  async sessionTitle(sessionId) {
    try {
      const value = await this.host.sessionTitle?.(sessionId)
      return typeof value === 'string' ? value : ''
    } catch {
      return ''
    }
  }

  /** Evidence lookup used by the gate. */
  lookup() {
    const kinds = this.config.capture.humanSourceKinds
    const cache = new Map()
    return {
      sessionText: async (sessionId, seq) => {
        if (!cache.has(sessionId)) cache.set(sessionId, await this.sessionEvents(sessionId))
        const events = cache.get(sessionId)
        return events === undefined ? undefined : messageAt(events, seq, kinds)
      },
      fileLines: async (path) => {
        const text = readIfExists(path)
        return text === undefined ? undefined : text.replace(/\r\n?/g, '\n').split('\n')
      },
    }
  }

  /* ------------------------------------------------------------------ *
   * Citation and presentation
   * ------------------------------------------------------------------ */

  /**
   * The "参考：" line for an item.
   * @param row - item row.
   * @returns citation line with a clickable absolute-path link.
   */
  async citeLine(row) {
    const tag = row.pool === 'staging' ? '待验证' : row.status === 'disputed' ? '⚠️有争议' : '记忆'
    let basis = ''
    const evidence = this.latestEvidence(row.id)
    if (evidence?.kind === 'session') {
      const title = await this.sessionTitle(evidence.sessionId)
      const day = typeof evidence.time === 'number' ? new Date(evidence.time).toISOString().slice(0, 10) : ''
      basis = ` · 依据：会话「${title || evidence.sessionId.slice(0, 16)}」${day ? ` ${day}` : ''}`
    } else if (evidence?.kind === 'file') {
      basis = ` · 依据：文件 ${evidence.path.split('/').pop()} 第 ${evidence.line} 行`
    } else if (row.human_at) {
      basis = ' · 依据：人工编写'
    }
    return `参考：[${row.title.replace(/[[\]]/g, '')}](<${row.path}>)（${tag}${basis}）`
  }

  /**
   * Most recent evidence recorded for an item in the changelog.
   * @param id - item id.
   * @returns evidence object or undefined.
   */
  latestEvidence(id) {
    const records = this.store.changelog.all()
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]
      if (record.item === id && Array.isArray(record.evidence) && record.evidence.length > 0) return record.evidence[record.evidence.length - 1]
    }
    return undefined
  }

  /**
   * Every evidence ever recorded for an item.
   * @param id - item id.
   * @returns evidence list.
   */
  allEvidence(id) {
    const out = []
    for (const record of this.store.changelog.all()) {
      if (record.item === id && Array.isArray(record.evidence)) out.push(...record.evidence)
    }
    return out
  }

  /**
   * One-hop neighbors as titles only.
   * @param id - item id.
   * @returns `{ id, title, type, direction, pool, status }[]`.
   */
  related(id) {
    const out = []
    for (const edge of this.graph.neighbors(id)) {
      const other = this.graph.item(edge.other)
      if (other === undefined) continue
      out.push({ id: other.id, title: other.title, type: edge.type, direction: edge.direction, pool: other.pool, status: other.status })
    }
    // Conflicts and supersessions first: the model must not see only one side.
    const rank = { contradicts: 0, supersedes: 1, 'depends-on': 2, refines: 3, related: 4, 'derived-from': 5 }
    return out.sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9))
  }

  /* ------------------------------------------------------------------ *
   * Recall
   * ------------------------------------------------------------------ */

  /**
   * Query, browse, or open.
   * @param args - `{ query?, area?, id?, limit?, pool? }`.
   * @returns result object for the tool.
   */
  async recall(args = {}) {
    if (typeof args.id === 'string' && args.id.length > 0) return this.open(normalizeId(args.id))
    const limit = Math.min(Math.max(Number(args.limit) || this.config.recall.limit, 1), 10)
    const snippetChars = this.config.recall.snippetChars
    const poolFilter = args.pool === 'memory' || args.pool === 'staging' || args.pool === 'archive' ? args.pool : undefined
    if ((typeof args.query !== 'string' || args.query.trim().length === 0) && typeof args.area === 'string' && args.area.length > 0) {
      return this.browse(args.area, poolFilter)
    }
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return { kind: 'areas', areas: this.store.areas() }
    }
    const allowed = id => {
      const row = this.graph.item(id)
      if (row === undefined) return false
      if (poolFilter !== undefined) return row.pool === poolFilter
      if (row.pool === 'archive') return false
      if (typeof args.area === 'string' && args.area.length > 0 && row.area !== args.area) return false
      return true
    }
    const hits = this.store.index.search(args.query, { limit: limit * 2, filter: allowed })
    const items = []
    for (const hit of hits) {
      const row = this.graph.item(hit.id)
      if (row === undefined) continue
      // Staging and disputed items rank below settled ones at equal relevance.
      const penalty = (row.pool === 'staging' ? 0.75 : 1) * (row.status === 'disputed' ? 0.7 : 1)
      items.push({ row, score: hit.score * penalty })
    }
    items.sort((a, b) => b.score - a.score)
    const out = []
    for (const { row } of items.slice(0, limit)) {
      const file = readIfExists(row.path)
      const body = file === undefined ? '' : parseItem(file).body.replace(/^#.*\n>.*\n?/u, '').trim()
      out.push({
        id: row.id,
        title: row.title,
        when: row.whenuse,
        area: row.area,
        pool: row.pool,
        status: row.status,
        snippet: [...body].slice(0, snippetChars).join('') + ([...body].length > snippetChars ? '…' : ''),
        related: this.related(row.id).slice(0, 6).map(rel => ({ id: rel.id, title: rel.title, type: rel.type })),
        cite: await this.citeLine(row),
      })
    }
    return { kind: 'hits', query: args.query, items: out }
  }

  /**
   * One category's items.
   * @param area - folder name.
   * @param pool - optional pool filter.
   * @returns browse result.
   */
  browse(area, pool) {
    const rows = this.graph.items().filter(row => row.area === area && (pool === undefined ? row.pool !== 'archive' : row.pool === pool))
    return {
      kind: 'browse',
      area,
      description: this.store.areaDescription(area),
      items: rows.slice(0, 50).map(row => ({ id: row.id, title: row.title, when: row.whenuse, pool: row.pool, status: row.status })),
      more: Math.max(0, rows.length - 50),
    }
  }

  /**
   * One item in full.
   * @param id - item id or alias.
   * @returns open result.
   */
  async open(id) {
    const found = this.store.read(id)
    if (found === undefined) return { kind: 'missing', id }
    const { row, parsed } = found
    this.graph.patchItem(row.id, { last_loaded: this.now() })
    const evidence = this.allEvidence(row.id).slice(-5)
    return {
      kind: 'item',
      id: row.id,
      title: row.title,
      when: row.whenuse,
      area: row.area,
      pool: row.pool,
      status: row.status,
      body: parsed.body,
      evidence: evidence.map(item => item.kind === 'session'
        ? { kind: 'session', sessionId: item.sessionId, seq: item.seq, quote: item.quote }
        : { kind: 'file', path: item.path, line: item.line, quote: item.quote }),
      related: this.related(row.id),
      cite: await this.citeLine(row),
    }
  }

  /* ------------------------------------------------------------------ *
   * Daytime writes: remember / feedback
   * ------------------------------------------------------------------ */

  /**
   * Remember something the person explicitly asked to keep.
   * @param args - checklist fields plus optional `area`, `title`, `replaces`.
   * @param context - `{ sessionId }` of the calling agent.
   * @returns write result.
   */
  async remember(args, context) {
    const events = await this.sessionEvents(context.sessionId)
    const human = events === undefined ? undefined : lastHumanMessage(events, this.config.capture.humanSourceKinds)
    if (human === undefined) throw new GateError('EVIDENCE_MISSING', '找不到本会话里用户的原话，无法记住')
    // Verify against the verbatim message; persist redacted.
    const quote = [...human.text.trim()].slice(0, 120).join('')
    const replaces = normalizeId(args.replaces)
    const target = normalizeId(args.target) ?? replaces
    // `replaces` alone means the old item is superseded; with resolution
    // update/noop the old item is edited in place / only gains evidence.
    const resolution = args.resolution ?? (replaces ? 'supersede' : undefined)
    const input = {
      ...args,
      confirmedBy: 'user-requested',
      validity: args.validity ?? 'long-term',
      pool: 'memory',
      evidence: [{ kind: 'session', sessionId: context.sessionId, seq: human.seq, quote }],
      resolution,
      target,
      replaces: undefined,
    }
    const op = resolution === 'supersede' ? 'supersede' : resolution === 'update' ? 'update' : 'add'
    return this.write({ ...input, op }, { via: 'remember', actor: 'agent', sessionId: context.sessionId, statedAt: human.time })
  }

  /**
   * Feedback on an item from a live conversation.
   * @param args - `{ id, verdict: wrong|outdated|forget|confirm, note? }`.
   * @param context - `{ sessionId }`.
   * @returns result.
   */
  async feedback(args, context) {
    return this.store.serial(async () => {
      const id = normalizeId(String(args.id ?? ''))
      const row = this.graph.item(id)
      if (row === undefined) throw new GateError('UNKNOWN_ITEM', `没有这条记忆：${args.id}`)
      const now = this.now()
      const events = await this.sessionEvents(context.sessionId)
      const human = events === undefined ? undefined : lastHumanMessage(events, this.config.capture.humanSourceKinds)
      const evidence = human === undefined ? [] : [{ kind: 'session', sessionId: context.sessionId, seq: human.seq, quote: redact([...human.text].slice(0, 120).join('')), role: 'user', time: human.time }]
      const note = typeof args.note === 'string' ? args.note.slice(0, 500) : undefined
      switch (args.verdict) {
        case 'wrong':
        case 'outdated': {
          this.graph.patchItem(row.id, { status: 'disputed', updated_at: now })
          const record = this.store.changelog.append({ op: 'dispute', actor: 'agent', item: row.id, path: row.path, verdict: args.verdict, note, evidence, session: context.sessionId }, now)
          if (human !== undefined) this.graph.addUse({ itemId: row.id, sessionId: context.sessionId, seq: human.seq }, now)
          this.graph.setUseVerdict(row.id, context.sessionId, 'challenged')
          this.store.emitChange()
          return { ok: true, id: row.id, status: 'disputed', change: record.change }
        }
        case 'forget': {
          const result = this.retireNow(row, { reason: note ?? 'user-forget', actor: 'agent', evidence, op: 'forget' })
          return { ok: true, id: row.id, status: 'retired', change: result.change }
        }
        case 'confirm': {
          this.graph.patchItem(row.id, { confirmed: true, status: row.status === 'disputed' ? 'active' : row.status, updated_at: now })
          const record = this.store.changelog.append({ op: 'confirm', actor: 'agent', item: row.id, path: row.path, note, evidence, session: context.sessionId }, now)
          if (human !== undefined) {
            this.graph.addUse({ itemId: row.id, sessionId: context.sessionId, seq: human.seq }, now)
            this.graph.setUseVerdict(row.id, context.sessionId, 'accepted')
          }
          this.store.emitChange()
          return { ok: true, id: row.id, status: 'confirmed', change: record.change }
        }
        default:
          throw new GateError('BAD_VERDICT', 'verdict 必须是 wrong / outdated / forget / confirm')
      }
    })
  }

  /**
   * Move an item to the archive with a tombstone (machine-initiated retire).
   * @param row - item row.
   * @param options - `{ reason, actor, evidence, op, supersededBy }`.
   * @returns changelog record.
   */
  retireNow(row, options) {
    const now = this.now()
    const text = readIfExists(row.path) ?? ''
    this.store.history.save(row.id, text, 'machine', now)
    this.graph.addTombstone({ id: row.id, fingerprint: row.fingerprint, title: row.title, text: essence(row.title, parseItem(text).body), reason: options.reason }, now)
    this.store.moveItem(row.id, 'archive')
    this.graph.patchItem(row.id, { status: 'retired', updated_at: now })
    if (options.supersededBy) this.graph.addEdge({ from: options.supersededBy, to: row.id, type: 'supersedes', by: options.actor }, now)
    return this.store.changelog.append({ op: options.op ?? 'retire', actor: options.actor, item: row.id, path: this.graph.item(row.id).path, reason: options.reason, evidence: options.evidence, supersededBy: options.supersededBy }, now)
  }

  /* ------------------------------------------------------------------ *
   * The write path (curator, remember, promote, import)
   * ------------------------------------------------------------------ */

  /**
   * One gated write.
   * @param args - mk_write arguments.
   * @param context - `{ via, actor, sessionId? }`.
   * @returns `{ ok, change, id, path }`.
   */
  async write(rawArgs, context) {
    const args = {
      ...rawArgs,
      target: normalizeId(rawArgs.target),
      to: normalizeId(rawArgs.to),
      endConflictWith: normalizeId(rawArgs.endConflictWith),
      from: Array.isArray(rawArgs.from) ? rawArgs.from.map(normalizeId) : rawArgs.from,
      relations: Array.isArray(rawArgs.relations) ? rawArgs.relations.map(r => ({ ...r, to: normalizeId(r?.to) })) : rawArgs.relations,
    }
    return this.store.serial(async () => {
      const op = args.op
      switch (op) {
        case 'add': return this.opAdd(args, context)
        case 'update': return this.opUpdate(args, context)
        case 'supersede': return this.opSupersede(args, context)
        case 'retire': return this.opRetire(args, context)
        case 'promote': return this.opPromote(args, context)
        case 'resolve': return this.opResolve(args, context)
        case 'link': return this.opLink(args, context)
        case 'unlink': return this.opUnlink(args, context)
        case 'skill': return this.opSkill(args, context)
        default: throw new GateError('BAD_OP', `op 必须是 add / update / supersede / retire / promote / resolve / link / unlink / skill`)
      }
    })
  }

  /**
   * Shared checks for content writes.
   * @param args - write arguments.
   * @param context - write context.
   * @param target - row being replaced/updated, if any.
   * @returns `{ evidence, pool, area, dupes }`.
   */
  async gateContent(args, context, target) {
    // The first question is not "is this written well" but "is this knowledge".
    // It runs before everything else so no write path — including mk_remember,
    // which the person triggers in conversation — can skip it.
    checkIsKnowledge(args, {
      via: context.via,
      workspaceInstructions: this.workspaceInstructions?.(context.sessionId),
      skills: this.installedSkills(this.sessionCwd?.(context.sessionId)),
    })
    checkChecklist(args, { skill: args.op === 'skill' })
    const evidence = await checkEvidence(args.evidence, this.lookup())
    const sources = []
    for (const item of evidence) {
      if (item.kind === 'session') {
        const found = await this.lookup().sessionText(item.sessionId, item.seq)
        if (found !== undefined) sources.push(found.text)
      }
    }
    checkNotTranscription(args, sources)
    const pool = args.op === 'skill' ? 'memory' : checkPool(args, evidence, context)
    const area = target?.area ?? (typeof args.area === 'string' && args.area.trim().length > 0 ? args.area.trim() : '')
    if (args.op !== 'skill' && !validArea(area)) throw new GateError('BAD_AREA', '请给出一个分类（area），例如 cloudbase、finance、preferences')
    const title = (typeof args.title === 'string' && args.title.trim()) || target?.title || [...String(args.claim)].slice(0, 24).join('')
    const text = essence(title, composeBodyText(args))
    const exclude = new Set([target?.id, typeof args.target === 'string' ? this.graph.canonical(args.target) : undefined].filter(Boolean))
    const similar = this.similarLive(text, exclude)
    checkResurrection(text, this.graph.tombstones().filter(stone => !exclude.has(stone.id)), evidence, similar[0]?.similarity ?? 0)
    if (target !== undefined) checkHumanLock(target, evidence)
    const dupes = checkDuplicates(similar, args.resolution)
    checkEdges(args.relations, target?.id, this.graph)
    return { evidence, pool, area, dupes }
  }

  /**
   * Living items (memory + staging) most similar to an essence. Candidates come
   * from the keyword index, then similarity is measured essence to essence.
   * @param text - candidate essence.
   * @param exclude - ids to skip.
   * @returns `{ id, title, pool, status, similarity }[]`, best first.
   */
  similarLive(text, exclude = new Set()) {
    const hits = this.store.index.search(text, { limit: 12, filter: id => !exclude.has(id) && this.graph.item(id)?.pool !== 'archive' })
    const out = []
    for (const hit of hits) {
      const row = this.graph.item(hit.id)
      if (row === undefined) continue
      const file = readIfExists(row.path)
      if (file === undefined) continue
      const parsed = parseItem(file, row.area === 'skills' ? 'skill' : 'item')
      // Compare against the full text too, so a copied body with a reworded
      // title still counts as a duplicate.
      const byEssence = jaccard(text, essence(row.title, parsed.body))
      const byFull = jaccard(text, fullText(row.title, parsed.body))
      out.push({ id: row.id, title: row.title, pool: row.pool, status: row.status, similarity: Math.max(byEssence, byFull) })
    }
    return out.sort((a, b) => b.similarity - a.similarity)
  }

  /** @param args @param context @returns result */
  async opAdd(args, context) {
    if (['update', 'supersede', 'noop'].includes(args.resolution)) {
      if (!args.target) throw new GateError('TARGET_REQUIRED', `resolution=${args.resolution} 时必须用 target（或 mk_remember 的 replaces）指明已有条目的 id`)
      if (this.graph.item(args.target) === undefined) throw new GateError('UNKNOWN_ITEM', `没有这条记忆：${args.target}`)
    }
    if (args.resolution === 'noop') return this.opNoop(args, context)
    if (args.resolution === 'update' && args.target) return this.opUpdate({ ...args, op: 'update' }, context)
    if (args.resolution === 'supersede' && args.target) return this.opSupersede({ ...args, op: 'supersede' }, context)
    const { evidence, pool, area } = await this.gateContent(args, context)
    const now = this.now()
    const title = (typeof args.title === 'string' && args.title.trim()) || [...args.claim].slice(0, 24).join('')
    const id = this.store.freshId()
    const path = this.store.pathFor(pool, area, title)
    const row = this.store.writeItem({
      id, path, pool, area, kind: args.kind, status: 'active', human_at: context.statedAt ?? null, confirmed: false, last_loaded: null,
      source_sessions: [...new Set(evidence.filter(e => e.kind === 'session').map(e => e.sessionId))],
    }, { title, when: args.when, body: composeBodyText(args) })
    this.addRelations(id, args.relations, context.actor, now)
    const record = this.store.changelog.append({ op: 'add', actor: context.actor, item: id, path: row.path, pool, kind: args.kind, confirmedBy: args.confirmedBy, evidence: strip(evidence), via: context.via }, now)
    return { ok: true, change: record.change, id, path: row.path, pool, cite: await this.citeLine(row) }
  }

  /** @param args @param context @returns result */
  async opNoop(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined) throw new GateError('UNKNOWN_ITEM', 'noop 需要 target（已有条目的 id）')
    const evidence = await checkEvidence(args.evidence, this.lookup())
    const now = this.now()
    const sessions = new Set(target.source_sessions)
    for (const item of evidence) if (item.kind === 'session') sessions.add(item.sessionId)
    this.graph.patchItem(target.id, { source_sessions: [...sessions], updated_at: now })
    const record = this.store.changelog.append({ op: 'link', actor: context.actor, item: target.id, path: target.path, note: 'evidence-added', evidence: strip(evidence), via: context.via }, now)
    return { ok: true, change: record.change, id: target.id, path: target.path, noop: true }
  }

  /** @param args @param context @returns result */
  async opUpdate(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined) throw new GateError('UNKNOWN_ITEM', 'update 需要 target（已有条目的 id）')
    const { evidence } = await this.gateContent({ ...args, resolution: args.resolution ?? 'update' }, context, target)
    const now = this.now()
    const title = (typeof args.title === 'string' && args.title.trim()) || target.title
    const sessions = new Set(target.source_sessions)
    for (const item of evidence) if (item.kind === 'session') sessions.add(item.sessionId)
    // A file still named after its old title follows the new title; a name
    // the person chose is kept.
    const ownName = basename(target.path, '.md').replace(/-\d+$/, '') === slugify(target.title)
    const path = ownName && title !== target.title ? this.store.pathFor(target.pool, target.area, title, target.path) : target.path
    const statedAt = context.statedAt ?? target.human_at ?? null
    let row
    try {
      row = this.store.writeItem({ ...target, path, human_at: statedAt, source_sessions: [...sessions] }, { title, when: args.when, body: composeBodyText(args) }, { baseFingerprint: args.baseFingerprint ?? target.fingerprint })
    } catch (error) {
      if (error.code === 'STALE_BASE') throw new GateError('STALE_BASE', '文件在你读取之后被改过，请重新读取再决定')
      throw error
    }
    if (target.status === 'disputed') this.graph.patchItem(target.id, { status: 'active' })
    this.addRelations(target.id, args.relations, context.actor, now)
    const record = this.store.changelog.append({ op: 'update', actor: context.actor, item: target.id, path: row.path, evidence: strip(evidence), via: context.via, reason: args.reason }, now)
    return { ok: true, change: record.change, id: target.id, path: row.path, cite: await this.citeLine(row) }
  }

  /** @param args @param context @returns result */
  async opSupersede(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined) throw new GateError('UNKNOWN_ITEM', 'supersede 需要 target（被取代条目的 id）')
    const { evidence, pool, area } = await this.gateContent({ ...args, resolution: 'supersede' }, { ...context }, undefined)
    if (target.human_at !== null && target.human_at !== undefined) checkHumanLock(target, evidence)
    const now = this.now()
    const title = (typeof args.title === 'string' && args.title.trim()) || target.title
    const id = this.store.freshId()
    const newPool = target.pool === 'memory' && pool === 'staging' && context.via !== 'curator' ? 'memory' : pool
    const path = this.store.pathFor(newPool, area || target.area, title)
    const row = this.store.writeItem({
      id, path, pool: newPool, area: area || target.area, kind: args.kind, status: 'active', human_at: context.statedAt ?? null, confirmed: false, last_loaded: null,
      source_sessions: [...new Set(evidence.filter(e => e.kind === 'session').map(e => e.sessionId))],
    }, { title, when: args.when, body: composeBodyText(args) })
    const retired = this.retireNow(target, { reason: args.reason ?? 'superseded', actor: context.actor, evidence: strip(evidence), op: 'supersede', supersededBy: id })
    this.addRelations(id, args.relations, context.actor, now)
    const record = this.store.changelog.append({ op: 'add', actor: context.actor, item: id, path: row.path, pool: newPool, kind: args.kind, evidence: strip(evidence), via: context.via, supersedes: target.id, retiredChange: retired.change }, now)
    return { ok: true, change: record.change, id, path: row.path, superseded: target.id, cite: await this.citeLine(row) }
  }

  /** @param args @param context @returns result */
  async opRetire(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined) throw new GateError('UNKNOWN_ITEM', 'retire 需要 target')
    const evidence = Array.isArray(args.evidence) && args.evidence.length > 0 ? await checkEvidence(args.evidence, this.lookup()) : []
    if (target.human_at !== null && target.human_at !== undefined) checkHumanLock(target, evidence)
    if (target.pool === 'memory' && evidence.length === 0) throw new GateError('EVIDENCE_MISSING', '作废记忆区条目需要依据')
    const record = this.retireNow(target, { reason: args.reason ?? 'retired', actor: context.actor, evidence: strip(evidence) })
    return { ok: true, change: record.change, id: target.id }
  }

  /** @param args @param context @returns result */
  async opPromote(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined || target.pool !== 'staging') throw new GateError('UNKNOWN_ITEM', 'promote 需要预备区条目的 id')
    const votes = this.votes(target.id)
    // A curator-confirmed flag alone must never skip the vote requirement: the
    // agent can call mk_feedback(confirm) by itself, so trusting it would let
    // one model turn promote unvalidated knowledge into memory. Only the
    // person's own confirmation (recorded with actor 'human') counts as a vote.
    const humanConfirmed = target.confirmed && this.hasHumanConfirm(target.id)
    if (!humanConfirmed && votes < this.config.pools.promoteVotes) {
      throw new GateError('NOT_ENOUGH_VOTES', `需要在 ${this.config.pools.promoteVotes} 个其他会话里被引用且无人质疑，当前 ${votes} 票${target.confirmed ? '（整理员的 confirm 不算票）' : ''}`)
    }
    if (this.graph.neighbors(target.id).some(edge => edge.type === 'contradicts') || target.status === 'disputed') {
      throw new GateError('DISPUTED', '有未解决的冲突或争议，不能转正')
    }
    const now = this.now()
    const row = this.store.moveItem(target.id, 'memory')
    const record = this.store.changelog.append({ op: 'promote', actor: context.actor, item: target.id, path: row.path, votes, reason: args.reason }, now)
    return { ok: true, change: record.change, id: target.id, path: row.path, cite: await this.citeLine(row) }
  }

  /** @param args @param context @returns result */
  async opResolve(args, context) {
    const target = this.graph.item(String(args.target ?? ''))
    if (target === undefined) throw new GateError('UNKNOWN_ITEM', 'resolve 需要 target')
    const now = this.now()
    if (args.outcome === 'retire') return this.opRetire({ ...args, op: 'retire' }, context)
    if (args.outcome === 'dispute') {
      this.graph.patchItem(target.id, { status: 'disputed', updated_at: now })
      const record = this.store.changelog.append({ op: 'dispute', actor: context.actor, item: target.id, path: target.path, reason: args.reason }, now)
      this.store.emitChange()
      return { ok: true, change: record.change, id: target.id, status: 'disputed' }
    }
    this.graph.patchItem(target.id, { status: 'active', updated_at: now })
    for (const edge of this.graph.neighbors(target.id).filter(e => e.type === 'contradicts')) {
      if (args.endConflictWith === edge.other) {
        const from = edge.direction === 'out' ? target.id : edge.other
        const to = edge.direction === 'out' ? edge.other : target.id
        this.graph.endEdge({ from, to, type: 'contradicts' }, now)
      }
    }
    const record = this.store.changelog.append({ op: 'resolve', actor: context.actor, item: target.id, path: target.path, outcome: 'keep', reason: args.reason }, now)
    this.store.emitChange()
    return { ok: true, change: record.change, id: target.id, status: 'active' }
  }

  /** @param args @param context @returns result */
  async opLink(args, context) {
    const from = this.graph.item(String(args.target ?? ''))
    if (from === undefined) throw new GateError('UNKNOWN_ITEM', 'link 需要 target（起点条目 id）')
    const edges = [{ to: String(args.to ?? ''), type: args.type }]
    checkEdges(edges, from.id, this.graph)
    const now = this.now()
    const to = this.graph.item(edges[0].to)
    this.graph.addEdge({ from: from.id, to: to.id, type: args.type, by: context.actor, evidence: args.reason ?? '' }, now)
    if (args.type === 'contradicts') {
      this.graph.patchItem(from.id, { status: 'disputed' })
      this.graph.patchItem(to.id, { status: 'disputed' })
    }
    const record = this.store.changelog.append({ op: 'link', actor: context.actor, item: from.id, to: to.id, type: args.type, reason: args.reason }, now)
    this.store.emitChange()
    return { ok: true, change: record.change, id: from.id }
  }

  /** @param args @param context @returns result */
  async opUnlink(args, context) {
    const from = this.graph.item(String(args.target ?? ''))
    const to = this.graph.item(String(args.to ?? ''))
    if (from === undefined || to === undefined || !EDGE_TYPES.includes(args.type)) throw new GateError('BAD_EDGE', 'unlink 需要 target、to 和 type')
    const now = this.now()
    this.graph.endEdge({ from: from.id, to: to.id, type: args.type }, now)
    this.graph.endEdge({ from: to.id, to: from.id, type: args.type }, now)
    const record = this.store.changelog.append({ op: 'unlink', actor: context.actor, item: from.id, to: to.id, type: args.type, reason: args.reason }, now)
    return { ok: true, change: record.change, id: from.id }
  }

  /**
   * Upgrade a method to a skill.
   * @param args - `{ name, description, when, steps, from: id[], evidence, … }`.
   * @param context - write context.
   * @returns result.
   */
  async opSkill(args, context) {
    const name = String(args.name ?? '').trim()
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(name)) throw new GateError('BAD_SKILL_NAME', 'Skill 名用小写字母、数字和连字符，2~49 位')
    const skills = this.graph.items({ pool: 'memory' }).filter(row => row.area === 'skills' && row.status === 'active')
    const existing = skills.find(row => row.title === name)
    if (existing === undefined && skills.length >= this.config.skills.maxSkills) {
      throw new GateError('SKILL_LIMIT', `Skill 已达上限 ${this.config.skills.maxSkills}，请先合并相近的`)
    }
    const input = { ...args, kind: 'method', claim: args.description, why: args.why ?? '多次出现的稳定流程', scope: args.scope ?? '见步骤中的前提', when: args.when ?? args.description }
    checkChecklist(input, { skill: true })
    const evidence = await checkEvidence(args.evidence, this.lookup())
    const sessions = new Set(evidence.filter(item => item.kind === 'session').map(item => item.sessionId))
    if (sessions.size < 3 && args.corrections !== true) {
      throw new GateError('SKILL_THRESHOLD', '升级为 Skill 需要来自至少 3 个不同会话的依据（或用户就同一流程纠正过至少 2 次，并设 corrections=true）')
    }
    if (existing?.human_at) checkHumanLock(existing, evidence)
    const now = this.now()
    const id = existing?.id ?? this.store.freshId()
    const folder = join(this.config.skillsDir, name)
    const path = join(folder, 'SKILL.md')
    const text = composeSkill({ id, name, description: args.description, whenToUse: args.when, body: String(args.steps ?? '') })
    if (existing !== undefined) this.store.history.save(id, readIfExists(path) ?? '', 'machine', now)
    writeAtomic(path, text)
    const parsed = parseItem(text, 'skill')
    this.store.ownWrites.set(path, parsed.fingerprint)
    this.graph.putItem({
      ...(existing ?? { created_at: now, human_at: null, confirmed: false, last_loaded: null }),
      id, path, pool: 'memory', area: 'skills', kind: 'method', status: 'active', title: name, whenuse: args.when ?? args.description,
      fingerprint: parsed.fingerprint, machine_fingerprint: parsed.fingerprint, updated_at: now, source_sessions: [...sessions],
    })
    this.store.history.save(id, text, 'machine', now)
    this.store.indexItem(this.graph.item(id), parsed.body)
    for (const fromId of Array.isArray(args.from) ? args.from : []) {
      const origin = this.graph.item(String(fromId))
      if (origin === undefined || origin.id === id) continue
      this.graph.addEdge({ from: id, to: origin.id, type: 'derived-from', by: context.actor }, now)
      if (origin.pool !== 'archive') this.retireNow(origin, { reason: 'upgraded-to-skill', actor: context.actor, evidence: [], op: 'retire' })
      this.graph.removeTombstone(origin.id)
    }
    const record = this.store.changelog.append({ op: 'skill', actor: context.actor, item: id, path, name, evidence: strip(evidence) }, now)
    this.store.emitChange()
    return { ok: true, change: record.change, id, path, name }
  }

  /**
   * Add relation edges after a content write.
   * @param id - item id.
   * @param relations - `{ to, type }[]`.
   * @param actor - who.
   * @param now - timestamp.
   */
  addRelations(id, relations, actor, now) {
    if (!Array.isArray(relations)) return
    for (const relation of relations) {
      this.graph.addEdge({ from: id, to: this.graph.canonical(String(relation.to)), type: relation.type, by: actor }, now)
      if (relation.type === 'contradicts') {
        this.graph.patchItem(id, { status: 'disputed' })
        this.graph.patchItem(this.graph.canonical(String(relation.to)), { status: 'disputed' })
      }
    }
  }

  /**
   * Whether the person themselves confirmed this item (not an agent).
   * @param id - item id.
   * @returns true when a human-sourced confirm exists.
   */
  hasHumanConfirm(id) {
    return this.store.changelog.all().some(record =>
      record.op === 'confirm' && record.item === id && record.actor === 'human')
  }

  /**
   * Accepted votes from sessions other than the item's own sources.
   * @param id - item id.
   * @returns vote count.
   */
  votes(id) {
    const row = this.graph.item(id)
    if (row === undefined) return 0
    const sources = new Set(row.source_sessions)
    return this.graph.uses(id).filter(use => use.verdict === 'accepted' && !sources.has(use.session_id)).length
  }

  /* ------------------------------------------------------------------ *
   * Curation queue
   * ------------------------------------------------------------------ */

  /**
   * Next unit of curation work, in priority order: human edits → disputes →
   * imports → sessions → promotions/expiry.
   * @param budget - `{ charsLeft, sessionsLeft }` mutable run budget.
   * @returns `{ unit }` or `{ done: true }`.
   */
  async next(budget) {
    const human = this.pendingHumanEdit()
    if (human !== undefined) return { unit: human }
    const dispute = this.pendingDispute()
    if (dispute !== undefined) return { unit: dispute }
    const imported = this.pendingImport?.()
    if (imported !== undefined) return { unit: imported }
    if (budget.charsLeft > 0 && budget.sessionsLeft > 0) {
      const session = await this.pendingSession(budget)
      if (session !== undefined) return { unit: session }
    }
    const promote = this.pendingPromotion()
    if (promote !== undefined) return { unit: promote }
    // Surface skill duplicates last, after the work that changes the library,
    // so a long report never crowds out actual curation.
    const suspect = this.suspectSkills(5)[0]
    if (suspect !== undefined) return { unit: suspect }
    this.expireStaging()
    const startedAt = this.graph.get('runStartedAt')
    if (startedAt !== undefined) {
      const writes = this.store.changelog.all()
        .filter(record => record.at >= startedAt && ['add', 'update', 'supersede', 'retire', 'promote', 'expire', 'skill'].includes(record.op))
        .length
      this.graph.set('lastRun', { at: this.now(), units: this.graph.get('runUnits') ?? 0, writes })
      this.graph.set('runUnits', 0)
      this.graph.set('runStartedAt', undefined)
    }
    return { done: true }
  }

  /** @returns the oldest unprocessed human-edit unit or undefined. */
  pendingHumanEdit() {
    const done = new Set(this.graph.get('humanEditsDone') ?? [])
    for (const record of this.store.changelog.all()) {
      if (!['human-edit', 'human-add', 'human-delete'].includes(record.op) || done.has(record.change)) continue
      const row = this.graph.item(record.item)
      const related = row === undefined ? [] : this.related(row.id).slice(0, 8).map(rel => ({ id: rel.id, title: rel.title, type: rel.type }))
      const similar = row === undefined ? [] : this.store.index.search(`${row.title} ${row.whenuse}`, { limit: 6, filter: id => id !== row.id })
        .map(hit => this.graph.item(hit.id)).filter(Boolean).map(other => ({ id: other.id, title: other.title, pool: other.pool }))
      return {
        kind: 'human-edit',
        ref: record.change,
        op: record.op,
        id: record.item,
        title: row?.title ?? record.title,
        path: row?.path ?? record.path,
        diff: record.diff,
        text: record.rewrite || record.op === 'human-add' ? (row === undefined ? null : this.store.read(row.id)?.parsed.body ?? null) : null,
        pendingEdges: row === undefined ? [] : this.graph.pendingEdges(row.id),
        related: [...related, ...similar.filter(s => !related.some(r => r.id === s.id))].slice(0, 10),
      }
    }
    return undefined
  }

  /** @returns a disputed-item unit or undefined. */
  pendingDispute() {
    const seen = new Set(this.graph.get('disputesSeenThisRun') ?? [])
    const row = this.graph.items({ status: 'disputed' }).find(item => !seen.has(item.id))
    if (row === undefined) return undefined
    const records = this.store.changelog.all().filter(record => record.item === row.id && ['dispute', 'link'].includes(record.op)).slice(-3)
    return {
      kind: 'dispute', ref: row.id, id: row.id, title: row.title, path: row.path, pool: row.pool,
      text: this.store.read(row.id)?.parsed.body ?? null,
      notes: records.map(record => ({ op: record.op, verdict: record.verdict, note: record.note, evidence: record.evidence })),
      related: this.related(row.id).slice(0, 8),
    }
  }

  /**
   * The next eligible session with new material.
   * @param budget - mutable run budget.
   * @returns session unit or undefined.
   */
  async pendingSession(budget) {
    const query = this.host.sessionQuery?.()
    if (query === undefined) return undefined
    let records
    try { records = await query.listSessions() } catch { return undefined }
    const options = { workspace: this.config.workspace, includeCwd: this.config.capture.includeCwd, excludeCwd: this.config.capture.excludeCwd }
    const skipped = new Set(this.graph.get('sessionsSkippedThisRun') ?? [])
    for (const record of records) {
      const header = record?.header
      if (!eligibleSession(header, options) || skipped.has(header.id)) continue
      const fromSeq = this.graph.progress(header.id)
      const events = await this.sessionEvents(header.id)
      if (events === undefined) continue
      const maxChars = Math.min(this.config.curator.maxCharsPerSession, budget.charsLeft)
      const digest = digestSession(events, { fromSeq, humanKinds: this.config.capture.humanSourceKinds, maxChars, library: this.config.library })
      if (digest.toSeq <= fromSeq) continue
      if (digest.messages === 0 || digest.text.length === 0) {
        this.graph.setProgress(header.id, digest.toSeq, this.now())
        continue
      }
      budget.charsLeft -= digest.text.length
      budget.sessionsLeft -= 1
      const citedUses = []
      const pathIndex = this.store.changelog.pathIndex()
      for (const citation of digest.citations) {
        const id = this.graph.itemByPath(citation.path)?.id ?? pathIndex.get(citation.path)
        const row = id === undefined ? undefined : this.graph.item(id)
        if (row === undefined) continue
        this.graph.addUse({ itemId: row.id, sessionId: header.id, seq: citation.seq }, this.now())
        if (citation.nextUserText !== undefined) citedUses.push({ id: row.id, title: row.title, seq: citation.seq, sourceSession: row.source_sessions.includes(header.id), nextUser: citation.nextUserText })
        else citedUses.push({ id: row.id, title: row.title, seq: citation.seq, sourceSession: row.source_sessions.includes(header.id), nextUser: null })
      }
      const remembered = this.store.changelog.all()
        .filter(r => r.via === 'remember' && Array.isArray(r.evidence) && r.evidence.some(e => e.sessionId === header.id))
        .map(r => this.graph.item(r.item)).filter(Boolean).map(row => ({ id: row.id, title: row.title }))
      const produced = this.graph.items().filter(row => row.source_sessions.includes(header.id)).map(row => ({ id: row.id, title: row.title, pool: row.pool }))
      return {
        kind: 'session',
        ref: header.id,
        sessionId: header.id,
        title: await this.sessionTitle(header.id),
        cwd: header.cwd,
        fromSeq,
        toSeq: digest.toSeq,
        text: digest.text,
        hints: digest.corrections.map(c => ({ kind: 'possible-correction', seq: c.seq, replyTo: c.replyTo })),
        citedUses,
        alreadyRemembered: remembered,
        produced: produced.slice(0, 20),
      }
    }
    return undefined
  }

  /** @returns a staging item with enough votes, or undefined. */
  /**
   * Items that look like they restate a rule an installed skill already owns.
   *
   * Reported, never enforced. The judgement is lexical and therefore wrong in
   * both directions — measured on this library, the clearest true duplicate
   * (a skill defining 「说人话」) scored below an unrelated note — so a person
   * decides, and the curator only surfaces the candidates with the evidence
   * needed to decide: which skill, why, and the item's own text.
   * @param limit - how many to report in one run.
   * @returns `{ kind, id, title, path, pool, skill, reason, text }[]`.
   */
  suspectSkills(limit = 5) {
    const skills = this.installedSkills(this.suspectCwd ?? this.host.suspectCwd?.())
    if (skills.length === 0) return []
    const reported = new Set(this.graph.get('skillSuspectsSeen') ?? [])
    const out = []
    for (const row of this.graph.items({ pool: 'staging' })) {
      if (out.length >= limit) break
      if (reported.has(row.id) || row.status === 'disputed') continue
      const body = this.store.read(row.id)?.parsed.body ?? ''
      const claim = /\*\*结论\*\*[:：]\s*(.+)/.exec(body)?.[1] ?? row.title
      // Report on a deliberately loose signal. Being listed costs a person a
      // glance; being missed hides a duplicate forever, and the strict test
      // provably misses the clearest case in this very library (a skill that
      // defines 「说人话」 score below an unrelated note). So: any skill whose
      // name or stated subject shares a distinctive phrase with the item is
      // listed, most-related first.
      let best
      for (const skill of skills) {
        const score = skillAffinity(claim, skill)
        if (score === undefined) continue
        if (best === undefined || score.strength > best.strength) best = { skill: skill.name, ...score }
      }
      if (best !== undefined) {
        out.push({ kind: 'skill-suspect', ref: row.id, id: row.id, title: row.title, path: row.path, pool: row.pool, skill: best.skill, reason: best.reason, text: body.slice(0, 1200) })
      }
    }
    return out
  }

  pendingPromotion() {
    const seen = new Set(this.graph.get('promotionsSeenThisRun') ?? [])
    for (const row of this.graph.items({ pool: 'staging' })) {
      if (seen.has(row.id) || row.status === 'disputed') continue
      const votes = this.votes(row.id)
      if (!(row.confirmed && this.hasHumanConfirm(row.id)) && votes < this.config.pools.promoteVotes) continue
      return { kind: 'promote', ref: row.id, id: row.id, title: row.title, path: row.path, votes, confirmed: row.confirmed, text: this.store.read(row.id)?.parsed.body ?? null, related: this.related(row.id).slice(0, 6) }
    }
    return undefined
  }

  /** Archive staging items older than the expiry with no accepted vote. */
  expireStaging() {
    const now = this.now()
    const cutoff = now - this.config.pools.stagingExpireDays * DAY
    for (const row of this.graph.items({ pool: 'staging' })) {
      if (row.created_at > cutoff || this.votes(row.id) > 0 || row.confirmed) continue
      this.store.moveItem(row.id, 'archive')
      this.graph.patchItem(row.id, { status: 'expired' })
      this.store.changelog.append({ op: 'expire', actor: 'curator', item: row.id, path: this.graph.item(row.id).path }, now)
    }
  }

  /**
   * Close a unit.
   * @param args - `{ unit: {kind, ref}, summary?, useVerdicts?, edgeReviews? }`.
   * @param budget - run budget.
   * @returns `{ ok }`.
   */
  async done(args) {
    return this.store.serial(async () => {
      const unit = args?.unit ?? {}
      const now = this.now()
      if (unit.kind === 'human-edit') {
        const record = this.store.changelog.find(String(unit.ref))
        const row = record === undefined ? undefined : this.graph.item(record.item)
        const pending = row === undefined ? [] : this.graph.pendingEdges(row.id)
        const reviews = Array.isArray(args.edgeReviews) ? args.edgeReviews : []
        for (const edge of pending) {
          const review = reviews.find(r => r.from === edge.from && r.to === edge.to && r.type === edge.type)
          if (review === undefined) throw new GateError('UNIT_INCOMPLETE', `还有待复核的关系没有结论：${edge.from} → ${edge.to} (${edge.type})`)
          if (review.decision === 'drop') this.graph.endEdge(edge, now)
          else this.graph.clearReview(edge)
        }
        const done = new Set(this.graph.get('humanEditsDone') ?? [])
        done.add(String(unit.ref))
        this.graph.set('humanEditsDone', [...done].slice(-2000))
      } else if (unit.kind === 'dispute') {
        const seen = new Set(this.graph.get('disputesSeenThisRun') ?? [])
        seen.add(String(unit.ref))
        this.graph.set('disputesSeenThisRun', [...seen])
      } else if (unit.kind === 'skill-suspect') {
        // A person decides; the curator only records that it was raised, so the
        // same item is not re-reported every night.
        const seen = new Set(this.graph.get('skillSuspectsSeen') ?? [])
        seen.add(String(unit.ref))
        this.graph.set('skillSuspectsSeen', [...seen].slice(-2000))
      } else if (unit.kind === 'promote') {
        const seen = new Set(this.graph.get('promotionsSeenThisRun') ?? [])
        seen.add(String(unit.ref))
        this.graph.set('promotionsSeenThisRun', [...seen])
      } else if (unit.kind === 'session') {
        const sessionId = String(unit.ref)
        const verdicts = Array.isArray(args.useVerdicts) ? args.useVerdicts : []
        const pending = this.graph.pendingUses().filter(use => use.session_id === sessionId)
        for (const use of pending) {
          const verdict = verdicts.find(v => v.id === use.item_id)
          if (verdict === undefined) throw new GateError('UNIT_INCOMPLETE', `引用核实还没有结论：${use.item_id}`)
          const value = ['accepted', 'challenged', 'excluded'].includes(verdict.verdict) ? verdict.verdict : 'accepted'
          const row = this.graph.item(use.item_id)
          this.graph.setUseVerdict(use.item_id, sessionId, row?.source_sessions.includes(sessionId) ? 'excluded' : value)
          if (value === 'challenged' && row !== undefined && row.status !== 'disputed') this.graph.patchItem(row.id, { status: 'disputed' })
        }
        if (typeof unit.toSeq === 'number') this.graph.setProgress(sessionId, unit.toSeq, now)
      } else if (unit.kind === 'import') {
        this.importDone?.(unit)
      } else {
        throw new GateError('BAD_UNIT', 'unit.kind 必须是 human-edit / dispute / import / session / promote')
      }
      this.graph.set('runUnits', (this.graph.get('runUnits') ?? 0) + 1)
      return { ok: true }
    })
  }

  /** Reset per-run markers at the start of a curation run. */
  beginRun() {
    this.graph.set('disputesSeenThisRun', [])
    this.graph.set('promotionsSeenThisRun', [])
    this.graph.set('sessionsSkippedThisRun', [])
    this.graph.set('runStartedAt', this.now())
  }

  /**
   * Bounded excerpt of a session.
   * @param args - `{ sessionId, fromSeq, toSeq }`.
   * @returns `{ text }`.
   */
  async excerpt(args) {
    const events = await this.sessionEvents(String(args.sessionId))
    if (events === undefined) return { text: '', error: '读不到这个会话' }
    const from = Math.max(0, Number(args.fromSeq) - 1)
    const to = Number(args.toSeq)
    const lines = []
    let used = 0
    for (const event of events) {
      if (event.seq <= from || event.seq > to) continue
      const message = messageOf(event, this.config.capture.humanSourceKinds)
      if (message === undefined) continue
      const line = `[#${message.seq} ${message.role === 'user' ? '用户' : '助手'}] ${redact(message.text)}`
      if (used + line.length > 8000) { lines.push('…（超过 8000 字已截断，缩小区间再取）'); break }
      lines.push(line)
      used += line.length
    }
    return { text: lines.join('\n\n') }
  }

  /* ------------------------------------------------------------------ *
   * Undo and status
   * ------------------------------------------------------------------ */

  /**
   * Undo a change by restoring the item version before it.
   * @param args - `{ change }`.
   * @param context - `{ actor }`.
   * @returns result.
   */
  async undo(args, context = { actor: 'command' }) {
    return this.store.serial(async () => {
      const record = this.store.changelog.find(String(args.change))
      if (record === undefined || typeof record.item !== 'string') throw new GateError('UNKNOWN_CHANGE', `找不到改动 ${args.change}`)
      const now = this.now()
      const versions = this.store.history.list(record.item)
      const before = versions.find(version => version.at < record.at)
      let row
      let detail = ''
      switch (record.op) {
        case 'undo': {
          const original = this.store.changelog.find(record.undoes)
          if (original === undefined) throw new GateError('NO_VERSION', '找不到被撤销的那次改动')
          const after = versions.find(version => version.at >= original.at) ?? versions[0]
          if (after === undefined) throw new GateError('NO_VERSION', '没有可恢复的版本')
          row = this.store.restoreVersion(record.item, after.name)
          detail = `恢复「${original.op}」的结果`
          break
        }
        case 'add': {
          const target = this.graph.item(record.item)
          if (target === undefined) throw new GateError('NO_VERSION', '这条记忆已经不存在了')
          this.store.history.save(record.item, readIfExists(target.path) ?? '', 'before-undo', now)
          this.store.dropItem(record.item)
          detail = '删除这条记忆'
          break
        }
        case 'promote': {
          if (before === undefined) throw new GateError('NO_VERSION', '没有可恢复的版本')
          row = this.store.restoreVersion(record.item, before.name)
          this.store.moveItem(record.item, 'staging')
          this.graph.patchItem(record.item, { status: 'active' })
          detail = '退回预备区'
          break
        }
        case 'dispute': {
          this.graph.patchItem(record.item, { status: 'active', updated_at: now })
          detail = '解除争议标记'
          break
        }
        case 'confirm': {
          this.graph.patchItem(record.item, { confirmed: false, updated_at: now })
          detail = '取消确认'
          break
        }
        case 'link': {
          if (typeof record.to === 'string') this.graph.endEdge({ from: record.item, to: this.graph.canonical(record.to), type: record.type }, now)
          detail = '删除关系'
          break
        }
        case 'unlink': {
          if (typeof record.to === 'string') this.graph.addEdge({ from: record.item, to: this.graph.canonical(record.to), type: record.type, by: context.actor }, now)
          detail = '恢复关系'
          break
        }
        case 'retire':
        case 'supersede':
        case 'forget':
        case 'expire':
        case 'human-delete': {
          if (before === undefined) throw new GateError('NO_VERSION', '这条记忆没有可恢复的版本')
          row = this.store.restoreVersion(record.item, before.name)
          const pool = record.op === 'expire' ? 'staging' : 'memory'
          const target = this.graph.item(record.item)
          if (target !== undefined && target.pool === 'archive') this.store.moveItem(record.item, pool)
          this.graph.patchItem(record.item, { status: 'active' })
          this.graph.removeTombstone(record.item)
          detail = `恢复条目并移回${pool === 'staging' ? '预备区' : '记忆区'}`
          break
        }
        case 'import':
        case 'task':
        case 'restamp':
        case 'move':
        case 'merge':
          throw new GateError('NOT_UNDOABLE', `「${record.op}」类改动不需要撤销`)
        default: {
          // update / human-edit / skill：恢复正文到上一版
          if (before === undefined) throw new GateError('NO_VERSION', '这次改动之前没有可恢复的版本')
          row = this.store.restoreVersion(record.item, before.name)
          detail = '恢复之前的版本'
        }
      }
      const stored = this.store.changelog.append({ op: 'undo', actor: context.actor, item: record.item, undoes: record.change, undid: record.op, detail, path: row?.path ?? record.path }, now)
      this.store.emitChange()
      return { ok: true, change: stored.change, id: record.item, path: row?.path ?? record.path, detail }
    })
  }

  /**
   * Overview for the settings page and the curator.
   * @returns status object.
   */
  status() {
    const counts = this.graph.counts()
    const lastRun = this.graph.get('lastRun')
    const runStartedAt = this.graph.get('runStartedAt')
    return {
      running: runStartedAt !== undefined && this.now() - runStartedAt < 3_600_000,
      root: this.config.root,
      library: this.config.library,
      counts,
      skills: this.graph.items({ pool: 'memory' }).filter(row => row.area === 'skills').length,
      lastRun: lastRun ?? null,
      task: this.graph.get('task') ?? null,
      pendingHumanEdits: this.pendingHumanEdit() === undefined ? 0 : 1,
      imports: this.graph.queuedImports().length,
      recent: this.store.changelog.tail(40)
        .filter(record => !['restamp', 'task', 'import'].includes(record.op))
        .slice(0, 20)
        .map(record => ({
          change: record.change, at: record.at, op: record.op, actor: record.actor, item: record.item,
          title: record.item ? (this.graph.item(record.item)?.title ?? record.title ?? '') : '', path: record.path ?? null,
          hasDiff: typeof record.diff === 'string' && record.diff.length > 0,
          canUndo: ['add', 'update', 'retire', 'supersede', 'forget', 'expire', 'promote', 'dispute', 'confirm', 'link', 'unlink', 'human-edit', 'human-delete', 'skill'].includes(record.op),
          canDiff: ['add', 'update', 'human-edit', 'human-add', 'skill', 'retire', 'forget', 'supersede', 'promote', 'expire', 'dispute', 'confirm'].includes(record.op),
          detail: record.detail ?? record.reason ?? null,
        })),
    }
  }

  /**
   * Diff of one recorded change, for the settings page.
   * @param args - `{ change }`.
   * @returns `{ text }`.
   */
  diffOf(args) {
    const record = this.store.changelog.find(String(args.change))
    if (record === undefined) return { text: '', reason: 'missing' }
    const stateOnly = {
      promote: '转正：从预备区移入记忆区（正文没变）',
      expire: '过期归档：预备区长期未被引用（正文没变）',
      dispute: '标记为有争议（正文没变）',
      confirm: '用户确认了这条记忆（正文没变）',
      resolve: '处理了争议（正文没变）',
      link: '建立了条目间的关系（正文没变）',
      unlink: '删除了条目间的关系（正文没变）',
      move: '文件移动或改名（正文没变）',
      merge: '两个条目合并了（正文没变）',
      restamp: '补上了丢失的 ID 行（正文没变）',
      import: '加入导入队列',
      task: '整理任务的创建/修复记录',
      undo: '撤销了一次改动（看被撤销那条的记录）',
    }
    if (record.op === 'add' || record.op === 'human-add') {
      const row = this.graph.item(record.item)
      if (row === undefined) return { text: '这条记忆已不存在（可能已被撤销删除）。', reason: 'deleted' }
      const file = readIfExists(row.path)
      if (file === undefined) return { text: '文件已不存在。', reason: 'missing-file' }
      return { text: `（新增时的全文）\n${parseItem(file).body}` }
    }
    if (typeof record.diff === 'string' && record.diff.length > 0) return { text: record.diff }
    if (stateOnly[record.op] !== undefined) return { text: stateOnly[record.op], reason: 'no-body-change' }
    const versions = this.store.history.list(record.item)
    const after = versions.find(version => version.at <= record.at + 5)
    const before = versions.find(version => version.at < (after?.at ?? record.at))
    if (after === undefined || before === undefined) {
      if (['retire', 'forget', 'supersede'].includes(record.op)) return { text: '这条记忆被作废了；点「撤销」可以恢复它。', reason: 'retired' }
      return { text: '（这次改动没有记录差异）', reason: 'no-diff' }
    }
    return { text: renderDiff(parseItem(this.store.history.read(record.item, before.name)).body, parseItem(this.store.history.read(record.item, after.name)).body).text }
  }
}

/**
 * Evidence without derived fields, for the changelog.
 * @param evidence - normalized evidence.
 * @returns stored shape.
 */
function strip(evidence) {
  const clean = quote => redact(String(quote ?? ''))
  return (evidence ?? []).map(item => item.kind === 'session'
    ? { kind: 'session', sessionId: item.sessionId, seq: item.seq, quote: clean(item.quote), role: item.role, time: item.time }
    : { kind: 'file', path: item.path, line: item.line, quote: clean(item.quote) })
}

