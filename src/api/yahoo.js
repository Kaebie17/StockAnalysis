// yahoo.js — Yahoo Finance, no API key needed, global coverage including India
// Uses v8/finance/chart for price history + v10/finance/quoteSummary for fundamentals
// Field names verified against real Yahoo API responses

const BASE_CHART   = 'https://query1.finance.yahoo.com/v8/finance/chart'
const BASE_SUMMARY = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary'

// Yahoo Finance works from the browser (CORS open) but NOT from Node.js server-side.
// In dev: call directly from browser. On Vercel: also from browser (client-side fetch).

export async function fetchAllYahoo(ticker) {
  const T = encodeURIComponent(ticker)

  // Run both requests in parallel
  const [chartRes, summaryRes] = await Promise.all([
    fetch(`${BASE_CHART}/${T}?interval=1d&range=1y`, {
      headers: { 'Accept': 'application/json' }
    }),
    fetch(
      `${BASE_SUMMARY}/${T}?modules=` + [
        'price',
        'financialData',
        'defaultKeyStatistics',
        'summaryDetail',
        'assetProfile',
        'incomeStatementHistory',
        'balanceSheetHistory',
        'cashflowStatementHistory',
      ].join(','),
      { headers: { 'Accept': 'application/json' } }
    )
  ])

  if (!chartRes.ok)   throw new Error(`Yahoo chart HTTP ${chartRes.status}`)
  if (!summaryRes.ok) throw new Error(`Yahoo summary HTTP ${summaryRes.status}`)

  const chartJson   = await chartRes.json()
  const summaryJson = await summaryRes.json()

  if (chartJson.chart?.error)           throw new Error(chartJson.chart.error.description   ?? 'Yahoo chart error')
  if (summaryJson.quoteSummary?.error)  throw new Error(summaryJson.quoteSummary.error.description ?? 'Yahoo summary error')

  const chartResult  = chartJson.chart?.result?.[0]
  const summaryResult = summaryJson.quoteSummary?.result?.[0]

  if (!chartResult)   throw new Error(`Yahoo: no chart data for ${ticker}`)
  if (!summaryResult) throw new Error(`Yahoo: no summary data for ${ticker}`)

  return {
    raw:       buildRaw(ticker, chartResult, summaryResult),
    source:    'Yahoo Finance',
    errors:    [],
    fetchedAt: Date.now(),
  }
}

// ── Build normalized raw object matching FMP shape ────────
// All values are plain numbers (not {raw,fmt} objects)
// r(obj) safely extracts .raw from Yahoo's {raw,fmt} wrapper

function r(obj) {
  if (obj == null) return null
  if (typeof obj === 'number') return obj
  if (typeof obj === 'object' && 'raw' in obj) return obj.raw ?? null
  return null
}

