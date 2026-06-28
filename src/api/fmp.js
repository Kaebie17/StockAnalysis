// FMP API — Financial Modeling Prep
// Free tier: 250 calls/day  |  https://financialmodelingprep.com
// All endpoints return raw data — no derived metrics here

import { cacheGet, cacheSet } from '../utils/db.js'

const BASE = 'https://financialmodelingprep.com/stable/'

async function fmpFetch(endpoint, params = {}, apiKey) {
  // Convert params object to query string format
  const queryParams = new URLSearchParams({ ...params, apikey: apiKey }).toString()
  const url = `${BASE}${endpoint}?${queryParams}`
  const cacheKey = `${endpoint}?${queryParams}`

  // Try cache first
  const cached = await cacheGet(cacheKey)
  if (cached) return cached

  const res = await fetch(url)
  if (!res.ok) throw new Error(`FMP ${res.status}: ${res.statusText}`)
  const data = await res.json()

  // FMP returns { "Error Message": "..." } on bad key / limit
  if (data && data['Error Message']) throw new Error(data['Error Message'])
  if (!data || (Array.isArray(data) && data.length === 0)) throw new Error('No data returned')

  await cacheSet(cacheKey, data)
  return data
}

// ── Raw data fetchers — matching stable endpoints ────

export async function fetchProfile(ticker, apiKey) {
  // Suffix is dropping /v3/ and using symbol= parameter
  return fmpFetch('profile', { symbol: ticker }, apiKey)
}

export async function fetchIncomeStatements(ticker, apiKey, limit = 5) {
  return fmpFetch('income-statement', { symbol: ticker, limit }, apiKey)
}

export async function fetchBalanceSheets(ticker, apiKey, limit = 5) {
  return fmpFetch('balance-sheet-statement', { symbol: ticker, limit }, apiKey)
}

export async function fetchCashFlowStatements(ticker, apiKey, limit = 5) {
  return fmpFetch('cash-flow-statement', { symbol: ticker, limit }, apiKey)
}

export async function fetchKeyMetrics(ticker, apiKey, limit = 5) {
  return fmpFetch('key-metrics', { symbol: ticker, limit }, apiKey)
}

export async function fetchHistoricalPrice(ticker, apiKey, from, to) {
  // Note: Confirm endpoint availability under /stable/ rules or adjust accordingly
  const fromStr = from || getDateNDaysAgo(365)
  const toStr   = to   || getTodayStr()
  return fmpFetch('historical-price-full', { symbol: ticker, from: fromStr, to: toStr }, apiKey)
}

export async function fetchQuote(ticker, apiKey) {
  return fmpFetch('quote', { symbol: ticker }, apiKey)
}

export async function fetchPeers(ticker, apiKey) {
  return fmpFetch('stock_peers', { symbol: ticker }, apiKey)
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