/**
 * src/engine/peerCompatibility.js — does this company operate the same way,
 * and is it actually usable as a valuation peer. Two separate questions,
 * kept as two separate functions.
 *
 * scoreBusinessModelMatch() compares two classification records (see
 * businessProfileEnums.js) — pure classification-vs-classification, no
 * financial data, no network/AI call. It answers "does this company operate
 * the same way," nothing about whether their multiples are comparable RIGHT
 * NOW — a company with an identical business model can still have wildly
 * different scale, margins, or leverage, which is exactly what
 * assessValuationPeerEligibility() checks separately using each company's
 * own already-cached financials. Collapsing both into one score risked
 * handing out "Tier 1" to a pair that matched on business model alone.
 *
 * All thresholds below are named constants, explicitly first-pass governance
 * parameters — not validated statistical cutoffs — so they're easy to find
 * and tune without touching the logic shape.
 */

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

// ── Business-model relationship ─────────────────────────────────────────────

const WEIGHTS = { model: 0.50, endMarket: 0.25, revenueModel: 0.15, productionProfile: 0.10 }
const DIRECT_MIN_SCORE = 65
const BROAD_MIN_SCORE = 35

/**
 * Business-model relationship only. Renamed/reshaped from an earlier
 * "Tier 1/2/3" version specifically because that framing implied valuation-
 * peer eligibility, which this function alone cannot determine.
 */
export function scoreBusinessModelMatch(target, candidate) {
  if (!target?.businessModel || !candidate?.businessModel) return null
  const reasons = []
  let score = 0

  const targetModels = [target.businessModel, ...(target.secondaryBusinessModels || [])]
  const candidateModels = [candidate.businessModel, ...(candidate.secondaryBusinessModels || [])]
  const modelOverlap = targetModels.some(m => candidateModels.includes(m))
  if (target.businessModel === candidate.businessModel) {
    score += WEIGHTS.model * 100
    reasons.push(`Same primary business model: ${target.businessModel}`)
  } else if (modelOverlap) {
    score += WEIGHTS.model * 60
    reasons.push('Overlapping business model via secondary classification')
  } else {
    reasons.push(`Different business model: ${target.businessModel} vs ${candidate.businessModel}`)
  }

  const tSet = new Set(target.endMarkets || [])
  const cSet = new Set(candidate.endMarkets || [])
  const union = new Set([...tSet, ...cSet])
  const overlap = [...tSet].filter(m => cSet.has(m))
  const jaccard = union.size ? overlap.length / union.size : 0
  score += jaccard * WEIGHTS.endMarket * 100
  reasons.push(overlap.length ? `End markets overlap: ${overlap.join(', ')}` : 'No end-market overlap')

  if (target.revenueModel === candidate.revenueModel) {
    score += WEIGHTS.revenueModel * 100
    reasons.push(`Same revenue model: ${target.revenueModel}`)
  }
  if (target.productionProfile === candidate.productionProfile) {
    score += WEIGHTS.productionProfile * 100
    reasons.push(`Same production profile: ${target.productionProfile}`)
  }
  score = Math.round(score)

  const businessRelationship =
    (target.businessModel === candidate.businessModel && score >= DIRECT_MIN_SCORE) ? 'DIRECT_BUSINESS_MODEL'
    : score >= BROAD_MIN_SCORE ? 'BROAD_BUSINESS_MODEL'
    : 'SECTOR_OR_THEME_ONLY'

  return { businessModelScore: score, businessRelationship, reasons }
}

// ── Valuation-peer eligibility ──────────────────────────────────────────────

const MARGIN_CAVEAT_PTS = 15    // margin gap beyond this → caveat
const SCALE_CAVEAT_RATIO = 5    // revenue >5x or <0.2x → caveat, never exclusion alone
const LEVERAGE_CAVEAT_GAP = 2   // net-debt/EBITDA gap beyond this (turns) → caveat

// Which margin field gates PROFITABILITY per metric. ev_revenue has no
// profitability gate at all — revenue-based multiples don't need positive
// earnings to be meaningful.
const PROFITABILITY_FIELD = { ev_ebitda: 'ebitdaMargin', pe: 'netMargin' }

/**
 * Given a business-model relationship, is THIS pair actually usable for a
 * multiple comparison right now — using each side's own already-cached
 * ratios (no network call, no AI). Small, explicit, named filters rather
 * than a weighted black-box score, so a decline is always attributable to a
 * specific, stated reason — the same "decline rather than manufacture false
 * precision" standard peerBand() already holds itself to below 3 usable
 * samples.
 *
 * SCOPE: written for EV/EBITDA comparisons by default — the motivating
 * Dixon/Kaynes/EMS case is fundamentally an EV/EBITDA comparison. `metric`
 * lets the same shape extend to 'pe' (checks netMargin instead) or
 * 'ev_revenue' (no profitability gate) without a rewrite; only 'ev_ebitda'
 * is exercised by this app's callers in v1.
 *
 * @param targetFin/candidateFin: { ebitdaMargin, netMargin, revCagr, netDebtEbitda, revenue }
 *   read off each company's own cached ratioResult (peersClient.js's
 *   enrichFromCache). Any field may be null (missing) — missing is handled
 *   distinctly from present-but-fails.
 */
