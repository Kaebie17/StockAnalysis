/**
 * src/engine/normalize.js
 *
 * Converts raw API responses into a standard data object.
 *
 * Yahoo data strategy (June 2026):
 * - Price/volume: v8/chart → result[0].indicators.quote[0] for OHLCV,
 *   result[0].indicators.adjclose[0].adjclose for adjusted close.
 * - Financials: incomeStatementHistory (NOT fundamentalsTimeSeries — empty for Indian stocks).
 * - TTM: financialData module.
 */

export function normalize(source, raw) {
  if (source === 'yahoo')   return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'csv')     return raw // already normalized by App.jsx
  throw new Error(`Unknown source: ${source}`)
}

// ─── Yahoo ────────────────────────────────────────────────────────────────────

function normalizeYahoo({ ticker, chart, quote }) {
  const qs  = quote?.quoteSummary?.result?.[0] || {}
  const priceModule   = qs.price              || {}
  const finData       = qs.financialData      || {}
  const keyStats      = qs.defaultKeyStatistics || {}
  const summaryDetail = qs.summaryDetail      || {}
  const assetProfile  = qs.assetProfile       || {}

  // ── Price history from v8 chart ────────────────────────────────────────────
  // Structure: chart.chart.result[0]
  //   .timestamp[]                          — unix seconds
  //   .indicators.quote[0].open/high/low/close/volume[]
  //   .indicators.adjclose[0].adjclose[]    — split/dividend adjusted close
  const chartResult = chart?.chart?.result?.[0]
  const timestamps  = chartResult?.timestamp || []
  const q0          = chartResult?.indicators?.quote?.[0]          || {}
  const adjClose    = chartResult?.indicators?.adjclose?.[0]?.adjclose || []

  const priceHistory = timestamps.map((ts, i) => {
    const close = adjClose[i] ?? q0.close?.[i] ?? null
    return {
      date:   new Date(ts * 1000).toISOString().slice(0, 10),
      open:   q0.open?.[i]   ?? null,
      high:   q0.high?.[i]   ?? null,
      low:    q0.low?.[i]    ?? null,
      close,                              // use adjClose preferentially
      volume: q0.volume?.[i] ?? null      // allow null — non-trading days
    }
  }).filter(d => d.close !== null)        // only drop if close itself is null

  // ── Income history from incomeStatementHistory ─────────────────────────────
  // This is the reliable source for ALL markets including Indian stocks.
  // fundamentalsTimeSeries is intentionally NOT used — empty for .NS/.BO.
  const incStmt = qs.incomeStatementHistory?.incomeStatementHistory || []
  const incomeHistory = incStmt.map(s => ({
    year:            yearOf(rv(s.endDate)),
    revenue:         rv(s.totalRevenue),
    grossProfit:     rv(s.grossProfit),
    operatingProfit: rv(s.operatingIncome) ?? rv(s.ebit),
    ebitda:          null, // not in this module; computed in ratios.js
    netIncome:       rv(s.netIncome),
    interest:        rv(s.interestExpense),
    depreciation:    null,
    eps:             null  // from earnings module below
  })).filter(r => r.year && r.revenue != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // Supplement EPS from earnings module
  const epsHistory = (qs.earnings?.financialsChart?.yearly || [])
  epsHistory.forEach(e => {
    const yr = String(e.date)
    const row = incomeHistory.find(r => r.year === yr)
    if (row) row.eps = rv(e.earnings)
  })

  // ── Balance sheet ──────────────────────────────────────────────────────────
  const bsStmt = qs.balanceSheetHistory?.balanceSheetStatements || []
  const balanceHistory = bsStmt.map(s => ({
    year:            yearOf(rv(s.endDate)),
    totalAssets:     rv(s.totalAssets),
    totalDebt:       rv(s.longTermDebt) ?? rv(s.shortLongTermDebt) ?? 0,
    totalEquity:     rv(s.totalStockholderEquity),
    cash:            rv(s.cash) ?? rv(s.cashAndCashEquivalents) ?? 0,
    totalLiabilities: rv(s.totalLiab)
  })).filter(r => r.year && r.totalAssets != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // ── Cash flow ──────────────────────────────────────────────────────────────
  const cfStmt = qs.cashflowStatementHistory?.cashflowStatements || []
  const cashflowHistory = cfStmt.map(s => {
    const opCF  = rv(s.totalCashFromOperatingActivities)
    const capex = rv(s.capitalExpenditures)              // usually negative
    const fcf   = rv(s.freeCashFlow) ?? computeFCF(opCF, capex)
    return {
      year:        yearOf(rv(s.endDate)),
      operatingCF: opCF,
      investingCF: rv(s.totalCashflowsFromInvestingActivities),
      financingCF: rv(s.totalCashFromFinancingActivities),
      capex,
      freeCashFlow: fcf
    }
  }).filter(r => r.year && r.operatingCF != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // ── TTM from financialData module ──────────────────────────────────────────
  const ttm = {
    revenue:          rv(finData.totalRevenue),
    grossProfit:      rv(finData.grossProfits),
    ebitda:           rv(finData.ebitda),
    netIncome:        rv(finData.netIncomeToCommon),
    eps:              rv(finData.trailingEps)    ?? rv(keyStats.trailingEps),
    debtToEquity:     rv(finData.debtToEquity),
    roe:              rv(finData.returnOnEquity),
    ebitdaMargins:    rv(finData.ebitdaMargins),
    grossMargins:     rv(finData.grossMargins),
    profitMargins:    rv(finData.profitMargins),
    currentRatio:     rv(finData.currentRatio),
    quickRatio:       rv(finData.quickRatio),
    totalDebt:        rv(finData.totalDebt),
    totalCash:        rv(finData.totalCash),
    freeCashflow:     rv(finData.freeCashflow),
    operatingCashflow: rv(finData.operatingCashflow),
    revenueGrowth:    rv(finData.revenueGrowth),
    earningsGrowth:   rv(finData.earningsGrowth),
    operatingMargins: rv(finData.operatingMargins),
    returnOnAssets:   rv(finData.returnOnAssets)
  }

  return {
    ticker,
    name:              priceModule.longName || priceModule.shortName || ticker,
    source:            'yahoo',
    currency:          priceModule.currency || chartResult?.meta?.currency || 'USD',
    price:             rv(priceModule.regularMarketPrice),
    marketCap:         rv(priceModule.marketCap),
    sharesOutstanding: rv(keyStats.sharesOutstanding),
    priceHistory,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm,
    meta: {
      sector:      assetProfile.sector      || null,
      industry:    assetProfile.industry    || null,
      website:     assetProfile.website     || null,
      description: assetProfile.longBusinessSummary || null,
      exchange:    priceModule.exchangeName || null,
      pe:          rv(summaryDetail.trailingPE),
      forwardPe:   rv(summaryDetail.forwardPE),
      pb:          rv(keyStats.priceToBook),
      divYield:    rv(summaryDetail.dividendYield),
      beta:        rv(summaryDetail.beta),
      high52:      rv(summaryDetail.fiftyTwoWeekHigh),
      low52:       rv(summaryDetail.fiftyTwoWeekLow),
      avgVolume:   rv(summaryDetail.averageVolume),
      sharesFloat: rv(keyStats.floatShares)
    }
  }
}

// ─── Screener ─────────────────────────────────────────────────────────────────

function normalizeScreener(raw) {
  const CR = 1e7 // Crores → absolute INR

  const incomeHistory = (raw.incomeHistory || []).map(r => ({
    year:            r.year,
    revenue:         mul(r.revenue, CR),
    grossProfit:     mul(r.grossProfit, CR),
    operatingProfit: mul(r.operatingProfit, CR),
    ebitda:          r.ebitda != null
      ? r.ebitda * CR
      : computeEbitda(mul(r.operatingProfit, CR), mul(r.depreciation, CR)),
    netIncome:    mul(r.netIncome, CR),
    interest:     mul(r.interest, CR),
    depreciation: mul(r.depreciation, CR),
    eps:          r.eps  // already per-share, no scaling
  }))

  const balanceHistory = (raw.balanceHistory || []).map(r => ({
    year:            r.year,
    totalAssets:     mul(r.totalAssets, CR),
    totalDebt:       mul(r.totalDebt, CR),
    totalEquity:     mul(r.totalEquity, CR),
    cash:            mul(r.cash, CR),
    totalLiabilities: mul(r.totalLiabilities, CR)
  }))

  const cashflowHistory = (raw.cashflowHistory || []).map(r => {
    const opCF  = mul(r.operatingCF, CR)
    const capex = mul(r.capex, CR)
    return {
      year:         r.year,
      operatingCF:  opCF,
      investingCF:  mul(r.investingCF, CR),
      financingCF:  mul(r.financingCF, CR),
      capex,
      freeCashFlow: r.freeCashFlow != null ? r.freeCashFlow * CR : computeFCF(opCF, capex)
    }
  })

  const latest  = incomeHistory[incomeHistory.length - 1]  || {}
  const latestB = balanceHistory[balanceHistory.length - 1] || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}

  return {
    ticker:   raw.ticker,
    name:     raw.name || raw.ticker,
    source:   'screener',
    currency: 'INR',
    price:    raw.price,
    marketCap: raw.marketCap,
    sharesOutstanding: null,
    priceHistory: [],  // Screener doesn't provide price history
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm: {
      revenue:       latest.revenue,
      grossProfit:   latest.grossProfit,
      ebitda:        latest.ebitda,
      netIncome:     latest.netIncome,
      eps:           latest.eps,
      debtToEquity:  null,
      roe:           raw.ratios?.roe ? raw.ratios.roe / 100 : null,
      ebitdaMargins: latest.ebitda && latest.revenue ? latest.ebitda / latest.revenue : null,
      grossMargins:  latest.grossProfit && latest.revenue ? latest.grossProfit / latest.revenue : null,
      profitMargins: latest.netIncome && latest.revenue ? latest.netIncome / latest.revenue : null,
      totalDebt:     latestB.totalDebt,
      totalCash:     latestB.cash,
      freeCashflow:  latestCF.freeCashFlow,
      operatingCashflow: latestCF.operatingCF
    },
    meta: {
      sector: null, industry: null, website: null, description: null,
      exchange: 'NSE/BSE',
      pe: raw.ratios?.pe, pb: raw.ratios?.pb,
      divYield: raw.ratios?.divYield, bookValue: raw.ratios?.bookValue
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract .raw from Yahoo value objects {raw: 1234, fmt: "1,234"} or return number directly */
function rv(v) {
  if (v == null) return null
  if (typeof v === 'object' && 'raw' in v) return v.raw
  if (typeof v === 'number') return v
  return null
}

function mul(v, factor) { return v != null ? v * factor : null }

function yearOf(unixSeconds) {
  if (!unixSeconds) return null
  return new Date(unixSeconds * 1000).getFullYear().toString()
}

function computeFCF(operatingCF, capex) {
  if (operatingCF == null) return null
  // Capex from Yahoo is negative, so we subtract the absolute value
  return operatingCF - Math.abs(capex || 0)
}

function computeEbitda(operatingProfit, depreciation) {
  if (operatingProfit == null) return null
  return operatingProfit + (depreciation || 0)
}
