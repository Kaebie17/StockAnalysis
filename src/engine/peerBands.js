/**
 * src/engine/peerBands.js — the median/quartile band a set of real peer
 * quotes trades at, for one named multiple.
 *
 * Generalizes what rerating.js's peerBandFrom() already did (P/E only, one
 * per-peer forward-then-trailing fallback) into a reusable, metric-agnostic
 * form — Fair Value's P/E and P/B models (src/engine/valuation.js) need the
 * same "median peer multiple, only trust it with enough peers" logic
 * rerating.js already proved out for App Target, just for more than one
 * field and without baking in that one specific fallback rule.
 */

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

function quantile(sorted, p) {
  const a = [...sorted].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]
}

// Sanity ceilings per metric — a peer quote glitch (or a genuinely distressed
// name trading at some absurd multiple) shouldn't drag the whole band with it.
const SANITY_MAX = { pe: 100, forwardPe: 100, pb: 30 }

/**
 * @param peers  [{ pe, forwardPe, pb, ... }] — from src/api/peersClient.js
 * @param metric which field to band ('pe' | 'forwardPe' | 'pb')
 * @returns { low, median, high, count } (25th/50th/75th percentile) or null
 *          if fewer than 3 peers have a usable value for this metric — too
 *          few to describe a range, same threshold rerating.js already used.
 */
export function peerBand(peers = [], metric = 'pe') {
  const max = SANITY_MAX[metric] ?? 100
  const vals = peers.map(p => p?.[metric]).filter(v => v > 0 && v < max).sort((a, b) => a - b)
  if (vals.length < 3) return null
  return {
    low: round(quantile(vals, 0.25), 1),
    median: round(quantile(vals, 0.5), 1),
    high: round(quantile(vals, 0.75), 1),
    count: vals.length,
  }
}
