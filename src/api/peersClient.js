/**
 * src/api/peersClient.js — similar companies and what they trade at.
 *
 * Second anchor for the multiple. A company's own history can't see a sector-wide
 * re-rating: if every NBFC de-rates together, this stock's past looks like a
 * bargain right up until it isn't. Peers are the only view that distinguishes
 * "the market changed its mind about this company" from "…about this industry",
 * and those two have very different odds of reverting.
 *
 * Cached for the session — peer multiples move slowly, and this is called from
 * pages that re-render often.
 */

import { getCached } from '../utils/db.js'

const TTL_MS = 30 * 60 * 1000
const cache = new Map()      // ticker -> { at, peers }

export async function fetchPeers(ticker) {
  const t = String(ticker || '').trim().toUpperCase()
  if (!t) return []
  const hit = cache.get(t)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.peers

  try {
    const r = await fetch(`/api/yahoo?endpoint=peers&ticker=${encodeURIComponent(t)}`)
    if (!r.ok) return []
    const j = await r.json().catch(() => null)
    const peers = await enrichFromCache(j?.peers || [])
    cache.set(t, { at: Date.now(), peers })
    return peers
  } catch {
    return []      // never breaks the page — the estimate falls back to own history
  }
}

// EV/Revenue, EV/FCF and EV/EBITDA need real revenue/EBITDA/FCF/debt/cash
// — fields Yahoo's batched quote() call above doesn't carry (only
// pe/forwardPe/pb/marketCap). Those fields only exist on quoteSummary(),
// which can't be batched, so fetching them live would mean one extra
// Yahoo call PER peer (up to 8) on every single fetch of this endpoint.
// Used by both marketExpectation.js (Sales/FCF terminal multiples) and
// valuation.js (EV/EBITDA and P/S extrinsic models) — same gap, same fix,
// in both files.
//
// Reused for free instead: if a peer ticker has ALREADY been analyzed in
// this app — this stock's own history, or as someone else's peer before —
// its full financials are already sitting in this browser's IndexedDB
// (db.js's getCached/setCached), including any richer, longer-history
// Screener data if it was ever pasted for that ticker (the cache doesn't
// track source, it just holds whatever's most current). No network call
// either way: a cache hit reads local IndexedDB; a miss just leaves that
// one peer without evRevenue/evFcf/evEbitda — peerBand() already filters
// out missing/non-positive values, so an unresolved peer simply doesn't
// contribute to that particular median rather than breaking anything.
// Coverage grows for free as more tickers get analyzed over time —
// including by deliberately opening a peer ticker once to "warm" it, if
// you want a specific sector's peer coverage sooner than that (see
// PeerSelectModal.jsx for the deliberate version of that).
async function enrichFromCache(peers) {
  return Promise.all(peers.map(async p => {
    try {
      const rec = await getCached(p.symbol)
      // `cached` is whether this ticker has EVER been analyzed in this app
      // — distinct from whether evRevenue/evFcf/evEbitda actually computed
      // (a cached record might still lack, say, FCF). PeerSelectModal and
      // the auto-open trigger both need the former: "is there anything to
      // gain by loading this peer" is a different question from "did every
      // multiple resolve."
      if (!rec) return { ...p, cached: false }
      const r = rec.ratioResult
      // r.ev, not a hand-reconstructed marketCap+debt-cash — ratios.js
      // already computes and stores enterprise value on every ratioResult,
      // the same figure the rest of the app trusts; recomputing a parallel
      // version here risked silently drifting from it.
      const evRevenue = (r?.ev > 0 && r.revenue > 0) ? r.ev / r.revenue : null
      const evFcf      = (r?.ev > 0 && r.fcf > 0)     ? r.ev / r.fcf     : null
      const evEbitda    = (r?.ev > 0 && r.ebitda > 0)  ? r.ev / r.ebitda  : null
      return { ...p, cached: true, evRevenue, evFcf, evEbitda }
    } catch {
      return { ...p, cached: false }   // a read failure just leaves this one peer without the extra fields
    }
  }))
}

export function clearPeersCache() { cache.clear() }
