/**
 * src/api/peersClient.js — similar companies and what they trade at.
 *
 * Second anchor for the multiple. A company's own history can't see a sector-wide
 * re-rating: if every NBFC de-rates together, this stock's past looks like a
 * bargain right up until it isn't. Peers are the only view that distinguishes
 * "the market changed its mind about this company" from "…about this industry",
 * and those two have very different odds of reverting.
 *
 * Candidates come from two automatic sources — NSE's own sectoral index
 * constituents and this browser's own analysis history in the same sector
 * (see fetchPeerCandidates below) — never Yahoo's recommendationsBySymbol,
 * which is effectively empty for Indian tickers. Neither source is cached
 * across a full session by itself (the server already CDN-caches the NSE
 * fetch for a day; the own-cache scan is a cheap local IndexedDB read every
 * time), only the NSE constituent list gets a short in-module cache below,
 * shared across every stock in the same sector.
 */

import { getCached, listCachedTickers } from '../utils/db.js'
import { sectorIndexFor, NSE_SECTORAL_INDEX_KEYS } from './marketRegime.js'

// EV/Revenue, EV/FCF, EV/EBITDA, P/E and P/B all need each peer's own
// financials, not just a live quote — and every one of them is read off
// each peer's OWN cached ratioResult (db.js's getCached/setCached) rather
// than any live network call. Reused for free: if a peer ticker has
// ALREADY been analyzed in this app — this stock's own history, or as
// someone else's peer before — its full financials are already sitting in
// this browser's IndexedDB, including any richer, longer-history Screener
// data if it was ever pasted for that ticker (the cache doesn't track
// source, it just holds whatever's most current). No network call either
// way: a cache hit reads local IndexedDB; a miss just leaves that one peer
// without these fields — peerBand() already filters out missing/
// non-positive values, so an unresolved peer simply doesn't contribute to
// that particular median rather than breaking anything. Coverage grows for
// free as more tickers get analyzed over time — including by deliberately
// opening a peer ticker once to "warm" it, if you want a specific sector's
// peer coverage sooner than that (see PeerSelectModal.jsx for the
// deliberate version of that).
async function enrichFromCache(peers) {
  return Promise.all(peers.map(async p => {
    try {
      const rec = await getCached(p.symbol)
      // `cached` is whether this ticker has EVER been analyzed in this app
      // — distinct from whether these fields actually computed (a cached
      // record might still lack, say, FCF). PeerSelectModal and the
      // auto-open trigger both need the former: "is there anything to gain
      // by loading this peer" is a different question from "did every
      // multiple resolve."
      if (!rec) return { ...p, cached: false }
      const r = rec.ratioResult
      // r.ev, not a hand-reconstructed marketCap+debt-cash — ratios.js
      // already computes and stores enterprise value on every ratioResult,
      // the same figure the rest of the app trusts; recomputing a parallel
      // version here risked silently drifting from it. Same reasoning for
      // pe/pb: ratios.js already computes them (price ÷ EPS, price ÷ book
      // value per share) for every analyzed ticker — reading that instead
      // of a live Yahoo quote means peer P/E and P/B bands need no network
      // call at all, same as the EV multiples below.
      const evRevenue = (r?.ev > 0 && r.revenue > 0) ? r.ev / r.revenue : null
      const evFcf      = (r?.ev > 0 && r.fcf > 0)     ? r.ev / r.fcf     : null
      const evEbitda    = (r?.ev > 0 && r.ebitda > 0)  ? r.ev / r.ebitda  : null
      const pe = r?.ratios?.pe?.value > 0 ? r.ratios.pe.value : null
      const pb = r?.ratios?.pb?.value > 0 ? r.ratios.pb.value : null
      return { ...p, cached: true, evRevenue, evFcf, evEbitda, pe, pb }
    } catch {
      return { ...p, cached: false }   // a read failure just leaves this one peer without the extra fields
    }
  }))
}

