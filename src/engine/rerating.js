/**
 * src/engine/rerating.js — has the market permanently changed what it will pay?
 *
 * This is the failure mode the estimate can't see on its own. Growth and margin
 * changes eventually show up in reported numbers; a re-rating never does. The
 * observed multiple band keeps describing the old regime, so the estimate goes
 * on calling a stock cheap while it de-rates — the range says "cheap" all the
 * way down and is technically correct about a world that stopped existing.
 *
 * Two measurable readings, neither of which is a judgment call:
 *
 *   SUSTAINED DEVIATION — the market has traded outside the historical band for
 *   long enough that "temporary" stops being a reasonable description.
 *
 *   PEER-RELATIVE — did the whole sector re-rate, or just this company? Those
 *   have different odds of reverting, and only peers can tell them apart.
 *
 * What deliberately isn't automated is the first few weeks. Nothing distinguishes
 * a panic from a permanent repricing in real time, so the detector stays quiet
 * until a deviation has persisted, and always reports how long it has held so
 * the user is accepting a measured fact rather than a hunch.
 */

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const DAY = 86400000

// How long a deviation must persist before it counts as a re-rating — but ONLY
// when nothing explains it. Time is a substitute for evidence: with no visible
// cause, duration is the only way to tell a bad month from a permanent change.
// Where a cause exists — a result, a policy change, a news item the user has
// acted on — the cause IS the evidence and waiting is just delay. See
// `opts.cause` below.
const MIN_MONTHS_UNEXPLAINED = 3
// How far outside the band counts as "outside" at all — a multiple grazing the
// edge of its own historical range is unremarkable.
const MIN_DEVIATION = 0.08

/**
 * @param priceHistory  daily closes
 * @param incomeHistory annual rows (for forward EPS by year)
 * @param band          { low, median, high } from forwardPeBand
 * @param peerBand      { median, ... } optional
 */
