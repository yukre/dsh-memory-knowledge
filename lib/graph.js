/**
 * Relation graph and item state on SQLite (`node:sqlite`, bundled with the DSH
 * runtime — DSH's own session search uses it).
 *
 * Markdown files are the source of truth for content; this database holds what
 * a file cannot carry without becoming heavy: pool and status, the relation
 * edges keyed on item ids, citation votes, tombstones, curation progress and
 * the scheduled-task identity. Everything here can be rebuilt from the files
 * plus the changelog, so a lost or corrupt database is an inconvenience, not
 * data loss.
 *
 * @module dsh-memory-knowledge/graph
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Relation types; see the plan's tree + graph section. */
export const EDGE_TYPES = Object.freeze(['supersedes', 'refines', 'depends-on', 'contradicts', 'related', 'derived-from'])
/** Maximum live edges touching one item. */
export const MAX_EDGES_PER_ITEM = 12

const SCHEMA_VERSION = 1

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  pool TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  kind TEXT NOT NULL DEFAULT 'fact',
  area TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  whenuse TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL DEFAULT '',
  machine_fingerprint TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  human_at INTEGER,
  source_sessions TEXT NOT NULL DEFAULT '[]',
  confirmed INTEGER NOT NULL DEFAULT 0,
  last_loaded INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS items_path ON items(path);
CREATE INDEX IF NOT EXISTS items_pool ON items(pool, status);
CREATE TABLE IF NOT EXISTS edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  type TEXT NOT NULL,
  by TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  review INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id);
