/**
 * src/engine/normalize.js
 *
 * Yahoo data sources (June 2026):
 *  - quote (v7):        price, marketCap, PE, PB, 52w, volume, sharesOutstanding
 *  - chart (v8):        OHLCV price history, adjclose, currency
 *  - fundamentals (v10):financialData (TTM margins/returns), statements (history)
 *  - screener:          historical financials in Crores (Indian stocks)
 *
 * Merge: Yahoo price/TTM/meta wins. Histories merged by year, Screener fills gaps.
 */

export function normalize(source, raw) {
  if (source === 'yahoo')    return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  if (source === 'merged')   return normalizeMerged(raw)
  if (source === 'csv')      return raw
  throw new Error(`Unknown source: ${source}`)
}

// ─── Merged ───────────────────────────────────────────────────────────────────

function normalizeMerged({ yahoo, screener }) {
  const y = normalizeYahoo(yahoo)
  const s = normalizeScreener(screener)
  return {
    ...y,
    source: 'merged',
    incomeHistory:   mergeHistories(y.incomeHistory,   s.incomeHistory,   mergeIncomeRow),
    balanceHistory:  mergeHistories(y.balanceHistory,  s.balanceHistory,  mergeBalanceRow),
    cashflowHistory: mergeHistories(y.cashflowHistory, s.cashflowHistory, mergeCFRow),
    ttm: mergeTTM(y.ttm, s.ttm),
    // Use Screener price if Yahoo didn't return one
    price:     y.price     ?? s.price,
    marketCap: y.marketCap ?? s.marketCap
  }
}

function mergeHistories(yahooArr, screenerArr, mergeRow) {
  const map = {}
  for (const r of (screenerArr || [])) if (r.year) map[r.year] = r
  for (const r of (yahooArr || []))   if (r.year) map[r.year] = map[r.year] ? mergeRow(r, map[r.year]) : r
  return Object.values(map).sort((a, b) => a.year.localeCompare(b.year))
}

function mergeIncomeRow(y, s) {
  return { year: y.year,
    revenue:         y.revenue         ?? s.revenue,
    grossProfit:     y.grossProfit     ?? s.grossProfit,
    operatingProfit: y.operatingProfit ?? s.operatingProfit,
    ebitda:          y.ebitda          ?? s.ebitda,
    netIncome:       y.netIncome       ?? s.netIncome,
    interest:        y.interest        ?? s.interest,
    depreciation:    y.depreciation    ?? s.depreciation,
    eps:             y.eps             ?? s.eps }
}
function mergeBalanceRow(y, s) {
  return { year: y.year,
    totalAssets:     y.totalAssets     ?? s.totalAssets,
    totalDebt:       y.totalDebt       ?? s.totalDebt,
    totalEquity:     y.totalEquity     ?? s.totalEquity,
    cash:            y.cash            ?? s.cash,
    totalLiabilities: y.totalLiabilities ?? s.totalLiabilities }
}
function mergeCFRow(y, s) {
  return { year: y.year,
    operatingCF:  y.operatingCF  ?? s.operatingCF,
    investingCF:  y.investingCF  ?? s.investingCF,
    financingCF:  y.financingCF  ?? s.financingCF,
    capex:        y.capex        ?? s.capex,
    freeCashFlow: y.freeCashFlow ?? s.freeCashFlow }
}
function mergeTTM(y, s) {
  if (!y) return s; if (!s) return y
  const out = { ...y }
  for (const k of Object.keys(s)) if (out[k] == null) out[k] = s[k]
  return out
}

// ─── Yahoo ────────────────────────────────────────────────────────────────────

