/**
 * src/engine/normalize.js
 *
 * Converts raw API responses (Yahoo or Screener) into a standard data object.
 * ALL values stored raw — no derived ratios here.
 *
 * Standard object shape:
 * {
 *   ticker, name, source, currency,
 *   price, marketCap, sharesOutstanding,
 *   priceHistory: [{ date, open, high, low, close, volume }],
 *   incomeHistory: [{ year, revenue, grossProfit, operatingProfit, ebitda, netIncome, interest, depreciation, eps }],
 *   balanceHistory: [{ year, totalAssets, totalDebt, totalEquity, cash, totalLiabilities }],
 *   cashflowHistory: [{ year, operatingCF, investingCF, financingCF, capex, freeCashFlow }],
 *   ttm: { revenue, grossProfit, ebitda, netIncome, eps, debtToEquity, roe, roic, ebitdaMargins, grossMargins, profitMargins, currentRatio, quickRatio, totalDebt, totalCash, freeCashflow },
 *   meta: { sector, industry, website, description, exchange, currency }
 * }
 */

export function normalize(source, raw) {
  if (source === 'yahoo') return normalizeYahoo(raw)
  if (source === 'screener') return normalizeScreener(raw)
  throw new Error(`Unknown source: ${source}`)
}

// ─── Yahoo ────────────────────────────────────────────────────────────────────

