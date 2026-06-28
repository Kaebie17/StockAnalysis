// yahoo.js — Yahoo Finance, no API key, global coverage including India
// Uses 3 endpoints verified from node-yahoo-finance2 v3.15.3 (June 2026):
//
//  1. /v8/finance/chart/{ticker}?range=1y&interval=1d
//     → price, OHLCV history
//
//  2. /v10/finance/quoteSummary/{ticker}?modules=price,financialData,defaultKeyStatistics,summaryDetail,assetProfile
//     → current price, TTM financials, sector, industry
//
//  3. /ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}
//     → full annual income, balance sheet, cash flow (5 years)
//
// All work from the browser (CORS open). Field names verified from real fixtures.

const Y1 = 'https://query1.finance.yahoo.com'
const Y2 = 'https://query2.finance.yahoo.com'

// Standard headers that work in 2026
const HEADERS = {
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

async function yFetch(url) {
  // Try query1 first, fall back to query2
  for (const base of [Y1, Y2]) {
    try {
      const fullUrl = url.startsWith('http') ? url : base + url
      const r = await fetch(fullUrl, { headers: HEADERS })
      if (r.ok) return r.json()
      if (r.status === 429) throw new Error('Yahoo rate limited')
    } catch (e) {
      if (e.message.includes('rate limited')) throw e
      // network error — try query2
    }
  }
  throw new Error(`Yahoo fetch failed: ${url.slice(0, 60)}`)
}

export async function fetchAllYahoo(ticker) {
  const T = encodeURIComponent(ticker)
  const now = new Date()
  const fiveYearsAgo = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate())
  const period1 = Math.floor(fiveYearsAgo.getTime() / 1000)
  const period2 = Math.floor(now.getTime() / 1000)

  // Run chart + summary in parallel, then fetch fundamentals timeseries
  const [chartData, summaryData] = await Promise.all([
    yFetch(`/v8/finance/chart/${T}?interval=1d&range=1y`),
    yFetch(`/v10/finance/quoteSummary/${T}?modules=price,financialData,defaultKeyStatistics,summaryDetail,assetProfile`),
  ])

  // Validate responses
  if (chartData?.chart?.error)          throw new Error(chartData.chart.error.description ?? 'Yahoo chart error')
  if (summaryData?.quoteSummary?.error) throw new Error(summaryData.quoteSummary.error.description ?? 'Yahoo summary error')

  const chart   = chartData?.chart?.result?.[0]
  const summary = summaryData?.quoteSummary?.result?.[0]

  if (!chart && !summary) throw new Error(`Yahoo: no data returned for ${ticker}`)

  // Fetch annual fundamentals — income, balance sheet, cash flow
  // URL: /ws/fundamentals-timeseries/v1/finance/timeseries/{ticker}
  // Each module fetched separately to avoid size limits
  let fundData = null
  try {
    fundData = await fetchFundamentalsTimeSeries(T, period1, period2)
  } catch (e) {
    console.warn('[Yahoo fundamentals failed, using summary only]', e.message)
  }

  return {
    raw:       buildRaw(ticker, chart, summary, fundData),
    source:    'Yahoo Finance',
    errors:    [],
    fetchedAt: Date.now(),
  }
}

// ── fundamentalsTimeSeries endpoint ──────────────────────
// Returns all financial statements as time series arrays
// Each item: { dataId, asOfDate, periodType, currencyCode, reportedValue: { raw, fmt } }

async function fetchFundamentalsTimeSeries(ticker, period1, period2) {
  // The 'all' module type fetches income + balance + cashflow in one call
  // type=annual gives 5 years of annual data
  const url = `${Y1}/ws/fundamentals-timeseries/v1/finance/timeseries/${ticker}` +
    `?type=annual&period1=${period1}&period2=${period2}&padTimeSeries=false&merge=false`

  const data = await yFetch(url)
  if (data?.timeseries?.error) throw new Error(data.timeseries.error.description)

  const results = data?.timeseries?.result ?? []

  // results is an array where each item is an object keyed by field name
  // e.g. { annualTotalRevenue: [{asOfDate, reportedValue: {raw}}] }
  // Build a lookup: fieldName → array of {date, value}
  const lookup = {}
  for (const item of results) {
    const keys = Object.keys(item).filter(k => k.startsWith('annual'))
    for (const key of keys) {
      const series = item[key]
      if (!Array.isArray(series)) continue
      lookup[key] = series
        .filter(d => d.reportedValue?.raw != null)
        .map(d => ({ date: d.asOfDate, value: d.reportedValue.raw }))
        .sort((a, b) => new Date(b.date) - new Date(a.date)) // newest first
    }
  }

  return lookup
}

// Extract latest value from a timeseries array for a specific date
function tsVal(lookup, fieldName, date) {
  const series = lookup?.[fieldName]
  if (!series) return null
  if (date) {
    const entry = series.find(s => s.date === date)
    return entry?.value ?? null
  }
  return series[0]?.value ?? null
}

