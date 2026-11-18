/**
 * Append-only changelog: the authoritative record of every change.
 *
 * One JSON object per line. Records are never rewritten; corrections are new
 * records (an `undo` names the change it reverses). The graph database can be
 * rebuilt by replaying this file against the Markdown files.
 *
 * @module dsh-memory-knowledge/changelog
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Every operation a record may carry. */
export const OPS = Object.freeze([
  'add', 'update', 'supersede', 'retire', 'promote', 'expire', 'resolve', 'link', 'unlink', 'merge',
  'dispute', 'confirm', 'forget',
  'human-add', 'human-edit', 'human-delete', 'move', 'restamp', 'adopt-copy',
  'undo', 'skill', 'import', 'task',
])

/** Writes and reads the changelog file. */
export class Changelog {
  /** @param file - absolute path of changelog.jsonl. */
  constructor(file) {
    this.file = file
  }

  /**
   * Append one record and return it with its assigned id and time.
   * @param record - `{ op, actor, item?, path?, ... }`.
   * @param now - timestamp in ms; defaults to Date.now().
   * @returns the stored record.
   */
  append(record, now = Date.now()) {
    if (!OPS.includes(record.op)) throw new Error(`unknown changelog op: ${record.op}`)
    const stored = { v: 1, change: `c_${now.toString(36)}_${randomBytes(3).toString('hex')}`, at: now, ...record }
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, `${JSON.stringify(stored)}\n`, 'utf8')
    return stored
  }

  /**
   * Read every record; a torn last line (crash mid-append) is skipped.
   * @returns records in write order.
   */
  all() {
    if (!existsSync(this.file)) return []
    const out = []
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try { out.push(JSON.parse(line)) } catch { /* torn line */ }
    }
    return out
  }

  /**
   * @param limit - how many records from the end.
   * @returns the newest records, newest first.
   */
  recent(limit = 20) {
    return this.all().slice(-limit).reverse()
  }

  /**
   * @param change - change id.
   * @returns the record or undefined.
   */
  find(change) {
    return this.all().find(record => record.change === change)
  }

  /**
   * Every path an item has had, newest first. Lets a citation that still uses
   * an old path count for the item after a rename.
   * @returns map from path to item id.
   */
  pathIndex() {
    const map = new Map()
    for (const record of this.all()) {
      if (typeof record.item === 'string' && typeof record.path === 'string') map.set(record.path, record.item)
      if (typeof record.item === 'string' && typeof record.from === 'string') map.set(record.from, record.item)
    }
    return map
  }
}
