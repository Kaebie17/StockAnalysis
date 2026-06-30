/**
 * src/api/yahoo.js — browser-side client
 * Calls single /api/yahoo?endpoint=all which uses yahoo-finance2 package
 */

const BASE = '/api/yahoo'

async function yFetch(params) {
  const r = await fetch(`${BASE}?${new URLSearchParams(params)}`)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

const INDIAN_EXCHANGES = new Set(['NSI', 'BSE', 'NSE', 'BOM', 'NSE India'])

async function resolveTicker(raw) {
  const ticker = raw.trim().toUpperCase()
  if (ticker.includes('.')) return ticker

  try {
    const data = await yFetch({ endpoint: 'search', query: ticker })
    const quotes = (data?.quotes || []).filter(q =>
      q.typeDisp === 'Equity' || q.quoteType === 'EQUITY'
    )
    const exact  = quotes.find(q => q.symbol?.replace(/\.(NS|BO)$/, '') === ticker)
    const nse    = quotes.find(q => q.symbol?.endsWith('.NS'))
    const bse    = quotes.find(q => q.symbol?.endsWith('.BO'))
    const indian = quotes.find(q => INDIAN_EXCHANGES.has(q.exchange))
    const found  = (exact || nse || bse || indian || quotes[0])?.symbol
    if (found) return found
  } catch (_) {}

  // Heuristic fallback
  if (/^[A-Z&-]{2,15}$/.test(ticker)) return `${ticker}.NS`
  return ticker
}

export async function fetchYahoo(rawTicker) {
  const ticker = await resolveTicker(rawTicker)
  const data   = await yFetch({ endpoint: 'all', ticker })
  return { ticker, ...data }
}
