/**
 * Item file format: identity line, fingerprint, parsing, and atomic writes.
 *
 * An item is one plain Markdown file. Its only machine marker is the identity:
 *
 *   - an ordinary item ends with the line `<!-- dmk:id=mk_xxxxxxxxxx -->`;
 *   - a skill keeps it in its YAML frontmatter as `metadata.dmk_id`, because a
 *     SKILL.md must begin with frontmatter and the body's tail belongs to the
 *     user.
 *
 * Identity and change are separate on purpose. The id never changes, so the
 * relation graph keyed on it survives every edit, rename, and move. The
 * fingerprint (SHA-256 of the normalized body, identity line excluded) changes
 * with every content edit and is what reveals a human edit.
 *
 * @module dsh-memory-knowledge/item
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

/** The identity line's exact grammar; the id alphabet is lowercase base32-ish. */
export const ID_LINE = /^<!--\s*dmk:id=(mk_[a-z0-9]{10})\s*-->\s*$/
const ID_PATTERN = /^mk_[a-z0-9]{10}$/
const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

/**
 * Mint a new item id. Ten characters of a 32-letter alphabet give 50 bits,
 * enough that a collision across a personal library is negligible; callers
 * still check uniqueness against the graph before using it.
 * @returns an id like `mk_8c2f0q7v1z`.
 */
export function newId() {
  const bytes = randomBytes(10)
  let out = 'mk_'
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length]
  return out
}

/**
 * Accept the id forms a model actually sends: with or without the `mk_`
 * prefix, wrapped in brackets or backticks, any case.
 * @param value - candidate id.
 * @returns canonical `mk_…` id, or the trimmed input when it is not id-shaped.
 */