function normalizeYahoo({ ticker, chart, quote, fundamentals }) {
  // ── v7 quote — most reliable for price + valuation ratios ─────────────────
  const q7 = quote?.quoteResponse?.result?.[0] || {}

  // ── v10 quoteSummary modules ───────────────────────────────────────────────
  const qs  = fundamentals?.quoteSummary?.result?.[0] || {}
  const finData   = qs.financialData        || {}
  const keyStats  = qs.defaultKeyStatistics || {}
  const sumDetail = qs.summaryDetail        || {}
  const profile   = qs.assetProfile         || {}

  // ── v8 chart meta — currency + fallback price ──────────────────────────────
  const chartResult = chart?.chart?.result?.[0]
  const chartMeta   = chartResult?.meta || {}

  // Currency: chart meta is most reliable (always present)
  const currency = chartMeta.currency || q7.currency || 'USD'
  const sym = currency === 'INR' ? '₹' : currency === 'GBP' ? '£' : '$'

  // Price: v7 quote is most reliable, chart meta as fallback
  const price = q7.regularMarketPrice ?? chartMeta.regularMarketPrice ?? rv(finData.currentPrice) ?? null

  // Market cap: v7 quote
  const marketCap = q7.marketCap ?? rv(keyStats.marketCap) ?? null

  // Shares outstanding: v7, then keyStats
  const sharesOutstanding = q7.sharesOutstanding ?? rv(keyStats.sharesOutstanding) ?? null

  // ── Price history from v8 chart ────────────────────────────────────────────
  const timestamps = chartResult?.timestamp || []
  const q0         = chartResult?.indicators?.quote?.[0]             || {}
  const adjCloses  = chartResult?.indicators?.adjclose?.[0]?.adjclose || []

  const priceHistory = timestamps.map((ts, i) => ({
    date:   new Date(ts * 1000).toISOString().slice(0, 10),
    open:   q0.open?.[i]   ?? null,
    high:   q0.high?.[i]   ?? null,
    low:    q0.low?.[i]    ?? null,
    close:  adjCloses[i]   ?? q0.close?.[i] ?? null,
    volume: q0.volume?.[i] ?? null
  })).filter(d => d.close !== null)

  // ── Income history ─────────────────────────────────────────────────────────
  const incStmt = qs.incomeStatementHistory?.incomeStatementHistory || []
  const incomeHistory = incStmt.map(s => ({
    year:            yearOf(rv(s.endDate)),
    revenue:         rv(s.totalRevenue),
    grossProfit:     rv(s.grossProfit),
    operatingProfit: rv(s.operatingIncome) ?? rv(s.ebit),
    ebitda:          null,
    netIncome:       rv(s.netIncome),
    interest:        rv(s.interestExpense),
    depreciation:    null,
    eps:             null
  })).filter(r => r.year && r.revenue != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // EPS from earnings module
  for (const e of (qs.earnings?.financialsChart?.yearly || [])) {
    const row = incomeHistory.find(r => r.year === String(e.date))
    if (row) row.eps = rv(e.earnings)
  }

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
    const capex = rv(s.capitalExpenditures)
    return {
      year:        yearOf(rv(s.endDate)),
      operatingCF: opCF,
      investingCF: rv(s.totalCashflowsFromInvestingActivities),
      financingCF: rv(s.totalCashFromFinancingActivities),
      capex,
      freeCashFlow: rv(s.freeCashFlow) ?? computeFCF(opCF, capex)
    }
  }).filter(r => r.year && r.operatingCF != null)
    .sort((a, b) => a.year.localeCompare(b.year))

  // ── TTM — financialData module ─────────────────────────────────────────────
  const ttm = {
    revenue:           rv(finData.totalRevenue),
    grossProfit:       rv(finData.grossProfits),
    ebitda:            rv(finData.ebitda),
    netIncome:         rv(finData.netIncomeToCommon),
    eps:               rv(finData.trailingEps) ?? rv(keyStats.trailingEps),
    debtToEquity:      rv(finData.debtToEquity),
    roe:               rv(finData.returnOnEquity),
    ebitdaMargins:     rv(finData.ebitdaMargins),
    grossMargins:      rv(finData.grossMargins),
    profitMargins:     rv(finData.profitMargins),
    currentRatio:      rv(finData.currentRatio),
    quickRatio:        rv(finData.quickRatio),
    totalDebt:         rv(finData.totalDebt),
    totalCash:         rv(finData.totalCash),
    freeCashflow:      rv(finData.freeCashflow),
    operatingCashflow: rv(finData.operatingCashflow),
    revenueGrowth:     rv(finData.revenueGrowth),
    earningsGrowth:    rv(finData.earningsGrowth),
    operatingMargins:  rv(finData.operatingMargins),
    returnOnAssets:    rv(finData.returnOnAssets)
  }

  // ── Meta — blend v7 quote + v10 profile ───────────────────────────────────
  return {
    ticker,
    name:              q7.longName || q7.shortName || chartMeta.instrumentType || ticker,
    source:            'yahoo',
    currency,
    price,
    marketCap,
    sharesOutstanding,
    priceHistory,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm,
    meta: {
      sector:    profile.sector   || null,
      industry:  profile.industry || null,
      website:   profile.website  || null,
      description: profile.longBusinessSummary || null,
      exchange:  q7.exchange      || chartMeta.exchangeName || null,
      // Valuation ratios — v7 quote is authoritative for Indian stocks
      pe:        q7.trailingPE    ?? rv(sumDetail.trailingPE),
      forwardPe: q7.forwardPE     ?? rv(sumDetail.forwardPE),
      pb:        q7.priceToBook   ?? rv(keyStats.priceToBook),
      divYield:  q7.trailingAnnualDividendYield ?? rv(sumDetail.dividendYield),
      beta:      q7.beta          ?? rv(sumDetail.beta),
      high52:    q7.fiftyTwoWeekHigh ?? rv(sumDetail.fiftyTwoWeekHigh),
      low52:     q7.fiftyTwoWeekLow  ?? rv(sumDetail.fiftyTwoWeekLow),
      avgVolume: q7.averageDailyVolume3Month ?? rv(sumDetail.averageVolume),
      change1d:  q7.regularMarketChangePercent ?? null,
      volume:    q7.regularMarketVolume ?? null
    }
  }
}

