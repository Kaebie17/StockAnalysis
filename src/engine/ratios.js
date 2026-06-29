/**
 * src/engine/ratios.js
 * Sector-aware ratio calculation. Insurance/bank companies get different fields.
 */
import { detectSectorType, SECTOR_TYPES } from './stage.js'

export function calcRatios(data) {
  const sectorType = detectSectorType(data)

  if (sectorType === SECTOR_TYPES.INSURANCE || sectorType === SECTOR_TYPES.BANK || sectorType === SECTOR_TYPES.NBFC) {
    return calcFinancialRatios(data, sectorType)
  }
  return calcStandardRatios(data)
}

// ─── Standard (industrial/tech/consumer) ─────────────────────────────────────

function calcStandardRatios(data) {
  const { price, marketCap, sharesOutstanding, incomeHistory,
          balanceHistory, cashflowHistory, ttm, meta } = data

  const latest   = incomeHistory[incomeHistory.length - 1]   || {}
  const prev     = incomeHistory[incomeHistory.length - 2]   || {}
  const oldest   = incomeHistory[0]                          || {}
  const latestB  = balanceHistory[balanceHistory.length - 1]  || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}

  const n = incomeHistory.length - 1
  const revCagr = (n > 0 && oldest.revenue > 0 && latest.revenue > 0)
    ? (Math.pow(latest.revenue / oldest.revenue, 1 / n) - 1) * 100 : null

  const shares = sharesOutstanding ?? (marketCap && price ? marketCap / price : null)

  const revenue     = latest.revenue     ?? ttm.revenue
  const netIncome   = latest.netIncome   ?? ttm.netIncome
  const grossProfit = latest.grossProfit ?? ttm.grossProfit
  const opProfit    = latest.operatingProfit

  // EBITDA: statement → TTM financialData → compute from op profit + depreciation
  const ebitda = latest.ebitda
    ?? ttm.ebitda
    ?? (opProfit != null && latest.depreciation != null ? opProfit + latest.depreciation : null)
    ?? (opProfit != null ? opProfit : null) // last resort: use op profit as proxy

  const totalDebt  = latestB.totalDebt  ?? ttm.totalDebt  ?? 0
  const cash       = latestB.cash       ?? ttm.totalCash  ?? 0
  const equity     = latestB.totalEquity

  const ev = marketCap != null ? marketCap + totalDebt - cash : null

  const eps = latest.eps ?? ttm.eps
    ?? (netIncome && shares ? netIncome / shares : null)

  const grossMargin     = pct(grossProfit, revenue)  ?? pct100(ttm.grossMargins)
  const ebitdaMargin    = pct(ebitda, revenue)       ?? pct100(ttm.ebitdaMargins)
  const netMargin       = pct(netIncome, revenue)    ?? pct100(ttm.profitMargins)
  const operatingMargin = pct(opProfit, revenue)     ?? pct100(ttm.operatingMargins)

  const roe  = pct(netIncome, equity) ?? pct100(ttm.roe)
  const roce = pct(ebitda, equity != null ? equity + totalDebt - cash : null)
  const roa  = pct100(ttm.returnOnAssets)

  const de = div(totalDebt, equity) ?? ttm.debtToEquity
  const netDebt = totalDebt - cash
  const interestCoverage = div(ebitda, latest.interest)

  const bookPerShare = div(equity, shares) ?? meta.bookValue
  const grahamNumber = (eps > 0 && bookPerShare > 0) ? Math.sqrt(22.5 * eps * bookPerShare) : null

  const pe       = div(price, eps)                   ?? meta.pe
  const pb       = div(price, bookPerShare)          ?? meta.pb
  const ps       = div(marketCap, revenue)
  const evEbitda = div(ev, ebitda)
  const evRev    = div(ev, revenue)

  const fcf = latestCF.freeCashFlow ?? ttm.freeCashflow
  const fcfYield      = pct(fcf, marketCap)
  const fcfConversion = pct(fcf, netIncome)

  const revenueGrowthYoY   = pct(latest.revenue  - (prev.revenue  || 0), prev.revenue)  ?? pct100(ttm.revenueGrowth)
  const netIncomeGrowthYoY = pct(latest.netIncome - (prev.netIncome || 0), prev.netIncome) ?? pct100(ttm.earningsGrowth)

  return {
    sectorType: 'standard',
    price, marketCap, ev, shares,
    eps, bookPerShare, grahamNumber,
    pe, pb, ps, evEbitda, evRevenue: evRev,
    grossMargin, ebitdaMargin, netMargin, operatingMargin,
    roe, roce, roa,
    totalDebt, totalEquity: equity, cash, netDebt, de, interestCoverage,
    revCagr, revenueGrowthYoY, netIncomeGrowthYoY,
    fcf, fcfYield, fcfConversion,
    operatingCF: latestCF.operatingCF ?? ttm.operatingCashflow,
    revenue, netIncome, ebitda, grossProfit,
    divYield: meta.divYield, beta: meta.beta,
    high52: meta.high52, low52: meta.low52,
    avgVolume: meta.avgVolume, change1d: meta.change1d, volume: meta.volume
  }
}

