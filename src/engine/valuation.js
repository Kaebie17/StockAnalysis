/**
 * src/engine/valuation.js
 */

const MODELS = ['dcf', 'pe', 'evEbitda', 'pb', 'ps', 'graham', 'evGrossProfit']

export function runValuation(data, ratios, assumptions = {}) {
  const {
    wacc         = 0.10,
    termGrowth   = 0.03,
    projYears    = 10,
    sectorPe     = ratios.pe ? Math.min(Math.max(ratios.pe, 8), 35) : 20,
    sectorEvEb   = 12,
    growthRate   = estimateGrowthRate(ratios)
  } = assumptions

  const results = {}

  // ── DCF ──────────────────────────────────────────────────────────────────────
  const fcf0 = ratios.fcf ?? ratios.operatingCF
  if (fcf0 != null && fcf0 > 0 && data.marketCap) {
    const shares = data.sharesOutstanding ?? (data.marketCap / ratios.price)
    let pv = 0
    let cf = fcf0
    for (let i = 1; i <= projYears; i++) {
      const g = growthRate * Math.pow(0.85, i - 1) // fading growth
      cf *= (1 + Math.max(g, termGrowth))
      pv += cf / Math.pow(1 + wacc, i)
    }
    const tv = (cf * (1 + termGrowth)) / (wacc - termGrowth)
    const pvTv = tv / Math.pow(1 + wacc, projYears)
    const enterpriseValue = pv + pvTv
    const equityValue = enterpriseValue + (ratios.cash || 0) - (ratios.totalDebt || 0)
    results.dcf = shares > 0 ? equityValue / shares : null
  }

  // ── P/E based ─────────────────────────────────────────────────────────────────
  if (ratios.eps != null && ratios.eps > 0) {
    results.pe = ratios.eps * sectorPe
  }

  // ── EV/EBITDA ─────────────────────────────────────────────────────────────────
  if (ratios.ebitda != null && data.marketCap) {
    const shares = data.sharesOutstanding ?? (data.marketCap / ratios.price)
    const impliedEV = ratios.ebitda * sectorEvEb
    const impliedEquity = impliedEV + (ratios.cash || 0) - (ratios.totalDebt || 0)
    results.evEbitda = shares > 0 ? impliedEquity / shares : null
  }

  // ── P/B ───────────────────────────────────────────────────────────────────────
  if (ratios.bookPerShare != null) {
    const targetPb = Math.min(Math.max(ratios.roe / 10, 1), 4) // ROE-anchored
    results.pb = ratios.bookPerShare * targetPb
  }

  // ── P/S ───────────────────────────────────────────────────────────────────────
  if (ratios.revenue != null && data.marketCap && ratios.price) {
    const revenuePerShare = ratios.revenue / (data.marketCap / ratios.price)
    const sectorPs = Math.min(Math.max(ratios.netMargin / 10, 0.5), 5)
    results.ps = revenuePerShare * sectorPs
  }

  // ── Graham Number ─────────────────────────────────────────────────────────────
  if (ratios.grahamNumber != null) {
    results.graham = ratios.grahamNumber
  }

  // ── EV / Gross Profit ─────────────────────────────────────────────────────────
  if (ratios.grossProfit != null && data.marketCap) {
    const shares = data.sharesOutstanding ?? (data.marketCap / ratios.price)
    const impliedEV = ratios.grossProfit * 8 // typical 8× gross profit
    const impliedEquity = impliedEV + (ratios.cash || 0) - (ratios.totalDebt || 0)
    results.evGrossProfit = shares > 0 ? impliedEquity / shares : null
  }

  // ── Weighted consensus ────────────────────────────────────────────────────────
  const weights = { dcf: 3, pe: 2, evEbitda: 2, pb: 1, ps: 1, graham: 1, evGrossProfit: 1 }
  const validModels = MODELS.filter(m => results[m] != null && results[m] > 0)
  const totalWeight = validModels.reduce((s, m) => s + weights[m], 0)
  const fairValue = totalWeight > 0
    ? validModels.reduce((s, m) => s + results[m] * weights[m], 0) / totalWeight
    : null

  const upside = (fairValue != null && ratios.price > 0)
    ? ((fairValue - ratios.price) / ratios.price) * 100 : null

  const signal = upside == null ? 'UNKNOWN'
    : upside > 15  ? 'UNDERVALUED'
    : upside < -15 ? 'OVERVALUED'
    : 'FAIRLY_VALUED'

  // ── Reverse DCF ───────────────────────────────────────────────────────────────
  let impliedGrowth = null
  if (ratios.fcf != null && ratios.fcf > 0 && ratios.price > 0) {
    const shares = data.sharesOutstanding ?? (data.marketCap / ratios.price)
    const targetEV = ratios.price * shares + (ratios.totalDebt || 0) - (ratios.cash || 0)
    impliedGrowth = solveImpliedGrowth(ratios.fcf, targetEV, wacc, termGrowth, projYears)
  }

  return {
    models: results,
    fairValue,
    upside,
    signal,
    impliedGrowth,
    assumptions: { wacc, termGrowth, projYears, growthRate, sectorPe, sectorEvEb }
  }
}

function estimateGrowthRate(ratios) {
  const g = ratios.revCagr != null
    ? ratios.revCagr / 100
    : ratios.revenueGrowthYoY != null
    ? ratios.revenueGrowthYoY / 100
    : 0.08
  return Math.max(Math.min(g, 0.30), 0.02)
}

function solveImpliedGrowth(fcf0, targetEV, wacc, termGrowth, years) {
  // Binary search for growth rate that matches target EV
  let lo = -0.2, hi = 0.6
  for (let iter = 0; iter < 50; iter++) {
    const mid = (lo + hi) / 2
    const ev = dcfEV(fcf0, mid, wacc, termGrowth, years)
    if (Math.abs(ev - targetEV) < 1e6) break
    if (ev > targetEV) hi = mid; else lo = mid
  }
  return ((lo + hi) / 2) * 100
}

function dcfEV(fcf0, growth, wacc, termGrowth, years) {
  let pv = 0, cf = fcf0
  for (let i = 1; i <= years; i++) {
    const g = growth * Math.pow(0.85, i - 1)
    cf *= (1 + Math.max(g, termGrowth))
    pv += cf / Math.pow(1 + wacc, i)
  }
  const tv = (cf * (1 + termGrowth)) / (wacc - termGrowth)
  return pv + tv / Math.pow(1 + wacc, years)
}
