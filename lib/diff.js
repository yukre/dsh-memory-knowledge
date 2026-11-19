/**
 * Line diff (Myers O(ND)) refined by a character diff on changed lines.
 *
 * Chinese text often keeps a whole paragraph on one line, so a pure line diff
 * would report "this paragraph changed" and hide the actual edit. Changed line
 * pairs are therefore refined character by character and rendered inline as
 * `[-old-]{+new+}`, the word-diff convention most models already read.
 *
 * @module dsh-memory-knowledge/diff
 */

/**
 * Myers shortest edit script over two token arrays.
 * @param a - old tokens.
 * @param b - new tokens.
 * @returns operations `{ op: '='|'-'|'+', value }` in order.
 */
export function myers(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max
  let v = new Int32Array(2 * max + 2)
  const trace = []
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d)
    }
  }
  /* c8 ignore next */
  return []
}

/**
 * Rebuild the edit script from the saved frontier snapshots.
 * @param trace - V arrays per D.
 * @param a - old tokens.
 * @param b - new tokens.
 * @param offset - index offset of k=0.
 * @param dFinal - the D at which the end was reached.
 * @returns ordered operations.
 */
function backtrack(trace, a, b, offset, dFinal) {
  const ops = []
  let x = a.length
  let y = b.length
  for (let d = dFinal; d > 0; d--) {
    const v = trace[d]
    const k = x - y
    const prevK = (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) ? k + 1 : k - 1
    const prevX = v[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ op: '=', value: a[x - 1] }); x--; y-- }
    if (x === prevX) ops.push({ op: '+', value: b[y - 1] })
    else ops.push({ op: '-', value: a[x - 1] })
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) { ops.push({ op: '=', value: a[x - 1] }); x--; y-- }
  return ops.reverse()
}

/**
 * Inline character diff of one changed line pair.
 * @param oldLine - previous line.
 * @param newLine - current line.
 * @returns a single line with `[-…-]` and `{+…+}` marks.
 */
export function inlineDiff(oldLine, newLine) {
  const ops = myers([...oldLine], [...newLine])
  let out = ''
  let mode = '='
  let buffer = ''
  const flush = () => {
    if (buffer.length === 0) return
    if (mode === '=') out += buffer
    else if (mode === '-') out += `[-${buffer}-]`
    else out += `{+${buffer}+}`
    buffer = ''
  }
  for (const { op, value } of ops) {
    if (op !== mode) { flush(); mode = op }
    buffer += value
  }
  flush()
  return out
}

/**
 * Human- and model-readable diff with context, inline-refining changed lines.
 * @param oldText - previous version.
 * @param newText - current version.
 * @param options - `{ context: lines around each change, maxChars: cap }`.
 * @returns `{ text, changed, rewrite, added, removed }`; `rewrite` is true when
 *   the diff would exceed `maxChars` (the caller then sends the new text whole).
 */
export function renderDiff(oldText, newText, options = {}) {
  const context = options.context ?? 2
  const maxChars = options.maxChars ?? 3000
  // An empty text is zero lines, not one empty line: otherwise creating a file
  // reports "added 1, removed 1" and a diff shows a phantom paired change.
  const splitLines = text => {
    const source = String(text).replace(/\r\n?/g, '\n')
    return source === '' ? [] : source.split('\n')
  }
  const a = splitLines(oldText)
  const b = splitLines(newText)
  const ops = myers(a, b)
  let added = 0
  let removed = 0
  for (const op of ops) { if (op.op === '+') added++; else if (op.op === '-') removed++ }
  if (added === 0 && removed === 0) return { text: '', changed: false, rewrite: false, added, removed }

  // Pair adjacent -/+ runs so a modified line renders as one inline-diff line.
  const rows = []
  for (let i = 0; i < ops.length;) {
    if (ops[i].op === '=') { rows.push({ kind: '=', text: ops[i].value }); i++; continue }
    const minus = []
    const plus = []
    while (i < ops.length && ops[i].op === '-') minus.push(ops[i++].value)
    while (i < ops.length && ops[i].op === '+') plus.push(ops[i++].value)
    const pairs = Math.min(minus.length, plus.length)
    for (let p = 0; p < pairs; p++) rows.push({ kind: '~', text: inlineDiff(minus[p], plus[p]) })
    for (let p = pairs; p < minus.length; p++) rows.push({ kind: '-', text: minus[p] })
    for (let p = pairs; p < plus.length; p++) rows.push({ kind: '+', text: plus[p] })
  }

  const keep = new Array(rows.length).fill(false)
  rows.forEach((row, index) => {
    if (row.kind === '=') return
    for (let j = Math.max(0, index - context); j <= Math.min(rows.length - 1, index + context); j++) keep[j] = true
  })
  const lines = []
  let skipped = false
  rows.forEach((row, index) => {
    if (!keep[index]) { skipped = true; return }
    if (skipped) { lines.push('…'); skipped = false }
    const prefix = row.kind === '=' ? '  ' : row.kind === '~' ? '~ ' : `${row.kind} `
    lines.push(prefix + row.text)
  })
  const text = lines.join('\n')
  return { text, changed: true, rewrite: text.length > maxChars, added, removed }
}
