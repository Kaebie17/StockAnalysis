/**
 * src/engine/valuation.js — All models calculated from raw engine values.
 * Reads scalar values from ratios output (not tagged — pure numbers).
 */
import { getApplicableModels } from './stage.js'

export function runValuation(data, ratioResult, stage, sectorType, assumptions = {}) {
  const modelMeta = getApplicableModels(stage, sectorType)
  const r = ratioResult  // has both scalar fields and .ratios tagged fields

  const {
    wacc       = 0.10,
    termGrowth = 0.03,
    projYears  = 10,
    sectorPe   = clamp(r.ratios.pe?.value, 8, 50) ?? 20,
    sectorEvEb = 12,
    growthRate = estimateGrowth(r)
  } = assumptions

  const results = {}

  // DCF
  if (isApplicable('dcf', modelMeta) && r.fcf > 0 && r.shares) {
    let pv = 0, cf = r.fcf
    for (let i = 1; i <= projYears; i++) {
      cf *= (1 + Math.max(growthRate * Math.pow(0.85, i-1), termGrowth))
      pv += cf / Math.pow(1 + wacc, i)
    }
    const tv  = (cf * (1 + termGrowth)) / (wacc - termGrowth)
    const eq  = pv + tv / Math.pow(1 + wacc, projYears) + (r.cash || 0) - (r.totalDebt || 0)
    results.dcf = eq / r.shares
  }

  // P/E
  if (isApplicable('pe', modelMeta) && r.eps > 0) {
    results.pe = r.eps * sectorPe
  }

  // EV/EBITDA
  if (isApplicable('evEbitda', modelMeta) && r.ebitda && r.shares) {
    results.evEbitda = (r.ebitda * sectorEvEb + (r.cash || 0) - (r.totalDebt || 0)) / r.shares
  }

  // P/B
  if (isApplicable('pb', modelMeta) && r.bookPerShare) {
    const targetPb = ['insurance','bank','nbfc'].includes(sectorType)
      ? clamp(r.ratios.pb?.value ?? 2, 1, 6)
      : clamp((r.roe || 12) / 8, 0.8, 5)
    results.pb = r.bookPerShare * targetPb
  }

  // P/S
  if (isApplicable('ps', modelMeta) && r.revenue && r.shares) {
    results.ps = (r.revenue / r.shares) * clamp((r.ratios.netMargin?.value || 5) / 8, 0.3, 6)
  }

  // Graham
  if (isApplicable('graham', modelMeta) && r.grahamNumber) {
    results.graham = r.grahamNumber
  }

  // EV/Gross Profit
  if (isApplicable('evGrossProfit', modelMeta) && r.opProfit && r.shares) {
    results.evGrossProfit = (r.opProfit * 8 + (r.cash || 0) - (r.totalDebt || 0)) / r.shares
  }

  // Weighted consensus — only applicable models
  const weights = { dcf: 3, pe: 2, evEbitda: 2, pb: 1.5, ps: 1, graham: 1, evGrossProfit: 1 }
  const valid = modelMeta.applicable.filter(m => results[m] > 0)
  const totalW = valid.reduce((s, m) => s + weights[m], 0)
  const fairValue = totalW > 0
    ? valid.reduce((s, m) => s + results[m] * weights[m], 0) / totalW : null

  const upside = fairValue != null && r.price > 0
    ? ((fairValue - r.price) / r.price) * 100 : null

  const signal = upside == null ? 'UNKNOWN'
    : upside > 15  ? 'UNDERVALUED'
    : upside < -15 ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // Reverse DCF
  let impliedGrowth = null
  if (r.fcf > 0 && r.price > 0 && r.shares) {
    const targetEV = r.price * r.shares + (r.totalDebt || 0) - (r.cash || 0)
    impliedGrowth = solveGrowth(r.fcf, targetEV, wacc, termGrowth, projYears)
  }

  return { models: results, modelMeta, fairValue, upside, signal, impliedGrowth,
           assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb } }
}

function isApplicable(m, meta) { return meta.applicable.includes(m) || meta.caution.includes(m) }
function estimateGrowth(r) {
  const g = r.ratios.revCagr?.value != null ? r.ratios.revCagr.value / 100
    : r.ratios.revGrowthYoY?.value != null ? r.ratios.revGrowthYoY.value / 100 : 0.08
  return Math.max(Math.min(g, 0.35), 0.02)
}
function clamp(v, min, max) { return v == null ? null : Math.max(min, Math.min(max, v)) }
function solveGrowth(fcf0, tEV, wacc, tg, yrs) {
  let lo = -0.2, hi = 0.6
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const ev = dcfEV(fcf0, mid, wacc, tg, yrs)
    if (Math.abs(ev - tEV) < 1e5) break
    ev > tEV ? (hi = mid) : (lo = mid)
  }
  return ((lo + hi) / 2) * 100
}
function dcfEV(f, g, w, tg, yrs) {
  let pv = 0, cf = f
  for (let i = 1; i <= yrs; i++) {
    cf *= (1 + Math.max(g * Math.pow(0.85, i-1), tg))
    pv += cf / Math.pow(1 + w, i)
  }
  return pv + (cf * (1 + tg)) / (w - tg) / Math.pow(1 + w, yrs)
}