export function detectRerating(priceHistory = [], incomeHistory = [], band = null, opts = {}) {
  const { peerBand = null, currentEps = null, monthsWindow = 6 } = opts
  if (!band?.median || !(band.median > 0)) {
    return { detected: false, reason: 'No historical multiple band to compare against' }
  }

  // The band this is compared against is a FORWARD one (price over NEXT year's
  // earnings), so the current reading has to be forward too. Measuring today's
  // price against today's EPS produces a trailing multiple, and the gap between
  // trailing and forward is roughly the growth rate — so a growing company would
  // read as permanently "re-rated upward" and the detector would fire on
  // arithmetic rather than on anything the market did.
  const trailingEps = currentEps ?? latestEps(incomeHistory)
  if (!(trailingEps > 0)) return { detected: false, reason: 'No EPS to measure the current multiple' }
  const g = opts.growth
  const eps = (g != null && isFinite(g) && g > -0.5) ? trailingEps * (1 + g) : trailingEps
  if (g == null) {
    // Without a growth rate the two aren't comparable at all; saying so beats
    // reporting a re-rating that is really just the growth gap.
    return { detected: false, reason: 'No growth rate available to compare like with like' }
  }

  const cutoff = Date.now() - monthsWindow * 30 * DAY
  const recent = (priceHistory || [])
    .filter(p => p?.date && p.close > 0 && Date.parse(p.date) >= cutoff)
    .map(p => ({ t: Date.parse(p.date), pe: p.close / eps }))
    .filter(p => isFinite(p.t) && p.pe > 0)
    .sort((a, b) => a.t - b.t)

  if (recent.length < 30) {
    return { detected: false, reason: 'Not enough recent prices to judge a re-rating' }
  }

  const median = q(recent.map(r => r.pe), 0.5)
  const below = median < band.low
  const above = median > band.high
  if (!below && !above) {
    return { detected: false, current: round(median), band,
             reason: 'Trading within its usual multiple range' }
  }

  const edge = below ? band.low : band.high
  const deviation = (median - edge) / edge
  if (Math.abs(deviation) < MIN_DEVIATION) {
    return { detected: false, current: round(median), band, reason: 'Only marginally outside its range' }
  }

  // How long has it stayed on this side? Walk back to the last close that was
  // inside the band — that's when the regime changed.
  let sinceMs = null
  for (let i = recent.length - 1; i >= 0; i--) {
    const inside = recent[i].pe >= band.low && recent[i].pe <= band.high
    if (inside) { sinceMs = recent[i].t; break }
  }
  const heldDays = sinceMs ? Math.round((Date.now() - sinceMs) / DAY)
                           : Math.round((Date.now() - recent[0].t) / DAY)
  const heldMonths = heldDays / 30

  // A known cause removes the waiting period entirely. Requiring 90 days after a
  // regulator restricts a business line, or after results reset what the company
  // earns, is waiting for confirmation of something already confirmed.
  const cause = opts.cause || null
  if (!cause && heldMonths < MIN_MONTHS_UNEXPLAINED) {
    return { detected: false, current: round(median), band, heldDays,
             reason: `Outside its range for ${Math.round(heldDays)} days with nothing explaining it — ` +
                     `too soon to tell a drawdown from a re-rating` }
  }

  // Sector index. Peers give a snapshot of what comparable companies trade at;
  // the index says whether the whole sector actually MOVED. A stock that
  // de-rated alongside its industry is in a different situation from one that
  // de-rated alone, and only the index distinguishes them.
  let sectorContext = null
  if (opts.relative?.sectorPct != null) {
    const { sectorPct, marketPct, vsSector, sectorName } = opts.relative
    const sectorFell = sectorPct <= -5
    sectorContext = {
      sectorName, sectorPct, marketPct, vsSector,
      sectorWide: below ? sectorFell : sectorPct >= 5,
      label: below
        ? (sectorFell
            ? `${sectorName || 'The sector'} is down ${Math.abs(round(sectorPct))}% too — this looks industry-wide`
            : `${sectorName || 'The sector'} is ${sectorPct >= 0 ? 'up' : 'down'} ${Math.abs(round(sectorPct))}% — the de-rating is specific to this company`)
        : `${sectorName || 'The sector'} is ${sectorPct >= 0 ? 'up' : 'down'} ${Math.abs(round(sectorPct))}% over the same period`,
    }
  }

  // Peer context. A sector-wide move is more likely to persist; a lone one is
  // more likely to mean-revert. The detector reports which, and doesn't pretend
  // to know the odds beyond that.
  let peerContext = null
  if (peerBand?.median > 0) {
    const vsPeers = (median - peerBand.median) / peerBand.median
    peerContext = {
      peerMedian: round(peerBand.median),
      vsPeersPct: round(vsPeers * 100),
      sectorWide: Math.abs(vsPeers) < 0.15,
      label: Math.abs(vsPeers) < 0.15
        ? 'Peers are on similar multiples — this looks sector-wide'
        : vsPeers < 0
        ? 'Peers trade higher — this is specific to this company'
        : 'Peers trade lower — this company is the outlier on the upside',
    }
  }

  return {
    detected: true,
    direction: below ? 'de-rated' : 're-rated up',
    current: round(median),
    band,
    deviationPct: round(deviation * 100),
    heldDays, heldMonths: round(heldMonths, 0),
    cause,
    peerContext, sectorContext,
    proposal: {
      multiple: round(median, 1),
      label: `Adopt ${round(median, 1)}× as the base multiple`,
    },
    summary: cause
      ? `The market has repriced this to about ${round(median, 1)}×, ${below ? 'below' : 'above'} its usual ` +
        `${band.low}–${band.high}× range — following ${cause.label}.`
      : `The market has paid about ${round(median, 1)}× for ${Math.round(heldMonths)} months, ` +
        `${below ? 'below' : 'above'} the ${band.low}–${band.high}× range this stock used to trade in.`,
  }
}

/** Median peer multiple, for the second anchor. */
export function peerBandFrom(peers = []) {
  const pes = peers.map(p => p.forwardPe ?? p.pe).filter(v => v > 0 && v < 100).sort((a, b) => a - b)
  if (pes.length < 3) return null
  return {
    low: round(q(pes, 0.25), 1),
    median: round(q(pes, 0.5), 1),
    high: round(q(pes, 0.75), 1),
    count: pes.length,
  }
}

function latestEps(incomeHistory = []) {
  const val = t => (t && typeof t === 'object' ? t.value : t)
  for (let i = incomeHistory.length - 1; i >= 0; i--) {
    const e = val(incomeHistory[i]?.eps)
    if (e > 0) return e
  }
  return null
}

function q(sorted, p) {
  const a = [...sorted].sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(p * a.length))]
}
