/**
 * src/engine/technicals.js
 */

import { atr } from './exitTriggers.js'

export function runTechnicals(priceHistory) {
  if (!priceHistory || priceHistory.length < 30) {
    return { available: false, reason: 'Insufficient price history (need 30+ days)' }
  }

  const closes  = priceHistory.map(d => d.close)
  const volumes = priceHistory.map(d => d.volume || 0)
  const last    = closes[closes.length - 1]

  const sma50  = sma(closes, 50)
  const sma200 = sma(closes, 200)
  const ema20  = ema(closes, 20)
  const rsiVal = rsi(closes, 14)
  const { macd: macdLine, signal: signalLine, histogram } = macdCalc(closes)
  const bb     = bollingerBands(closes, 20, 2)
  const obv    = calcOBV(closes, volumes)

  const latestRsi  = rsiVal[rsiVal.length - 1]
  const latestMacd = macdLine[macdLine.length - 1]
  const latestSig  = signalLine[signalLine.length - 1]
  const latestHist = histogram[histogram.length - 1]
  const prevHist   = histogram[histogram.length - 2]

  // Volume metrics
  const vol20avg = avg(volumes.slice(-20))
  const volRatio = volumes[volumes.length - 1] / (vol20avg || 1)
  const volumeClass = classifyVolume(volRatio)

  // OBV was computed above and then never read — "OBV rising ✓" in the UI was
  // actually inferring accumulation from the volume ratio (today vs the 20-day
  // average), a different signal entirely. The real OBV trend over the same
  // 20-day window it's compared against: is cumulative volume net higher than
  // it was, i.e. is buying pressure actually confirming the move.
  const obvNow  = obv[obv.length - 1]
  const obvPrev = obv[Math.max(0, obv.length - 21)]
  const obvRising = obvNow > obvPrev

  // ── Trend ────────────────────────────────────────────────────────────────
  const lastSma50  = sma50[sma50.length - 1]
  const lastSma200 = sma200[sma200.length - 1]
  const prevSma50  = sma50[sma50.length - 2]
  const prevSma200 = sma200[sma200.length - 2]

  const goldenCross = lastSma50 > lastSma200 && prevSma50 <= prevSma200
  const deathCross  = lastSma50 < lastSma200 && prevSma50 >= prevSma200
  // Kept exactly as before (an unavailable SMA200 on a short history coerces
  // the comparison to `false`, reading as "above") — signals.* below feeds
  // positionHealth.js's own scoring and isn't worth changing here. The new
  // Trend group/regime below use the null-aware versions instead, so short
  // histories report "no evidence" there rather than a manufactured reading.
  const aboveSma50  = last > lastSma50
  const aboveSma200 = last > lastSma200

  const sma50Known  = lastSma50  != null
  const sma200Known = lastSma200 != null
  const aboveSma50Safe   = sma50Known  ? last > lastSma50  : null
  const aboveSma200Safe  = sma200Known ? last > lastSma200 : null
  const sma50AboveSma200 = (sma50Known && sma200Known) ? lastSma50 > lastSma200 : null

  const sma50Pct  = sma50Known  ? +(((last - lastSma50)  / lastSma50)  * 100).toFixed(1) : null
  const sma200Pct = sma200Known ? +(((last - lastSma200) / lastSma200) * 100).toFixed(1) : null
  const regime = classifyRegime({ aboveSma50: aboveSma50Safe, aboveSma200: aboveSma200Safe, sma50AboveSma200 })

  // ── RSI ──────────────────────────────────────────────────────────────────
  const rsiOverbought = latestRsi > 70
  const rsiOversold    = latestRsi < 30
  const rsiBullDiv     = detectRsiDivergence(closes, rsiVal, 'bull')
  const rsiBearDiv     = detectRsiDivergence(closes, rsiVal, 'bear')
  const rsiZone = rsiOverbought ? 'Overbought' : rsiOversold ? 'Oversold' : latestRsi >= 50 ? 'Positive' : 'Weak/neutral'
  // Momentum reading, not a contrarian reversal call. An extreme RSI describes
  // how stretched the recent move is — it doesn't by itself flip which way
  // momentum points. So the score only rewards the confirmed-positive band; a
  // low or oversold reading registers as "not positive" rather than
  // manufacturing a bearish point out of "might bounce," and a genuine
  // reversal only counts once something else (MACD, a pattern) confirms it.
  const rsiDirection = latestRsi >= 50 ? 1 : 0

  // ── MACD ─────────────────────────────────────────────────────────────────
  const macdAboveSignal = latestMacd > latestSig
  const macdBullCross = macdAboveSignal  && macdLine[macdLine.length - 2] <= signalLine[signalLine.length - 2]
  const macdBearCross = !macdAboveSignal && macdLine[macdLine.length - 2] >= signalLine[signalLine.length - 2]
  const macdAboveZero = latestMacd > 0
  const macdHistRising = prevHist != null ? latestHist > prevHist : null
  const macdDirection = macdAboveSignal ? 1 : -1

  // ── Participation (volume + OBV) ────────────────────────────────────────
  // Raw volume expansion isn't directional on its own — 1.1x average is
  // ordinary activity either way. It only says something once paired with
  // which way price actually moved on it: expansion on an advance reads as
  // buying participation, expansion on a decline reads as selling pressure.
  const priceUpToday = last > closes[closes.length - 2]
  const volumeConfirms = volRatio > 1.3 ? (priceUpToday ? 1 : -1) : 0
  const obvDirection = obvRising ? 1 : -1
  // Price and OBV disagreeing over the same 20-session window obvRising already
  // looks at. Surfaced as a caveat, not scored — a divergence is something to
  // watch, not a confirmed reversal.
  const divergence = computeDivergence(closes, obvRising)

  // ── Patterns (last 5 candles) ────────────────────────────────────────────
  const patterns = detectPatterns(priceHistory.slice(-5))
  const patternDirection = patterns.some(p => p.type === 'bullish') ? 1
                          : patterns.some(p => p.type === 'bearish') ? -1 : 0

  // Bollinger position — still computed for the price chart overlay, but no
  // longer scored. It correlates heavily with the RSI/SMA readings already
  // counted and was adding an opinion rather than new evidence.
  const latestBB = { upper: bb.upper[bb.upper.length - 1], lower: bb.lower[bb.lower.length - 1], mid: bb.mid[bb.mid.length - 1] }
  const bbPosition = (last - latestBB.lower) / (latestBB.upper - latestBB.lower) // 0=at lower, 1=at upper

  // ── Four groups — trend / momentum / participation / structure ─────────────
  // Every metric is directional evidence only: +1/-1 when it actually points
  // somewhere, 0 when it doesn't (an unconfirmed reading, a level that isn't
  // there, "no pattern today"). A group reads Bullish/Bearish only when
  // everything in it agrees, Neutral only when nothing in it has a reading at
  // all, and Mixed for everything in between — so "no evidence" can never
  // pass itself off as "bearish evidence."
  const trendMetrics = [
    aboveSma50Safe   != null && { label: 'Price vs SMA50',   direction: aboveSma50Safe   ? 1 : -1 },
    aboveSma200Safe  != null && { label: 'Price vs SMA200',  direction: aboveSma200Safe  ? 1 : -1 },
    sma50AboveSma200 != null && { label: 'SMA50 vs SMA200',  direction: sma50AboveSma200 ? 1 : -1 },
  ].filter(Boolean)
  const momentumMetrics = [
    { label: 'RSI',  direction: rsiDirection },
    { label: 'MACD', direction: macdDirection },
  ]
  const participationMetrics = [
    { label: 'OBV',    direction: obvDirection },
    { label: 'Volume', direction: volumeConfirms },
  ]
  const structureMetrics = [
    { label: 'Pattern', direction: patternDirection },
  ]

  const groups = {
    trend:         { status: groupStatus(trendMetrics),         metrics: trendMetrics },
    momentum:      { status: groupStatus(momentumMetrics),      metrics: momentumMetrics },
    participation: { status: groupStatus(participationMetrics), metrics: participationMetrics },
    structure:     { status: groupStatus(structureMetrics),     metrics: structureMetrics },
  }

  // ── Overall score ────────────────────────────────────────────────────────
  // Every metric counts once, equally — no double-weighting a cross event AND
  // the trend reading it produces, no folding Bollinger position on top of
  // RSI/SMA readings it mostly duplicates. A 5.0 midpoint means "no net
  // directional evidence," not "everything's bearish."
  const allDirections = [...trendMetrics, ...momentumMetrics, ...participationMetrics, ...structureMetrics].map(m => m.direction)
  const netMean = allDirections.length ? allDirections.reduce((s, d) => s + d, 0) / allDirections.length : 0
  const techScore = +(((netMean + 1) / 2) * 10).toFixed(1)
  const label = techScore >= 6.5 ? 'BULLISH' : techScore <= 3.5 ? 'BEARISH' : 'NEUTRAL'
  const bias  = label === 'BULLISH' ? 'Bullish-leaning' : label === 'BEARISH' ? 'Bearish-leaning' : 'Neutral'

  // ── Support / Resistance (swing-pivot clustering) ────────────────────────
  const levels = computeLevels(priceHistory, last)

  // ── Volatility — the same ATR the exit-plan's "moves about X on an
  // ordinary day" language already uses, so the technical read and the stop-
  // loss math are talking about the same number. ──────────────────────────
  const atrVal = atr(priceHistory, 14)
  const volatility = (atrVal > 0 && last > 0)
    ? { atr: +atrVal.toFixed(2), atrPct: +((atrVal / last) * 100).toFixed(1) }
    : null

  // ── 52-week position ─────────────────────────────────────────────────────
  const week52 = compute52Week(closes)

  return {
    available: true,
    score: techScore,
    label,
    bias,
    regime,
    groups,
    indicators: {
      price: last,
      sma50: lastSma50, sma200: lastSma200, ema20: ema20[ema20.length - 1],
      rsi: +latestRsi.toFixed(1),
      macd: { macd: +latestMacd.toFixed(3), signal: +latestSig.toFixed(3), histogram: +latestHist.toFixed(3) },
      bollinger: { ...latestBB, position: +bbPosition.toFixed(2) },
      volume: { current: volumes[volumes.length - 1], avg20: +vol20avg.toFixed(0), ratio: +volRatio.toFixed(2), obv: Math.round(obvNow) }
    },
    signals: {
      goldenCross, deathCross, aboveSma50, aboveSma200,
      rsiOverbought, rsiOversold, rsiBullDiv, rsiBearDiv,
      macdBullCross, macdBearCross, macdAboveZero, macdAboveSignal, macdHistRising,
      obvRising
    },
    smaDistances: { sma50Pct, sma200Pct },
    sma50vs200: sma50AboveSma200 == null ? null : (sma50AboveSma200 ? 'above' : 'below'),
    rsiZone,
    volumeClass,
    divergence,
    volatility,
    week52,
    levels,
    patterns,
    series: {
      // Subset for charting (last 100 points)
      closes:  closes.slice(-100),
      sma50:   sma50.slice(-100),
      sma200:  sma200.slice(-100),
      rsi:     rsiVal.slice(-100),
      macd:    macdLine.slice(-100),
      signal:  signalLine.slice(-100),
      histogram: histogram.slice(-100),
      bbUpper: bb.upper.slice(-100),
      bbLower: bb.lower.slice(-100),
      dates:   priceHistory.slice(-100).map(d => d.date)
    }
  }
}

