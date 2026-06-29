/**
 * src/api/yahoo.js
 * Fires chart + quote + fundamentals in parallel.
 * Auto-appends .NS for bare Indian tickers via search.
 */

const BASE = '/api/yahoo'

async function yFetch(params) {
  const r = await fetch(`${BASE}?${new URLSearchParams(params)}`)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

// Known Indian stock exchanges on Yahoo — if search returns one of these, add .NS/.BO
const INDIAN_EXCHANGES = new Set(['NSI', 'BSE', 'NSE', 'BOM'])

async function resolveTicker(raw) {
  const ticker = raw.trim().toUpperCase()
  if (ticker.includes('.')) return ticker  // already has suffix

  try {
    const data = await yFetch({ endpoint: 'search', query: ticker })
    const quotes = (data?.quotes || []).filter(q => q.typeDisp === 'Equity' || q.quoteType === 'EQUITY')
    // Prefer exact symbol match first
    const exact = quotes.find(q => q.symbol?.replace(/\.(NS|BO)$/, '') === ticker)
    const nse   = quotes.find(q => q.symbol?.endsWith('.NS'))
    const bse   = quotes.find(q => q.symbol?.endsWith('.BO'))
    const indian = quotes.find(q => INDIAN_EXCHANGES.has(q.exchange))
    const resolved = (exact || nse || bse || indian || quotes[0])?.symbol
    if (resolved) return resolved
  } catch (_) {}

  // Fallback heuristic: pure alpha → try .NS
  if (/^[A-Z&-]{2,15}$/.test(ticker)) return `${ticker}.NS`
  return ticker
}

export async function fetchYahoo(rawTicker) {
  const ticker = await resolveTicker(rawTicker)

  // All three in parallel — none block each other
  const [chartRes, quoteRes, fundsRes] = await Promise.allSettled([
    yFetch({ endpoint: 'chart',        ticker }),
    yFetch({ endpoint: 'quote',        ticker }),
    yFetch({ endpoint: 'fundamentals', ticker })
  ])

  const chart  = chartRes.status  === 'fulfilled' ? chartRes.value  : null
  const quote  = quoteRes.status  === 'fulfilled' ? quoteRes.value  : null
  const funds  = fundsRes.status  === 'fulfilled' ? fundsRes.value  : null

  if (!chart && !quote && !funds) {
    const err = [chartRes, quoteRes, fundsRes].map(r => r.reason?.message).find(Boolean)
    throw new Error(`Yahoo returned no data for "${ticker}": ${err}`)
  }

  if (chartRes.status === 'rejected') console.warn('[yahoo] chart failed:', chartRes.reason?.message)
  if (quoteRes.status === 'rejected') console.warn('[yahoo] quote failed:', quoteRes.reason?.message)
  if (fundsRes.status === 'rejected') console.warn('[yahoo] fundamentals failed:', fundsRes.reason?.message)

  return { ticker, chart, quote, fundamentals: funds }
}