// ─── Screener ─────────────────────────────────────────────────────────────────

function normalizeScreener(raw) {
  const CR = 1e7
  const incomeHistory = (raw.incomeHistory || []).map(r => ({
    year: r.year,
    revenue:         mul(r.revenue, CR),
    grossProfit:     mul(r.grossProfit, CR),
    operatingProfit: mul(r.operatingProfit, CR),
    ebitda:          r.ebitda != null ? r.ebitda * CR : computeEbitda(mul(r.operatingProfit, CR), mul(r.depreciation, CR)),
    netIncome:       mul(r.netIncome, CR),
    interest:        mul(r.interest, CR),
    depreciation:    mul(r.depreciation, CR),
    eps:             r.eps
  }))
  const balanceHistory = (raw.balanceHistory || []).map(r => ({
    year: r.year,
    totalAssets:     mul(r.totalAssets, CR),
    totalDebt:       mul(r.totalDebt, CR),
    totalEquity:     mul(r.totalEquity, CR),
    cash:            mul(r.cash, CR),
    totalLiabilities: mul(r.totalLiabilities, CR)
  }))
  const cashflowHistory = (raw.cashflowHistory || []).map(r => {
    const opCF = mul(r.operatingCF, CR), capex = mul(r.capex, CR)
    return { year: r.year, operatingCF: opCF, investingCF: mul(r.investingCF, CR),
      financingCF: mul(r.financingCF, CR), capex,
      freeCashFlow: r.freeCashFlow != null ? r.freeCashFlow * CR : computeFCF(opCF, capex) }
  })
  const latest   = incomeHistory[incomeHistory.length - 1]   || {}
  const latestB  = balanceHistory[balanceHistory.length - 1]  || {}
  const latestCF = cashflowHistory[cashflowHistory.length - 1] || {}
  return {
    ticker: raw.ticker, name: raw.name || raw.ticker,
    source: 'screener', currency: 'INR',
    price: raw.price, marketCap: raw.marketCap, sharesOutstanding: null,
    priceHistory: [], incomeHistory, balanceHistory, cashflowHistory,
    ttm: {
      revenue: latest.revenue, grossProfit: latest.grossProfit, ebitda: latest.ebitda,
      netIncome: latest.netIncome, eps: latest.eps, debtToEquity: null,
      roe: raw.ratios?.roe ? raw.ratios.roe / 100 : null,
      ebitdaMargins:  latest.ebitda     && latest.revenue ? latest.ebitda     / latest.revenue : null,
      grossMargins:   latest.grossProfit && latest.revenue ? latest.grossProfit / latest.revenue : null,
      profitMargins:  latest.netIncome  && latest.revenue ? latest.netIncome  / latest.revenue : null,
      totalDebt: latestB.totalDebt, totalCash: latestB.cash,
      freeCashflow: latestCF.freeCashFlow, operatingCashflow: latestCF.operatingCF
    },
    meta: { sector: null, industry: null, website: null, description: null,
      exchange: 'NSE/BSE', pe: raw.ratios?.pe, pb: raw.ratios?.pb,
      divYield: raw.ratios?.divYield, bookValue: raw.ratios?.bookValue }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function rv(v) {
  if (v == null) return null
  if (typeof v === 'object' && 'raw' in v) return v.raw
  if (typeof v === 'number') return v
  return null
}
function mul(v, f) { return v != null ? v * f : null }
function yearOf(unix) { return unix ? new Date(unix * 1000).getFullYear().toString() : null }
function computeFCF(opCF, capex) { return opCF != null ? opCF - Math.abs(capex || 0) : null }
function computeEbitda(op, dep) { return op != null ? op + (dep || 0) : null }