// ─── Financial sector (insurance / bank / NBFC) ───────────────────────────────
// These companies don't have "revenue" in the traditional sense.
// For insurance: netPremiumIncome is the revenue proxy.
// For banks: netInterestIncome is the revenue proxy.
// We pull what we can from TTM + screener income rows + meta.

function calcFinancialRatios(data, sectorType) {
  const { price, marketCap, sharesOutstanding, incomeHistory,
          balanceHistory, ttm, meta } = data

  const latest  = incomeHistory[incomeHistory.length - 1] || {}
  const latestB = balanceHistory[balanceHistory.length - 1] || {}

  const shares = sharesOutstanding ?? (marketCap && price ? marketCap / price : null)

  // For insurance/banks, "revenue" = total income (netIncome is most reliable)
  // Screener provides this correctly; Yahoo's totalRevenue is sometimes empty
  const revenue   = latest.revenue   ?? ttm.revenue   ?? null
  const netIncome = latest.netIncome ?? ttm.netIncome ?? null
  const equity    = latestB.totalEquity ?? null

  const eps = latest.eps ?? ttm.eps
    ?? (netIncome && shares ? netIncome / shares : null)

  const bookPerShare = div(equity, shares) ?? meta.bookValue

  // P/E and P/B are THE primary metrics for financial companies
  const pe = div(price, eps)        ?? meta.pe
  const pb = div(price, bookPerShare) ?? meta.pb
  const ps = div(marketCap, revenue)

  const netMargin = pct(netIncome, revenue) ?? pct100(ttm.profitMargins)
  const roe = pct(netIncome, equity) ?? pct100(ttm.roe)

  const n = incomeHistory.length - 1
  const oldest = incomeHistory[0] || {}
  const revCagr = (n > 0 && oldest.revenue > 0 && latest.revenue > 0)
    ? (Math.pow(latest.revenue / oldest.revenue, 1 / n) - 1) * 100 : null

  return {
    sectorType,
    price, marketCap, ev: null, shares,
    eps, bookPerShare, grahamNumber: null,
    pe, pb, ps,
    evEbitda: null, evRevenue: null,   // not applicable
    grossMargin: null, ebitdaMargin: null,
    netMargin, operatingMargin: null,
    roe, roce: null, roa: pct100(ttm.returnOnAssets),
    totalDebt: null, totalEquity: equity, cash: null,
    netDebt: null, de: null, interestCoverage: null,
    revCagr, revenueGrowthYoY: pct100(ttm.revenueGrowth), netIncomeGrowthYoY: pct100(ttm.earningsGrowth),
    fcf: null, fcfYield: null, fcfConversion: null, operatingCF: null,
    revenue, netIncome, ebitda: null, grossProfit: null,
    divYield: meta.divYield, beta: meta.beta,
    high52: meta.high52, low52: meta.low52,
    avgVolume: meta.avgVolume, change1d: meta.change1d, volume: meta.volume
  }
}

function div(a, b) { return (a != null && b != null && b !== 0) ? a / b : null }
function pct(a, b) { const d = div(a, b); return d != null ? d * 100 : null }
function pct100(v) { return v != null ? v * 100 : null }
