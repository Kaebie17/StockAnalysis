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

import { percentileSpread, filterRelativeOutliers } from './spread.js'

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

// A peer quote glitch (or a genuinely distressed name trading at some absurd
// multiple) shouldn't drag the whole band with it — but a flat universal
// ceiling (this used to be pe/forwardPe: 100, pb: 30) is a judgement about
// what a peer is allowed to trade at that has no basis, and would silently
// discard a real peer's real multiple the same way a fixed band already did
// for this stock's OWN multiple history (see estimate.js's forwardPeBand).
// Measured against the peer GROUP's own median instead: a peer more than 4x
// (or less than a quarter of) what its peers trade at is far more likely bad
// data than a real, wildly-differently-priced comparable.
const OUTLIER_MULTIPLE = 4

/**
 * @param peers  [{ pe, forwardPe, pb, ... }] — from src/api/peersClient.js
 * @param metric which field to band ('pe' | 'forwardPe' | 'pb')
 * @returns { low, median, high, count } (25th/50th/75th percentile) or null
 *          if fewer than 3 peers have a usable value for this metric — too
 *          few to describe a range, same threshold rerating.js already used.
 */
export function peerBand(peers = [], metric = 'pe') {
  const raw = peers.map(p => p?.[metric]).filter(v => v > 0)
  const cleaned = filterRelativeOutliers(raw, { multiple: OUTLIER_MULTIPLE, minKeep: 3 })
  const ps = percentileSpread(cleaned, { lowP: 0.25, highP: 0.75, minSamples: 3 })
  if (!ps) return null
  return {
    low: round(ps.low, 1),
    median: round(ps.median, 1),
    high: round(ps.high, 1),
    count: ps.count,
  }
}
