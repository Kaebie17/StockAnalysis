/**
 * src/engine/setups.js — conditions that tend to precede a move.
 *
 * The technical bar reads the present: where price sits against its moving
 * averages, whether a reversal pattern printed, whether RSI is stretched. All
 * coincident. Everything here is the other kind — measurable conditions that
 * have historically shown up BEFORE a re-rating rather than during it.
 *
 * What each is and isn't: a setup raises the odds, it does not forecast. Some
 * carry a direction (volume rising while price holds reads as accumulation);
 * volatility compression carries none at all — it says a move is likelier, not
 * which way. They are reported separately and never blended into one number,
 * because a composite would imply a confidence none of them individually has.
 *
 * Nothing here needs data the app doesn't already fetch. Volume in particular
 * has been arriving in every price history and going unused.
 */

const round = (v, d = 1) => (v == null || !isFinite(v) ? null : +v.toFixed(d))
const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)

/**
 * Volume moving without price.
 *
 * Sustained heavy volume that doesn't move the price is the classic footprint of
 * someone building or unwinding a position: size is being absorbed. The
 * direction of the small price drift over the same window separates the two —
 * holding up under heavy volume is accumulation, sagging is distribution.
 */
export function volumeDivergence(priceHistory = [], { window = 10, baseline = 60 } = {}) {
  const rows = priceHistory.filter(d => d?.close > 0 && d.volume > 0)
  if (rows.length < baseline + window) return null

  const recent = rows.slice(-window)
  const prior = rows.slice(-(baseline + window), -window)
  const recentVol = avg(recent.map(d => d.volume))
  const priorVol = avg(prior.map(d => d.volume))
  if (!(priorVol > 0)) return null

  const volRatio = recentVol / priorVol
  const priceMove = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close) * 100

  // Volume has to be genuinely elevated, and the price move genuinely muted,
  // or this fires on ordinary trading.
  if (volRatio < 1.6 || Math.abs(priceMove) > 3) return null

  const accumulating = priceMove >= 0
  return {
    id: 'volume-divergence',
    direction: accumulating ? 'bullish' : 'bearish',
    label: accumulating ? 'Heavy volume, price holding' : 'Heavy volume, price slipping',
    detail: `Volume over ${window} days is ${round(volRatio, 1)}× its ${baseline}-day average while price moved ` +
            `${priceMove >= 0 ? '+' : ''}${round(priceMove)}% — size being ${accumulating ? 'absorbed' : 'distributed'} ` +
            `without moving the price yet.`,
    strength: volRatio >= 2.5 ? 'strong' : 'moderate',
  }
}

/**
 * Volatility compression.
 *
 * Ranges narrow before they expand. Well documented and genuinely useful — but
 * strictly directionless, so it is reported without one. Presenting it as
 * bullish or bearish would be inventing the half it doesn't contain.
 */
export function volatilityCompression(priceHistory = [], { window = 10, baseline = 60 } = {}) {
  const rows = priceHistory.filter(d => d?.high != null && d.low != null && d.close > 0)
  if (rows.length < baseline + window) return null

  const trueRange = (i) => {
    const c = rows[i], p = rows[i - 1]
    if (!p) return c.high - c.low
    return Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close))
  }
  const recent = []
  for (let i = rows.length - window; i < rows.length; i++) recent.push(trueRange(i))
  const prior = []
  for (let i = rows.length - baseline - window; i < rows.length - window; i++) prior.push(trueRange(i))

  const r = avg(recent), p = avg(prior)
  if (!(p > 0) || !(r > 0)) return null
  const ratio = r / p
  if (ratio > 0.65) return null

  return {
    id: 'volatility-compression',
    direction: 'neutral',
    label: 'Trading range has tightened',
    detail: `Daily range over ${window} days is ${round(ratio * 100)}% of its ${baseline}-day norm. ` +
            `Compressed ranges tend to be followed by expansion — this says a move is more likely, not which way.`,
    strength: ratio < 0.5 ? 'strong' : 'moderate',
  }
}

/**
 * Multiple sitting at the edge of its own historical band.
 *
 * A stock pinned to the bottom of the range it has traded in is closer to
 * breaking out of that range — in either direction — than one sitting mid-band.
 * Combined with the direction of earnings it leans one way.
 */
