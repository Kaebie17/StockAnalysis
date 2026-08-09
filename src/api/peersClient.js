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
    const peers = j?.peers || []
    cache.set(t, { at: Date.now(), peers })
    return peers
  } catch {
    return []      // never breaks the page — the estimate falls back to own history
  }
}

export function clearPeersCache() { cache.clear() }
