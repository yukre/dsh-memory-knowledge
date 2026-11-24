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
 * An explicit instruction to keep something long-term.
 *
 * Deliberately narrow. This is the one signal that skips validation entirely,
 * so 「统一用中文」 must not qualify — it decides a preference, but not that it
 * should be remembered forever.
 */
const RETAIN = /(记住|记一下|记下来|别忘|以后都|今后|长期保留|永久|一直(都)?(这样|按)|别再|不要再|下次(记得|也)|以后(不要|别)|沉淀(下来|成)|存(进|到)记忆)/

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
 * A — the person explicitly asked for this to be kept ("记住…", "以后都…",
 *     "别再…"). That instruction is what mk_remember acts on; when a tier-A
 *     item is written by the curator instead, it still needs a citation.
 *     An ordinary statement — 「统一用中文」 — is deliberately NOT tier A: it may
 *     be about one project, and nothing in it says it should outlive that.
 * B — the person approved it (mk_feedback confirm, user-approved, user-requested).
 * C — it came from the person's own file, written by them.
 * D — only a model's inference supports it.
 * @param input - `{ confirmedBy, evidence, via }`.
 * @returns `{ tier, label }`.
 */
export function originOf(input = {}) {
  const evidence = Array.isArray(input.evidence) ? input.evidence : []
  const confirmedBy = input.confirmedBy

  // Tier A is reserved for an explicit instruction to retain something. It is
  // the only path that skips validation, so it must be unambiguous: "记住 X",
  // "以后都按 Y 来", "别再 Z". An ordinary statement of preference still needs a
  // citation — it may be about one project, one afternoon, or one draft, and
  // nothing in the sentence says it should outlive them.
  // `confirmedBy` is a label the *writer* chooses, and the writer is usually the
  // curator — an agent. Trusting it alone would let the model declare its own
  // item "user-requested" and skip validation, which is the same self-certifying
  // hole that made a curator `confirm` stop counting as a vote. It is only
  // believed when the evidence independently shows the person saying it.
  const human = evidence.filter(item => item?.kind === 'session' && item.role === 'user')

  if (confirmedBy === 'user-requested') {
    if (human.length > 0) return { tier: 'A', label: '用户明确要求记住' }
    return { tier: 'C', label: `标记为${confirmedBy}，但没有用户原话` }
  }
  if (confirmedBy === 'user-approved') {
    if (human.length > 0) return { tier: 'B', label: '用户认可' }
    return { tier: 'C', label: `标记为${confirmedBy}，但没有用户原话` }
  }
  if (human.length > 0) {
    const quote = human.map(item => String(item.quote ?? '')).join(' ')
    // An explicit retention instruction inside the quote also counts, even when
    // the item arrived through the curator rather than mk_remember.
    if (!ASKS.test(quote) && RETAIN.test(quote)) return { tier: 'A', label: '用户明确要求长期保留' }
    if (ASKS.test(quote)) return { tier: 'B', label: '用户原话（提问，非结论）' }
    if (STATES.test(quote) || human.length >= 2) {
      return { tier: 'B', label: '用户原话（陈述，但未要求保留）' }
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
 * @returns votes required; never zero (see below).
 */
export function votesRequired(tier, base) {
  const floor = Number.isFinite(base) && base > 0 ? base : 2
  // Every tier reached here needs citations. "The person said remember this" is
  // not a tier — it is a different route entirely: mk_remember writes straight
  // to memory and never enters staging, so it never asks this question.
  //
  // Keeping the two apart matters. If a stated preference could skip citations
  // just by being emphatic, then the citation route would only ever apply to
  // whatever the model inferred, and the library would fill with items no real
  // use ever confirmed.
  if (tier === 'A') return Math.max(1, floor - 1)
  if (tier === 'B') return Math.max(1, floor - 1)
  if (tier === 'C') return Math.max(1, floor - 1)
  return floor + 1
}
