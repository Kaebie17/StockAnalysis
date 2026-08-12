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
 * Sector index for a company, from its sector/industry labels.
 *
 * A de-rating measured only against a stock's own history can't tell "the market
 * changed its mind about this company" from "…about this whole industry" — and
 * those have very different odds of reverting. The sector index is what
 * separates them.
 */
const SECTOR_INDICES = [
  [/bank/i,                                    '^NSEBANK',   'Nifty Bank'],
  [/financial|nbfc|credit|insurance|finance/i, '^CNXFIN',    'Nifty Financial Services'],
  [/software|information technology|\bit\b/i,  '^CNXIT',     'Nifty IT'],
  [/auto|vehicle|tyre/i,                       '^CNXAUTO',   'Nifty Auto'],
  [/pharma|drug|healthcare|hospital/i,         '^CNXPHARMA', 'Nifty Pharma'],
  [/metal|steel|mining|aluminium/i,            '^CNXMETAL',  'Nifty Metal'],
  [/fmcg|consumer|food|beverage|personal/i,    '^CNXFMCG',   'Nifty FMCG'],
  [/energy|oil|gas|petroleum|power|utility/i,  '^CNXENERGY', 'Nifty Energy'],
  [/realty|real estate|construction|cement/i,  '^CNXREALTY', 'Nifty Realty'],
  [/media|entertainment|broadcast/i,           '^CNXMEDIA',  'Nifty Media'],
]

export function sectorIndexFor(meta = {}, sectorType = null) {
  const hay = `${meta?.industry || ''} ${meta?.sector || ''} ${sectorType || ''}`
  for (const [re, symbol, name] of SECTOR_INDICES) {
    if (re.test(hay)) return { symbol, name }
  }
  return null
}

const relCache = new Map()   // `${symbol}:${days}` -> { change, from }

/**
 * How an index has moved over a window. Used to place a stock's move in context:
 * the same −8% means opposite things depending on whether the sector fell 12% or
 * rose 3%.
 */
export async function indexMove(symbol, days = 180) {
  if (!symbol) return null
  const key = `${symbol}:${days}`
  const hit = relCache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value

  let value = null
  try {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10)
    const to = new Date().toISOString().slice(0, 10)
    const r = await fetch(`/api/yahoo?endpoint=history&ticker=${encodeURIComponent(symbol)}` +
                          `&from=${from}&to=${to}`)
    if (r.ok) {
      const j = await r.json().catch(() => null)
      const rows = (j?.history || []).filter(x => x?.close > 0)
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      if (rows.length >= 2) {
        const first = rows[0].close, last = rows[rows.length - 1].close
        value = { changePct: ((last - first) / first) * 100, from: rows[0].date, level: last }
      }
    }
  } catch { /* absent rather than wrong */ }

  relCache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Stock against its sector and against the market.
 *
 * Three numbers rather than one, because they answer different questions: how
 * the holding did, whether the sector explains it, and whether the sector itself
 * moved with the market.
 */
export async function relativePerformance({ priceHistory = [], meta, sectorType, days = 180 } = {}) {
  const rows = (priceHistory || []).filter(p => p?.date && p.close > 0)
    .map(p => ({ t: Date.parse(p.date), close: p.close }))
    .filter(p => isFinite(p.t) && p.t >= Date.now() - days * 86400000)
    .sort((a, b) => a.t - b.t)
  if (rows.length < 2) return null

  const stockPct = ((rows[rows.length - 1].close - rows[0].close) / rows[0].close) * 100
  const sector = sectorIndexFor(meta, sectorType)

  const [mkt, sec] = await Promise.all([
    indexMove('^NSEI', days),
    sector ? indexMove(sector.symbol, days) : Promise.resolve(null),
  ])

  const r = v => (v == null || !isFinite(v) ? null : +v.toFixed(1))
  return {
    days,
    stockPct: r(stockPct),
    marketPct: r(mkt?.changePct),
    sectorPct: r(sec?.changePct),
    sectorName: sector?.name || null,
    vsMarket: mkt ? r(stockPct - mkt.changePct) : null,
    vsSector: sec ? r(stockPct - sec.changePct) : null,
    // Whether the sector itself moved, which is what separates a company story
    // from an industry one.
    sectorVsMarket: (sec && mkt) ? r(sec.changePct - mkt.changePct) : null,
  }
}

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
