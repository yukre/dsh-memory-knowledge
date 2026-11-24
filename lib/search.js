/**
 * Keyword search: tokenizer, BM25 index, and Jaccard similarity.
 *
 * No embeddings and no model calls. CJK text is split into overlapping
 * character bigrams (plus single characters for one-character queries); Latin
 * text into lowercase words. Title and "when to use" fields are weighted above
 * the body so an item whose title names the topic ranks first.
 *
 * @module dsh-memory-knowledge/search
 */

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u
const WORD = /[\p{L}\p{N}_]+/gu

/**
 * Tokenize text for indexing and querying.
 * @param text - any text.
 * @returns tokens (lowercase words and CJK bigrams).
 */
/**
 * Query words that carry no subject matter.
 *
 * They are frequent in questions and rare in the documents, so IDF makes them
 * decisive: a query that says 「怎么写」 retrieves notes about writing instead of
 * notes about 周报. Removing them lets the subject decide the ranking.
 */
const QUESTION_WORDS = /(怎么写|怎么|怎样|如何|为什么|为啥|是什么|是什么|什么是|多少|哪些|哪个|什么时候|怎么弄|怎么用|帮我|请|一下|关于|有关|的吗|呢|吗|吧)/g

/**
 * @param query - raw query.
 * @returns the query with question framing removed, or the original when
 *   stripping would leave nothing (a query that is only 「为什么」 must still work).
 */
export function stripQuestionWords(query) {
  const text = String(query ?? '')
  const stripped = text.replace(QUESTION_WORDS, ' ').replace(/\s+/g, ' ').trim()
  return stripped.length >= 2 ? stripped : text
}

export function tokenize(text) {
  const out = []
  const source = String(text ?? '').toLowerCase().normalize('NFKC')
  for (const match of source.matchAll(WORD)) {
    const run = match[0]
    if (!CJK.test(run)) {
      if (run.length > 1 || /\d/.test(run)) out.push(run)
      continue
    }
    // Mixed runs (e.g. "CU换算") split into Latin words and CJK bigrams.
    let latin = ''
    const cjk = []
    const flushCjk = () => {
      if (cjk.length === 1) out.push(cjk[0])
      for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk[i] + cjk[i + 1])
      cjk.length = 0
    }
    for (const char of run) {
      if (CJK.test(char)) {
        if (latin.length > 0) { out.push(latin); latin = '' }
        cjk.push(char)
      } else {
        flushCjk()
        latin += char
      }
    }
    if (latin.length > 0) out.push(latin)
    flushCjk()
  }
  return out
}

/**
 * Jaccard similarity of two texts' token sets.
 * @param a - first text.
 * @param b - second text.
 * @returns 0..1.
 */
export function jaccard(a, b) {
  const sa = new Set(tokenize(a))
  const sb = new Set(tokenize(b))
  if (sa.size === 0 || sb.size === 0) return 0
  let common = 0
  for (const token of sa) if (sb.has(token)) common++
  return common / (sa.size + sb.size - common)
}

/** Field weights for BM25F-style scoring. */
const WEIGHTS = Object.freeze({ title: 3, when: 2, area: 1.5, body: 1 })

/** In-memory BM25 index over items. */
export class SearchIndex {
  constructor() {
    /** @type {Map<string, { fields: Record<string,string[]>, length: number }>} */
    this.docs = new Map()
    /** @type {Map<string, number>} token → number of docs containing it */
    this.df = new Map()
    this.totalLength = 0
  }

  /**
   * Add or replace one document.
   * @param id - item id.
   * @param fields - `{ title, when, area, body }` raw texts.
   */
  put(id, fields) {
    this.remove(id)
    const tokens = {}
    let length = 0
    const seen = new Set()
    for (const field of Object.keys(WEIGHTS)) {
      tokens[field] = tokenize(fields[field] ?? '')
      length += tokens[field].length * WEIGHTS[field]
      for (const token of tokens[field]) seen.add(token)
    }
    for (const token of seen) this.df.set(token, (this.df.get(token) ?? 0) + 1)
    this.docs.set(id, { fields: tokens, length })
    this.totalLength += length
  }

  /**
   * @param id - item id.
   */
  remove(id) {
    const doc = this.docs.get(id)
    if (doc === undefined) return
    const seen = new Set()
    for (const field of Object.keys(WEIGHTS)) for (const token of doc.fields[field]) seen.add(token)
    for (const token of seen) {
      const next = (this.df.get(token) ?? 1) - 1
      if (next <= 0) this.df.delete(token)
      else this.df.set(token, next)
    }
    this.totalLength -= doc.length
    this.docs.delete(id)
  }

  /** @returns number of indexed documents. */
  get size() {
    return this.docs.size
  }

  /**
   * Rank documents for a query.
   * @param query - free text.
   * @param options - `{ limit, filter(id) → boolean, k1, b }`.
   * @returns `{ id, score }[]`, best first.
   */
  search(query, options = {}) {
    const limit = options.limit ?? 5
    const k1 = options.k1 ?? 1.2
    const b = options.b ?? 0.75
    // Strip the words people use to ask rather than to name. 「周报怎么写」scores
    // 怎么写 as a term and returns an agent-design note at 13.1 while the actual
    // 周报 entries sit at 5.0 — the question framing outranks the subject.
    const terms = [...new Set(tokenize(stripQuestionWords(query)))]
    if (terms.length === 0 || this.docs.size === 0) return []
    const n = this.docs.size
    const avg = this.totalLength / n || 1
    const scores = []
    for (const [id, doc] of this.docs) {
      if (options.filter !== undefined && !options.filter(id)) continue
      let score = 0
      for (const term of terms) {
        let tf = 0
        for (const field of Object.keys(WEIGHTS)) {
          let count = 0
          for (const token of doc.fields[field]) if (token === term) count++
          tf += count * WEIGHTS[field]
        }
        if (tf === 0) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / avg))
      }
      if (score > 0) scores.push({ id, score })
    }
    scores.sort((x, y) => y.score - x.score)
    return scores.slice(0, limit)
  }
}
