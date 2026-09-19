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
import { assessValuationPeerEligibility } from './peerCompatibility.js'

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

/**
 * peerBand(), screened by financial-eligibility first — deliberately a
 * wrapper, not a change to peerBand() itself, so the underlying statistical
 * function (outlier filtering, percentile spread) stays reusable and
 * untouched. Without this, a peer flagged "not eligible" in the UI (e.g.
 * loss-making, wrong scale) still fully drove the multiple once confirmed —
 * the eligibility badge was advisory-only with no actual gate anywhere.
 *
 * Falls back to every confirmed peer (peerBand()'s original behavior) when
 * fewer than `minimumEligiblePeers` clear ELIGIBLE — but that fallback is
 * NEVER silent: `screeningMode`/`warning` on the result say exactly when it
 * happened, so a caller (or the UI) can't accidentally present a fallback
 * result as a clean screened one.
 *
 * @param eligibilityMetric  separate from `metric` on purpose — e.g. an
 *   EV/Revenue band (`metric: 'evRevenue'`) still screens on net-margin-type
 *   comparability via `eligibilityMetric: 'pe'` if that's the more relevant
 *   check, though callers here mostly keep them aligned. See
 *   peerCompatibility.js's PROFITABILITY_FIELD for which metrics actually
 *   gate on profitability at all (ev_revenue and pb never do, by design).
 */
export function screenedPeerBand({ peers = [], metric = 'pe', targetFin, eligibilityMetric = metric, minimumEligiblePeers = 3 } = {}) {
  const scored = peers.map(peer => ({
    ...peer,
    eligibility: assessValuationPeerEligibility(null, null, targetFin, peer, { metric: eligibilityMetric }),
  }))
  // USABLE means ELIGIBLE or ELIGIBLE_WITH_CAVEAT — a caveat is a disclosed
  // difference (margin gap, scale gap, a missing optional field), not a
  // reason to throw the peer out. Only NOT_ELIGIBLE (a real profitability
  // mismatch for this metric) and UNASSESSED (a field REQUIRED for this
  // metric's own hard check is missing — see peerCompatibility.js's
  // PROFITABILITY_FIELD) are excluded. An earlier version of this filtered
  // to ELIGIBLE only, which meant almost any real peer — margin, scale, and
  // leverage all matching closely enough to carry zero caveats is rare —
  // fell out of the "clean" set, so the fallback below fired on nearly
  // every real peer set and the screening did almost nothing in practice.
  const usable = scored.filter(p =>
    p.eligibility.valuationEligibility === 'ELIGIBLE' || p.eligibility.valuationEligibility === 'ELIGIBLE_WITH_CAVEAT')
  const useUsableOnly = usable.length >= minimumEligiblePeers
  const peersUsed = useUsableOnly ? usable : scored

  const band = peerBand(peersUsed, metric)
  if (!band) return null

  return {
    ...band,
    peersUsed,
    excludedPeers: useUsableOnly ? scored.filter(p => !usable.includes(p)) : [],
    screeningMode: useUsableOnly ? 'eligible_only' : 'fallback_all_confirmed',
    warning: useUsableOnly ? null
      : `Only ${usable.length} usable peer${usable.length === 1 ? '' : 's'} of ${scored.length} confirmed — all confirmed peers were used instead of the screened set.`,
  }
}
