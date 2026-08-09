/**
 * src/api/quotesClient.js — current prices for many tickers in one request.
 *
 * The positions pages need a live price for every holding, including stocks the
 * user hasn't opened — otherwise a sold position stays frozen at its exit price
 * forever and the whole "what happened next" review has nothing to work from.
 * Visit-triggered refresh can't solve that by definition: the interesting cases
 * are exactly the ones nobody is visiting.
 */

const TTL_MS = 2 * 60 * 1000
const cache = new Map()      // symbol -> { at, quote }

/**
 * @param symbols array of tickers
 * @returns { [symbol]: { price, changePct, prevClose, currency } }
 */
export async function fetchQuotes(symbols = [], { force = false } = {}) {
  const wanted = [...new Set(symbols.filter(Boolean))]
  if (wanted.length === 0) return {}

  const now = Date.now()
  const out = {}
  const missing = []
  for (const s of wanted) {
    const hit = cache.get(s)
    if (!force && hit && now - hit.at < TTL_MS) out[s] = hit.quote
    else missing.push(s)
  }
  if (missing.length === 0) return out

  try {
    // Chunked: a very long query string can be rejected upstream, and one
    // oversized request failing would take out prices for every position rather
    // than just the tickers in that chunk.
    for (let i = 0; i < missing.length; i += 40) {
      const chunk = missing.slice(i, i + 40)
      const r = await fetch(`/api/yahoo?endpoint=quotes&tickers=${encodeURIComponent(chunk.join(','))}`)
      if (!r.ok) continue
      const j = await r.json().catch(() => null)
      for (const [sym, q] of Object.entries(j?.quotes || {})) {
        cache.set(sym, { at: now, quote: q })
        out[sym] = q
      }
    }
  } catch { /* partial results are fine — callers render what they have */ }

  return out
}

export function clearQuotesCache() { cache.clear() }