// ─── Indicator functions ───────────────────────────────────────────────────────

function classifyVolume(ratio) {
  if (ratio == null || !isFinite(ratio)) return null
  if (ratio < 0.7) return 'low'
  if (ratio <= 1.3) return 'normal'
  if (ratio <= 2)   return 'elevated'
  return 'high'
}

// Explicit rules, describing the CURRENT alignment of price against its own
// moving averages — not a forecast of where it goes next.
function classifyRegime({ aboveSma50, aboveSma200, sma50AboveSma200 }) {
  if (sma50AboveSma200 == null || aboveSma50 == null || aboveSma200 == null) return null
  if (aboveSma50 && aboveSma200 && sma50AboveSma200)   return 'Strong uptrend'
  if (!aboveSma50 && !aboveSma200 && !sma50AboveSma200) return 'Strong downtrend'
  if (aboveSma200 && sma50AboveSma200)   return 'Uptrend'
  if (!aboveSma200 && !sma50AboveSma200) return 'Downtrend'
  return 'Range / transition'
}

// Bullish/Bearish only when every metric in the group agrees; Neutral only
// when none of them have a directional read at all; anything else is a
// genuine mix and is labeled that way rather than forced toward one side.
function groupStatus(metrics) {
  const dirs = metrics.map(m => m.direction)
  if (!dirs.length || dirs.every(d => d === 0))  return 'Neutral'
  if (dirs.every(d => d === 1))  return 'Bullish'
  if (dirs.every(d => d === -1)) return 'Bearish'
  return 'Mixed'
}

