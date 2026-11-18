/**
 * Import queue: files enter as chunks; the curator (an LLM) turns each chunk
 * into items through the normal gated write path. The plugin only lists,
 * chunks, tracks progress, and keeps the source read-only.
 *
 * Installed onto Engine by `installImporter(engine)`.
 *
 * @module dsh-memory-knowledge/importer
 */

import { readdirSync, statSync } from 'node:fs'
import { join, isAbsolute, extname, basename } from 'node:path'
import { readIfExists, fingerprint } from './item.js'
import { GateError } from './gate.js'

const MAX_FILE_BYTES = 512 * 1024
const CHUNK_CHARS = 6000
const MAX_FILES = 2000

/**
 * Split Markdown into chunks at headings, each under the size cap, keeping
 * line numbers so evidence can cite `path + line`.
 * @param text - file text.
 * @returns `{ startLine, text }[]`; startLine is 1-based.
 */
export function chunkMarkdown(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const chunks = []
  let current = []
  let start = 1
  let size = 0
  const flush = (nextStart) => {
    if (current.length > 0 && current.join('').trim().length > 0) chunks.push({ startLine: start, text: current.join('\n') })
    current = []
    size = 0
    start = nextStart
  }
  lines.forEach((line, index) => {
    const heading = /^#{1,3}\s/.test(line)
    if ((heading && size > CHUNK_CHARS / 3) || size + line.length > CHUNK_CHARS) flush(index + 1)
    current.push(line)
    size += line.length + 1
  })
  flush(lines.length + 1)
  return chunks
}

/**
 * Number each line of a chunk for the model ("12| text").
 * @param chunk - `{ startLine, text }`.
 * @returns numbered text.
 */
export function numberLines(chunk) {
  return chunk.text.split('\n').map((line, index) => `${chunk.startLine + index}| ${line}`).join('\n')
}

/**
 * Files to import under a path.
 * @param path - file or directory.
 * @param exclude - absolute paths to skip (the library itself).
 * @returns absolute file paths.
 */
export function listImportable(path, exclude = []) {
  const out = []
  const visit = (target) => {
    if (out.length >= MAX_FILES) return
    if (exclude.some(prefix => target === prefix || target.startsWith(`${prefix}/`))) return
    let info
    try { info = statSync(target) } catch { return }
    if (info.isDirectory()) {
      for (const name of readdirSync(target).sort()) {
        if (name.startsWith('.') || name === 'node_modules') continue
        visit(join(target, name))
      }
    } else if (info.isFile() && ['.md', '.txt', '.markdown'].includes(extname(target).toLowerCase()) && info.size <= MAX_FILE_BYTES) {
      out.push(target)
    }
  }
  visit(path)
  return out
}

/**
 * Add import capability to an engine.
 * @param engine - Engine instance.
 */
export function installImporter(engine) {
  const graph = () => engine.graph

  engine.queueImport = async (args) => engine.store.serial(() => {
    const path = String(args?.path ?? '')
    if (!isAbsolute(path)) throw new GateError('BAD_PATH', '请给出绝对路径')
    const files = listImportable(path, [engine.config.root])
    if (files.length === 0) throw new GateError('NOTHING_TO_IMPORT', '没有可导入的 .md / .txt 文件')
    const now = engine.now()
    let queued = 0
    let unchanged = 0
    for (const file of files) {
      const text = readIfExists(file)
      if (text === undefined) continue
      const fp = fingerprint(text)
      const existing = graph().importEntry(file)
      if (existing !== undefined && existing.fingerprint === fp && existing.state === 'done') { unchanged++; continue }
      graph().putImport({ path: file, fingerprint: fp, state: 'queued', chunk: 0, chunks: chunkMarkdown(text).length }, now)
      queued++
    }
    engine.store.changelog.append({ op: 'import', actor: 'curator', path, queued, unchanged }, now)
    return { ok: true, queued, unchanged, total: files.length }
  })

  engine.pendingImport = () => {
    const entry = graph().queuedImports()[0]
    if (entry === undefined) return undefined
    const text = readIfExists(entry.path)
    if (text === undefined || fingerprint(text) !== entry.fingerprint) {
      // The source changed or vanished since queueing: requeue with fresh chunks.
      if (text === undefined) graph().putImport({ ...entry, state: 'missing' }, engine.now())
      else graph().putImport({ path: entry.path, fingerprint: fingerprint(text), state: 'queued', chunk: 0, chunks: chunkMarkdown(text).length }, engine.now())
      return engine.pendingImport()
    }
    const chunks = chunkMarkdown(text)
    const chunk = chunks[entry.chunk]
    if (chunk === undefined) {
      graph().putImport({ ...entry, state: 'done' }, engine.now())
      return engine.pendingImport()
    }
    const titleHint = basename(entry.path, extname(entry.path))
    const similar = engine.store.index.search(`${titleHint} ${chunk.text.slice(0, 400)}`, { limit: 6 })
      .map(hit => engine.graph.item(hit.id)).filter(Boolean).map(row => ({ id: row.id, title: row.title, pool: row.pool }))
    return {
      kind: 'import',
      ref: `${entry.path}#${entry.chunk}`,
      path: entry.path,
      chunk: entry.chunk + 1,
      chunks: chunks.length,
      text: numberLines(chunk),
      related: similar,
      hint: '依据写成 { kind:"file", path, line, quote }，line 用行首的编号。',
    }
  }

  engine.importDone = (unit) => {
    const [path, chunkText] = String(unit.ref).split(/#(?=\d+$)/)
    const entry = graph().importEntry(path)
    if (entry === undefined) return
    const chunk = Number(chunkText) + 1
    graph().putImport({ ...entry, chunk, state: chunk >= entry.chunks ? 'done' : 'queued' }, engine.now())
  }
}
