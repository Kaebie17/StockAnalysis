/**
 * src/engine/estimation.js — backward gap-filling for a metric missing in an
 * otherwise-complete year. NOT forward projection.
 *
 * Priority (annual always wins):
 *   1. annual figure for the year        → calculated (near-actual)
 *   2. all 4 quarters of the year present → estimated · "sum of 4 quarters"
 *   3. trend ratio (metric/anchor across years we DO have) × this year's anchor
 *                                        → estimated · "trend ratio"
 * Partial-quarter interpolation is intentionally omitted (least reliable).
 *
 * Fragments come from captured document inputs (arData.derivedInputs.<metric>),
 * each carrying a period string (FY24 / Q2 FY25). Anchor = revenue by year.
 */
import { calculated, estimated } from './provenance.js'

export function parsePeriod(asOf) {
  const s = String(asOf || '').toLowerCase()
  const q = s.match(/q([1-4])/)
  const fyM = s.match(/fy\s*'?(\d{2,4})/) || s.match(/\b(\d{4})\b/)
  let fy = null
  if (fyM) { const n = Number(fyM[1]); fy = n < 100 ? 2000 + n : n }
  return { fy, quarter: q ? Number(q[1]) : null }
}

// Gross margin for targetFy from captured material-cost fragments + revenue.
export function estimateGrossMargin(materialCostFragments, revenueByYear, targetFy) {
  const rev = revenueByYear[targetFy]
  if (!rev || rev <= 0) return null
  const frags = (materialCostFragments || []).map(f => ({ ...parsePeriod(f.asOf), value: f.value }))
                 .filter(f => f.value != null && f.fy != null)

  // 1. annual figure for the target year
  const annual = frags.find(f => f.fy === targetFy && f.quarter == null)
  if (annual) return calculated(gm(rev, scaleCost(annual.value, rev)), { method: 'annual figure' })

  // 2. all four quarters of the target year → sum = actual annual
  const qs = frags.filter(f => f.fy === targetFy && f.quarter != null)
  const uniqQ = new Set(qs.map(f => f.quarter))
  if (uniqQ.size === 4) {
    const sum = [1, 2, 3, 4].reduce((s, q) => s + qs.find(f => f.quarter === q).value, 0)
    return estimated(gm(rev, scaleCost(sum, rev)), { method: 'sum of 4 quarters' })
  }

  // 3. trend ratio from other years that have an annual figure
  const ratios = []
  for (const f of frags.filter(x => x.quarter == null && x.fy !== targetFy)) {
    const r = revenueByYear[f.fy]
    if (r) ratios.push(scaleCost(f.value, r) / r)
  }
  if (ratios.length) return estimated(gm100(median(ratios)), { method: `trend ratio (${ratios.length}y)` })

  return null
}

// Full gross-margin SERIES from captured material-cost fragments + revenue.
// Per year: annual figure → calculated; 4 quarters → estimated (sum); else trend
// → estimated. This is the document FALLBACK for gross margin (primary source is
// Screener's Material Cost %, which fills grossProfit in the history rows).
// Returns { grossMargin: [{asOf, pct, tier, method}] } or {}.
export function deriveGrossMarginSeries(arData, revenueByYear) {
  const frags = arData?.derivedInputs?.materialCost || []
  const out = []
  for (const y of Object.keys(revenueByYear).map(Number)) {
    const est = estimateGrossMargin(frags, revenueByYear, y)
    if (est && est.value != null && est.value > 0 && est.value < 100) {
      out.push({ asOf: `FY${String(y).slice(-2)}`, pct: est.value, tier: est.tier, method: est.method })
    }
  }
  out.sort((a, b) => yearOf(a.asOf) - yearOf(b.asOf))
  return out.length ? { grossMargin: out } : {}
}

export function yearOf(asOf) {
  const s = String(asOf || '').toLowerCase()
  let m = s.match(/\b(19|20)\d{2}\b/)
  if (m) return Number(m[0])
  m = s.match(/fy\s*'?(\d{2,4})/)
  if (m) { const n = Number(m[1]); return n < 100 ? 2000 + n : n }
  m = s.match(/'?(\d{2})\b/)
  if (m) return 2000 + Number(m[1])
  return 0
}

// ── helpers ───────────────────────────────────────────────────────────────────
const gm = (rev, cost) => Math.round((rev - cost) / rev * 1000) / 10
const gm100 = ratio => Math.round((1 - ratio) * 1000) / 10

// crore↔absolute auto-scale so cost is a plausible fraction of revenue
function scaleCost(value, rev) {
  let c = value, guard = 0
  while (c / rev < 0.01 && guard < 4) { c *= 1e7; guard++ }
  return c
}
function median(a) {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