function computeDivergence(closes, obvRising) {
  const n = closes.length
  const refIdx = Math.max(0, n - 21)
  if (refIdx === 0) return null
  const priceUp   = closes[n - 1] > closes[refIdx]
  const priceDown = closes[n - 1] < closes[refIdx]
  if (priceUp && !obvRising) return 'bearish'
  if (priceDown && obvRising) return 'bullish'
  return null
}

const MIN_DAYS_FOR_52W = 180
function compute52Week(closes) {
  if (closes.length < MIN_DAYS_FOR_52W) return null
  const window = closes.slice(-252)
  const last = window[window.length - 1]
  const high = Math.max(...window)
  const low  = Math.min(...window)
  if (!(high > low)) return null
  return {
    high: +high.toFixed(2),
    low:  +low.toFixed(2),
    positionPct: +(((last - low) / (high - low)) * 100).toFixed(0),
    fromHighPct: +(((last - high) / high) * 100).toFixed(1),
    fromLowPct:  +(((last - low) / low) * 100).toFixed(1),
  }
}

// Support / resistance from swing pivots.
//  1. Find swing highs/lows (a bar that is the extreme within a ±k window).
//  2. Cluster pivots that sit within `tol` of each other into a single level.
//  3. Score each level by touches (recency-weighted) + volume at those pivots
//     — that's `historicalStrength`, "biggest level this stock has ever shown."
//  4. Discount that by distance from the current price for `strength` — a
//     level touched 14 times a decade ago and 90% away shouldn't outrank one
//     touched 3 times last month and 1% away just because it's an older,
//     bigger number. `strength` (current relevance) drives strongestSupport/
//     strongestResistance, which exitTriggers.js anchors stop/target
//     suggestions to; `historicalStrength` drives majorSupport/
//     majorResistance, shown separately as "biggest level on record."
//  5. Split by current price → resistance (above) / support (below); report
//     the nearest of each, the current-relevant strongest of each, and the
//     historical major of each.
function computeLevels(priceHistory, last, { k = 5, tol = 0.02 } = {}) {
  const n = priceHistory.length
  if (n < 2 * k + 5 || !(last > 0)) return null
  const highs = priceHistory.map(d => d.high ?? d.close)
  const lows  = priceHistory.map(d => d.low  ?? d.close)
  const vols  = priceHistory.map(d => d.volume || 0)

  const pivots = []   // { price, idx, vol }
  for (let i = k; i < n - k; i++) {
    let isHigh = true, isLow = true
    for (let j = i - k; j <= i + k; j++) {
      if (highs[j] > highs[i]) isHigh = false
      if (lows[j]  < lows[i])  isLow  = false
    }
    if (isHigh) pivots.push({ price: highs[i], idx: i, vol: vols[i] })
    if (isLow)  pivots.push({ price: lows[i],  idx: i, vol: vols[i] })
  }
  if (!pivots.length) return null

  // Cluster pivots within `tol` (relative) into levels.
  pivots.sort((a, b) => a.price - b.price)
  const clusters = []
  for (const p of pivots) {
    const c = clusters[clusters.length - 1]
    if (c && Math.abs(p.price - c.price) / c.price <= tol) {
      c.members.push(p)
      c.price = c.members.reduce((s, m) => s + m.price, 0) / c.members.length
    } else {
      clusters.push({ price: p.price, members: [p] })
    }
  }

  const totalVol = vols.reduce((s, v) => s + v, 0) || 1
  const levels = clusters.map(c => {
    const touches = c.members.length
    const recencyW = c.members.reduce((s, m) => s + (0.4 + 0.6 * (m.idx / n)), 0)
    const volW = c.members.reduce((s, m) => s + m.vol, 0) / totalVol
    const historicalStrength = +(recencyW + volW * 3).toFixed(2)
    const distancePct = Math.abs((c.price - last) / last) * 100
    const proximityW = 1 / (1 + distancePct / 25)
    return {
      price: +c.price.toFixed(2),
      range: [+Math.min(...c.members.map(m => m.price)).toFixed(2), +Math.max(...c.members.map(m => m.price)).toFixed(2)],
      touches,
      lastTouch: Math.max(...c.members.map(m => m.idx)),
      historicalStrength,
      strength: +(historicalStrength * proximityW).toFixed(2),   // current-relevance composite score
    }
  })

  const near   = arr => arr.length ? arr.reduce((a, b) => Math.abs(b.price - last) < Math.abs(a.price - last) ? b : a) : null
  const strong = arr => arr.length ? arr.reduce((a, b) => b.strength > a.strength ? b : a) : null
  const major  = arr => arr.length ? arr.reduce((a, b) => b.historicalStrength > a.historicalStrength ? b : a) : null
  const withDist = lvl => lvl && { ...lvl, distancePct: +(((lvl.price - last) / last) * 100).toFixed(1) }
  // Closest few first — a level price would reach soonest is what's actionable
  // right now; a "strongest" level miles away is context, not a lead item.
  const byProximity = arr => [...arr].sort((a, b) => Math.abs(a.price - last) - Math.abs(b.price - last))

  // A level within ~0.5% of price is effectively "at" price; treat by side of the cluster mid.
  // Sidedness is recomputed fresh from the CURRENT price every call, so a level
  // price has already broken through doesn't linger mislabeled on its old side —
  // once price closes past it, it reclassifies to the other side automatically.
  const resistance = levels.filter(l => l.price > last * 1.001)
  const support    = levels.filter(l => l.price < last * 0.999)

  return {
    price: last,
    nearestResistance: withDist(near(resistance)),
    strongestResistance: withDist(strong(resistance)),
    majorResistance: withDist(major(resistance)),
    nearestSupport: withDist(near(support)),
    strongestSupport: withDist(strong(support)),
    majorSupport: withDist(major(support)),
    // Up to 3 nearest per side, closest first — what the panel leads with.
    nearResistances: byProximity(resistance).slice(0, 3).map(withDist),
    nearSupports: byProximity(support).slice(0, 3).map(withDist),
    all: levels
      .map(l => ({ ...l, distancePct: +(((l.price - last) / last) * 100).toFixed(1), side: l.price >= last ? 'resistance' : 'support' }))
      .sort((a, b) => a.price - b.price),
  }
}