// NSE Indices Ltd's own sectoral index constituents (api/nseIndices.js) —
// real, exchange-maintained peer candidates, unlike Yahoo's
// recommendationsBySymbol (documented weak international coverage,
// confirmed empty for RELIANCE.NS). Cached by SECTOR SLUG, not by ticker
// — every stock in the same sector shares the same constituent list, so
// caching per-parent-ticker would refetch/reparse the identical data for
// each one. The server (api/nseIndices.js) already caches the raw fetch
// for a day at the CDN; this just avoids redundant client-side re-fetches
// of that same cached response within a session.
const sectorCache = new Map()   // csvSlug -> { at, constituents }
const SECTOR_TTL_MS = 60 * 60 * 1000   // shorter than the server's day-long cache is fine to keep this simple

async function fetchIndexCsv(csvSlug) {
  const hit = sectorCache.get(csvSlug)
  if (hit && Date.now() - hit.at < SECTOR_TTL_MS) return hit.constituents
  try {
    const r = await fetch(`/api/nseIndices?index=${encodeURIComponent(csvSlug)}`)
    const j = r.ok ? await r.json().catch(() => null) : null
    const constituents = j?.constituents || []
    sectorCache.set(csvSlug, { at: Date.now(), constituents })
    return constituents
  } catch {
    return []
  }
}

export async function fetchSectorConstituents(excludeTicker) {
  const t = String(excludeTicker || '').trim().toUpperCase()
  // NSE only lists NSE-listed (.NS) and dual-listed-on-BSE (.BO) companies
  // — a US ticker or anything else can never appear in these CSVs, so
  // decline before firing ten (cheap, cached, but pointless) requests on
  // every non-Indian ticker's load.
  if (!/\.(NS|BO)$/.test(t)) return []
  const bareTicker = t.replace(/\.(NS|BO)$/, '')

  // Real NSE index MEMBERSHIP, not a text-classification guess: check
  // every one of NSE's 28 published sectoral indices (small, CDN- and
  // session-cached CSVs, cheap to check in parallel) for the ticker's own
  // row, rather than inferring "which one index" from Yahoo's free-text
  // sector/industry via a hand-maintained keyword regex (marketRegime.js's
  // sectorIndexFor — kept for its own, lower-stakes use there, see that
  // file). A regex is a judgment call sitting between two data sources
  // with no guaranteed correspondence between their wording; checking
  // real membership has no such gap — the ticker either is or isn't a row
  // in a given index's own published list. (An earlier version of this
  // checked only ten hand-picked sectors and used the broader "Nifty
  // Energy" theme in place of a dedicated Oil & Gas index — both were
  // guesses that turned out wrong: NSE publishes 28 real sectoral
  // indices, not 10, and Energy isn't even one of them.)
  const perIndex = await Promise.all(NSE_SECTORAL_INDEX_KEYS.map(fetchIndexCsv))

  const matches = new Map()   // symbol -> constituent row
  for (const constituents of perIndex) {
    const ownRow = constituents.find(c => String(c.symbol || '').trim().toUpperCase() === bareTicker)
    if (!ownRow) continue
    // NSE's own per-company Industry column (already in every row of the
    // CSV, no extra call) is a real, finer classification than "member of
    // this Nifty index": Nifty Energy alone spans Oil Gas & Consumable
    // Fuels, Power AND Capital Goods — three different businesses that
    // happen to share one index (confirmed live: RELIANCE's own row is
    // tagged "Oil Gas & Consumable Fuels", same CSV that also lists NTPC
    // as "Power" and Siemens as "Capital Goods"). Narrow to constituents
    // sharing the ticker's own Industry value, not the whole index.
    for (const c of constituents) {
      if (c.industry === ownRow.industry) matches.set(c.symbol, c)
    }
  }

  // Not a member of ANY NSE sectoral index at all — a real, disclosed gap
  // (below the index's market-cap cutoff, a sector NSE doesn't publish a
  // dedicated index for, or a BSE-only listing) rather than something to
  // paper over with a looser guess.
  if (matches.size === 0) return []

  // NSE's CSV symbols are bare (e.g. "BPCL") — this app's convention is
  // exchange-suffixed (e.g. "BPCL.NS"), same as every other ticker.
  const mapped = [...matches.values()].map(c => ({ symbol: `${c.symbol}.NS`, name: c.name, industry: c.industry }))
  const withCache = await enrichFromCache(mapped)
  return withCache.filter(p => p.symbol !== t)
}