function normalizeYahoo({ ticker, chart, quote, timeseries }) {
  const qs = quote?.quoteSummary?.result?.[0] || {}
  const priceModule   = qs.price || {}
  const finData       = qs.financialData || {}
  const keyStats      = qs.defaultKeyStatistics || {}
  const summaryDetail = qs.summaryDetail || {}
  const assetProfile  = qs.assetProfile || {}

  // TTM financials
  const ttm = {
    revenue:        rv(finData.totalRevenue),
    grossProfit:    rv(finData.grossProfits),
    ebitda:         rv(finData.ebitda),
    netIncome:      rv(finData.netIncomeToCommon),
    eps:            rv(finData.trailingEps) ?? rv(keyStats.trailingEps),
    debtToEquity:   rv(finData.debtToEquity),
    roe:            rv(finData.returnOnEquity),
    roic:           rv(finData.returnOnAssets), // proxy
    ebitdaMargins:  rv(finData.ebitdaMargins),
    grossMargins:   rv(finData.grossMargins),
    profitMargins:  rv(finData.profitMargins),
    currentRatio:   rv(finData.currentRatio),
    quickRatio:     rv(finData.quickRatio),
    totalDebt:      rv(finData.totalDebt),
    totalCash:      rv(finData.totalCash),
    freeCashflow:   rv(finData.freeCashflow),
    operatingCashflow: rv(finData.operatingCashflow),
    revenueGrowth:  rv(finData.revenueGrowth),
    earningsGrowth: rv(finData.earningsGrowth)
  }

  // Price history from chart
  const chartResult = chart?.chart?.result?.[0]
  const timestamps = chartResult?.timestamp || []
  const ohlcv = chartResult?.indicators?.quote?.[0] || {}
  const priceHistory = timestamps.map((ts, i) => ({
    date:   new Date(ts * 1000).toISOString().slice(0, 10),
    open:   ohlcv.open?.[i]   ?? null,
    high:   ohlcv.high?.[i]   ?? null,
    low:    ohlcv.low?.[i]    ?? null,
    close:  ohlcv.close?.[i]  ?? null,
    volume: ohlcv.volume?.[i] ?? null
  })).filter(d => d.close !== null)

  // Annual history from timeseries
  const ts = timeseries?.timeseries?.result || []

  function getTSeries(type) {
    const series = ts.find(s => s.meta?.type?.includes(type))
    if (!series) return []
    const key = Object.keys(series).find(k => k.startsWith('annual'))
    return series[key] || []
  }

  const revenues      = getTSeries('annualTotalRevenue')
  const netIncomes    = getTSeries('annualNetIncome')
  const totalDebts    = getTSeries('annualTotalDebt')
  const cashItems     = getTSeries('annualCashAndCashEquivalents')
  const fcfItems      = getTSeries('annualFreeCashFlow')
  const ebitdaItems   = getTSeries('annualEbitda')
  const grossProfits  = getTSeries('annualGrossProfit')
  const equities      = getTSeries('annualStockholdersEquity')
  const operIncome    = getTSeries('annualOperatingIncome')

  // Align by asOfDate
  const years = [...new Set(revenues.map(r => r.asOfDate?.slice(0, 4)))].sort()

  const incomeHistory = years.map(yr => {
    const rev  = revenues.find(r => r.asOfDate?.startsWith(yr))
    const ni   = netIncomes.find(r => r.asOfDate?.startsWith(yr))
    const gp   = grossProfits.find(r => r.asOfDate?.startsWith(yr))
    const eb   = ebitdaItems.find(r => r.asOfDate?.startsWith(yr))
    const oi   = operIncome.find(r => r.asOfDate?.startsWith(yr))
    return {
      year: yr,
      revenue:         rv(rev?.reportedValue),
      grossProfit:     rv(gp?.reportedValue),
      operatingProfit: rv(oi?.reportedValue),
      ebitda:          rv(eb?.reportedValue),
      netIncome:       rv(ni?.reportedValue),
      interest:        null, // not in timeseries — use income statement module
      depreciation:    null,
      eps:             null
    }
  }).filter(r => r.revenue !== null)

  // Supplement with incomeStatementHistory if timeseries sparse
  const incStmt = qs.incomeStatementHistory?.incomeStatementHistory || []
  if (incomeHistory.length < 2 && incStmt.length > 0) {
    incomeHistory.length = 0
    incStmt.forEach(s => {
      incomeHistory.push({
        year:            new Date(rv(s.endDate) * 1000).getFullYear().toString(),
        revenue:         rv(s.totalRevenue),
        grossProfit:     rv(s.grossProfit),
        operatingProfit: rv(s.operatingIncome) ?? rv(s.ebit),
        ebitda:          null,
        netIncome:       rv(s.netIncome),
        interest:        rv(s.interestExpense),
        depreciation:    null,
        eps:             null
      })
    })
  }

  const balanceHistory = years.map(yr => {
    const debt   = totalDebts.find(r => r.asOfDate?.startsWith(yr))
    const cash   = cashItems.find(r => r.asOfDate?.startsWith(yr))
    const equity = equities.find(r => r.asOfDate?.startsWith(yr))
    return {
      year:            yr,
      totalAssets:     null,
      totalDebt:       rv(debt?.reportedValue),
      totalEquity:     rv(equity?.reportedValue),
      cash:            rv(cash?.reportedValue),
      totalLiabilities: null
    }
  }).filter(r => r.totalDebt !== null || r.totalEquity !== null)

  // Supplement balance from balance sheet history module
  const bsStmt = qs.balanceSheetHistory?.balanceSheetStatements || []
  if (balanceHistory.length < 2 && bsStmt.length > 0) {
    balanceHistory.length = 0
    bsStmt.forEach(s => {
      balanceHistory.push({
        year:            new Date(rv(s.endDate) * 1000).getFullYear().toString(),
        totalAssets:     rv(s.totalAssets),
        totalDebt:       rv(s.longTermDebt) ?? rv(s.shortLongTermDebt),
        totalEquity:     rv(s.totalStockholderEquity),
        cash:            rv(s.cash),
        totalLiabilities: rv(s.totalLiab)
      })
    })
  }

  const cashflowHistory = years.map(yr => {
    const fcf = fcfItems.find(r => r.asOfDate?.startsWith(yr))
    return {
      year:        yr,
      operatingCF: null,
      investingCF: null,
      financingCF: null,
      capex:       null,
      freeCashFlow: rv(fcf?.reportedValue)
    }
  }).filter(r => r.freeCashFlow !== null)

  // Supplement cashflow from cashflow module
  const cfStmt = qs.cashflowStatementHistory?.cashflowStatements || []
  if (cashflowHistory.length < 2 && cfStmt.length > 0) {
    cashflowHistory.length = 0
    cfStmt.forEach(s => {
      cashflowHistory.push({
        year:        new Date(rv(s.endDate) * 1000).getFullYear().toString(),
        operatingCF: rv(s.totalCashFromOperatingActivities),
        investingCF: rv(s.totalCashflowsFromInvestingActivities),
        financingCF: rv(s.totalCashFromFinancingActivities),
        capex:       rv(s.capitalExpenditures),
        freeCashFlow: rv(s.freeCashFlow) ?? computeFCF(
          rv(s.totalCashFromOperatingActivities),
          rv(s.capitalExpenditures)
        )
      })
    })
  }

  return {
    ticker,
    name:             priceModule.longName || priceModule.shortName || ticker,
    source:           'yahoo',
    currency:         priceModule.currency || 'USD',
    price:            rv(priceModule.regularMarketPrice),
    marketCap:        rv(priceModule.marketCap),
    sharesOutstanding: rv(keyStats.sharesOutstanding),
    priceHistory,
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm,
    meta: {
      sector:      assetProfile.sector || null,
      industry:    assetProfile.industry || null,
      website:     assetProfile.website || null,
      description: assetProfile.longBusinessSummary || null,
      exchange:    priceModule.exchangeName || null,
      pe:          rv(summaryDetail.trailingPE),
      pb:          rv(keyStats.priceToBook),
      divYield:    rv(summaryDetail.dividendYield),
      beta:        rv(summaryDetail.beta),
      high52:      rv(summaryDetail.fiftyTwoWeekHigh),
      low52:       rv(summaryDetail.fiftyTwoWeekLow)
    }
  }
}

