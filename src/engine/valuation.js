/**
 * src/engine/valuation.js
 * Stage + sector aware. Only runs applicable models. Never shows — for applicable ones.
 */
import { getApplicableModels } from './stage.js'

export function runValuation(data, ratios, stage, sectorType, assumptions = {}) {
  const modelMeta = getApplicableModels(stage, sectorType)

  const {
    wacc       = 0.10,
    termGrowth = 0.03,
    projYears  = 10,
    sectorPe   = clamp(ratios.pe, 8, 50) ?? 20,
    sectorEvEb = 12,
    growthRate = estimateGrowth(ratios)
  } = assumptions

  const results = {}

  // ── DCF ──────────────────────────────────────────────────────────────────────
  if (isApplicable('dcf', modelMeta)) {
    const fcf0 = ratios.fcf ?? ratios.operatingCF
    if (fcf0 != null && fcf0 > 0 && ratios.marketCap && ratios.shares) {
      let pv = 0, cf = fcf0
      for (let i = 1; i <= projYears; i++) {
        const g = growthRate * Math.pow(0.85, i - 1)
        cf *= (1 + Math.max(g, termGrowth))
        pv += cf / Math.pow(1 + wacc, i)
      }
      const tv   = (cf * (1 + termGrowth)) / (wacc - termGrowth)
      const pvTv = tv / Math.pow(1 + wacc, projYears)
      const eqVal = pv + pvTv + (ratios.cash || 0) - (ratios.totalDebt || 0)
      results.dcf = ratios.shares > 0 ? eqVal / ratios.shares : null
    }
  }

  // ── P/E ───────────────────────────────────────────────────────────────────────
  if (isApplicable('pe', modelMeta) && ratios.eps != null && ratios.eps > 0) {
    results.pe = ratios.eps * sectorPe
  }

  // ── EV/EBITDA ─────────────────────────────────────────────────────────────────
  if (isApplicable('evEbitda', modelMeta) && ratios.ebitda && ratios.shares) {
    const impliedEV  = ratios.ebitda * sectorEvEb
    const impliedEq  = impliedEV + (ratios.cash || 0) - (ratios.totalDebt || 0)
    results.evEbitda = impliedEq / ratios.shares
  }

  // ── P/B ───────────────────────────────────────────────────────────────────────
  if (isApplicable('pb', modelMeta) && ratios.bookPerShare) {
    // For financial companies use actual meta.pb as target; for others derive from ROE
    const targetPb = sectorType === 'insurance' || sectorType === 'bank' || sectorType === 'nbfc'
      ? clamp(ratios.pb ?? 2, 1, 6)
      : clamp((ratios.roe || 12) / 8, 0.8, 5)
    results.pb = ratios.bookPerShare * targetPb
  }

  // ── P/S ───────────────────────────────────────────────────────────────────────
  if (isApplicable('ps', modelMeta) && ratios.revenue && ratios.shares) {
    const revPerShare = ratios.revenue / ratios.shares
    const targetPs = clamp((ratios.netMargin || 5) / 8, 0.3, 6)
    results.ps = revPerShare * targetPs
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  if (isApplicable('graham', modelMeta) && ratios.grahamNumber) {
    results.graham = ratios.grahamNumber
  }

  // ── EV / Gross Profit ─────────────────────────────────────────────────────────
  if (isApplicable('evGrossProfit', modelMeta) && ratios.grossProfit && ratios.shares) {
    const impliedEV  = ratios.grossProfit * 8
    const impliedEq  = impliedEV + (ratios.cash || 0) - (ratios.totalDebt || 0)
    results.evGrossProfit = impliedEq / ratios.shares
  }

  // ── Weighted consensus (only applicable models) ───────────────────────────────
  const weights = { dcf: 3, pe: 2, evEbitda: 2, pb: 1.5, ps: 1, graham: 1, evGrossProfit: 1 }
  const valid = modelMeta.applicable.filter(m => results[m] != null && results[m] > 0)
  const totalW = valid.reduce((s, m) => s + weights[m], 0)
  const fairValue = totalW > 0
    ? valid.reduce((s, m) => s + results[m] * weights[m], 0) / totalW
    : null

  const upside = fairValue != null && ratios.price > 0
    ? ((fairValue - ratios.price) / ratios.price) * 100 : null

  const signal = upside == null ? 'UNKNOWN'
    : upside > 15  ? 'UNDERVALUED'
    : upside < -15 ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // ── Reverse DCF ───────────────────────────────────────────────────────────────
  let impliedGrowth = null
  if (ratios.fcf > 0 && ratios.price > 0 && ratios.shares) {
    const targetEV = ratios.price * ratios.shares + (ratios.totalDebt || 0) - (ratios.cash || 0)
    impliedGrowth = solveGrowth(ratios.fcf, targetEV, wacc, termGrowth, projYears)
  }

  return {
    models: results,
    modelMeta,
    fairValue,
    upside,
    signal,
    impliedGrowth,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb }
  }
}

function isApplicable(model, meta) {
  return meta.applicable.includes(model) || meta.caution.includes(model)
}

function estimateGrowth(ratios) {
  const g = ratios.revCagr != null ? ratios.revCagr / 100
    : ratios.revenueGrowthYoY != null ? ratios.revenueGrowthYoY / 100
    : 0.08
  return Math.max(Math.min(g, 0.35), 0.02)
}

function clamp(v, min, max) {
  if (v == null) return null
  return Math.max(min, Math.min(max, v))
}

function solveGrowth(fcf0, targetEV, wacc, termGrowth, years) {
  let lo = -0.2, hi = 0.6
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    const ev  = dcfEV(fcf0, mid, wacc, termGrowth, years)
    if (Math.abs(ev - targetEV) < 1e5) break
    ev > targetEV ? (hi = mid) : (lo = mid)
  }
  return ((lo + hi) / 2) * 100
}

function dcfEV(fcf0, g, wacc, tg, years) {
  let pv = 0, cf = fcf0
  for (let i = 1; i <= years; i++) {
    cf *= (1 + Math.max(g * Math.pow(0.85, i-1), tg))
    pv += cf / Math.pow(1 + wacc, i)
  }
  return pv + (cf * (1 + tg)) / (wacc - tg) / Math.pow(1 + wacc, years)
}