CREATE TABLE IF NOT EXISTS aliases (alias_id TEXT PRIMARY KEY, id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uses (
  item_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  verdict TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, session_id)
);
CREATE TABLE IF NOT EXISTS tombstones (
  id TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS progress (session_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS imports (
  path TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL,
  chunk INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`

/**
 * Open (or create) the graph database.
 * @param file - database path.
 * @param sqlite - the `node:sqlite` module, injectable for tests.
 * @returns a Graph instance.
 */
export async function openGraph(file, sqlite) {
  const mod = sqlite ?? await import('node:sqlite')
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new mod.DatabaseSync(file)
  // busy_timeout first: switching to WAL takes a write lock, and with the
  // timeout still at its 0 default a concurrent open fails instantly with
  // SQLITE_BUSY instead of waiting. The window is small but real — every session
  // in the host opens this file.
  db.exec('PRAGMA busy_timeout = 3000;')
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(DDL)
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema')
  if (row === undefined) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema', String(SCHEMA_VERSION))
  return new Graph(db)
}

/** Thin, synchronous wrapper; every write path stays inside one process. */
export class Graph {
  /** @param db - an open DatabaseSync. */
  constructor(db) {
    this.db = db
    this.statements = new Map()
  }

  /**
   * Cached prepared statement.
   * @param sql - statement text.
   * @returns prepared statement.
   */
  sql(sql) {
    let statement = this.statements.get(sql)
    if (statement === undefined) {
      statement = this.db.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  /**
   * Run a function inside a transaction.
   * @param fn - work; its return value is passed through.
   * @returns fn's result.
   */
  transaction(fn) {
    this.db.exec('BEGIN')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw error
    }
  }

  /** Close the database. */
  close() {
    try { this.db.close() } catch { /* already closed */ }
  }

  /* ---------------- items ---------------- */

  /**
   * @param id - item id or alias.
   * @returns the canonical id, following one alias hop.
   */
  canonical(id) {
    const alias = this.sql('SELECT id FROM aliases WHERE alias_id = ?').get(id)
    return alias === undefined ? id : alias.id
  }

  /**
   * @param id - item id (aliases resolved).
   * @returns the item row or undefined.
   */
  item(id) {
    return decodeItem(this.sql('SELECT * FROM items WHERE id = ?').get(this.canonical(id)))
  }

  /**
   * @param path - absolute file path.
   * @returns the item row or undefined.
   */
  itemByPath(path) {
    return decodeItem(this.sql('SELECT * FROM items WHERE path = ?').get(path))
  }

  /**
   * @param fp - content fingerprint.
   * @returns rows whose current fingerprint matches.
   */
  itemsByFingerprint(fp) {
    return this.sql('SELECT * FROM items WHERE fingerprint = ?').all(fp).map(decodeItem)
  }

  /**
   * @param filter - optional `{ pool, status }`.
   * @returns matching rows.
   */
  items(filter = {}) {
    const clauses = []
    const values = []
    if (filter.pool !== undefined) { clauses.push('pool = ?'); values.push(filter.pool) }
    if (filter.status !== undefined) { clauses.push('status = ?'); values.push(filter.status) }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
    return this.db.prepare(`SELECT * FROM items${where} ORDER BY updated_at DESC`).all(...values).map(decodeItem)
  }

  /**
   * Insert or replace an item row.
   * @param row - full item row.
   */
  putItem(row) {
    this.sql(`INSERT INTO items (id, path, pool, status, kind, area, title, whenuse, fingerprint, machine_fingerprint,
        created_at, updated_at, human_at, source_sessions, confirmed, last_loaded)
      VALUES (@id, @path, @pool, @status, @kind, @area, @title, @whenuse, @fingerprint, @machine_fingerprint,
        @created_at, @updated_at, @human_at, @source_sessions, @confirmed, @last_loaded)
      ON CONFLICT(id) DO UPDATE SET path=excluded.path, pool=excluded.pool, status=excluded.status, kind=excluded.kind,
        area=excluded.area, title=excluded.title, whenuse=excluded.whenuse, fingerprint=excluded.fingerprint,
        machine_fingerprint=excluded.machine_fingerprint, updated_at=excluded.updated_at, human_at=excluded.human_at,
        source_sessions=excluded.source_sessions, confirmed=excluded.confirmed, last_loaded=excluded.last_loaded`)
      .run(encodeItem(row))
  }

  /**
   * Patch selected columns of one item.
   * @param id - item id.
   * @param patch - columns to change.
   */
  patchItem(id, patch) {
    const current = this.item(id)
    if (current === undefined) throw new Error(`unknown item ${id}`)
    this.putItem({ ...current, ...patch })
  }

  /**
   * Remove an item row (its file is gone and it has been recorded as such).
   * @param id - item id.
   */
  /**
   * Drop rows that point at items no longer present.
   *
   * Any delete that happened before the cascade was written leaves these behind,
   * and they are invisible until something joins on them: a vote count silently
   * including a missing item, or an edge pointing nowhere. Cheap to run and safe
   * to repeat, so open() calls it once.
   * @returns `{ uses, edges, aliases }` counts removed.
   */
  pruneOrphans() {
    const uses = Number(this.sql('DELETE FROM uses WHERE item_id NOT IN (SELECT id FROM items)').run().changes)
    const edges = Number(this.sql('DELETE FROM edges WHERE from_id NOT IN (SELECT id FROM items) OR to_id NOT IN (SELECT id FROM items)').run().changes)
    const aliases = Number(this.sql('DELETE FROM aliases WHERE id NOT IN (SELECT id FROM items)').run().changes)
    return { uses, edges, aliases }
  }

  /**
   * Remove an item and everything that referenced it.
   *
   * Deleting the items row alone leaves dangling edges, uses and aliases behind:
   * the graph would keep pointing at a title that no longer exists, and relation
   * lookups would return ghosts. Release deletes the item outright, so the
   * cleanup has to reach every table that names it.
   * @param id - item id.
   */
  deleteItem(id) {
    this.sql('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id)
    this.sql('DELETE FROM uses WHERE item_id = ?').run(id)
    this.sql('DELETE FROM aliases WHERE id = ? OR alias_id = ?').run(id, id)
    this.sql('DELETE FROM items WHERE id = ?').run(id)
  }

  /**
   * Record that `aliasId` now means `id` (two items merged into one file).
   * Edges pointing at the alias move to the surviving id.
   * @param aliasId - retired id.
   * @param id - surviving id.
   */
  addAlias(aliasId, id) {
    this.transaction(() => {
      this.sql('INSERT OR REPLACE INTO aliases(alias_id, id) VALUES (?, ?)').run(aliasId, id)
      for (const edge of this.sql('SELECT * FROM edges WHERE from_id = ? OR to_id = ?').all(aliasId, aliasId)) {
        const from = edge.from_id === aliasId ? id : edge.from_id
        const to = edge.to_id === aliasId ? id : edge.to_id
        this.sql('DELETE FROM edges WHERE from_id = ? AND to_id = ? AND type = ?').run(edge.from_id, edge.to_id, edge.type)
        if (from !== to) {
          this.sql(`INSERT OR IGNORE INTO edges(from_id, to_id, type, by, evidence, created_at, ended_at, review)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(from, to, edge.type, edge.by, edge.evidence, edge.created_at, edge.ended_at, edge.review)
        }
      }
      this.sql('DELETE FROM items WHERE id = ?').run(aliasId)
    })
  }

  /* ---------------- edges ---------------- */

  /**
   * @param id - item id.
   * @returns number of live edges touching it.
   */
  edgeCount(id) {
    return this.sql('SELECT COUNT(*) AS n FROM edges WHERE ended_at IS NULL AND (from_id = ? OR to_id = ?)').get(id, id).n
  }

  /**
   * Live edges touching an item, with the neighbor's id and direction.
   * @param id - item id.
   * @returns `{ type, direction: 'out'|'in', other, by, review }[]`.
   */
  neighbors(id) {
    const canonical = this.canonical(id)
    const rows = this.sql('SELECT * FROM edges WHERE ended_at IS NULL AND (from_id = ? OR to_id = ?)').all(canonical, canonical)
    return rows.map(row => ({
      type: row.type,
      direction: row.from_id === canonical ? 'out' : 'in',
      other: row.from_id === canonical ? row.to_id : row.from_id,
      by: row.by,
      review: row.review === 1,
    }))
  }

  /**
   * Add a live edge. Callers validate type, endpoints and caps first (gate.js).
   * @param edge - `{ from, to, type, by, evidence }`.
   * @param now - timestamp.
   */
  addEdge({ from, to, type, by, evidence = '' }, now) {
    this.sql(`INSERT INTO edges(from_id, to_id, type, by, evidence, created_at, ended_at, review)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT(from_id, to_id, type) DO UPDATE SET ended_at = NULL, review = 0, by = excluded.by, evidence = excluded.evidence`)
      .run(from, to, type, by, evidence, now)
  }

  /**
   * End a live edge (kept for history, ignored by reads).
   * @param edge - `{ from, to, type }`.
   * @param now - timestamp.
   */
  endEdge({ from, to, type }, now) {
    this.sql('UPDATE edges SET ended_at = ? WHERE from_id = ? AND to_id = ? AND type = ? AND ended_at IS NULL').run(now, from, to, type)
  }

  /**
   * Flag every live edge of an item for review (its content changed).
   * @param id - item id.
   * @returns number of edges flagged.
   */
  flagEdgesForReview(id) {
    return Number(this.sql('UPDATE edges SET review = 1 WHERE ended_at IS NULL AND (from_id = ? OR to_id = ?)').run(id, id).changes)
  }

  /**
   * Clear the review flag on one edge.
   * @param edge - `{ from, to, type }`.
   */
  clearReview({ from, to, type }) {
    this.sql('UPDATE edges SET review = 0 WHERE from_id = ? AND to_id = ? AND type = ?').run(from, to, type)
  }

  /**
   * @param id - item id.
   * @returns live edges of the item still flagged for review.
   */
  pendingEdges(id) {
    return this.sql('SELECT * FROM edges WHERE ended_at IS NULL AND review = 1 AND (from_id = ? OR to_id = ?)').all(id, id)
      .map(row => ({ from: row.from_id, to: row.to_id, type: row.type }))
  }

  /**
   * Whether following `supersedes` edges from `to` reaches `from` (a cycle).
   * @param from - would-be superseding item.
   * @param to - would-be superseded item.
   * @returns true when adding from→to would close a cycle.
   */
  supersedesCycle(from, to) {
    const seen = new Set()
    const stack = [to]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === from) return true
      if (seen.has(current)) continue
      seen.add(current)
      for (const row of this.sql("SELECT to_id FROM edges WHERE ended_at IS NULL AND type = 'supersedes' AND from_id = ?").all(current)) {
        stack.push(row.to_id)
      }
    }
    return false
  }

  /* ---------------- uses (citation votes) ---------------- */

  /**
   * Record that a session cited an item; one row per (item, session).
   * @param use - `{ itemId, sessionId, seq }`.
   * @param now - timestamp.
   * @returns whether a new row was created.
   */
  addUse({ itemId, sessionId, seq }, now) {
    const result = this.sql('INSERT OR IGNORE INTO uses(item_id, session_id, seq, verdict, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(itemId, sessionId, seq, 'pending', now)
    return Number(result.changes) > 0
  }

  /**
   * @param itemId - item id.
   * @param sessionId - session id.
   * @param verdict - 'accepted' | 'challenged' | 'excluded'.
   */
  setUseVerdict(itemId, sessionId, verdict) {
    this.sql('UPDATE uses SET verdict = ? WHERE item_id = ? AND session_id = ?').run(verdict, itemId, sessionId)
  }

  /**
   * @param itemId - item id.
   * @returns vote rows of the item.
   */
  uses(itemId) {
    return this.sql('SELECT * FROM uses WHERE item_id = ?').all(itemId)
  }

  /**
   * @returns pending vote rows across all items.
   */
  pendingUses() {
    return this.sql("SELECT * FROM uses WHERE verdict = 'pending' ORDER BY created_at").all()
  }

  /* ---------------- tombstones ---------------- */

  /**
   * @param stone - `{ id, fingerprint, title, text, reason }`.
   * @param now - retirement time.
   */
  addTombstone({ id, fingerprint, title = '', text = '', reason = '' }, now) {
    this.sql('INSERT OR REPLACE INTO tombstones(id, retired_at, fingerprint, title, text, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, now, fingerprint, title, text.slice(0, 4000), reason)
  }

  /**
   * @param id - item id.
   */
  removeTombstone(id) {
    this.sql('DELETE FROM tombstones WHERE id = ?').run(id)
  }

  /** @returns every tombstone. */
  tombstones() {
    return this.sql('SELECT * FROM tombstones').all()
  }

  /* ---------------- progress / imports / kv ---------------- */

  /**
   * @param sessionId - session id.
   * @returns last processed seq, or 0.
   */
  progress(sessionId) {
    return this.sql('SELECT seq FROM progress WHERE session_id = ?').get(sessionId)?.seq ?? 0
  }

  /**
   * @param sessionId - session id.
   * @param seq - processed through this seq.
   * @param now - timestamp.
   */
  setProgress(sessionId, seq, now) {
    this.sql(`INSERT INTO progress(session_id, seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET seq = MAX(seq, excluded.seq), updated_at = excluded.updated_at`).run(sessionId, seq, now)
  }

  /**
   * @param key - setting key.
   * @returns parsed JSON value or undefined.
   */
  get(key) {
    const row = this.sql('SELECT value FROM kv WHERE key = ?').get(key)
    if (row === undefined) return undefined
    try { return JSON.parse(row.value) } catch { return undefined }
  }

  /**
   * @param key - setting key.
   * @param value - JSON-serializable value; undefined deletes.
   */
  set(key, value) {
    if (value === undefined) this.sql('DELETE FROM kv WHERE key = ?').run(key)
    else this.sql('INSERT OR REPLACE INTO kv(key, value) VALUES (?, ?)').run(key, JSON.stringify(value))
  }

  /**
   * Delete prefixed kv entries whose stored `at` is older than a cutoff.
   * @param prefix - key prefix.
   * @param cutoff - timestamp; entries with `at` before it are removed.
   * @returns number removed.
   */
  pruneKv(prefix, cutoff) {
    let removed = 0
    for (const row of this.sql('SELECT key, value FROM kv WHERE key LIKE ?').all(`${prefix}%`)) {
      let at = 0
      try { at = Number(JSON.parse(row.value)?.at) || 0 } catch { at = 0 }
      if (at < cutoff) { this.sql('DELETE FROM kv WHERE key = ?').run(row.key); removed++ }
    }
    return removed
  }

  /**
   * @param entry - `{ path, fingerprint, state, chunk, chunks }`.
   * @param now - timestamp.
   */
  putImport(entry, now) {
    this.sql(`INSERT INTO imports(path, fingerprint, state, chunk, chunks, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET fingerprint = excluded.fingerprint, state = excluded.state, chunk = excluded.chunk,
        chunks = excluded.chunks, updated_at = excluded.updated_at`)
      .run(entry.path, entry.fingerprint, entry.state, entry.chunk ?? 0, entry.chunks ?? 1, now)
  }

  /**
   * @param path - source file path.
   * @returns import row or undefined.
   */
  importEntry(path) {
    return this.sql('SELECT * FROM imports WHERE path = ?').get(path)
  }

  /** @returns import rows still queued, oldest first. */
  queuedImports() {
    return this.sql("SELECT * FROM imports WHERE state = 'queued' ORDER BY updated_at").all()
  }

  /** @returns counts per pool and status. */
  counts() {
    const rows = this.sql('SELECT pool, status, COUNT(*) AS n FROM items GROUP BY pool, status').all()
    const out = { memory: 0, staging: 0, archive: 0, disputed: 0 }
    for (const row of rows) {
      if (row.pool in out) out[row.pool] += row.n
      if (row.status === 'disputed') out.disputed += row.n
    }
    return out
  }
}

/**
 * @param row - raw database row.
 * @returns row with JSON columns decoded, or undefined.
 */
function decodeItem(row) {
  if (row === undefined || row === null) return undefined
  let sources = []
  try { sources = JSON.parse(row.source_sessions) } catch { sources = [] }
  return { ...row, source_sessions: Array.isArray(sources) ? sources : [], confirmed: row.confirmed === 1 }
}

/**
 * @param row - item row.
 * @returns row with JSON columns encoded and nullable fields normalized.
 */
function encodeItem(row) {
  return {
    id: row.id,
    path: row.path,
    pool: row.pool,
    status: row.status ?? 'active',
    kind: row.kind ?? 'fact',
    area: row.area ?? '',
    title: row.title ?? '',
    whenuse: row.whenuse ?? '',
    fingerprint: row.fingerprint ?? '',
    machine_fingerprint: row.machine_fingerprint ?? '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    human_at: row.human_at ?? null,
    source_sessions: JSON.stringify(Array.isArray(row.source_sessions) ? row.source_sessions : []),
    confirmed: row.confirmed ? 1 : 0,
    last_loaded: row.last_loaded ?? null,
  }
}
