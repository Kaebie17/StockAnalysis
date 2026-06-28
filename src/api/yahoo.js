/**
 * src/api/yahoo.js — client-side fetcher
 * All calls go through /api/yahoo (Vercel serverless).
 *
 * NOTE: chart and quote are fetched in parallel — chart doesn't need crumb
 * so it never blocks on the crumb fetch server-side.
 * timeseries endpoint removed — empty for Indian stocks, redundant for US.
 */

const BASE = '/api/yahoo'

async function yFetch(params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}?${qs}`)
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `Yahoo proxy error ${res.status}`)
  return data
}

/** Resolve bare Indian tickers to Yahoo symbol (e.g. RELIANCE → RELIANCE.NS) */
async function resolveTicker(rawTicker) {
  const ticker = rawTicker.trim().toUpperCase()
  if (ticker.includes('.')) return ticker  // already has suffix

  try {
    const data = await yFetch({ endpoint: 'search', query: ticker })
    const quotes = (data?.quotes || []).filter(q => q.typeDisp === 'Equity')
    // Prefer NSE (.NS), then BSE (.BO), then first equity result
    const nse   = quotes.find(q => q.symbol?.endsWith('.NS'))
    const bse   = quotes.find(q => q.symbol?.endsWith('.BO'))
    const first = quotes[0]
    const resolved = (nse || bse || first)?.symbol
    if (resolved) {
      console.log(`[yahoo] Resolved "${ticker}" → "${resolved}"`)
      return resolved
    }
  } catch (_) {
    // Search failed — fall through to heuristic
  }

  // Heuristic: pure alpha ticker <= 15 chars → try .NS first
  if (/^[A-Z&-]{2,15}$/.test(ticker)) return `${ticker}.NS`
  return ticker
}

export async function fetchYahoo(rawTicker) {
  const ticker = await resolveTicker(rawTicker)

  // Fetch chart and quote in parallel
  const [chartResult, quoteResult] = await Promise.allSettled([
    yFetch({ endpoint: 'chart', ticker }),
    yFetch({ endpoint: 'quote', ticker })
  ])

  const chart = chartResult.status === 'fulfilled' ? chartResult.value : null
  const quote = quoteResult.status === 'fulfilled' ? quoteResult.value : null

  if (!chart && !quote) {
    const err = chartResult.reason?.message || quoteResult.reason?.message || 'No data'
    throw new Error(`Yahoo fetch failed for "${ticker}": ${err}`)
  }

  if (chartResult.status === 'rejected') {
    console.warn('[yahoo] Chart failed:', chartResult.reason?.message)
  }
  if (quoteResult.status === 'rejected') {
    console.warn('[yahoo] Quote failed:', quoteResult.reason?.message)
  }

  return { ticker, chart, quote }
}
