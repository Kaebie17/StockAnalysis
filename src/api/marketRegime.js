/**
 * src/api/marketRegime.js — India VIX + index level, for the market-regime bar.
 *
 * Reuses the existing /api/yahoo endpoint — ^INDIAVIX and ^NSEI are just more
 * symbols through a pipe that already works, so this needs no new backend.
 *
 * Cached in-module for the session: the regime is a market-wide reading shared
 * by every position on screen, so fetching it per position would be the same
 * request repeated a dozen times.
 *
 * Never throws. The regime bar degrades to "no volatility data" and the other
 * three bars are unaffected — a missing macro reading must not take down a page
 * about the user's own holdings.
 */

const TTL_MS = 5 * 60 * 1000
let cache = null      // { at, data }

async function quote(symbol) {
  const r = await fetch(`/api/yahoo?endpoint=all&ticker=${encodeURIComponent(symbol)}`)
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  return j?.quote || null
}

export async function fetchMarketRegime({ indian = true } = {}) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data

  const volSymbol   = indian ? '^INDIAVIX' : '^VIX'
  const indexSymbol = indian ? '^NSEI' : '^GSPC'

  let data = { vix: null, vixAvg: null, indexChangePct: null, indexLevel: null }
  try {
    const [v, idx] = await Promise.allSettled([quote(volSymbol), quote(indexSymbol)])
    const vq = v.status === 'fulfilled' ? v.value : null
    const iq = idx.status === 'fulfilled' ? idx.value : null
    data = {
      vix: vq?.regularMarketPrice ?? null,
      // The 50-day average gives "elevated relative to lately", which is more
      // informative than an absolute threshold in a market whose baseline drifts.
      vixAvg: vq?.fiftyDayAverage ?? null,
      indexChangePct: iq?.regularMarketChangePercent ?? null,
      // The LEVEL, not just the day's move. Without it a position's entry index
      // has nothing to be compared against, so every benchmark line fell back to
      // "no index recorded" — including ones whose snapshot had a perfectly good
      // entry level stored.
      indexLevel: iq?.regularMarketPrice ?? null,
    }
  } catch { /* leave nulls — the bar reports unavailable */ }

  cache = { at: Date.now(), data }
  return data
}

export function clearRegimeCache() { cache = null }

/**
 * VIX and index level as they stood on a past date, for reconstructing the
 * market conditions a position was entered in.
 *
 * Uses the chart endpoint on ^INDIAVIX / ^NSEI, which carries daily history.
 * Availability is not assumed: index history is reliable, but VIX history for an
 * older date can come back empty, and a missing reading is reported as missing
 * rather than filled with today's value — a purchase two years ago labelled with
 * today's volatility would be worse than saying nothing.
 */
const histCache = new Map()      // `${symbol}:${yyyy-mm-dd}` -> value | null

async function closeOn(symbol, dateMs) {
  const day = new Date(dateMs).toISOString().slice(0, 10)
  const key = `${symbol}:${day}`
  if (histCache.has(key)) return histCache.get(key)

  let value = null
  try {
    // A window around the date: the exact day may be a holiday or weekend, and
    // the nearest prior close is the right reading for "what was it then".
    const from = new Date(dateMs - 10 * 86400000).toISOString().slice(0, 10)
    const to   = new Date(Math.min(Date.now(), dateMs + 2 * 86400000)).toISOString().slice(0, 10)
    const r = await fetch(`/api/yahoo?endpoint=history&ticker=${encodeURIComponent(symbol)}` +
                          `&from=${from}&to=${to}`)
    if (r.ok) {
      const j = await r.json().catch(() => null)
      const rows = (j?.history || []).filter(x => x?.date && x.close > 0)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      const onOrBefore = [...rows].reverse().find(x => Date.parse(x.date) <= dateMs + 86400000)
      value = onOrBefore?.close ?? null
    }
  } catch { /* leave null — the caller reports it as unavailable */ }

  histCache.set(key, value)
  return value
}

/**
 * @returns { vix, indexLevel, asOf, missing: [] } — `missing` names what could
 * not be retrieved, so the UI can say so instead of implying a complete record.
 */
export async function fetchRegimeOn(dateMs, { indian = true } = {}) {
  if (!isFinite(dateMs)) return { vix: null, indexLevel: null, missing: ['date'] }
  const volSymbol   = indian ? '^INDIAVIX' : '^VIX'
  const indexSymbol = indian ? '^NSEI' : '^GSPC'

  const [v, i] = await Promise.allSettled([
    closeOn(volSymbol, dateMs), closeOn(indexSymbol, dateMs),
  ])
  const vix = v.status === 'fulfilled' ? v.value : null
  const indexLevel = i.status === 'fulfilled' ? i.value : null

  const missing = []
  if (vix == null) missing.push('volatility')
  if (indexLevel == null) missing.push('index level')

  return { vix, indexLevel, asOf: new Date(dateMs).toISOString().slice(0, 10), missing }
}
