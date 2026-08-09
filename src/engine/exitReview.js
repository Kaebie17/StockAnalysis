/**
 * src/engine/exitReview.js — what a completed sale can teach you.
 *
 * A sale is the only point where a decision becomes checkable. While a position
 * is open every judgment is provisional; once it's closed, both the analysis and
 * the timing have a verdict, and — crucially — they can DISAGREE. Being right
 * about a company and wrong about when to leave are different failures with
 * different fixes, so they're scored separately here and never averaged into a
 * single "was that a good sale?" number.
 *
 * There's also a statistical reason this exists at all. Scoring estimates only
 * on positions still held reads a survivor-selected sample: the ones that went
 * badly are exactly the ones sold. Sold positions are the missing half, and
 * without them "are my estimates any good?" is unanswerable.
 */

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const DAY = 86400000

/** Exit reasons. The fixed list is what makes the aggregate stats countable —
 *  free text alone can't be grouped, which is where the real insight lives. */
export const EXIT_REASONS = [
  { id: 'profit_booking', label: 'Profit booking' },
  { id: 'estimate_stretched', label: 'Estimate stretched' },
  { id: 'fundamentals', label: 'Fundamentals deteriorated' },
  { id: 'policy_news', label: 'Policy / news flag' },
  { id: 'stop_loss', label: 'Stop loss' },
  { id: 'needed_money', label: 'Needed the money' },
  { id: 'other', label: 'Other' },
]
export const reasonLabel = id => EXIT_REASONS.find(r => r.id === id)?.label || 'Untagged'

/**
 * Review one closed lot against where the stock actually went.
 *
 * @param pos      closed position record
 * @param price    current price for that ticker
 * @param estimate the estimate that was live at purchase (from pos.snapshot)
 */
export function reviewExit(pos, price, opts = {}) {
  if (!pos || pos.status !== 'closed') return null
  const sell = Number(pos.sellPrice) || null
  const buy  = Number(pos.buyPrice) || null
  const shares = Number(pos.shares) || 0
  if (!sell || !buy) return null

  const realised = (sell - buy) * shares
  const realisedPct = ((sell - buy) / buy) * 100
  const heldDays = pos.sellDate && pos.buyDate
    ? Math.max(0, Math.round((pos.sellDate - pos.buyDate) / DAY)) : null
  const sinceDays = pos.sellDate ? Math.max(0, Math.round((Date.now() - pos.sellDate) / DAY)) : null

  // ── what happened after ───────────────────────────────────────────────────
  let after = null
  if (price > 0 && sell > 0) {
    const movePct = ((price - sell) / sell) * 100
    after = {
      price, movePct: round(movePct),
      // Deliberately framed as "left on the table" / "avoided" rather than
      // good/bad: selling into a further rise isn't a mistake if the money went
      // somewhere better, and the app has no way to know that.
      leftOnTable: movePct > 0 ? round((price - sell) * shares) : null,
      avoided: movePct < 0 ? round((sell - price) * shares) : null,
      sinceDays,
    }
  }

  // ── did the estimate hold? ────────────────────────────────────────────────
  // Separate question from the exit. The estimate is about the company; the
  // exit is about you.
  const est = pos.snapshot?.estimate
  let estimateVerdict = null
  if (est?.low && est?.high && price > 0) {
    const reached = price >= est.low
    const exceeded = price >= est.high
    const horizonDays = Math.round((opts.horizonYears ?? 1) * 365)
    const matured = pos.snapshot?.takenAt
      ? (Date.now() - pos.snapshot.takenAt) >= horizonDays * DAY : false
    estimateVerdict = {
      low: est.low, base: est.base, high: est.high,
      reached, exceeded, matured,
      status: exceeded ? 'exceeded' : reached ? 'held' : matured ? 'missed' : 'pending',
      label: exceeded ? 'Exceeded the range'
           : reached ? 'Reached it — estimate held'
           : matured ? 'Never reached the range'
           : 'Still within its horizon',
    }
  }

  // ── was the exit early? ───────────────────────────────────────────────────
  // Only meaningful when the estimate later proved right: leaving before an
  // estimate matured is only a miss if the estimate was going to pay off.
  let timing = null
  if (est?.base && pos.snapshot?.takenAt && pos.sellDate) {
    const horizonMs = (opts.horizonYears ?? 1) * 365 * DAY
    const maturesAt = pos.snapshot.takenAt + horizonMs
    const earlyDays = Math.round((maturesAt - pos.sellDate) / DAY)
    if (earlyDays > 30) {
      const vindicated = estimateVerdict?.reached
      timing = {
        earlyDays,
        earlyMonths: round(earlyDays / 30, 0),
        flag: vindicated,
        label: `Exited ${round(earlyDays / 30, 0)} months before your estimate matured`,
      }
    }
  }

  return {
    id: pos.id, ticker: pos.ticker, shares,
    buyPrice: buy, sellPrice: sell, buyDate: pos.buyDate, sellDate: pos.sellDate,
    realised: round(realised), realisedPct: round(realisedPct), heldDays,
    reason: pos.exitReason || null,
    reasonNote: pos.exitNote || null,
    after, estimateVerdict, timing,
    // Price back inside the range is the one forward-looking read here: a
    // company you already researched and already understood is a better
    // candidate than a fresh name at the same apparent discount.
    reentry: (est?.low && est?.high && price > 0 && price <= est.high)
      ? { candidate: price <= est.base, price, range: [est.low, est.high] }
      : null,
  }
}

