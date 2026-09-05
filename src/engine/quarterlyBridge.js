/**
 * src/engine/quarterlyBridge.js — make the pasted quarterly table actually count.
 *
 * The quarterly parser and the guidance tracker were both built and neither was
 * ever connected: rows went into `quarterlyData` and nothing read them, so a
 * company could miss guidance for three quarters running and no bar would move.
 * This is the join.
 *
 * It does three things the callers shouldn't each re-derive:
 *   • splits the stored rows into complete prior years and the year in progress
 *   • learns seasonality from the complete ones, so a light H1 at an H2-weighted
 *     business doesn't read as a miss
 *   • runs the assessment against guidance if it exists, or against our own
 *     standing growth assumption if it doesn't — labelled so the two can't blur
 */
import { assessGuidance, seasonalityFrom, resolveIfComplete } from './guidanceTracking.js'
import { percentileSpread } from './spread.js'

const val = t => (t && typeof t === 'object' ? t.value : t)

/**
 * @param quarterlyData  { rows: [{ period, fiscalYear, quarterIndex, revenue, ... }] }
 * @param opts.guidance      the ticker's guidance record
 * @param opts.modelGrowth   standing growth assumption (decimal)
 * @param opts.incomeHistory annual rows — fallback for the prior-year base
 */
export function assessFromQuarterly(quarterlyData, opts = {}) {
  const rows = (quarterlyData?.rows || [])
    .filter(r => r && r.fiscalYear && r.revenue != null)
    .map(r => ({
      label: r.period ?? r.year,
      fiscalYear: r.fiscalYear,
      quarterIndex: r.quarterIndex ?? null,
      revenue: val(r.revenue),
    }))
    .filter(r => r.revenue > 0)

  if (rows.length === 0) return null

  // Group by fiscal year, in order.
  const byFy = new Map()
  for (const r of rows) {
    if (!byFy.has(r.fiscalYear)) byFy.set(r.fiscalYear, [])
    byFy.get(r.fiscalYear).push(r)
  }
  const fys = [...byFy.keys()].sort()
  const complete = fys.filter(fy => byFy.get(fy).length >= 4)

  // The year being judged: the guided one if guidance names it and we have rows
  // for it, otherwise simply the latest year present.
  const guidedFy = opts.guidance?.revenueGuidance?.status !== 'resolved'
    ? opts.guidance?.revenueGuidance?.fiscalYear : null
  const targetFy = (guidedFy && byFy.has(guidedFy)) ? guidedFy : fys[fys.length - 1]
  const current = byFy.get(targetFy) || []

  // Prior-year base. Prefer the quarterly sum of the preceding year (same source,
  // same definitions); fall back to the annual history when that year wasn't
  // pasted in full.
  const prevFy = fys[fys.indexOf(targetFy) - 1]
  let priorFyRevenue = null
  if (prevFy && byFy.get(prevFy)?.length >= 4) {
    priorFyRevenue = byFy.get(prevFy).reduce((s, r) => s + r.revenue, 0)
  } else {
    const hist = opts.incomeHistory || []
    const last = hist[hist.length - 1]
    priorFyRevenue = val(last?.revenue) ?? null
  }
  if (!(priorFyRevenue > 0)) return null

  // Seasonality from every complete year EXCEPT the one being judged.
  const learnRows = complete.filter(fy => fy !== targetFy).flatMap(fy => byFy.get(fy))
  const seasonality = seasonalityFrom(learnRows)

  // Annual revenue growth history, from the SAME quarterly data already
  // being judged — used by growthDriftSuggestion() below to set a
  // per-company significance threshold instead of one flat number applied
  // to every business alike.
  const annualByFy = complete
    .map(fy => ({ year: fy, revenue: byFy.get(fy).reduce((s, r) => s + r.revenue, 0) }))
    .sort((a, b) => a.year - b.year)
  const annualGrowthHistory = []
  for (let i = 1; i < annualByFy.length; i++) {
    annualGrowthHistory.push(annualByFy[i].revenue / annualByFy[i - 1].revenue - 1)
  }

  const assessment = assessGuidance(opts.guidance, current, {
    modelGrowth: opts.modelGrowth ?? null,
    priorFyRevenue,
    seasonality,
  })

  return {
    ...assessment,
    targetFy,
    priorFyRevenue,
    quartersReported: current.length,
    seasonalityLearnedFrom: complete.filter(fy => fy !== targetFy),
    annualGrowthHistory,
    // Ready to persist when the year has fully reported — the caller decides
    // whether to write it, but the verdict is computed here.
    resolution: resolveIfComplete(opts.guidance, assessment),
  }
}

/**
 * Has the business been running ahead of or behind our own growth assumption for
 * long enough to be worth acting on? This is the mechanical trigger for a
 * quarterly revision — a fact, not a headline, so it can propose a number rather
 * than asking for one.
 */
export function growthDriftSuggestion(assessment, modelGrowth) {
  if (!assessment || modelGrowth == null) return null
  if (assessment.fullYearGapPct == null) return null
  const gapPct = Math.abs(assessment.fullYearGapPct)

  // Significance threshold, measured from THIS company's own historical
  // annual revenue growth volatility (half its 15th-85th percentile spread,
  // in points) rather than a flat 5% applied to every business alike — a
  // steady, predictable company should be flagged on a smaller surprise than
  // a volatile, cyclical one, because "5% off" means something completely
  // different for each. Floored at 3pts so even a very steady business needs
  // more than routine reporting noise to trigger. Falls back to the flat 5%
  // only when there's under 4 years of annual history to measure a real
  // spread from.
  const ps = percentileSpread(assessment.annualGrowthHistory, { minSamples: 4 })
  const thresholdPct = ps ? Math.max(3, ((ps.high - ps.low) / 2) * 100) : 5

  // A surprise several multiples beyond the company's own normal volatility
  // is acted on immediately, same as a real analyst reacts fast to an
  // obviously extraordinary print — otherwise, one quarter is still noise
  // and a second is required before calling it a trend. "2.5x the threshold"
  // is a judgement call, disclosed as one: there's no data-derived way to
  // say exactly how extreme is extreme enough to skip the confirmation wait.
  const isExtreme = ps != null && gapPct >= thresholdPct * 2.5
  if (assessment.reported < 2 && !isExtreme) return null
  if (gapPct < thresholdPct) return null

  // Implied growth from the run-rate: what the year is actually tracking at.
  const implied = (assessment.runRateFullYear / assessment.priorFyRevenue) - 1
  if (!isFinite(implied)) return null

  return {
    lever: 'growth',
    from: modelGrowth,
    to: implied,
    // A quarter's run-rate is evidence about the year in progress, not a
    // multi-year view — the DCF near-term window this feeds should only
    // hold for 1 year, not longer than the evidence actually supports.
    years: 1,
    steps: [
      `${assessment.reported} of ${assessment.quartersInYear} quarters reported for ${assessment.targetFy}`,
      `Run-rate implies ${(implied * 100).toFixed(1)}% for the year, vs ${(modelGrowth * 100).toFixed(1)}% assumed`,
      ps
        ? `Significance threshold: ${thresholdPct.toFixed(1)} pts, from this company's own historical growth volatility`
        : `Significance threshold: flat 5 pts (not enough annual history to measure this company's own volatility)`,
    ],
    reason: `Quarterly results running ${assessment.fullYearGapPct > 0 ? 'ahead of' : 'behind'} the assumption`,
  }
}