export function assessValuationPeerEligibility(target, candidate, targetFin, candidateFin, { metric = 'ev_ebitda' } = {}) {
  const reasons = []
  if (!targetFin || !candidateFin) {
    return { valuationEligibility: 'UNASSESSED', reasons: ['Financials not available for one side'] }
  }

  const profField = PROFITABILITY_FIELD[metric]
  if (profField) {
    const tVal = targetFin[profField]
    const cVal = candidateFin[profField]
    if (tVal == null || cVal == null) {
      return { valuationEligibility: 'UNASSESSED', reasons: [`${profField} missing for one side`] }
    }
    if (!(tVal > 0 && cVal > 0)) {
      reasons.push(`One side has non-positive ${profField === 'ebitdaMargin' ? 'EBITDA' : 'net profit'} — ${metric.toUpperCase()} is not a meaningful comparison here`)
      return { valuationEligibility: 'NOT_ELIGIBLE', reasons }
    }
    if (Math.abs(tVal - cVal) > MARGIN_CAVEAT_PTS) {
      reasons.push(`${profField} differs by >${MARGIN_CAVEAT_PTS}pts (${round(tVal)}% vs ${round(cVal)}%)`)
    }
  }

  if (targetFin.revenue == null || candidateFin.revenue == null) {
    reasons.push('Revenue missing for one side — scale comparability unassessed')
  } else {
    const ratio = targetFin.revenue / candidateFin.revenue
    if (ratio > SCALE_CAVEAT_RATIO || ratio < 1 / SCALE_CAVEAT_RATIO) {
      reasons.push(`Revenue scale differs by more than ${SCALE_CAVEAT_RATIO}×`)
    }
  }

  if (targetFin.netDebtEbitda != null && candidateFin.netDebtEbitda != null &&
      Math.abs(targetFin.netDebtEbitda - candidateFin.netDebtEbitda) > LEVERAGE_CAVEAT_GAP) {
    reasons.push(`Net debt/EBITDA differs by >${LEVERAGE_CAVEAT_GAP} turns`)
  }

  return { valuationEligibility: reasons.length === 0 ? 'ELIGIBLE' : 'ELIGIBLE_WITH_CAVEAT', reasons }
}

// ── Peer-set composition summary ────────────────────────────────────────────

/**
 * Composition summary over a set of already-CONFIRMED peers for one ticker.
 * Advisory only — never blocks confirming/using peers, mirrors this app's
 * existing pattern of disclosing a caveat rather than hiding a number.
 *
 * `relevance` is deliberately NOT called "confidence" — 3 direct peers
 * establishes business-model RELEVANCE (the composition of the set), not
 * statistical valuation reliability (peerBand()'s own sample-size/outlier
 * logic already owns that question separately). Conflating the two would
 * overclaim what this function actually measures.
 *
 * @param scoredConfirmedPeers: array of { businessRelationship } (the result
 *   of scoreBusinessModelMatch against the target, for each confirmed peer
 *   that has a classification)
 */
export function summarizePeerSet(scoredConfirmedPeers) {
  const direct = scoredConfirmedPeers.filter(p => p.businessRelationship === 'DIRECT_BUSINESS_MODEL').length
  const broad = scoredConfirmedPeers.filter(p => p.businessRelationship === 'BROAD_BUSINESS_MODEL').length
  const total = scoredConfirmedPeers.length

  let valuationPeerSet, relevance, reason
  if (direct >= 3) {
    valuationPeerSet = 'direct'; relevance = 'strong'; reason = null
  } else if (direct + broad >= 3) {
    valuationPeerSet = 'mixed'; relevance = 'mixed'
    reason = 'Fewer than 3 direct business-model peers; broad peers fill the rest'
  } else if (total > 0) {
    valuationPeerSet = 'broad-only'; relevance = 'weak'
    reason = 'Insufficient direct or broad business-model peers — median may reflect the sector generally, not this business specifically'
  } else {
    valuationPeerSet = 'unscored'; relevance = 'unscored'
    reason = 'No confirmed peers have a business-model classification yet'
  }

  return { primaryPeerCount: direct, broadPeerCount: broad, totalConfirmed: total, valuationPeerSet, relevance, reason }
}
