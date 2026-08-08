/**
 * src/engine/guidanceTracking.js
 *
 * Does the business look like it's tracking what was expected of it?
 *
 * Two things are deliberately kept apart here, because conflating them is what
 * makes a "beat/miss" read misleading:
 *
 *   vs GUIDANCE — management said FY27 revenue would be X. Their promise.
 *   vs MODEL    — nobody guided, so the yardstick is our own standing growth
 *                 assumption (ScoringStudio's figure, or the CAGR fallback).
 *
 * Both produce a verdict; they are NOT the same claim, and every result says
 * which one it is so the UI can't blur them into a generic "beat".
 *
 * The comparison is CUMULATIVE within the fiscal year, never quarter-by-quarter
 * against a flat quarter of the annual number. A business that earns most of its
 * revenue in H2 would "miss" every H1 quarter on a naive pro-rate while being
 * exactly on plan — the flag would fire on seasonality rather than on
 * performance. Judging the year-to-date against the year-to-date, and only
 * extrapolating once enough of the year has reported, avoids inventing that.
 *
 * Guidance expires. Once the fiscal year it was a promise ABOUT has fully
 * reported, it resolves once to a permanent verdict and stops being the live
 * yardstick — a stale FY26 guide must never quietly grade FY28 quarters.
 */

// How much of the year has to be in before an extrapolated verdict is offered.
// Below this, a year-to-date read is reported but left as 'tracking' — one
// quarter into a year is far too little to call a beat or a miss.
const MIN_QUARTERS_TO_JUDGE = 2

// Inside this band the result is 'meet' rather than beat/miss. Reported figures
// land near-but-not-exactly on plan constantly; without a tolerance almost
// everything reads as a miss by a fraction of a percent.
const MEET_BAND_PCT = 2

/**
 * @param guidance  the guidance record for this ticker (may be null)
 * @param quarters  quarterly rows for the fiscal year being judged, oldest
 *                  first: [{ label, fiscalYear, revenue, quarterIndex }]
 * @param opts.modelGrowth   standing growth assumption (decimal, e.g. 0.18)
 * @param opts.priorFyRevenue  last full FY revenue — the base both yardsticks
 *                             grow from
 * @param opts.quartersInYear  4 unless a company reports differently
 */
export function assessGuidance(guidance, quarters = [], opts = {}) {
  const { modelGrowth, priorFyRevenue, quartersInYear = 4 } = opts

  const g = activeGuidance(guidance)
  const rows = (quarters || []).filter(q => q && q.revenue != null)

  // Which yardstick applies, and what full-year revenue does it imply?
  let basis, targetFy, expectedFullYear
  if (g && priorFyRevenue != null) {
    basis    = 'guidance'
    targetFy = g.fiscalYear
    expectedFullYear = g.unit === 'absolute'
      ? g.value
      : priorFyRevenue * (1 + g.value / 100)
  } else if (modelGrowth != null && priorFyRevenue != null) {
    basis    = 'model'
    targetFy = rows[0]?.fiscalYear ?? null
    expectedFullYear = priorFyRevenue * (1 + modelGrowth)
  } else {
    return {
      basis: 'none', verdict: 'unknown', reported: 0, quartersInYear,
      note: 'No guidance and no growth assumption to judge against.',
    }
  }

  // Only quarters belonging to the year the yardstick is ABOUT. A guide for FY27
  // says nothing about an FY28 print.
  const inYear = targetFy ? rows.filter(q => q.fiscalYear === targetFy) : rows
  const reported = inYear.length

  if (reported === 0) {
    return {
      basis, targetFy, expectedFullYear, reported: 0, quartersInYear,
      verdict: 'pending',
      note: `No quarters reported yet for ${targetFy ?? 'this year'}.`,
    }
  }

  // Year-to-date actual vs the same slice of the expectation.
  //
  // The slice is weighted by the company's OWN historical seasonality, not by a
  // flat reported/quartersInYear. Going cumulative isn't enough on its own: a
  // business that books most of its revenue in H2 is genuinely "behind" a flat
  // half-year line at Q2 while being exactly on plan, so a flat slice would fire
  // a miss on seasonality rather than on performance. `seasonality` is the share
  // of a normal year that lands in each quarter (from prior years' quarterly
  // rows); with none supplied it degrades to the flat assumption, and the result
  // says so via `seasonalityUsed` so a verdict built on the weaker assumption is
  // never presented as if it were the stronger one.
  const weights   = normalizedWeights(opts.seasonality, quartersInYear)
  const ytdShare  = weights.slice(0, reported).reduce((s, w) => s + w, 0)
  const actualYtd   = inYear.reduce((s, q) => s + q.revenue, 0)
  const expectedYtd = expectedFullYear * ytdShare
  const ytdGapPct   = expectedYtd ? ((actualYtd - expectedYtd) / expectedYtd) * 100 : null

  // Run-rate extrapolation — grossed up by the same seasonal share, so a light
  // H1 extrapolates to a normal year rather than to a shortfall.
  const runRateFullYear = ytdShare > 0 ? actualYtd / ytdShare : null
  const fullYearGapPct  = (expectedFullYear && runRateFullYear != null)
    ? ((runRateFullYear - expectedFullYear) / expectedFullYear) * 100 : null

  const complete = reported >= quartersInYear
  let verdict
  if (reported < MIN_QUARTERS_TO_JUDGE) {
    verdict = 'tracking'                       // too early to call
  } else if (fullYearGapPct == null) {
    verdict = 'unknown'
  } else if (Math.abs(fullYearGapPct) <= MEET_BAND_PCT) {
    verdict = 'meet'
  } else {
    verdict = fullYearGapPct > 0 ? 'beat' : 'miss'
  }

  return {
    basis,                    // 'guidance' | 'model' — never blur these
    targetFy,
    verdict,                  // beat | meet | miss | tracking | pending | unknown
    final: complete,          // the year is fully reported; this verdict is now permanent
    reported, quartersInYear,
    actualYtd, expectedYtd, ytdGapPct,
    runRateFullYear, expectedFullYear, fullYearGapPct,
    seasonalityUsed: !!opts.seasonality,   // false → flat-quarters assumption
    note: describe(basis, verdict, reported, quartersInYear, fullYearGapPct, complete),
  }
}

