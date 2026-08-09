/**
 * src/engine/positionHealth.js — the four bars on a held position.
 *
 * The framing that makes this work at all: every bar reads DRIFT SINCE PURCHASE,
 * not an absolute verdict. Asking "is this cheap?" is useless for the kind of
 * business worth owning — a quality compounder is above a conservative fair
 * value almost permanently, so an absolute reading would say SELL forever and be
 * wrong for years. Asking "has the gap moved since you bought, and why?" is
 * answerable and actually decision-relevant.
 *
 * Four bars, never blended into one score. A single number would hide WHICH
 * dimension moved, and that's the only part you can act on. Each returns a level
 * 0–4 (the signal-bar metaphor) plus the reason, or available:false when the
 * inputs aren't there — a bar that can't be computed says so rather than
 * defaulting to a reassuring middle.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))

const NA = reason => ({ available: false, level: null, reason })

/**
 * BAR 1 — Estimate vs price.
 *
 * Compares the gap between our estimate and the price NOW against the same gap
 * on the day of purchase. Buying something already trading above our base case
 * isn't a problem in itself — you knew that when you bought. The gap WIDENING
 * without the business changing is the signal.
 */
export function estimateBar(position, currentEstimate, currentPrice) {
  const snap = position?.snapshot
  const snapEst = snap?.estimate
  if (!snapEst?.base || !snap?.price) return NA('No estimate was recorded at purchase')
  if (!currentEstimate?.ok || !(currentPrice > 0)) return NA('No current estimate')

  // Gap = how far the base case sits above (or below) the price, as a fraction.
  const gapThen = (snapEst.base - snap.price) / snap.price
  const gapNow  = (currentEstimate.target.base - currentPrice) / currentPrice
  const drift   = gapNow - gapThen                    // + = more headroom than before

  // ±25 points of drift spans the bar. Beyond that the reading is already
  // emphatic and more precision wouldn't change what you'd do.
  const level = clamp(Math.round(2 + (drift * 100) / 12.5), 0, 4)

  const dir = drift >= 0 ? 'wider' : 'narrower'
  return {
    available: true, level,
    gapThenPct: round(gapThen * 100), gapNowPct: round(gapNow * 100),
    driftPct: round(drift * 100),
    label: Math.abs(drift) < 0.03 ? 'Gap unchanged since purchase'
         : `Headroom ${dir} by ${Math.abs(round(drift * 100))} pts since purchase`,
    detail: `At purchase the base case sat ${round(gapThen * 100)}% from the price; now ${round(gapNow * 100)}%.`,
    lateSnapshot: !!snap.isLate,
  }
}

/**
 * BAR 2 — Fundamental trend.
 *
 * The only bar untouched by market pricing, which makes it the most robust of
 * the four: it reads the business, not the mood. Combines the quality score's
 * movement since purchase with the guidance/model verdict from reported results.
 */
export function fundamentalBar(position, { qualityScore, guidanceAssessment, marginTrendPct } = {}) {
  const snapQ = position?.snapshot?.qualityScore
  const parts = []
  let level = 2

  if (snapQ != null && qualityScore != null) {
    const d = qualityScore - snapQ
    level += clamp(Math.round(d / 5), -2, 2)
    if (Math.abs(d) >= 2) parts.push(`quality ${d > 0 ? '+' : ''}${round(d)} since purchase`)
    else parts.push('quality steady')
  }

  // A reported beat or miss is a harder fact than any score movement, so it
  // moves the bar in its own right rather than being averaged in.
  if (guidanceAssessment?.verdict) {
    const v = guidanceAssessment.verdict
    if (v === 'beat') { level += 1; parts.push(`beat ${guidanceAssessment.basis === 'guidance' ? 'guidance' : 'our model'}`) }
    else if (v === 'miss') { level -= 1; parts.push(`missed ${guidanceAssessment.basis === 'guidance' ? 'guidance' : 'our model'}`) }
    else if (v === 'meet') parts.push('in line with plan')
  }

  if (marginTrendPct != null && Math.abs(marginTrendPct) >= 2) {
    level += marginTrendPct > 0 ? 1 : -1
    parts.push(`margin ${marginTrendPct > 0 ? '+' : ''}${marginTrendPct} pts over 3 yrs`)
  }

  if (parts.length === 0) return NA('No quality score or results to compare')

  return {
    available: true, level: clamp(level, 0, 4),
    label: parts[0],
    detail: parts.join(' · '),
  }
}

