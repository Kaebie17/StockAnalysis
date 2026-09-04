/**
 * src/api/yahoo.js — browser-side client
 * Calls single /api/yahoo?endpoint=all which uses yahoo-finance2 package
 */
import { getResolvedTicker, saveResolvedTicker } from '../utils/db.js'

const BASE = '/api/yahoo'

async function yFetch(params) {
  const r = await fetch(`${BASE}?${new URLSearchParams(params)}`)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

const INDIAN_EXCHANGES = new Set(['NSI', 'BSE', 'NSE', 'BOM', 'NSE India'])

// Exported: orchestrator.js uses this SAME resolution — the real Yahoo symbol
// — to decide SEC vs Screener routing, instead of guessing from the raw
// input's suffix (which is wrong for a bare "RELIANCE", exactly what every
// example ticker on the homepage passes through).
export async function resolveTicker(raw) {
  const ticker = raw.trim().toUpperCase()
  if (ticker.includes('.')) return ticker

  // A ticker's exchange suffix doesn't change once assigned — resolve once,
  // remember forever. Without this, every fresh fetch re-hit Yahoo's search
  // endpoint for the exact same answer every time.
  const cached = await getResolvedTicker(ticker)
  if (cached) return cached

  const remember = async (resolved) => { await saveResolvedTicker(ticker, resolved); return resolved }

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
    if (found) return await remember(found)
  } catch (_) {}

  // Heuristic fallback
  if (/^[A-Z&-]{2,15}$/.test(ticker)) return await remember(`${ticker}.NS`)
  return ticker   // genuinely unresolved — not cached, so a later attempt can retry
}

// `preResolved`, when passed, skips a redundant second resolveTicker() call —
// orchestrator.js already resolves once up front to decide SEC vs Screener,
// and passes that same answer in here rather than resolving twice.
export async function fetchYahoo(rawTicker, preResolved) {
  const ticker = preResolved || await resolveTicker(rawTicker)
  const data   = await yFetch({ endpoint: 'all', ticker })
  return { ticker, ...data }
}
