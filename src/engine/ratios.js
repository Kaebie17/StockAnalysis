/**
 * src/engine/ratios.js
 * Calculates all derived ratios from the normalized data object.
 * Falls back to TTM values when historical data is sparse.
 */

export function calcRatios(data) {
  const { price, marketCap, sharesOutstanding, incomeHistory, balanceHistory,
          cashflowHistory, ttm, meta } = data

  const latest  = incomeHistory[incomeHistory.length - 1] || {}
  const latestB = balanceHistory[balanceHistory.length - 1] || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}
  const prev    = incomeHistory[incomeHistory.length - 2] || {}

  // Revenue CAGR (5 yr or available)
  const oldest = incomeHistory[0] || {}
  const n = incomeHistory.length - 1
  const revCagr = (n > 0 && oldest.revenue > 0 && latest.revenue > 0)
    ? (Math.pow(latest.revenue / oldest.revenue, 1 / n) - 1) * 100
    : null

  // EPS
  const eps = latest.eps ?? ttm.eps ?? safe(() =>
    latest.netIncome / (sharesOutstanding || marketCap / price)
  )

  // EV
  const totalDebt = latestB.totalDebt ?? ttm.totalDebt ?? 0
  const cash      = latestB.cash      ?? ttm.totalCash  ?? 0
  const ev        = marketCap != null ? marketCap + totalDebt - cash : null

  // EBITDA
  const ebitda = latest.ebitda ?? ttm.ebitda ?? safe(() =>
    latest.operatingProfit + (latest.depreciation || 0)
  )

  // Margins
  const rev = latest.revenue ?? ttm.revenue
  const ni  = latest.netIncome ?? ttm.netIncome
  const gp  = latest.grossProfit ?? ttm.grossProfit

  const grossMargin   = pct(gp, rev)     ?? pct100(ttm.grossMargins)
  const ebitdaMargin  = pct(ebitda, rev) ?? pct100(ttm.ebitdaMargins)
  const netMargin     = pct(ni, rev)     ?? pct100(ttm.profitMargins)
  const operatingMargin = pct(latest.operatingProfit, rev)

  // Leverage
  const totalEquity = latestB.totalEquity
  const de = div(totalDebt, totalEquity) ?? ttm.debtToEquity
  const netDebt = totalDebt != null ? totalDebt - cash : null

  // Returns
  const roe  = pct(ni, totalEquity) ?? pct100(ttm.roe)
  const roce = safe(() => pct(ebitda, (totalEquity + totalDebt - cash)))

  // Valuation multiples
  const pe         = div(price, eps)             ?? meta.pe
  const pb         = div(price, safe(() => totalEquity / sharesOutstanding)) ?? meta.pb
  const ps         = div(marketCap, rev)
  const evEbitda   = div(ev, ebitda)
  const evRevenue  = div(ev, rev)

  // FCF
  const fcf         = latestCF.freeCashFlow ?? ttm.freeCashflow
  const fcfYield    = div(fcf, marketCap) ? (fcf / marketCap) * 100 : null
  const fcfConversion = div(fcf, ni) ? (fcf / ni) * 100 : null

  // Interest coverage
  const interestCoverage = div(ebitda, latest.interest)

  // Graham Number
  const bookPerShare = safe(() => totalEquity / sharesOutstanding) ?? safe(() =>
    meta.bookValue // from Screener
  )
  const grahamNumber = (eps > 0 && bookPerShare > 0)
    ? Math.sqrt(22.5 * eps * bookPerShare) : null

  // YoY growth
  const revenueGrowthYoY = pct(latest.revenue - (prev.revenue || 0), prev.revenue) ?? pct100(ttm.revenueGrowth)
  const netIncomeGrowthYoY = pct(latest.netIncome - (prev.netIncome || 0), prev.netIncome) ?? pct100(ttm.earningsGrowth)

  return {
    // Core price data
    price, marketCap, ev,
    // Per share
    eps, bookPerShare, grahamNumber,
    // Valuation multiples
    pe, pb, ps, evEbitda, evRevenue,
    // Margins (%)
    grossMargin, ebitdaMargin, netMargin, operatingMargin,
    // Returns (%)
    roe, roce,
    // Leverage
    totalDebt, totalEquity, cash, netDebt, de, interestCoverage,
    // Growth (%)
    revCagr, revenueGrowthYoY, netIncomeGrowthYoY,
    // Cash flow
    fcf, fcfYield, fcfConversion,
    operatingCF: latestCF.operatingCF ?? ttm.operatingCashflow,
    // Misc
    divYield: meta.divYield, beta: meta.beta,
    high52: meta.high52, low52: meta.low52,
    // Raw for reference
    revenue: rev, netIncome: ni, ebitda, grossProfit: gp
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safe(fn) { try { const v = fn(); return isFinite(v) ? v : null } catch { return null } }
function div(a, b) { return (a != null && b != null && b !== 0) ? a / b : null }
function pct(a, b) { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v) { return v != null ? v * 100 : null }
