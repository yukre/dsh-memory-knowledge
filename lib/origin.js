/**
 * Where a memory came from, and how much weight that deserves.
 *
 * The person's own words carry intent; a model's inference carries a guess.
 * Treating the two the same is what let a 237-entry library sit entirely in
 * staging: everything waited for the same two citations, which nothing ever
 * accumulated. This ranks the source so the promotion threshold can differ.
 */

/**
 * @typedef {'A'|'B'|'C'|'D'} OriginTier
 * @property {OriginTier} tier
 * @property {string} label - human-readable reason.
 */

/** Human statements that state or decide something, as opposed to asking. */
const STATES = /(要|不要|必须|应该|改成|换成|用.+而不用|优先|别再|以后|记住|我习惯|确定|就这么|按.+[来写做]|不对|错了|其实是|只(要|能|记|用|需|看|在|有)|一律|统一|不许|不准)/

/**
 * Phrasing that turns a statement-shaped sentence back into a question.
 *
 * 「是不是应该这样」contains 应该 but asks rather than decides, and treating a
 * question as a stated position is exactly the confusion this whole change
 * exists to remove.
 */
const ASKS = /(是不是|要不要|能不能|可不可以|行不行|对不对|好不好|该不该|有没有|为什么|怎么办|如何|？|\?)/

/**
 * Classify where a memory came from.
 *
 * A — the person's own words, quoted verbatim as evidence, and those words
 *     state or decide something. Asking a question is not stating a conclusion,
 *     which is why a bare role check is not enough.
 * B — the person approved it (mk_feedback confirm, user-approved, user-requested).
 * C — it came from the person's own file, written by them.
 * D — only a model's inference supports it.
 * @param input - `{ confirmedBy, evidence, via }`.
 * @returns `{ tier, label }`.
 */
export function originOf(input = {}) {
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const confirmedBy = input.confirmedBy

  if (confirmedBy === 'user-requested') return { tier: 'A', label: '用户明确要求记住' }
  if (confirmedBy === 'user-approved') return { tier: 'B', label: '用户认可' }

  const human = evidence.filter(item => item?.kind === 'session' && item.role === 'user')
  if (human.length > 0) {
    // Verbatim human words. They only carry intent when they state or decide
    // something: "为什么会这样？" is the person thinking, not concluding.
    const quote = human.map(item => String(item.quote ?? '')).join(' ')
    if (ASKS.test(quote)) return { tier: 'B', label: '用户原话（提问，非结论）' }
    if (STATES.test(quote) || human.length >= 2) {
      return { tier: 'A', label: '用户原话（陈述或决定）' }
    }
    return { tier: 'B', label: '用户原话（讨论，非结论）' }
  }

  if (evidence.some(item => item?.kind === 'file')) return { tier: 'C', label: '来自用户文件' }

  return { tier: 'D', label: 'AI 推导，无用户原话' }
}

/**
 * Votes needed before an item may leave staging, by origin tier.
 *
 * A person's decision does not need a second session to re-derive it. A model's
 * inference does — not because it is wrong, but because nothing in this library
 * has ever accumulated citations, so demanding the same of everything means
 * nothing ever promotes.
 * @param tier - origin tier.
 * @param base - configured `promoteVotes`.
 * @returns votes required.
 */
export function votesRequired(tier, base) {
  const floor = Number.isFinite(base) && base > 0 ? base : 2
  // The person said "remember this": waiting for another session to cite it
  // would contradict the request that created it.
  if (tier === 'A') return 0
  if (tier === 'B') return Math.max(1, floor - 1)
  if (tier === 'C') return Math.max(1, floor - 1)
  return floor + 1
}
