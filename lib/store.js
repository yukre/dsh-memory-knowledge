/**
 * The store: the single writer of everything under the data root.
 *
 * It owns the Markdown files, the graph database, the search index, the
 * changelog and the version history, and keeps them consistent:
 *
 *   - `scan()` reconciles files with the graph by identity (the id line), not
 *     by path or time: renames and moves keep the id, content edits change only
 *     the fingerprint, copies get a fresh id, hand-merged files alias the second
 *     id to the first, and a missing id line is restored by matching path or
 *     fingerprint.
 *   - Writes go through `writeItem()`, which records the machine fingerprint so
 *     the next scan can tell a person's edit from the plugin's own.
 *   - All mutations run one at a time through `serial()`.
 *
 * @module dsh-memory-knowledge/store
 */

import { readdirSync, statSync, existsSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
import { join, relative, sep, dirname, basename, extname } from 'node:path'
import {
  newId, isId, parseItem, composeItem, stampId, writeAtomic, readIfExists, slugify, fingerprint, essence,
} from './item.js'
import { openGraph } from './graph.js'
import { SearchIndex } from './search.js'
import { Changelog } from './changelog.js'
import { History } from './history.js'
import { renderDiff } from './diff.js'

/** Folders under the library that are not user-visible categories. */
const RESERVED = new Set(['_staging', '_archive', 'skills'])
/** Seconds a hand-touched file must stay unchanged before the id line is restored. */
export const RESTAMP_QUIET_MS = 60_000

/** One data root. */
export class Store {
  /**
   * @param config - resolved config (lib/config.js).
   * @param options - `{ logger, now, sqlite }`; `now` and `sqlite` are test seams.
   */
  constructor(config, options = {}) {
    this.config = config
    this.logger = options.logger ?? { info() {}, warn() {} }
    this.now = options.now ?? (() => Date.now())
    this.sqlite = options.sqlite
    this.index = new SearchIndex()
    this.changelog = new Changelog(config.changelogFile)
    this.history = new History(config.historyDir, config.history)
    this.queue = Promise.resolve()
    this.graph = undefined
    /** Paths written by the plugin in this process → fingerprint, for quick self-write detection. */
    this.ownWrites = new Map()
    /** Pending restamps: path → first-seen-missing time. */
    this.missingIdSince = new Map()
    this.listeners = new Set()
  }

  /** Create directories, open the graph, run the first scan. */
  async open() {
    for (const dir of [this.config.library, this.config.staging, this.config.archive, this.config.skillsDir, this.config.workspace, this.config.meta]) {
      mkdirSync(dir, { recursive: true })
    }
    this.graph = await this.openGraphWithRecovery()
    await this.serial(() => this.scanNow())
    return this
  }

  /**
   * Open the graph database; a corrupt file is renamed aside (kept for
   * inspection) and a fresh one is rebuilt from the Markdown files — the
   * files are the source of truth, the database is derived state.
   * @returns a Graph.
   */
  async openGraphWithRecovery() {
    try {
      return await openGraph(this.config.graphFile, this.sqlite)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!/not a database|database disk image is malformed|CORRUPT/i.test(message)) throw error
      this.logger.warn(`graph database corrupt, rebuilding from files: ${message}`)
      for (const suffix of ['', '-wal', '-shm']) {
        try { renameSync(this.config.graphFile + suffix, `${this.config.graphFile}${suffix}.corrupt-${Date.now()}`) } catch { /* nothing to move */ }
      }
      return openGraph(this.config.graphFile, this.sqlite)
    }
  }

  /** Close the graph. */
  close() {
    this.graph?.close()
    this.graph = undefined
  }

  /**
   * Run mutations one at a time.
   * @param fn - synchronous or async work.
   * @returns its result.
   */
  serial(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Subscribe to "library changed" (snapshot inputs may have changed).
   * @param fn - listener.
   * @returns unsubscribe.
   */
  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Notify listeners; errors are contained. */
  emitChange() {
    for (const fn of this.listeners) {
      try { fn() } catch (error) { this.logger.warn(`memory-knowledge: change listener failed: ${error?.message ?? error}`) }
    }
  }

  /* ------------------------------------------------------------------ *
   * Location helpers
   * ------------------------------------------------------------------ */

  /**
   * Pool and area of a file path inside the library.
   * @param path - absolute path.
   * @returns `{ pool, area, kind }` or undefined when the path is not an item.
   */
  classify(path) {
    const rel = relative(this.config.library, path)
    if (rel.startsWith('..') || rel === '') return undefined
    const parts = rel.split(sep)
    if (parts[0] === 'skills') {
      if (parts.length === 3 && parts[2] === 'SKILL.md') return { pool: 'memory', area: 'skills', kind: 'skill' }
      return undefined
    }
    if (!path.endsWith('.md') || basename(path) === 'README.md' || basename(path).startsWith('.')) return undefined
    if (parts[0] === '_staging') return { pool: 'staging', area: parts.length > 2 ? parts[1] : '', kind: 'item' }
    if (parts[0] === '_archive') return { pool: 'archive', area: parts.length > 2 ? parts[1] : '', kind: 'item' }
    return { pool: 'memory', area: parts.length > 1 ? parts[0] : '', kind: 'item' }
  }

  /**
   * Every item-candidate file under the library (skips dot folders).
   * @returns absolute paths.
   */
  listFiles() {
    const out = []
    const walk = dir => {
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && this.classify(full) !== undefined) out.push(full)
      }
    }
    walk(this.config.library)
    return out
  }

  /**
   * A free path for a new item in a pool and area.
   * @param pool - 'memory' | 'staging' | 'archive'.
   * @param area - category folder; '' = library root (discouraged).
   * @param title - item title.
   * @param exclude - path that may be reused (the item's own current path).
   * @returns absolute path.
   */
  pathFor(pool, area, title, exclude) {
    const base = pool === 'staging' ? this.config.staging : pool === 'archive' ? this.config.archive : this.config.library
    const folder = area ? join(base, area) : base
    const slug = slugify(title)
    let candidate = join(folder, `${slug}.md`)
    for (let n = 2; existsSync(candidate) && candidate !== exclude; n++) candidate = join(folder, `${slug}-${n}.md`)
    return candidate
  }

  /* ------------------------------------------------------------------ *
   * Scan: reconcile files with the graph
   * ------------------------------------------------------------------ */

  /** Public, serialized scan. */
  scan() {
    return this.serial(() => this.scanNow())
  }

  /**
   * Reconcile every file with the graph. Never rewrites an item body; the only
   * file write is restoring a missing identity line after a quiet period.
   * @returns a summary of what changed.
   */
  scanNow() {
    const now = this.now()
    const graph = this.graph
    const summary = { added: [], edited: [], moved: [], deleted: [], restamped: [], copies: [], merged: [] }
    const files = this.listFiles()
    const claimed = new Map()
    const seenIds = new Set()

    // Pass 1: files that carry an identity.
    const unidentified = []
    for (const path of files) {
      const where = this.classify(path)
      const text = readIfExists(path)
      if (text === undefined || where === undefined) continue
      const parsed = parseItem(text, where.kind)
      if (parsed.ids.length === 0) { unidentified.push({ path, where, parsed, text }); continue }
      const [first, ...others] = parsed.ids.map(id => graph.canonical(id))
      // A hand-merged file: later ids become aliases of the first.
      for (const other of others) {
        if (other !== first && graph.item(other) !== undefined) {
          graph.addAlias(other, first)
          this.changelog.append({ op: 'merge', actor: 'human', item: first, alias: other, path }, now)
          summary.merged.push({ id: first, alias: other })
        }
      }
      // A copy: the same id already claimed by another path this scan, or the
      // graph knows the id at another existing path.
      const known = graph.item(first)
      const copyOf = claimed.get(first)
        ?? (known !== undefined && known.path !== path && existsSync(known.path) && files.includes(known.path) ? known.path : undefined)
      if (copyOf !== undefined && copyOf !== path) {
        unidentified.push({ path, where, parsed, text, copyOf: first })
        continue
      }
      claimed.set(first, path)
      seenIds.add(first)
      this.reconcileIdentified(first, path, where, parsed, text, now, summary)
    }

    // Pass 2: files without an identity (new, copied, or id line deleted).
    for (const entry of unidentified) {
      const { path, where, parsed, text } = entry
      if (entry.copyOf === undefined) {
        // Same path as a known item, or same content as a vanished one → restore its id.
        const byPath = graph.itemByPath(path)
        const byFp = byPath === undefined
          ? graph.itemsByFingerprint(parsed.fingerprint).find(row => !seenIds.has(row.id) && !files.includes(row.path))
          : undefined
        const recovered = byPath ?? byFp
        if (recovered !== undefined && !seenIds.has(recovered.id)) {
          seenIds.add(recovered.id)
          claimed.set(recovered.id, path)
          this.reconcileIdentified(recovered.id, path, where, parsed, text, now, summary)
          this.scheduleRestamp(path, recovered.id, now, summary)
          continue
        }
      }
      // The same path already has a record whose id was not claimed by an
      // identity line this scan: the file was rewritten in place (a person
      // replaced its whole content), so it is that item's edit, not a new item.
      const byPath = graph.itemByPath(path)
      if (byPath !== undefined && !seenIds.has(byPath.id)) {
        seenIds.add(byPath.id)
        claimed.set(byPath.id, path)
        this.reconcileIdentified(byPath.id, path, where, parsed, text, now, summary)
        this.scheduleRestamp(path, byPath.id, now, summary)
        continue
      }
      // Genuinely new (or a copy): a fresh id, owned by the person.
      const id = this.freshId()
      const row = {
        id, path, pool: where.pool, status: 'active', kind: where.kind === 'skill' ? 'method' : 'fact', area: where.area,
        title: parsed.title, whenuse: parsed.when, fingerprint: parsed.fingerprint, machine_fingerprint: '',
        created_at: now, updated_at: now, human_at: now, source_sessions: [], confirmed: false, last_loaded: null,
      }
      graph.putItem(row)
      seenIds.add(id)
      claimed.set(id, path)
      this.indexItem(row, parsed.body)
      this.history.save(id, text, 'human', now)
      this.changelog.append({ op: entry.copyOf ? 'adopt-copy' : 'human-add', actor: 'human', item: id, path, from: entry.copyOf }, now)
      ;(entry.copyOf ? summary.copies : summary.added).push(id)
      this.scheduleRestamp(path, id, now, summary)
    }

    // Pass 3: items whose file is gone → human delete (tombstone).
    for (const row of graph.items()) {
      if (seenIds.has(row.id)) continue
      if (existsSync(row.path)) continue
      const lastText = this.history.read(row.id) ?? ''
      graph.addTombstone({ id: row.id, fingerprint: row.fingerprint, title: row.title, text: essence(row.title, parseItem(lastText).body), reason: 'human-delete' }, now)
      for (const edge of graph.neighbors(row.id)) {
        const from = edge.direction === 'out' ? row.id : edge.other
        const to = edge.direction === 'out' ? edge.other : row.id
        graph.endEdge({ from, to, type: edge.type }, now)
      }
      graph.deleteItem(row.id)
      this.index.remove(row.id)
      this.changelog.append({ op: 'human-delete', actor: 'human', item: row.id, path: row.path, title: row.title }, now)
      summary.deleted.push(row.id)
    }

    const changed = Object.values(summary).some(list => list.length > 0)
    if (changed) this.emitChange()
    return summary
  }

  /**
   * Reconcile one file whose identity is known.
   * @param id - canonical id.
   * @param path - current path.
   * @param where - classification.
   * @param parsed - parsed file.
   * @param text - file text.
   * @param now - timestamp.
   * @param summary - scan summary to append to.
   */
  reconcileIdentified(id, path, where, parsed, text, now, summary) {
    const graph = this.graph
    const row = graph.item(id)
    if (row === undefined) {
      // An id the graph never saw (graph rebuilt or file brought from elsewhere).
      const fresh = {
        id, path, pool: where.pool, status: 'active', kind: where.kind === 'skill' ? 'method' : 'fact', area: where.area,
        title: parsed.title, whenuse: parsed.when, fingerprint: parsed.fingerprint, machine_fingerprint: parsed.fingerprint,
        created_at: now, updated_at: now, human_at: null, source_sessions: [], confirmed: false, last_loaded: null,
      }
      graph.putItem(fresh)
      this.indexItem(fresh, parsed.body)
      if (this.history.list(id).length === 0) this.history.save(id, text, 'machine', now)
      return
    }
    const patch = {}
    if (row.path !== path) {
      patch.path = path
      patch.pool = where.pool
      patch.area = where.area
      this.changelog.append({ op: 'move', actor: 'human', item: id, from: row.path, path }, now)
      summary.moved.push(id)
    }
    if (row.fingerprint !== parsed.fingerprint) {
      const self = parsed.fingerprint === row.machine_fingerprint || this.ownWrites.get(path) === parsed.fingerprint
      if (!self) {
        const baseline = this.history.read(id)
        const diff = baseline === undefined ? undefined : renderDiff(parseItem(baseline, where.kind).body, parsed.body)
        this.history.save(id, text, 'human', now)
        patch.human_at = now
        const flagged = graph.flagEdgesForReview(id)
        this.changelog.append({
          op: 'human-edit', actor: 'human', item: id, path,
          before: row.fingerprint, after: parsed.fingerprint,
          diff: diff?.rewrite ? undefined : diff?.text, rewrite: diff?.rewrite === true,
          added: diff?.added, removed: diff?.removed, edgesFlagged: flagged, pending: true,
        }, now)
        summary.edited.push(id)
      }
      patch.fingerprint = parsed.fingerprint
      patch.title = parsed.title
      patch.whenuse = parsed.when
      patch.updated_at = now
    }
    if (Object.keys(patch).length > 0) graph.patchItem(id, patch)
    const current = graph.item(id)
    this.indexItem(current, parsed.body)
  }

  /**
   * Restore a missing identity line once the file has been quiet long enough,
   * so the person is not fighting the plugin mid-edit.
   * @param path - file path.
   * @param id - identity to stamp.
   * @param now - timestamp.
   * @param summary - scan summary.
   */
  scheduleRestamp(path, id, now, summary) {
    let mtime
    try { mtime = statSync(path).mtimeMs } catch { return }
    if (now - mtime < RESTAMP_QUIET_MS) {
      this.missingIdSince.set(path, mtime)
      return
    }
    const where = this.classify(path)
    if (where === undefined || where.kind === 'skill') return
    const text = readIfExists(path)
    if (text === undefined) return
    const stamped = stampId(text, id)
    const fp = parseItem(stamped).fingerprint
    // Restamping is not an edit: the body fingerprint is unchanged.
    writeAtomic(path, stamped)
    this.ownWrites.set(path, fp)
    this.missingIdSince.delete(path)
    this.changelog.append({ op: 'restamp', actor: 'plugin', item: id, path }, now)
    summary.restamped.push(id)
  }

  /** @returns an id not used by any item or alias. */
  freshId() {
    for (;;) {
      const id = newId()
      if (this.graph.item(id) === undefined) return id
    }
  }

  /**
   * Add or refresh an item in the search index. Archived items are indexed too;
   * recall filters them out unless the archive is requested.
   * @param row - item row.
   * @param body - item body text.
   */
  indexItem(row, body) {
    if (row === undefined) return
    this.index.put(row.id, { title: row.title, when: row.whenuse, area: row.area, body })
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

  /**
   * Read an item's current file.
   * @param id - item id or alias.
   * @returns `{ row, text, parsed }` or undefined.
   */
  read(id) {
    const row = this.graph.item(id)
    if (row === undefined) return undefined
    const text = readIfExists(row.path)
    if (text === undefined) return undefined
    return { row, text, parsed: parseItem(text, row.kind === 'method' && row.area === 'skills' ? 'skill' : 'item') }
  }

  /**
   * First-level categories with their item counts and descriptions.
   * @returns `{ area, count, description }[]` sorted by name.
   */
  areas() {
    const counts = new Map()
    for (const row of this.graph.items({ pool: 'memory' })) {
      if (!row.area || row.area === 'skills' || RESERVED.has(row.area)) continue
      counts.set(row.area, (counts.get(row.area) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([area, count]) => ({ area, count, description: this.areaDescription(area) }))
      .sort((a, b) => a.area.localeCompare(b.area, 'zh'))
  }

  /**
   * A category's one-line description: the `> ` line of its README, written
   * once by the curator and then owned by the person.
   * @param area - folder name.
   * @returns description or ''.
   */
  areaDescription(area) {
    const text = readIfExists(join(this.config.library, area, 'README.md'))
    if (text === undefined) return ''
    return /^>\s*(.+?)\s*$/m.exec(text)?.[1] ?? ''
  }

  /* ------------------------------------------------------------------ *
   * Writes (machine)
   * ------------------------------------------------------------------ */

  /**
   * Write an item file and record it as a machine version. Refuses to clobber
   * content that changed since `baseFingerprint` (optimistic concurrency).
   * @param row - full item row to store (id, path, pool, …).
   * @param parts - `{ title, when, body }`.
   * @param options - `{ baseFingerprint, actor, op, meta }`.
   * @returns the stored row.
   */
  writeItem(row, parts, options = {}) {
    const now = this.now()
    if (!isId(row.id)) throw new Error(`invalid id ${row.id}`)
    const existing = this.graph.item(row.id)
    if (existing !== undefined && existsSync(existing.path)) {
      const onDisk = parseItem(readIfExists(existing.path) ?? '')
      if (options.baseFingerprint !== undefined && onDisk.fingerprint !== options.baseFingerprint) {
        const error = new Error('STALE_BASE')
        error.code = 'STALE_BASE'
        throw error
      }
    }
    const text = composeItem({ id: row.id, title: parts.title, when: parts.when, body: parts.body })
    const parsed = parseItem(text)
    if (existing !== undefined && existing.path !== row.path && existsSync(existing.path)) {
      mkdirSync(dirname(row.path), { recursive: true })
      renameSync(existing.path, row.path)
    }
    writeAtomic(row.path, text)
    this.ownWrites.set(row.path, parsed.fingerprint)
    const stored = {
      ...existing, ...row,
      title: parsed.title, whenuse: parsed.when,
      fingerprint: parsed.fingerprint, machine_fingerprint: parsed.fingerprint,
      created_at: existing?.created_at ?? now, updated_at: now,
    }
    this.graph.putItem(stored)
    this.history.save(row.id, text, 'machine', now)
    this.indexItem(stored, parsed.body)
    this.writeAreaReadme(stored.pool === 'memory' ? stored.area : undefined)
    this.emitChange()
    return stored
  }

  /**
   * Move an item between pools or areas without changing its body.
   * @param id - item id.
   * @param pool - target pool.
   * @param area - target area (defaults to current).
   * @returns the updated row.
   */
  moveItem(id, pool, area) {
    const now = this.now()
    const row = this.graph.item(id)
    if (row === undefined) throw new Error(`unknown item ${id}`)
    const targetArea = area ?? row.area
    const target = this.pathFor(pool, targetArea, row.title, row.path)
    if (target !== row.path) {
      mkdirSync(dirname(target), { recursive: true })
      renameSync(row.path, target)
    }
    const text = readIfExists(target) ?? ''
    const fp = parseItem(text).fingerprint
    this.ownWrites.set(target, fp)
    this.graph.patchItem(id, { path: target, pool, area: targetArea, updated_at: now })
    // Archived items stay indexed; recall hides them unless asked for the archive.
    this.indexItem(this.graph.item(id), parseItem(text).body)
    this.writeAreaReadme(row.pool === 'memory' ? row.area : undefined)
    if (pool === 'memory') this.writeAreaReadme(targetArea)
    this.emitChange()
    return this.graph.item(id)
  }

  /**
   * Restore an item to a stored version.
   * @param id - item id.
   * @param versionName - history version name; omitted = the previous version.
   * @returns the restored row.
   */
  restoreVersion(id, versionName) {
    const now = this.now()
    const row = this.graph.item(id)
    const versions = this.history.list(id)
    if (versions.length === 0) throw new Error(`no history for ${id}`)
    const target = versionName ?? versions[1]?.name ?? versions[0].name
    const text = this.history.read(id, target)
    if (text === undefined) throw new Error(`unknown version ${target}`)
    let path = row?.path
    if (path === undefined) {
      // A deleted item: bring it back under its last known area as a memory.
      const parsed = parseItem(text)
      path = this.pathFor('memory', '', parsed.title)
    }
    const current = readIfExists(path)
    if (current !== undefined) this.history.save(id, current, 'before-undo', now)
    const stamped = stampId(text, id)
    writeAtomic(path, stamped)
    const parsed = parseItem(stamped)
    this.ownWrites.set(path, parsed.fingerprint)
    const where = this.classify(path) ?? { pool: 'memory', area: '', kind: 'item' }
    this.graph.putItem({
      ...(row ?? { id, created_at: now, source_sessions: [], confirmed: false, human_at: null, last_loaded: null, kind: 'fact', status: 'active' }),
      path, pool: where.pool, area: where.area,
      title: parsed.title, whenuse: parsed.when, fingerprint: parsed.fingerprint, machine_fingerprint: parsed.fingerprint, updated_at: now,
    })
    this.graph.removeTombstone(id)
    this.indexItem(this.graph.item(id), parsed.body)
    this.emitChange()
    return this.graph.item(id)
  }

  /**
   * Regenerate one category README: title, the person's description line (kept
   * as is), then a table of items. Only the table is machine-owned.
   * @param area - folder name; undefined is a no-op.
   */
  writeAreaReadme(area) {
    if (!area || RESERVED.has(area)) return
    const folder = join(this.config.library, area)
    if (!existsSync(folder)) return
    const rows = this.graph.items({ pool: 'memory' }).filter(row => row.area === area && row.kind !== 'method')
    const previous = readIfExists(join(folder, 'README.md'))
    const description = previous === undefined ? '' : (/^>\s*(.+?)\s*$/m.exec(previous)?.[1] ?? '')
    const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
    const lines = [`# ${area}`, '']
    if (description) lines.push(`> ${description}`, '')
    lines.push('| 文件 | 内容 | 何时用 |', '|---|---|---|')
    for (const row of rows.sort((a, b) => a.title.localeCompare(b.title, 'zh'))) {
      const file = relative(folder, row.path)
      lines.push(`| [${cell(file)}](<${file}>) | ${cell(row.title)} | ${cell(row.whenuse)} |`)
    }
    writeAtomic(join(folder, 'README.md'), `${lines.join('\n')}\n`)
  }

  /**
   * Remove an item file and its row (machine retire into archive is preferred;
   * this is for undoing a machine add).
   * @param id - item id.
   */
  dropItem(id) {
    const row = this.graph.item(id)
    if (row === undefined) return
    try { unlinkSync(row.path) } catch { /* already gone */ }
    this.graph.deleteItem(id)
    this.index.remove(id)
    this.emitChange()
  }
}

/**
 * Fingerprint of a file's body on disk, or undefined when it is missing.
 * @param path - file path.
 * @returns hex digest.
 */
export function fileFingerprint(path) {
  const text = readIfExists(path)
  return text === undefined ? undefined : parseItem(text, extname(path) === '.md' && basename(path) === 'SKILL.md' ? 'skill' : 'item').fingerprint
}

export { fingerprint }