/**
 * Aggregate across many exits. One sale says nothing; twenty describe a habit.
 * This is the part that reports on the USER rather than on any stock, and it's
 * the reason exits need a tag from the very first sale — retrospective tagging
 * isn't possible.
 */
export function exitStats(reviews = []) {
  const done = reviews.filter(Boolean)
  if (done.length === 0) return null

  const withAfter = done.filter(r => r.after?.movePct != null)
  const roseAfter = withAfter.filter(r => r.after.movePct > 0)

  // Per-reason: how often did the stock keep rising after this kind of exit?
  const byReason = {}
  for (const r of done) {
    const key = r.reason || 'untagged'
    byReason[key] ??= { reason: key, label: reasonLabel(key), count: 0, roseAfter: 0, totalMovePct: 0, scored: 0 }
    byReason[key].count++
    if (r.after?.movePct != null) {
      byReason[key].scored++
      byReason[key].totalMovePct += r.after.movePct
      if (r.after.movePct > 0) byReason[key].roseAfter++
    }
  }
  for (const b of Object.values(byReason)) {
    b.avgMovePct = b.scored ? round(b.totalMovePct / b.scored) : null
  }

  // The weakest tag is the one whose exits are most often followed by a rise —
  // and only counted once there are enough of them to mean anything.
  const ranked = Object.values(byReason)
    .filter(b => b.scored >= 3 && b.reason !== 'untagged')
    .sort((a, b) => (b.roseAfter / b.scored) - (a.roseAfter / a.scored))

  const early = done.filter(r => r.timing?.flag)
  const estScored = done.filter(r => r.estimateVerdict && r.estimateVerdict.status !== 'pending')
  const estRight = estScored.filter(r => r.estimateVerdict.reached)

  return {
    count: done.length,
    realisedTotal: round(done.reduce((s, r) => s + (r.realised || 0), 0)),
    winRate: round((done.filter(r => r.realisedPct > 0).length / done.length) * 100),
    roseAfterPct: withAfter.length ? round((roseAfter.length / withAfter.length) * 100) : null,
    avgMoveAfterPct: withAfter.length
      ? round(withAfter.reduce((s, r) => s + r.after.movePct, 0) / withAfter.length) : null,
    byReason: Object.values(byReason).sort((a, b) => b.count - a.count),
    weakestReason: ranked[0] || null,
    earlyExits: early.length,
    estimateAccuracy: estScored.length
      ? { scored: estScored.length, right: estRight.length,
          pct: round((estRight.length / estScored.length) * 100) } : null,
  }
}