export function multipleAtEdge({ currentMultiple, band, earningsTrend } = {}) {
  if (!(currentMultiple > 0) || !(band?.low > 0) || !(band?.high > 0)) return null
  const span = band.high - band.low
  if (!(span > 0)) return null
  const position = (currentMultiple - band.low) / span

  if (position > 0.2 && position < 0.8) return null

  const atBottom = position <= 0.2
  // Improving earnings at the bottom of the band is the constructive version;
  // deteriorating earnings at the top is its opposite. Anything else is just a
  // position, reported without a direction.
  let direction = 'neutral'
  if (atBottom && earningsTrend === 'improving') direction = 'bullish'
  else if (!atBottom && earningsTrend === 'deteriorating') direction = 'bearish'

  return {
    id: 'multiple-at-edge',
    direction,
    label: atBottom ? 'Multiple near the bottom of its range' : 'Multiple near the top of its range',
    detail: `Trading at ${round(currentMultiple)}× against a historical ${band.low}–${band.high}×` +
            (earningsTrend && direction !== 'neutral'
              ? `, with earnings ${earningsTrend}.` : '.'),
    strength: (position <= 0.05 || position >= 0.95) ? 'strong' : 'moderate',
  }
}

/**
 * Price and fundamentals pulling apart.
 *
 * Earnings improving while the multiple compresses means the price is falling
 * behind the business — a gap that historically tends to close. The reverse is
 * the more dangerous version: price running while earnings flatten.
 */
export function priceFundamentalGap({ observations = [], currentMultiple } = {}) {
  if (observations.length < 3 || !(currentMultiple > 0)) return null
  const recent = observations.slice(-3)
  const epsFirst = recent[0].eps, epsLast = recent[recent.length - 1].eps
  const mFirst = recent[0].multiple
  if (!(epsFirst > 0) || !(epsLast > 0) || !(mFirst > 0)) return null

  const epsChange = ((epsLast / epsFirst) - 1) * 100
  const multipleChange = ((currentMultiple / mFirst) - 1) * 100
  const gap = epsChange - multipleChange

  if (Math.abs(gap) < 25) return null

  const earningsAhead = gap > 0
  return {
    id: 'price-fundamental-gap',
    direction: earningsAhead ? 'bullish' : 'bearish',
    label: earningsAhead ? 'Earnings running ahead of the multiple' : 'Multiple running ahead of earnings',
    detail: `Over ${recent.length} years earnings moved ${epsChange >= 0 ? '+' : ''}${round(epsChange)}% ` +
            `while the multiple moved ${multipleChange >= 0 ? '+' : ''}${round(multipleChange)}%. ` +
            (earningsAhead
              ? 'The business has improved faster than the market has repriced it.'
              : 'The market has repriced faster than the business has improved.'),
    strength: Math.abs(gap) > 50 ? 'strong' : 'moderate',
  }
}

/**
 * The sector has already moved and this stock hasn't, or the reverse.
 *
 * A de-rating that has swept a whole industry and left one name untouched marks
 * that name as a candidate — the same forces apply to it. Equally, a stock that
 * has de-rated alone while its sector held up is carrying something specific.
 */
export function sectorDivergence(relative) {
  if (!relative || relative.sectorPct == null || relative.stockPct == null) return null
  const gap = relative.stockPct - relative.sectorPct
  if (Math.abs(gap) < 12) return null

  const stockLagging = gap < 0
  return {
    id: 'sector-divergence',
    direction: stockLagging ? 'bearish' : 'bullish',
    label: stockLagging ? 'Lagging its sector' : 'Leading its sector',
    detail: `Over ${Math.round(relative.days / 30)} months this stock moved ${relative.stockPct >= 0 ? '+' : ''}${relative.stockPct}% ` +
            `against ${relative.sectorName || 'its sector'} at ${relative.sectorPct >= 0 ? '+' : ''}${relative.sectorPct}%. ` +
            (stockLagging
              ? 'Either the market sees something specific here, or it has not caught up yet.'
              : 'Outperforming peers — worth knowing whether that is earned or extended.'),
    strength: Math.abs(gap) > 25 ? 'strong' : 'moderate',
  }
}

/** All of them, plus a direction lean where the signals agree. */
export function detectSetups(ctx = {}) {
  const found = [
    volumeDivergence(ctx.priceHistory || []),
    volatilityCompression(ctx.priceHistory || []),
    multipleAtEdge(ctx),
    priceFundamentalGap(ctx),
    sectorDivergence(ctx.relative),
  ].filter(Boolean)

  const bull = found.filter(s => s.direction === 'bullish').length
  const bear = found.filter(s => s.direction === 'bearish').length

  return {
    setups: found,
    count: found.length,
    // A lean, not a score. Reported only when the directional signals actually
    // agree — two pointing opposite ways is genuinely no signal, and averaging
    // them would manufacture one.
    lean: (bull > 0 && bear === 0) ? 'bullish'
        : (bear > 0 && bull === 0) ? 'bearish'
        : null,
    directionless: found.filter(s => s.direction === 'neutral').length,
  }
}
