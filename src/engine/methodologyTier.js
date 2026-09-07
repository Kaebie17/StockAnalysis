/**
 * src/engine/methodologyTier.js — the ONE provenance system, replacing two
 * that disagreed with each other: provenance.js's REAL/CALCULATED/ESTIMATED
 * (wired into exactly one panel) and format.js's resolutionBadge() 9-status
 * icon system (wired into another). Both answered "how trustworthy is this
 * RAW data point" — a different question from the one this tier answers:
 * "how much of this VALUE — raw or computed — rests on a fact, a named
 * external formula, or a judgment call this app made up." One vocabulary,
 * used everywhere a number needs that answer.
 *
 *   REPORTED — taken directly from a source, or pure arithmetic on other
 *              REPORTED values with no external assumption injected.
 *   DERIVED  — a named, external, non-arbitrary formula or convention: a
 *              universal constant this app didn't invent (CAPM, Graham's
 *              22.5, Blume's 2/3, Lynch's PEG rule), a value anchored to a
 *              real external quantity with only a disclosed convention on
 *              top (terminal growth vs. a central bank's inflation target),
 *              or a systematic, repeatable reconstruction (TTM
 *              annualization, a stated cross-source reconciliation).
 *   ASSUMED  — a genuine judgment call with no external numeric anchor at
 *              all: a flat sector-multiple table, an unattributed proxy, a
 *              scenario-shift magnitude this app picked.
 *
 * A null/unavailable value gets no tag at all — absence isn't a provenance
 * level.
 */

export const TIER = { REPORTED: 'reported', DERIVED: 'derived', ASSUMED: 'assumed' }

export const reported = (value, meta = {}) => ({ value, tier: TIER.REPORTED, ...meta })
export const derived  = (value, meta = {}) => ({ value, tier: TIER.DERIVED,  ...meta })
export const assumed  = (value, meta = {}) => ({ value, tier: TIER.ASSUMED,  ...meta })

export const isReported = t => t?.tier === TIER.REPORTED
export const isDerived  = t => t?.tier === TIER.DERIVED
export const isAssumed  = t => t?.tier === TIER.ASSUMED

export const valueOf = t => (t && typeof t === 'object' && 'tier' in t ? t.value : t)

/**
 * Colors are literal black/blue/red — not this app's bull/bear/accent/
 * neutral tokens, which already carry a different meaning (bullish/bearish
 * price direction) that a provenance tier would collide with. REPORTED gets
 * no color at all (plain text is the "nothing to flag" signal, the closest
 * a dark-theme app gets to "black ink on paper"); a compact badge still
 * renders an "R" mark so a mixed list of tags stays visually consistent.
 */
export function tierMeta(tier) {
  switch (tier) {
    case TIER.REPORTED: return { label: 'Reported', short: 'R', className: 'text-slate-400', hint: 'Directly reported, or arithmetic on reported figures only' }
    case TIER.DERIVED:  return { label: 'Derived',  short: 'D', className: 'text-accent',     hint: 'A named, external formula or convention applied to real inputs' }
    case TIER.ASSUMED:  return { label: 'Assumed',  short: 'A', className: 'text-red-400',    hint: 'A judgment call with no external anchor — a fallback convention, not a measurement' }
    default:            return { label: '', short: '', className: 'text-slate-600', hint: '' }
  }
}

/**
 * Bridges the OLD raw {value, status, formula} shape — still produced
 * throughout normalize.js's src()/derived()/unavailable() helpers,
 * unchanged by this migration — onto the 3 tiers above, so existing tagged
 * data doesn't need retagging at the source. Only the display bucketing
 * consolidates from 9 statuses down to 3; the underlying `formula`/status
 * detail still flows into tooltips via the `method` a caller passes to
 * ProvenanceTag.
 */
export function tierFromStatus(status) {
  switch (status) {
    case 'source':
    case 'document':
    case 'source-reference':
      return TIER.REPORTED
    case 'derived':
    case 'calculated':
    case 'cross-source':
      return TIER.DERIVED
    case 'positional':
    case 'estimated':
    case 'proxy':
      return TIER.ASSUMED
    case 'unavailable':
    default:
      return null
  }
}