/**
 * Quarterly revenue shares of a normal year, from the company's own history.
 * Pass prior full years' quarterly rows (any number of complete years); returns
 * weights summing to 1, or null when there isn't a complete year to learn from —
 * in which case the caller falls back to flat quarters and says so.
 */
export function seasonalityFrom(historicalQuarters = [], quartersInYear = 4) {
  const byYear = new Map()
  for (const q of historicalQuarters) {
    if (!q || q.revenue == null || !q.fiscalYear) continue
    if (!byYear.has(q.fiscalYear)) byYear.set(q.fiscalYear, [])
    byYear.get(q.fiscalYear).push(q)
  }
  const complete = [...byYear.values()].filter(qs => qs.length === quartersInYear)
  if (complete.length === 0) return null

  const sums = Array(quartersInYear).fill(0)
  let years = 0
  for (const qs of complete) {
    const total = qs.reduce((s, q) => s + q.revenue, 0)
    if (!(total > 0)) continue
    // Order within the year matters — sort by quarterIndex when given.
    const ordered = qs.slice().sort((a, b) => (a.quarterIndex ?? 0) - (b.quarterIndex ?? 0))
    ordered.forEach((q, i) => { sums[i] += q.revenue / total })
    years++
  }
  if (years === 0) return null
  return sums.map(s => s / years)
}

/** Normalize supplied weights to sum to 1; fall back to flat quarters. */
function normalizedWeights(seasonality, quartersInYear) {
  const flat = Array(quartersInYear).fill(1 / quartersInYear)
  if (!Array.isArray(seasonality) || seasonality.length !== quartersInYear) return flat
  const total = seasonality.reduce((s, w) => s + (w > 0 ? w : 0), 0)
  if (!(total > 0)) return flat
  return seasonality.map(w => (w > 0 ? w : 0) / total)
}

/** Live guidance only — a resolved or expired guide is not a yardstick. */
export function activeGuidance(guidance) {
  const g = guidance?.revenueGuidance
  if (!g || g.status === 'resolved') return null
  if (g.value == null || !isFinite(g.value)) return null
  return g
}

/**
 * Once the guided year is fully reported the guide stops being live and becomes
 * a permanent entry in the track record. Returns the updated guidance record to
 * persist, or null when nothing needs to change.
 */
export function resolveIfComplete(guidance, assessment) {
  const g = activeGuidance(guidance)
  if (!g || !assessment?.final || assessment.basis !== 'guidance') return null
  return {
    ...guidance,
    revenueGuidance: {
      ...g,
      status: 'resolved',
      resolution: {
        actual:   assessment.actualYtd,
        expected: assessment.expectedFullYear,
        gapPct:   assessment.fullYearGapPct,
        verdict:  assessment.verdict,
        resolvedAt: Date.now(),
      },
    },
  }
}

function describe(basis, verdict, reported, total, gapPct, complete) {
  const against = basis === 'guidance' ? 'management guidance' : 'our growth assumption'
  const sofar   = `${reported} of ${total} quarters reported`
  if (verdict === 'tracking') return `${sofar} — too early to call against ${against}.`
  if (verdict === 'pending')  return `Nothing reported yet against ${against}.`
  if (verdict === 'unknown')  return `Not enough data to compare against ${against}.`
  const dir  = gapPct >= 0 ? 'ahead of' : 'behind'
  const mag  = `${Math.abs(gapPct).toFixed(1)}%`
  const when = complete ? 'Full year' : `Run-rate (${sofar})`
  if (verdict === 'meet') return `${when}: in line with ${against}.`
  return `${when}: ${mag} ${dir} ${against}.`
}