function buildRaw(ticker, chart, summary) {
  const meta   = chart.meta   ?? {}
  const price  = summary.price ?? {}
  const fin    = summary.financialData ?? {}
  const stats  = summary.defaultKeyStatistics ?? {}
  const detail = summary.summaryDetail ?? {}
  const profile = summary.assetProfile  ?? {}

  // ── Price history from chart ─────────────────────────
  const timestamps = chart.timestamp ?? []
  const q          = chart.indicators?.quote?.[0] ?? {}
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

  // ── Income statement history (4 annual years) ────────
  // Yahoo gives: totalRevenue, netIncome, ebit, grossProfit (often 0), costOfRevenue
  const incStmts = summary.incomeStatementHistory?.incomeStatementHistory ?? []
  const income = incStmts.map(s => ({
    date:            s.endDate?.fmt ?? toDateStr(r(s.endDate)),
    revenue:         r(s.totalRevenue)        ?? null,
    grossProfit:     r(s.grossProfit) || null,   // often 0 — use null if 0
    ebitda:          null,                        // not in income history; use fin.ebitda for TTM
    operatingIncome: r(s.operatingIncome)     ?? r(s.ebit) ?? null,
    netIncome:       r(s.netIncome)           ?? null,
    eps:             null,                        // not per-year; use stats.trailingEps for TTM
  }))

  // ── Balance sheet — Yahoo history is mostly empty ────
  // Use financialData for TTM snapshot + inject as single year
  const balStmts = summary.balanceSheetHistory?.balanceSheetStatements ?? []
  const balance = balStmts.length > 0
    ? balStmts.map(s => ({
        date:                    s.endDate?.fmt ?? toDateStr(r(s.endDate)),
        totalAssets:             r(s.totalAssets)               ?? null,
        totalDebt:               r(s.totalDebt) ?? r(s.longTermDebt) ?? null,
        totalStockholdersEquity: r(s.totalStockholderEquity)    ?? null,
        cashAndCashEquivalents:  r(s.cash) ?? r(s.cashAndCashEquivalents) ?? null,
        bookValuePerShare:       r(stats.bookValue)             ?? null,
      }))
    : [{
        // Fallback: build single entry from financialData + stats (TTM)
        date:                    new Date().toISOString().split('T')[0],
        totalAssets:             null,
        totalDebt:               r(fin.totalDebt)              ?? null,
        totalStockholdersEquity: null,
        cashAndCashEquivalents:  r(fin.totalCash)              ?? null,
        bookValuePerShare:       r(stats.bookValue)            ?? null,
      }]

  // ── Cash flow — Yahoo history only has netIncome ─────
  // Use financialData for TTM FCF and CFO
  const cfStmts = summary.cashflowStatementHistory?.cashflowStatements ?? []
  const cashflow = cfStmts.length > 0
    ? cfStmts.map(s => ({
        date:              s.endDate?.fmt ?? toDateStr(r(s.endDate)),
        operatingCashFlow: r(s.totalCashFromOperatingActivities) ?? null,
        capitalExpenditure:r(s.capitalExpenditures)              ?? null,
        freeCashFlow:      r(s.freeCashflow)                     ?? null,
        dividendsPaid:     r(s.dividendsPaid)                    ?? null,
      }))
    : [{
        // Fallback: TTM from financialData
        date:              new Date().toISOString().split('T')[0],
        operatingCashFlow: r(fin.operatingCashflow)  ?? null,
        capitalExpenditure:null,
        freeCashFlow:      r(fin.freeCashflow)        ?? null,
        dividendsPaid:     null,
      }]

  const currentPrice = r(price.regularMarketPrice) ?? r(meta.regularMarketPrice) ?? null
  const marketCap    = r(price.marketCap)   ?? r(detail.marketCap) ?? null
  const sharesOut    = r(stats.sharesOutstanding) ?? null

  return {
    profile: {
      symbol:           ticker.toUpperCase(),
      companyName:      price.longName ?? price.shortName ?? meta.longName ?? meta.shortName ?? ticker,
      sector:           profile.sector   ?? null,
      industry:         profile.industry ?? null,
      exchangeShortName:price.exchangeName ?? meta.exchangeName ?? '',
      currency:         price.currency ?? meta.currency ?? 'USD',
      country:          profile.country ?? null,
      beta:             r(stats.beta)    ?? r(detail.beta) ?? null,
      price:            currentPrice,
      mktCap:           marketCap,
      description:      profile.longBusinessSummary ?? '',
    },

    // Income: mix of history + TTM patch for missing fields
    income: income.map((y, i) => ({
      ...y,
      // Patch EPS and EBITDA into latest year only from TTM stats
      ...(i === 0 ? {
        eps:    r(stats.trailingEps) ?? null,
        ebitda: r(fin.ebitda)        ?? null,
      } : {})
    })),

    balance,
    cashflow,
    metrics: [],

    history: { historical },

    quote: {
      price:              currentPrice,
      marketCap,
      sharesOutstanding:  sharesOut,
      eps:                r(stats.trailingEps) ?? null,
      yearHigh:           r(detail.fiftyTwoWeekHigh) ?? r(meta.fiftyTwoWeekHigh) ?? null,
      yearLow:            r(detail.fiftyTwoWeekLow)  ?? r(meta.fiftyTwoWeekLow)  ?? null,
      avgVolume:          r(detail.averageVolume)     ?? null,
      volume:             r(price.regularMarketVolume) ?? null,
      change:             r(price.regularMarketChange) ?? null,
      changesPercentage:  r(price.regularMarketChangePercent) != null
                          ? r(price.regularMarketChangePercent) * 100
                          : null,
    },

    // Bonus: TTM financials directly for ratios (supplement sparse history)
    ttm: {
      revenue:           r(fin.totalRevenue)     ?? null,
      grossProfit:       r(fin.grossProfits)      ?? null,
      ebitda:            r(fin.ebitda)            ?? null,
      netIncome:         r(stats.netIncomeToCommon) ?? null,
      eps:               r(stats.trailingEps)     ?? null,
      totalDebt:         r(fin.totalDebt)         ?? null,
      cash:              r(fin.totalCash)         ?? null,
      fcf:               r(fin.freeCashflow)      ?? null,
      cfo:               r(fin.operatingCashflow) ?? null,
      bookValuePerShare: r(stats.bookValue)       ?? null,
      sharesOut:         r(stats.sharesOutstanding) ?? null,
      debtToEquity:      r(fin.debtToEquity)      ?? null,
      grossMargin:       r(fin.grossMargins)       ?? null,
      ebitdaMargin:      r(fin.ebitdaMargins)      ?? null,
      netMargin:         r(fin.profitMargins)      ?? null,
      roe:               r(fin.returnOnEquity)     ?? null,
      roa:               r(fin.returnOnAssets)     ?? null,
    }
  }
}

function toDateStr(epochSeconds) {
  if (!epochSeconds) return ''
  return new Date(epochSeconds * 1000).toISOString().split('T')[0]
}
