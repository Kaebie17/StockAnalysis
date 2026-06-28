/**
 * src/api/yahoo.js
 *
 * All calls go through /api/yahoo (Vercel serverless) which handles
 * the Yahoo session cookie + crumb requirement server-side.
 *
 * In dev mode, Vite does NOT proxy /api/yahoo — it runs via `vercel dev`
 * or you set VITE_USE_VERCEL_DEV=true.
 * For pure Vite dev, we expose a fallback note in the error.
 */

const BASE = '/api/yahoo'

async function yFetch(params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${BASE}?${qs}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `Yahoo proxy error ${res.status}`)
  }
  return res.json()
}

/** Auto-resolve Indian tickers: try bare name, then .NS, then .BO */
async function resolveTicker(rawTicker) {
  const ticker = rawTicker.trim().toUpperCase()

  // Already has exchange suffix
  if (ticker.includes('.')) return ticker

  // Try to resolve via Yahoo search
  try {
    const data = await yFetch({ endpoint: 'search', query: ticker })
    const quotes = data?.quotes || []
    // Prefer NSE (.NS) then BSE (.BO) then first result
    const nse = quotes.find(q => q.symbol?.endsWith('.NS') && q.typeDisp === 'Equity')
    const bse = quotes.find(q => q.symbol?.endsWith('.BO') && q.typeDisp === 'Equity')
    const first = quotes.find(q => q.typeDisp === 'Equity')
    if (nse) return nse.symbol
    if (bse) return bse.symbol
    if (first) return first.symbol
  } catch (_) {
    // Search failed — try appending .NS for common Indian tickers
  }

  // Heuristic: if it looks like an Indian ticker, try .NS
  // (Many NSE tickers are pure alpha, <= 10 chars)
  if (/^[A-Z&]{2,15}$/.test(ticker)) {
    return `${ticker}.NS`
  }

  return ticker
}

export async function fetchYahoo(rawTicker) {
  const ticker = await resolveTicker(rawTicker)

  // Fetch all 3 endpoints in parallel
  const [chartData, quoteData, timeseriesData] = await Promise.allSettled([
    yFetch({ endpoint: 'chart', ticker }),
    yFetch({ endpoint: 'quote', ticker }),
    yFetch({ endpoint: 'timeseries', ticker })
  ])

  const chart = chartData.status === 'fulfilled' ? chartData.value : null
  const quote = quoteData.status === 'fulfilled' ? quoteData.value : null
  const ts    = timeseriesData.status === 'fulfilled' ? timeseriesData.value : null

  if (!chart && !quote) {
    throw new Error(`No data returned for "${ticker}". Check the ticker symbol.`)
  }

  return { ticker, chart, quote, timeseries: ts }
}
