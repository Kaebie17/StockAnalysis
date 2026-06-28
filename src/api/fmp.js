// FMP API — Financial Modeling Prep
// Free tier: 250 calls/day  |  https://financialmodelingprep.com
// All endpoints return raw data — no derived metrics here

import { cacheGet, cacheSet } from '../utils/db.js'

const BASE = 'https://financialmodelingprep.com/api'

async function fmpFetch(path, apiKey) {
  const url       = `${BASE}${path}&apikey=${apiKey}`
  const cacheKey  = path

  // Try cache first
  const cached = await cacheGet(cacheKey)
  if (cached) return cached

  const res  = await fetch(url)
  if (!res.ok) throw new Error(`FMP ${res.status}: ${res.statusText}`)
  const data = await res.json()

  // FMP returns { "Error Message": "..." } on bad key / limit
  if (data['Error Message']) throw new Error(data['Error Message'])
  if (!data || (Array.isArray(data) && data.length === 0)) throw new Error('No data returned')

  await cacheSet(cacheKey, data)
  return data
}

// ── Raw data fetchers — return exactly what FMP sends ────

export async function fetchProfile(ticker, apiKey) {
  // Company name, sector, industry, exchange, description, beta, mktCap, price
  return fmpFetch(`/v3/profile/${ticker}?`, apiKey)
}

export async function fetchIncomeStatements(ticker, apiKey, limit = 5) {
  // Revenue, grossProfit, ebitda, operatingIncome, netIncome, eps — annual
  return fmpFetch(`/v3/income-statement/${ticker}?limit=${limit}&`, apiKey)
}

export async function fetchBalanceSheets(ticker, apiKey, limit = 5) {
  // totalAssets, totalDebt, totalEquity, cashAndCashEquivalents, bookValuePerShare
  return fmpFetch(`/v3/balance-sheet-statement/${ticker}?limit=${limit}&`, apiKey)
}

export async function fetchCashFlowStatements(ticker, apiKey, limit = 5) {
  // operatingCashFlow, capitalExpenditure, freeCashFlow, dividendsPaid
  return fmpFetch(`/v3/cash-flow-statement/${ticker}?limit=${limit}&`, apiKey)
}

export async function fetchKeyMetrics(ticker, apiKey, limit = 5) {
  // revenuePerShare, netIncomePerShare, operatingCashFlowPerShare, pe, pb
  return fmpFetch(`/v3/key-metrics/${ticker}?limit=${limit}&`, apiKey)
}

export async function fetchHistoricalPrice(ticker, apiKey, from, to) {
  // OHLCV daily — used for technicals
  const fromStr = from || getDateNDaysAgo(365)
  const toStr   = to   || getTodayStr()
  return fmpFetch(`/v3/historical-price-full/${ticker}?from=${fromStr}&to=${toStr}&`, apiKey)
}

export async function fetchQuote(ticker, apiKey) {
  // Current price, change, volume, marketCap, pe, eps, 52w high/low
  return fmpFetch(`/v3/quote/${ticker}?`, apiKey)
}

export async function fetchPeers(ticker, apiKey) {
  // Array of peer tickers in same sector
  return fmpFetch(`/v4/stock_peers?symbol=${ticker}&`, apiKey)
}

// ── Orchestrator: fetch all raw data for a ticker ────────

export async function fetchAllRawData(ticker, apiKey) {
  const results = await Promise.allSettled([
    fetchProfile(ticker, apiKey),
    fetchIncomeStatements(ticker, apiKey),
    fetchBalanceSheets(ticker, apiKey),
    fetchCashFlowStatements(ticker, apiKey),
    fetchKeyMetrics(ticker, apiKey),
    fetchHistoricalPrice(ticker, apiKey),
    fetchQuote(ticker, apiKey),
  ])

  const [profile, income, balance, cashflow, metrics, history, quote] = results

  // Surface any errors
  const errors = []
  results.forEach((r, i) => {
    const names = ['profile','income','balance','cashflow','metrics','history','quote']
    if (r.status === 'rejected') errors.push(`${names[i]}: ${r.reason?.message}`)
  })

  return {
    raw: {
      profile:   profile.status  === 'fulfilled' ? profile.value[0]   : null,
      income:    income.status   === 'fulfilled' ? income.value        : [],
      balance:   balance.status  === 'fulfilled' ? balance.value       : [],
      cashflow:  cashflow.status === 'fulfilled' ? cashflow.value      : [],
      metrics:   metrics.status  === 'fulfilled' ? metrics.value       : [],
      history:   history.status  === 'fulfilled' ? history.value       : null,
      quote:     quote.status    === 'fulfilled' ? quote.value[0]      : null,
    },
    errors,
    source: 'FMP API',
    fetchedAt: Date.now(),
  }
}

// ── Helpers ──────────────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().split('T')[0]
}

function getDateNDaysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().split('T')[0]
}