// Get all dates from a field (for building year-by-year history)
function tsDates(lookup, ...fieldNames) {
  const dates = new Set()
  for (const field of fieldNames) {
    const series = lookup?.[field] ?? []
    series.forEach(s => dates.add(s.date))
  }
  return [...dates].sort((a, b) => new Date(b) - new Date(a)) // newest first
}

// ── Build raw object matching FMP shape ───────────────────

function buildRaw(ticker, chart, summary, tsLookup) {
  const meta    = chart?.meta ?? {}
  const price   = summary?.price ?? {}
  const fin     = summary?.financialData ?? {}
  const stats   = summary?.defaultKeyStatistics ?? {}
  const detail  = summary?.summaryDetail ?? {}
  const profile = summary?.assetProfile ?? {}

  // ── Current price & market data ──────────────────────
  const currentPrice = r(price.regularMarketPrice) ?? meta.regularMarketPrice ?? null
  const marketCap    = r(price.marketCap) ?? r(detail.marketCap) ?? null
  const sharesOut    = r(stats.sharesOutstanding) ?? null

  // ── Price history from chart ──────────────────────────
  const timestamps = chart?.timestamp ?? []
  const q          = chart?.indicators?.quote?.[0] ?? {}
  const historical = timestamps
    .map((ts, i) => ({
      date:   new Date(ts * 1000).toISOString().split('T')[0],
      open:   q.open?.[i]   ?? null,
      high:   q.high?.[i]   ?? null,
      low:    q.low?.[i]    ?? null,
      close:  q.close?.[i]  ?? null,
      volume: q.volume?.[i] ?? null,
    }))
    .filter(d => d.close != null && d.close > 0)

  // ── Income history (from fundamentalsTimeSeries) ──────
  // Fields verified: annualTotalRevenue, annualGrossProfit, annualEBITDA,
  //                  annualOperatingIncome, annualNetIncome, annualBasicEPS
  const incomeDates = tsDates(tsLookup,
    'annualTotalRevenue', 'annualNetIncome', 'annualGrossProfit'
  )

  const income = incomeDates.map(date => ({
    date,
    revenue:         tsVal(tsLookup, 'annualTotalRevenue',    date),
    grossProfit:     tsVal(tsLookup, 'annualGrossProfit',     date),
    ebitda:          tsVal(tsLookup, 'annualEBITDA',          date)
                  ?? tsVal(tsLookup, 'annualNormalizedEBITDA', date),
    operatingIncome: tsVal(tsLookup, 'annualOperatingIncome', date)
                  ?? tsVal(tsLookup, 'annualTotalOperatingIncomeAsReported', date),
    netIncome:       tsVal(tsLookup, 'annualNetIncome',       date)
                  ?? tsVal(tsLookup, 'annualNetIncomeCommonStockholders', date),
    eps:             tsVal(tsLookup, 'annualBasicEPS',        date)
                  ?? tsVal(tsLookup, 'annualDilutedEPS',      date),
  })).filter(y => y.revenue != null || y.netIncome != null)

  // ── Balance sheet history ─────────────────────────────
  // Fields: annualTotalAssets, annualTotalDebt, annualStockholdersEquity,
  //         annualCashAndCashEquivalents, annualCommonStockEquity
  const balDates = tsDates(tsLookup, 'annualTotalAssets', 'annualTotalDebt', 'annualStockholdersEquity')

  const balance = balDates.map(date => ({
    date,
    totalAssets:              tsVal(tsLookup, 'annualTotalAssets',              date),
    totalDebt:                tsVal(tsLookup, 'annualTotalDebt',                date),
    totalStockholdersEquity:  tsVal(tsLookup, 'annualStockholdersEquity',       date)
                           ?? tsVal(tsLookup, 'annualCommonStockEquity',        date),
    cashAndCashEquivalents:   tsVal(tsLookup, 'annualCashAndCashEquivalents',   date)
                           ?? tsVal(tsLookup, 'annualCashCashEquivalentsAndShortTermInvestments', date),
    bookValuePerShare:        sharesOut && tsVal(tsLookup, 'annualCommonStockEquity', date)
                              ? tsVal(tsLookup, 'annualCommonStockEquity', date) / sharesOut
                              : r(stats.bookValue) ?? null,
  })).filter(y => y.totalAssets != null || y.totalDebt != null)

  // ── Cash flow history ─────────────────────────────────
  // Fields: annualOperatingCashFlow, annualCapitalExpenditure, annualFreeCashFlow
  const cfDates = tsDates(tsLookup, 'annualOperatingCashFlow', 'annualFreeCashFlow')

  const cashflow = cfDates.map(date => ({
    date,
    operatingCashFlow: tsVal(tsLookup, 'annualOperatingCashFlow',              date)
                    ?? tsVal(tsLookup, 'annualCashFlowFromContinuingOperatingActivities', date),
    capitalExpenditure:tsVal(tsLookup, 'annualCapitalExpenditure',             date),
    freeCashFlow:      tsVal(tsLookup, 'annualFreeCashFlow',                   date),
    dividendsPaid:     tsVal(tsLookup, 'annualCashDividendsPaid',              date)
                    ?? tsVal(tsLookup, 'annualCommonStockDividendPaid',        date),
  })).filter(y => y.operatingCashFlow != null || y.freeCashFlow != null)

  // ── TTM supplement from financialData ─────────────────
  // Used to fill gaps when fundamentalsTimeSeries has no recent data
  const ttm = {
    revenue:           r(fin.totalRevenue)       ?? null,
    grossProfit:       r(fin.grossProfits)        ?? null,
    ebitda:            r(fin.ebitda)              ?? null,
    netIncome:         r(stats.netIncomeToCommon) ?? null,
    eps:               r(stats.trailingEps)       ?? null,
    totalDebt:         r(fin.totalDebt)           ?? null,
    cash:              r(fin.totalCash)           ?? null,
    fcf:               r(fin.freeCashflow)        ?? null,
    cfo:               r(fin.operatingCashflow)   ?? null,
    bookValuePerShare: r(stats.bookValue)         ?? null,
    sharesOut:         r(stats.sharesOutstanding) ?? null,
    debtToEquity:      r(fin.debtToEquity)        ?? null,  // already a ratio
    grossMargin:       r(fin.grossMargins)        ?? null,  // 0.0–1.0
    ebitdaMargin:      r(fin.ebitdaMargins)       ?? null,
    netMargin:         r(fin.profitMargins)        ?? null,
    roe:               r(fin.returnOnEquity)      ?? null,
    roa:               r(fin.returnOnAssets)      ?? null,
  }

  return {
    profile: {
      symbol:            ticker.toUpperCase(),
      companyName:       price.longName ?? price.shortName ?? meta.longName ?? meta.shortName ?? ticker,
      sector:            profile.sector   ?? null,
      industry:          profile.industry ?? null,
      exchangeShortName: price.exchangeName ?? meta.exchangeName ?? '',
      currency:          price.currency ?? meta.currency ?? 'USD',
      country:           profile.country ?? null,
      beta:              r(stats.beta) ?? r(detail.beta) ?? null,
      price:             currentPrice,
      mktCap:            marketCap,
      description:       profile.longBusinessSummary ?? '',
    },

    // If no timeseries data (e.g. fundamentals failed), inject a single TTM entry
    income:   income.length > 0 ? income : ttm.revenue ? [{
      date:            new Date().toISOString().split('T')[0],
      revenue:         ttm.revenue,
      grossProfit:     ttm.grossProfit,
      ebitda:          ttm.ebitda,
      operatingIncome: null,
      netIncome:       ttm.netIncome,
      eps:             ttm.eps,
    }] : [],

    balance: balance.length > 0 ? balance : ttm.totalDebt ? [{
      date:                   new Date().toISOString().split('T')[0],
      totalAssets:            null,
      totalDebt:              ttm.totalDebt,
      totalStockholdersEquity:null,
      cashAndCashEquivalents: ttm.cash,
      bookValuePerShare:      ttm.bookValuePerShare,
    }] : [],

    cashflow: cashflow.length > 0 ? cashflow : ttm.fcf ? [{
      date:              new Date().toISOString().split('T')[0],
      operatingCashFlow: ttm.cfo,
      capitalExpenditure:null,
      freeCashFlow:      ttm.fcf,
      dividendsPaid:     null,
    }] : [],

    metrics: [],
    history: { historical },
    quote: {
      price:             currentPrice,
      marketCap,
      sharesOutstanding: sharesOut,
      eps:               r(stats.trailingEps) ?? null,
      yearHigh:          r(detail.fiftyTwoWeekHigh) ?? meta.fiftyTwoWeekHigh ?? null,
      yearLow:           r(detail.fiftyTwoWeekLow)  ?? meta.fiftyTwoWeekLow  ?? null,
      avgVolume:         r(detail.averageVolume)     ?? r(price.averageDailyVolume3Month) ?? null,
      volume:            r(price.regularMarketVolume) ?? null,
      change:            r(price.regularMarketChange) ?? null,
      // Yahoo returns percent as decimal (0.0065 = 0.65%) — multiply by 100
      changesPercentage: r(price.regularMarketChangePercent) != null
                         ? r(price.regularMarketChangePercent) * 100
                         : null,
    },
    ttm,
  }
}

// Safely extract .raw from Yahoo's {raw, fmt} wrapper, or return number directly
function r(obj) {
  if (obj == null) return null
  if (typeof obj === 'number') return obj
  if (typeof obj === 'object' && 'raw' in obj) return obj.raw ?? null
  return null
}