// ─── Screener ─────────────────────────────────────────────────────────────────

function normalizeScreener(raw) {
  // raw already has { incomeHistory, balanceHistory, cashflowHistory } in Crores
  // Convert Crores to absolute INR (multiply by 1e7) for consistency
  const CR = 1e7

  const incomeHistory = (raw.incomeHistory || []).map(r => ({
    year:            r.year,
    revenue:         mul(r.revenue, CR),
    grossProfit:     mul(r.grossProfit, CR),
    operatingProfit: mul(r.operatingProfit, CR),
    ebitda:          r.ebitda != null ? r.ebitda * CR : computeEbitda(
      mul(r.operatingProfit, CR), mul(r.depreciation, CR)
    ),
    netIncome:       mul(r.netIncome, CR),
    interest:        mul(r.interest, CR),
    depreciation:    mul(r.depreciation, CR),
    eps:             r.eps // EPS is already per-share, no scaling
  }))

  const balanceHistory = (raw.balanceHistory || []).map(r => ({
    year:            r.year,
    totalAssets:     mul(r.totalAssets, CR),
    totalDebt:       mul(r.totalDebt, CR),
    totalEquity:     mul(r.totalEquity, CR),
    cash:            mul(r.cash, CR),
    totalLiabilities: mul(r.totalLiabilities, CR)
  }))

  const cashflowHistory = (raw.cashflowHistory || []).map(r => ({
    year:        r.year,
    operatingCF: mul(r.operatingCF, CR),
    investingCF: mul(r.investingCF, CR),
    financingCF: mul(r.financingCF, CR),
    capex:       mul(r.capex, CR),
    freeCashFlow: r.freeCashFlow != null
      ? r.freeCashFlow * CR
      : computeFCF(mul(r.operatingCF, CR), mul(r.capex, CR))
  }))

  // Build TTM from most recent year
  const latest = incomeHistory[incomeHistory.length - 1] || {}
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
    priceHistory: [], // Screener doesn't provide price history
    incomeHistory,
    balanceHistory,
    cashflowHistory,
    ttm: {
      revenue:      latest.revenue,
      grossProfit:  latest.grossProfit,
      ebitda:       latest.ebitda,
      netIncome:    latest.netIncome,
      eps:          latest.eps,
      debtToEquity: raw.ratios?.pe ? null : null, // computed in ratios.js
      roe:          raw.ratios?.roe ? raw.ratios.roe / 100 : null,
      ebitdaMargins: latest.ebitda && latest.revenue ? latest.ebitda / latest.revenue : null,
      grossMargins:  latest.grossProfit && latest.revenue ? latest.grossProfit / latest.revenue : null,
      profitMargins: latest.netIncome && latest.revenue ? latest.netIncome / latest.revenue : null,
      totalDebt:    latestB.totalDebt,
      totalCash:    latestB.cash,
      freeCashflow: latestCF.freeCashFlow,
      operatingCashflow: latestCF.operatingCF
    },
    meta: {
      sector:    null,
      industry:  null,
      website:   null,
      description: null,
      exchange:  'NSE/BSE',
      pe:        raw.ratios?.pe,
      pb:        raw.ratios?.pb,
      divYield:  raw.ratios?.divYield,
      bookValue: raw.ratios?.bookValue
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract .raw from Yahoo value objects like { raw: 1234, fmt: "1,234" } */
function rv(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'object' && 'raw' in v) return v.raw
  if (typeof v === 'number') return v
  return null
}

function mul(v, factor) {
  return v != null ? v * factor : null
}

function computeFCF(operatingCF, capex) {
  if (operatingCF == null) return null
  return operatingCF - Math.abs(capex || 0)
}

function computeEbitda(operatingProfit, depreciation) {
  if (operatingProfit == null) return null
  return operatingProfit + (depreciation || 0)
}