function sma(data, period) {
  return data.map((_, i) => {
    if (i < period - 1) return null
    return avg(data.slice(i - period + 1, i + 1))
  })
}

function ema(data, period) {
  const k = 2 / (period + 1)
  const result = [data[0]]
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k))
  }
  return result
}

function rsi(data, period = 14) {
  const result = new Array(period).fill(null)
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1]
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d)
  }
  avgGain /= period; avgLoss /= period
  result.push(100 - 100 / (1 + avgGain / (avgLoss || 0.0001)))
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1]
    const gain = d > 0 ? d : 0, loss = d < 0 ? Math.abs(d) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    result.push(100 - 100 / (1 + avgGain / (avgLoss || 0.0001)))
  }
  return result
}

function macdCalc(data, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(data, fast)
  const emaSlow = ema(data, slow)
  const macdLine = emaFast.map((v, i) => v != null && emaSlow[i] != null ? v - emaSlow[i] : null)
  const signalLine = ema(macdLine.filter(v => v != null), signal)
  const pad = macdLine.filter(v => v != null).length - signalLine.length
  const paddedSignal = [...new Array(pad + slow - 1).fill(null), ...signalLine]
  const histogram = macdLine.map((v, i) => v != null && paddedSignal[i] != null ? v - paddedSignal[i] : null)
  return { macd: macdLine, signal: paddedSignal, histogram }
}