export function normalizeId(value) {
  if (typeof value !== 'string') return value
  const bare = value.trim().replace(/^[[`'"(]+|[\]`'")]+$/g, '').toLowerCase()
  if (/^mk_[a-z0-9]{10}$/.test(bare)) return bare
  if (/^[a-z0-9]{10}$/.test(bare)) return `mk_${bare}`
  return value.trim()
}

/**
 * @param value - candidate id.
 * @returns whether it has the id grammar.
 */
export function isId(value) {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

/**
 * Normalize text for fingerprinting: unify newlines, drop trailing whitespace on
 * each line and at the end. Whitespace-only edits therefore do not count as a
 * content change, which is what a person expects.
 * @param text - raw text.
 * @returns normalized text.
 */
export function normalize(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n+$/u, '')
}

/**
 * @param text - normalized or raw content.
 * @returns lowercase hex SHA-256.
 */
export function fingerprint(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex')
}

/**
 * Split a SKILL.md into frontmatter lines and body.
 * @param text - full file text.
 * @returns `{ front, body }`; `front` is null when there is no frontmatter.
 */
export function splitFrontmatter(text) {
  const source = String(text).replace(/\r\n?/g, '\n')
  if (!source.startsWith('---\n')) return { front: null, body: source }
  // The closing fence may be the very next line (empty frontmatter), which the
  // `\n---` search starting at offset 4 would otherwise skip past.
  if (source.startsWith('---\n---')) {
    const after = source.indexOf('\n', 7)
    return { front: '', body: after === -1 ? '' : source.slice(after + 1) }
  }
  const end = source.indexOf('\n---', 4)
  if (end === -1) return { front: null, body: source }
  const after = source.indexOf('\n', end + 4)
  return {
    front: source.slice(4, end),
    body: after === -1 ? '' : source.slice(after + 1),
  }
}

/**
 * Read the `metadata.dmk_id` field from frontmatter text without a YAML parser.
 * Only the exact shape this plugin writes is recognized: a `metadata:` block
 * with an indented `dmk_id:` key.
 * @param front - frontmatter text (between the fences).
 * @returns the id or undefined.
 */
function frontmatterId(front) {
  const lines = front.split('\n')
  let inMetadata = false
  for (const line of lines) {
    if (/^metadata:\s*$/.test(line)) { inMetadata = true; continue }
    if (inMetadata) {
      if (/^\S/.test(line)) { inMetadata = false; continue }
      const match = /^\s+dmk_id:\s*["']?(mk_[a-z0-9]{10})["']?\s*$/.exec(line)
      if (match) return match[1]
    }
  }
  return undefined
}

/**
 * Parse one item file.
 * @param text - full file text.
 * @param kind - 'skill' for SKILL.md files, anything else for ordinary items.
 * @returns `{ id, ids, title, when, body, fingerprint }`; `ids` lists every
 *   identity line found (more than one means two items were merged by hand).
 */
export function parseItem(text, kind = 'item') {
  const source = String(text).replace(/\r\n?/g, '\n')
  if (kind === 'skill') {
    const { front, body } = splitFrontmatter(source)
    const id = front === null ? undefined : frontmatterId(front)
    const name = front === null ? undefined : /^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(front)?.[1]
    const description = front === null ? undefined : /^description:\s*["']?([^\n]*?)["']?\s*$/m.exec(front)?.[1]
    const whenToUse = front === null ? undefined : /^whenToUse:\s*["']?([^\n]*?)["']?\s*$/m.exec(front)?.[1]
    return {
      id,
      ids: id === undefined ? [] : [id],
      title: name ?? '',
      when: whenToUse ?? description ?? '',
      body,
      fingerprint: fingerprint(body),
    }
  }
  const lines = source.split('\n')
  const ids = []
  const kept = []
  for (const line of lines) {
    const match = ID_LINE.exec(line)
    if (match) ids.push(match[1])
    else kept.push(line)
  }
  const body = kept.join('\n')
  const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1] ?? ''
  const when = /^>\s*何时用[:：]\s*(.+?)\s*$/m.exec(body)?.[1]
    ?? /^>\s*when to use[:：]?\s*(.+?)\s*$/im.exec(body)?.[1]
    ?? ''
  return { id: ids[0], ids, title, when, body, fingerprint: fingerprint(body) }
}

/**
 * The comparable core of an item: title plus its conclusion line. Duplicate and
 * resurrection checks compare this, never whole bodies (a long body dilutes any
 * similarity) and never mismatched fields.
 * @param title - item title.
 * @param body - item body (title/when lines may be present).
 * @returns short text.
 */
export function essence(title, body) {
  const text = String(body ?? '')
  const claim = /\*\*结论\*\*[:：]\s*(.+)/.exec(text)?.[1]
  const fallback = text
    .split('\n')
    .filter(line => !/^#\s/.test(line) && !/^>\s/.test(line) && !ID_LINE.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${String(title ?? '').trim()} ${claim ?? [...fallback].slice(0, 160).join('')}`.trim()
}

/**
 * The full comparable text of an item: title plus every content line.
 *
 * `essence()` is deliberately short (title + conclusion) so two items about
 * the same thing are recognised as duplicates. That is the wrong comparison
 * for detecting a *verbatim* rewrite, where the body is copied but the title
 * and conclusion are reworded — use this for transcription checks.
 * @param title - item title.
 * @param body - item body.
 * @returns title plus all non-heading lines, unbounded.
 */
export function fullText(title, body) {
  const text = String(body ?? '')
    .split('\n')
    .filter(line => !/^#\s/.test(line) && !/^>\s/.test(line) && !ID_LINE.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${String(title ?? '').trim()} ${text}`.trim()
}

/**
 * Compose an ordinary item's file text from its parts.
 * @param parts - `{ id, title, when, body }`; body excludes title and when lines.
 * @returns full file text ending with the identity line.
 */
export function composeItem({ id, title, when, body }) {
  if (!isId(id)) throw new Error(`invalid item id: ${id}`)
  const head = `# ${String(title).trim()}\n> 何时用：${String(when).trim()}\n`
  const main = normalize(body)
  return `${head}\n${main}\n\n<!-- dmk:id=${id} -->\n`
}

/**
 * Put an identity line at the end of existing text, replacing any present.
 * Used to restore a deleted identity line without touching the body.
 * @param text - file text.
 * @param id - identity to stamp.
 * @returns new text.
 */
export function stampId(text, id) {
  if (!isId(id)) throw new Error(`invalid item id: ${id}`)
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n').filter(line => !ID_LINE.test(line))
  const body = lines.join('\n').replace(/\n+$/u, '')
  return `${body}\n\n<!-- dmk:id=${id} -->\n`
}

/**
 * Compose a SKILL.md: frontmatter carrying the identity, then the body.
 * Values are single-line; quotes and newlines are stripped so the hand-rolled
 * frontmatter stays valid YAML.
 * @param parts - `{ id, name, description, whenToUse, body }`.
 * @returns full file text.
 */
export function composeSkill({ id, name, description, whenToUse, body }) {
  if (!isId(id)) throw new Error(`invalid item id: ${id}`)
  const clean = value => String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/"/g, '\'').trim()
  const lines = [
    '---',
    `name: ${clean(name)}`,
    `description: "${clean(description)}"`,
  ]
  if (whenToUse) lines.push(`whenToUse: "${clean(whenToUse)}"`)
  lines.push('metadata:', `  dmk_id: ${id}`, '---', '')
  return `${lines.join('\n')}${normalize(body)}\n`
}

/**
 * Write a file atomically: temp file in the same directory, then rename.
 * @param path - destination.
 * @param text - content.
 */
export function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp) } catch { /* temp cleanup is best-effort */ }
    throw error
  }
}

/**
 * Read a text file, returning undefined when it does not exist.
 * @param path - file path.
 * @returns content or undefined.
 */
/**
 * Read a file, treating "not there" as undefined and anything else as absent too.
 *
 * Every caller has a sensible answer when a file cannot be read — skip it,
 * requeue it, report it — so letting EACCES escape turned one unreadable
 * document into a crashed nightly run. Callers that need to distinguish "gone"
 * from "present but unreadable" use {@link probeFile} instead.
 * @param path - file to read.
 * @returns the text, or undefined when it cannot be read for any reason.
 */
export function readIfExists(path) {
  return probeFile(path).text
}

/**
 * Read a file, reporting why it could not be read.
 *
 * The library scanner needs this distinction: a file that vanished should be
 * dropped quietly, while one that is present but unreadable has to be surfaced
 * to the person, otherwise their note silently stops syncing.
 * @param path - file to read.
 * @returns `{ text }` on success, otherwise `{ missing: true }` or `{ reason }`.
 */
export function probeFile(path) {
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { missing: true }
    return { reason: String(error?.code ?? error?.message ?? error) }
  }
}

/**
 * A file name derived from a title: keep CJK and word characters, collapse the
 * rest, cap the length so paths stay manageable.
 * @param title - item title.
 * @returns a safe base name without extension.
 */
export function slugify(title) {
  const base = String(title)
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|#%{}^~[\]`'\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const capped = [...base].slice(0, 60).join('')
  return capped.length > 0 ? capped : 'untitled'
}
