/**
 * Version history: gzip copies of every machine-written or human-settled
 * version of an item. The newest one is the diff baseline; any of them is an
 * undo point. One mechanism, two uses — there is no separate "previous copy".
 *
 * Layout: `meta/history/<id>/<timestamp>-<label>.md.gz`, standard gzip, so a
 * file opens with a double click on macOS.
 *
 * @module dsh-memory-knowledge/history
 */

import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const NAME = /^(\d{13})-([a-z-]+)\.md\.gz$/

/** Stores and prunes versions. */
export class History {
  /**
   * @param dir - meta/history directory.
   * @param retention - `{ keepVersions, keepDays }`.
   */
  constructor(dir, retention = { keepVersions: 10, keepDays: 90 }) {
    this.dir = dir
    this.retention = retention
  }

  /**
   * Save one version.
   * @param id - item id.
   * @param text - full file text.
   * @param label - why it was saved: 'machine' | 'human' | 'before-undo' | 'import'.
   * @param now - timestamp.
   * @returns the version name.
   */
  save(id, text, label, now = Date.now()) {
    const folder = join(this.dir, id)
    mkdirSync(folder, { recursive: true })
    let stamp = now
    let name = `${stamp}-${label}.md.gz`
    // Two saves in the same millisecond keep both versions.
    while (existsSync(join(folder, name))) { stamp += 1; name = `${stamp}-${label}.md.gz` }
    const temp = join(folder, `.${name}.${randomBytes(3).toString('hex')}.tmp`)
    writeFileSync(temp, gzipSync(Buffer.from(String(text), 'utf8'), { level: 9 }))
    renameSync(temp, join(folder, name))
    this.prune(id, now)
    return name
  }

  /**
   * @param id - item id.
   * @returns versions, newest first: `{ name, at, label }`.
   */
  list(id) {
    const folder = join(this.dir, id)
    if (!existsSync(folder)) return []
    return readdirSync(folder)
      .map(name => ({ name, match: NAME.exec(name) }))
      .filter(entry => entry.match !== null)
      .map(entry => ({ name: entry.name, at: Number(entry.match[1]), label: entry.match[2] }))
      .sort((a, b) => b.at - a.at)
  }

  /**
   * @param id - item id.
   * @param name - version name; omitted reads the newest.
   * @returns version text, or undefined when there is none.
   */
  read(id, name) {
    const versions = this.list(id)
    const target = name === undefined ? versions[0] : versions.find(version => version.name === name)
    if (target === undefined) return undefined
    return gunzipSync(readFileSync(join(this.dir, id, target.name))).toString('utf8')
  }

  /**
   * Keep the newest `keepVersions`, plus everything younger than `keepDays`.
   * The newest version (the diff baseline) is always kept.
   * @param id - item id.
   * @param now - timestamp.
   */
  prune(id, now = Date.now()) {
    const versions = this.list(id)
    const cutoff = now - this.retention.keepDays * 86_400_000
    versions.forEach((version, index) => {
      if (index === 0) return
      if (index < this.retention.keepVersions) return
      if (version.at >= cutoff) return
      try { unlinkSync(join(this.dir, id, version.name)) } catch { /* concurrent prune */ }
    })
  }
}
