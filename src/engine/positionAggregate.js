/**
 * src/engine/positionAggregate.js — many lots, one holding.
 *
 * You sell FIFO and you decide on the whole position, so splitting the analysis
 * per lot was answering a question nobody asks. Everything analytical belongs to
 * the stock or to the holding as a whole; the lots are a ledger of how you got
 * here.
 *
 * The entry baseline is share-weighted, which behaves the way intuition expects:
 * topping up 100 shares with 10 more moves it by about 9%, not by half. It only
 * shifts materially when the new money is material — which is correct, because
 * your cost basis genuinely did move.
 *
 * Where it gets mushy is lots bought years apart in comparable size: a blend of
 * a 2024 baseline and a 2026 one describes neither. That's flagged rather than
 * hidden — see `spansYears`.
 */

const round = (v, d = 2) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const DAY = 86400000

/**
 * @param lots open positions for one ticker
 * @returns aggregate holding, or null when there's nothing open
 */
export function aggregateLots(lots = []) {
  const open = lots.filter(p => p && p.status !== 'closed' && (Number(p.shares) || 0) > 0)
  if (open.length === 0) return null

  const shares = open.reduce((t, p) => t + Number(p.shares), 0)
  const cost = open.reduce((t, p) => t + Number(p.shares) * (Number(p.buyPrice) || 0), 0)
  const avgPrice = shares > 0 ? cost / shares : null

  // Share-weighted entry baseline. Only lots that actually have a recorded
  // estimate contribute — a lot with no snapshot shouldn't drag the blend toward
  // zero, it should simply not vote.
  const withEst = open.filter(p => p.snapshot?.estimate?.base > 0)
  const estShares = withEst.reduce((t, p) => t + Number(p.shares), 0)
  let entryEstimate = null
  if (estShares > 0) {
    const w = (get) => withEst.reduce((t, p) => t + Number(p.shares) * get(p), 0) / estShares
    entryEstimate = {
      low:  round(w(p => p.snapshot.estimate.low  ?? p.snapshot.estimate.base)),
      base: round(w(p => p.snapshot.estimate.base)),
      high: round(w(p => p.snapshot.estimate.high ?? p.snapshot.estimate.base)),
      // The price the baseline was measured against — needed to compare gaps,
      // not prices, since a gap is what the bar actually reads.
      price: round(w(p => p.snapshot.price ?? p.buyPrice ?? 0)),
      coverage: round((estShares / shares) * 100, 0),   // % of shares with a baseline
    }
  }

  // Weighted market context at entry, for the benchmark line.
  const withIdx = open.filter(p => p.snapshot?.indexLevel > 0)
  const idxShares = withIdx.reduce((t, p) => t + Number(p.shares), 0)
  const entryIndex = idxShares > 0
    ? round(withIdx.reduce((t, p) => t + Number(p.shares) * p.snapshot.indexLevel, 0) / idxShares)
    : null

  const dates = open.map(p => p.buyDate).filter(Boolean).sort((a, b) => a - b)
  const first = dates[0] ?? null
  const last = dates[dates.length - 1] ?? null

  // A blend only misleads when the lots are far apart AND the newer money is
  // heavy enough to move the average. One small top-up on a long-held position
  // barely shifts it and needs no warning.
  let spansYears = false
  if (first && last && (last - first) > 365 * DAY && open.length > 1) {
    const newest = open.filter(p => p.buyDate && (last - p.buyDate) < 90 * DAY)
    const newestShares = newest.reduce((t, p) => t + Number(p.shares), 0)
    spansYears = (newestShares / shares) >= 0.25
  }

  return {
    ticker: open[0].ticker,
    lots: [...open].sort((a, b) => (a.buyDate || 0) - (b.buyDate || 0)),
    shares, cost, avgPrice: round(avgPrice),
    entryEstimate, entryIndex,
    firstBuy: first, lastBuy: last, spansYears,
    // Shaped like a position so the health engine can read it unchanged.
    snapshot: entryEstimate ? {
      price: entryEstimate.price,
      estimate: entryEstimate,
      indexLevel: entryIndex,
      backfilled: open.every(p => p.snapshot?.backfilled),
      reconstructed: open.some(p => p.snapshot?.reconstructed),
    } : null,
    buyPrice: round(avgPrice),
    status: 'open',
  }
}

/** Value and P/L for the whole holding at the current price. */
export function holdingMath(agg, price) {
  if (!agg) return null
  const value = price > 0 ? agg.shares * price : null
  return {
    cost: agg.cost,
    value,
    pnl: value != null ? value - agg.cost : null,
    pnlPct: (value != null && agg.cost > 0) ? ((value - agg.cost) / agg.cost) * 100 : null,
  }
}

/**
 * One bar out of several, for the collapsed row.
 *
 * A summary, explicitly — its parts are one tap away. The rule against blending
 * bars is about not passing a composite off as a verdict; a list needs SOME
 * single indicator per line or it can't be scanned at all, and hiding the parts
 * behind a tap is what keeps it honest.
 */
export function summaryLevel(health) {
  const parts = ['fundamental', 'technical', 'estimate']
    .map(k => health?.[k])
    .filter(b => b?.available && b.level != null)
  if (parts.length === 0) return null
  return Math.round(parts.reduce((t, b) => t + b.level, 0) / parts.length)
}