function bollingerBands(data, period = 20, stdDev = 2) {
  const mid = sma(data, period)
  const upper = [], lower = []
  data.forEach((_, i) => {
    if (i < period - 1) { upper.push(null); lower.push(null); return }
    const slice = data.slice(i - period + 1, i + 1)
    const mean = avg(slice)
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
    upper.push(mean + stdDev * std)
    lower.push(mean - stdDev * std)
  })
  return { upper, lower, mid }
}

function calcOBV(closes, volumes) {
  const obv = [0]
  for (let i = 1; i < closes.length; i++) {
    obv.push(obv[i - 1] + (closes[i] > closes[i - 1] ? volumes[i] : closes[i] < closes[i - 1] ? -volumes[i] : 0))
  }
  return obv
}

function detectRsiDivergence(closes, rsiArr, type) {
  const n = closes.length
  if (n < 20) return false
  const recentCloses = closes.slice(-20)
  const recentRsi    = rsiArr.slice(-20).filter(v => v != null)
  if (type === 'bull') {
    const priceLower = recentCloses[recentCloses.length - 1] < recentCloses[0]
    const rsiHigher  = recentRsi[recentRsi.length - 1] > recentRsi[0]
    return priceLower && rsiHigher
  }
  const priceHigher = recentCloses[recentCloses.length - 1] > recentCloses[0]
  const rsiLower    = recentRsi[recentRsi.length - 1] < recentRsi[0]
  return priceHigher && rsiLower
}