// Every ticker this browser has ever analyzed, matched against the CURRENT
// stock's sector — the real fallback for what NSE index MEMBERSHIP
// (#fetchSectorConstituents above) structurally can't cover at all: a
// BSE-only comparable is never a row in any NSE CSV, no matter how
// thoroughly the user has researched it independently, so there's no
// membership check to run for it. A stock the user has personally
// analyzed — under whatever ticker/exchange suffix — gets a real chance
// to surface as a peer here instead.
//
// This is the one place in the peer pipeline that still uses
// sectorIndexFor's text-classification regex, not real membership data —
// unavoidably: a cached candidate with no NSE index row of its own (that's
// the whole reason it needs this fallback) has no NSE Industry label to
// check against either. Matched on csvSlug (not on sectorType, which is a
// coarse valuation-methodology bucket — checked stage.js directly:
// STANDARD/BANK/NBFC/INSURANCE/YIELD/HOLDING/REALTY/CYCLICAL/
// CAPITAL_INTENSIVE — where RELIANCE and an unrelated IT company could
// both land in STANDARD). Both sides must resolve to a KNOWN bucket, so
// this declines for a sector SECTOR_INDICES doesn't cover at all, same as
// fetchSectorConstituents — it doesn't guess at a looser match just
// because the precise one came up empty. Being the lower-confidence,
// text-matched tier is exactly why PeerSelectModal tags these 'own-cache'
// rather than showing an NSE industry label.
async function fetchCachedSameSector(meta, sectorType, excludeTicker) {
  const target = sectorIndexFor(meta, sectorType)
  if (!target) return []

  const t = String(excludeTicker || '').trim().toUpperCase()
  let all
  try {
    all = await listCachedTickers()
  } catch {
    return []
  }

  const matches = all.filter(rec => {
    if (rec.symbol === t) return false
    const recIdx = sectorIndexFor(rec.meta, rec.sectorType)
    return recIdx?.csvSlug === target.csvSlug
  })

  const mapped = matches.map(rec => ({ symbol: rec.symbol, name: rec.name, industry: rec.meta?.industry || null }))
  return enrichFromCache(mapped)
}

// Merges NSE's real sectoral constituents (#fetchSectorConstituents — the
// primary source, exchange-maintained and automatic) with this browser's
// own analysis history in the same sector (#fetchCachedSameSector — covers
// what NSE's list structurally can't: BSE-only names). Yahoo's
// recommendationsBySymbol was dropped entirely, not kept as a third
// best-effort source — confirmed empty for RELIANCE.NS, and the library's
// own docs say international/small-cap coverage is weak generally, so for
// this app's actual market (Indian equities) it was never contributing a
// real candidate; every peer field it used to supply (pe/forwardPe/pb/
// marketCap) is now read off each cached peer's own ratioResult instead
// (see enrichFromCache above), so nothing downstream lost real data by
// dropping it. Every candidate is tagged with which source(s) surfaced it,
// so PeerSelectModal can show why it's in the list — these are candidates
// to review, not automatic peers.
export async function fetchPeerCandidates({ ticker, meta, sectorType } = {}) {
  const [nse, ownCache] = await Promise.all([
    fetchSectorConstituents(ticker),
    fetchCachedSameSector(meta, sectorType, ticker),
  ])

  const bySymbol = new Map()
  for (const p of nse) bySymbol.set(p.symbol, { ...p, sources: ['nse-index'] })
  for (const p of ownCache) {
    const existing = bySymbol.get(p.symbol)
    if (existing) {
      bySymbol.set(p.symbol, { ...existing, ...p, sources: [...existing.sources, 'own-cache'] })
    } else {
      bySymbol.set(p.symbol, { ...p, sources: ['own-cache'] })
    }
  }
  return [...bySymbol.values()]
}

export function clearPeersCache() { sectorCache.clear() }