/**
 * BAR 3 — Technical.
 *
 * Deliberately weighted on the patterns with published Indian-market backtests
 * (Harami, Engulfing, Inverted Hammer) rather than every pattern the technicals
 * engine can name. The same patterns test as noise on US indices; the edge shows
 * up in less institutionally dominated markets, which is the one this app
 * serves. Trend context (price vs the 50/200 SMA) frames them, since a reversal
 * pattern means something different in an uptrend than in a downtrend.
 *
 * This is the fastest-updating bar — it's computed straight from price, with no
 * wait for a quarter or a filing — so it's the first place a change shows up,
 * even before anyone knows why.
 */
export function technicalBar(technicals) {
  if (!technicals?.available) return NA(technicals?.reason || 'Not enough price history')

  const sig = technicals.signals || {}
  const pats = technicals.patterns || []
  const evidenced = pats.filter(p => p.evidenced)

  let level = 2
  const parts = []

  // Trend first — the frame everything else is read inside.
  if (sig.aboveSma50 && sig.aboveSma200) { level += 1; parts.push('above both moving averages') }
  else if (!sig.aboveSma50 && !sig.aboveSma200) { level -= 1; parts.push('below both moving averages') }
  if (sig.goldenCross) { level += 1; parts.push('golden cross') }
  if (sig.deathCross)  { level -= 1; parts.push('death cross') }

  // Evidenced patterns carry weight; the rest are mentioned, not scored.
  for (const p of evidenced) {
    level += p.type === 'bullish' ? 1 : p.type === 'bearish' ? -1 : 0
    parts.push(p.name.toLowerCase())
  }

  if (sig.rsiOverbought) { level -= 1; parts.push('RSI overbought') }
  if (sig.rsiOversold)   { level += 1; parts.push('RSI oversold') }

  return {
    available: true, level: clamp(level, 0, 4),
    label: parts[0] || 'no clear signal',
    detail: parts.join(' · ') || 'Nothing notable',
    evidencedPatterns: evidenced.map(p => p.name),
    otherPatterns: pats.filter(p => !p.evidenced).map(p => p.name),
  }
}

/**
 * BAR 4 — Market regime.
 *
 * NOT a direction call, and this is the whole point of it. VIX measures the size
 * of expected moves, not their sign, and it tends to rise WITH a decline rather
 * than before one — so treating it as a forecast would be dressing up a
 * coincident indicator as a leading one. What it does do reliably is cluster:
 * once volatility is elevated it tends to stay elevated for a while, and in that
 * regime correlations rise and good businesses get sold alongside bad ones.
 *
 * So this bar is a RELIABILITY CAVEAT on the other three: in a calm market a 4%
 * single-stock move probably means something about that company; in a stressed
 * one it probably doesn't.
 */
export function regimeBar({ vix, vixAvg, indexChangePct, stockChangePct } = {}) {
  if (vix == null) return NA('No volatility data')

  // Bands for India VIX: sub-15 calm, 15–20 normal, 20–28 elevated, 28+ stressed.
  let level, label
  if (vix < 15)      { level = 4; label = 'Calm market' }
  else if (vix < 20) { level = 3; label = 'Normal volatility' }
  else if (vix < 28) { level = 2; label = 'Elevated volatility' }
  else               { level = 1; label = 'Stressed market' }

  const parts = [`India VIX ${round(vix)}`]
  if (vixAvg != null) parts.push(`vs ${round(vixAvg)} average`)

  // Idiosyncratic vs market-wide: the more useful reading of a single day's move.
  let idiosyncratic = null
  if (indexChangePct != null && stockChangePct != null) {
    const excess = stockChangePct - indexChangePct
    idiosyncratic = Math.abs(excess) >= 2
    parts.push(idiosyncratic
      ? `moved ${round(excess)} pts vs the index — company-specific`
      : 'moving with the market')
  }

  return {
    available: true, level, label,
    detail: parts.join(' · '),
    caution: vix >= 20,
    idiosyncratic,
    note: vix >= 20
      ? 'Volatility is high — single-stock signals are less reliable while everything moves together.'
      : null,
  }
}

/** All four, in display order. */
export function positionHealth(position, ctx = {}) {
  return {
    estimate:    estimateBar(position, ctx.currentEstimate, ctx.currentPrice),
    fundamental: fundamentalBar(position, ctx),
    technical:   technicalBar(ctx.technicals),
    regime:      regimeBar(ctx.regime || {}),
    // True when the financials came from a saved analysis rather than a live
    // load. The price is still current (batch quote), but the statements are as
    // of whenever the stock was last analysed — worth saying rather than
    // presenting month-old fundamentals as today's.
    stale: !!ctx.stale,
  }
}