/**
 * Candlestick patterns.
 *
 * `evidenced: true` marks the patterns with published backtested support on
 * Indian large-caps specifically (Harami and Engulfing consistently; Inverted
 * Hammer in some studies). The distinction matters because the same patterns
 * test as noise on US indices — the edge appears in less institutionally
 * dominated markets, which is the one this app is built for. Everything else
 * here is folklore worth displaying but not worth scoring heavily, so the
 * position-health bar reads `evidenced` rather than counting all patterns alike.
 */
function detectPatterns(candles) {
  const patterns = []
  if (candles.length < 2) return patterns

  const [c1, c2] = [candles[candles.length - 2], candles[candles.length - 1]]
  if (!c1 || !c2) return patterns

  const body1 = Math.abs(c1.close - c1.open)
  const body2 = Math.abs(c2.close - c2.open)
  const range2 = c2.high - c2.low || 0.0001

  // Doji
  if (body2 / range2 < 0.1) patterns.push({ name: 'Doji', type: 'neutral' })

  // Hammer (bullish)
  if (c2.close > c2.open && (c2.low < c2.open - 2 * body2)) {
    patterns.push({ name: 'Hammer', type: 'bullish' })
  }

  // Inverted Hammer — long upper shadow, small body, after a decline.
  if (body2 / range2 < 0.35 &&
      (c2.high - Math.max(c2.open, c2.close)) > 2 * body2 &&
      (Math.min(c2.open, c2.close) - c2.low) < body2 &&
      c1.close < c1.open) {
    patterns.push({ name: 'Inverted Hammer', type: 'bullish', evidenced: true })
  }

  // Shooting star (bearish)
  if (c2.close < c2.open && (c2.high > c2.open + 2 * body2)) {
    patterns.push({ name: 'Shooting Star', type: 'bearish' })
  }

  // Bullish engulfing
  if (c1.close < c1.open && c2.close > c2.open &&
      c2.open < c1.close && c2.close > c1.open) {
    patterns.push({ name: 'Bullish Engulfing', type: 'bullish', evidenced: true })
  }

  // Bearish engulfing
  if (c1.close > c1.open && c2.close < c2.open &&
      c2.open > c1.close && c2.close < c1.open) {
    patterns.push({ name: 'Bearish Engulfing', type: 'bearish', evidenced: true })
  }

  // Harami — the reverse of engulfing: a small second candle contained within
  // the first's body, signalling the prior move losing force. The strongest
  // performer in the NSE studies. Requires a genuinely small inside body, or
  // any quiet day after a big one would qualify.
  const inside = Math.max(c2.open, c2.close) < Math.max(c1.open, c1.close) &&
                 Math.min(c2.open, c2.close) > Math.min(c1.open, c1.close)
  if (inside && body1 > 0 && body2 < body1 * 0.6) {
    if (c1.close < c1.open && c2.close > c2.open) {
      patterns.push({ name: 'Bullish Harami', type: 'bullish', evidenced: true })
    } else if (c1.close > c1.open && c2.close < c2.open) {
      patterns.push({ name: 'Bearish Harami', type: 'bearish', evidenced: true })
    }
  }

  return patterns
}

function avg(arr) {
  const valid = arr.filter(v => v != null)
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null
}
