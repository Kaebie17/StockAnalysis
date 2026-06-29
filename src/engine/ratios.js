/**
 * src/engine/ratios.js
 * All derived ratios. Falls back aggressively so valuation always has numbers.
 */

export function calcRatios(data) {
  const { price, marketCap, sharesOutstanding, incomeHistory,
          balanceHistory, cashflowHistory, ttm, meta } = data

  const latest   = incomeHistory[incomeHistory.length - 1]   || {}
  const prev     = incomeHistory[incomeHistory.length - 2]   || {}
  const oldest   = incomeHistory[0]                          || {}
  const latestB  = balanceHistory[balanceHistory.length - 1]  || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}

  // Revenue CAGR
  const n = incomeHistory.length - 1
  const revCagr = (n > 0 && oldest.revenue > 0 && latest.revenue > 0)
    ? (Math.pow(latest.revenue / oldest.revenue, 1 / n) - 1) * 100 : null

  // Shares — estimate from marketCap/price if not given
  const shares = sharesOutstanding
    ?? (marketCap && price ? marketCap / price : null)

  // EPS — statement → ttm → derive
  const eps = latest.eps
    ?? ttm.eps
    ?? (latest.netIncome && shares ? latest.netIncome / shares : null)
    ?? (ttm.netIncome    && shares ? ttm.netIncome    / shares : null)

  // Financials — statement then TTM
  const revenue     = latest.revenue     ?? ttm.revenue
  const netIncome   = latest.netIncome   ?? ttm.netIncome
  const grossProfit = latest.grossProfit ?? ttm.grossProfit
  const ebitda      = latest.ebitda      ?? ttm.ebitda
    ?? (latest.operatingProfit != null ? latest.operatingProfit + (latest.depreciation || 0) : null)
  const totalDebt   = latestB.totalDebt  ?? ttm.totalDebt   ?? 0
  const cash        = latestB.cash       ?? ttm.totalCash   ?? 0
  const totalEquity = latestB.totalEquity

  // Enterprise Value
  const ev = marketCap != null ? marketCap + totalDebt - cash : null

  // Margins
  const grossMargin    = pct(grossProfit, revenue)     ?? pct100(ttm.grossMargins)
  const ebitdaMargin   = pct(ebitda, revenue)          ?? pct100(ttm.ebitdaMargins)
  const netMargin      = pct(netIncome, revenue)       ?? pct100(ttm.profitMargins)
  const operatingMargin = pct(latest.operatingProfit, revenue) ?? pct100(ttm.operatingMargins)

  // Returns
  const roe  = pct(netIncome, totalEquity)       ?? pct100(ttm.roe)
  const roce = pct(ebitda,    totalEquity != null ? totalEquity + totalDebt - cash : null)
  const roa  = pct100(ttm.returnOnAssets)

  // Leverage
  const de = div(totalDebt, totalEquity) ?? ttm.debtToEquity
  const netDebt = totalDebt != null ? totalDebt - cash : null
  const interestCoverage = div(ebitda, latest.interest)

  // Valuation multiples
  // PE: statement-derived → v7 quote (meta.pe) → summaryDetail
  const pe       = div(price, eps)           ?? meta.pe
  const pb       = div(price, div(totalEquity, shares)) ?? meta.pb
  const ps       = div(marketCap, revenue)
  const evEbitda = div(ev, ebitda)
  const evRev    = div(ev, revenue)

  // Book value per share
  const bookPerShare = div(totalEquity, shares) ?? meta.bookValue

  // Graham Number
  const grahamNumber = (eps > 0 && bookPerShare > 0)
    ? Math.sqrt(22.5 * eps * bookPerShare) : null

  // FCF
  const fcf = latestCF.freeCashFlow ?? ttm.freeCashflow
  const fcfYield      = marketCap && fcf ? (fcf / marketCap) * 100 : null
  const fcfConversion = netIncome  && fcf ? (fcf / netIncome) * 100 : null

  // Growth
  const revenueGrowthYoY   = pct(latest.revenue  - (prev.revenue  || 0), prev.revenue)  ?? pct100(ttm.revenueGrowth)
  const netIncomeGrowthYoY = pct(latest.netIncome - (prev.netIncome || 0), prev.netIncome) ?? pct100(ttm.earningsGrowth)

  return {
    price, marketCap, ev, shares,
    eps, bookPerShare, grahamNumber,
    pe, pb, ps, evEbitda, evRevenue: evRev,
    grossMargin, ebitdaMargin, netMargin, operatingMargin,
    roe, roce, roa,
    totalDebt, totalEquity, cash, netDebt, de, interestCoverage,
    revCagr, revenueGrowthYoY, netIncomeGrowthYoY,
    fcf, fcfYield, fcfConversion,
    operatingCF: latestCF.operatingCF ?? ttm.operatingCashflow,
    revenue, netIncome, ebitda, grossProfit,
    divYield: meta.divYield, beta: meta.beta,
    high52: meta.high52, low52: meta.low52,
    avgVolume: meta.avgVolume, change1d: meta.change1d,
    volume: meta.volume
  }
}

function safe(fn) { try { const v = fn(); return isFinite(v) ? v : null } catch { return null } }
function div(a, b) { return (a != null && b != null && b !== 0) ? a / b : null }
function pct(a, b) { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v)  { return v != null ? v * 100 : null }
