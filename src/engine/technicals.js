/**
 * src/engine/technicals.js
 */

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

  // Trend detection
  const lastSma50  = sma50[sma50.length - 1]
  const lastSma200 = sma200[sma200.length - 1]
  const prevSma50  = sma50[sma50.length - 2]
  const prevSma200 = sma200[sma200.length - 2]

  const goldenCross = lastSma50 > lastSma200 && prevSma50 <= prevSma200
  const deathCross  = lastSma50 < lastSma200 && prevSma50 >= prevSma200
  const aboveSma50  = last > lastSma50
  const aboveSma200 = last > lastSma200

  // RSI signals
  const rsiOverbought  = latestRsi > 70
  const rsiOversold    = latestRsi < 30
  const rsiBullDiv     = detectRsiDivergence(closes, rsiVal, 'bull')
  const rsiBearDiv     = detectRsiDivergence(closes, rsiVal, 'bear')

  // MACD signals
  const macdBullCross = latestMacd > latestSig && macdLine[macdLine.length - 2] <= signalLine[signalLine.length - 2]
  const macdBearCross = latestMacd < latestSig && macdLine[macdLine.length - 2] >= signalLine[signalLine.length - 2]
  const macdAboveZero = latestMacd > 0

  // Candlestick patterns (last 5 candles)
  const patterns = detectPatterns(priceHistory.slice(-5))

  // Bollinger position
  const latestBB = { upper: bb.upper[bb.upper.length - 1], lower: bb.lower[bb.lower.length - 1], mid: bb.mid[bb.mid.length - 1] }
  const bbPosition = (last - latestBB.lower) / (latestBB.upper - latestBB.lower) // 0=at lower, 1=at upper

  // ── Scoring ───────────────────────────────────────────────────────────────────
  let bullPoints = 0, bearPoints = 0

  if (aboveSma50)    bullPoints += 1
  if (aboveSma200)   bullPoints += 1
  if (goldenCross)   bullPoints += 2
  if (deathCross)    bearPoints += 2
  if (!aboveSma50)   bearPoints += 1
  if (!aboveSma200)  bearPoints += 1

  if (rsiOversold)   bullPoints += 2
  if (rsiOverbought) bearPoints += 2
  if (rsiBullDiv)    bullPoints += 1
  if (rsiBearDiv)    bearPoints += 1

  if (latestHist > 0 && latestHist > prevHist) bullPoints += 1
  if (latestHist < 0 && latestHist < prevHist) bearPoints += 1
  if (macdBullCross)  bullPoints += 1
  if (macdBearCross)  bearPoints += 1
  if (macdAboveZero)  bullPoints += 0.5

  if (bbPosition < 0.2) bullPoints += 1
  if (bbPosition > 0.8) bearPoints += 1

  patterns.forEach(p => {
    if (p.type === 'bullish') bullPoints += 1
    if (p.type === 'bearish') bearPoints += 1
  })

  const totalScore = bullPoints + bearPoints || 1
  const techScore = (bullPoints / totalScore) * 10

  const label = techScore >= 6.5 ? 'BULLISH' : techScore <= 3.5 ? 'BEARISH' : 'NEUTRAL'

  // ── Support / Resistance (swing-pivot clustering) ────────────────────────────
  const levels = computeLevels(priceHistory, last)

  return {
    available: true,
    score: +techScore.toFixed(1),
    label,
    indicators: {
      price: last,
      sma50: lastSma50, sma200: lastSma200, ema20: ema20[ema20.length - 1],
      rsi: +latestRsi.toFixed(1),
      macd: { macd: +latestMacd.toFixed(3), signal: +latestSig.toFixed(3), histogram: +latestHist.toFixed(3) },
      bollinger: { ...latestBB, position: +bbPosition.toFixed(2) },
      volume: { current: volumes[volumes.length - 1], avg20: +vol20avg.toFixed(0), ratio: +volRatio.toFixed(2) }
    },
    signals: {
      goldenCross, deathCross, aboveSma50, aboveSma200,
      rsiOverbought, rsiOversold, rsiBullDiv, rsiBearDiv,
      macdBullCross, macdBearCross, macdAboveZero
    },
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

// Support / resistance from swing pivots.
//  1. Find swing highs/lows (a bar that is the extreme within a ±k window).
//  2. Cluster pivots that sit within `tol` of each other into a single level.
//  3. Score each level by touches (recency-weighted) + volume at those pivots.
//  4. Split by current price → resistance (above) / support (below); report the
//     nearest of each and the strongest of each.
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

  // Score: touches, weighted so recent touches count more (last bar = weight ~1,
  // oldest ~0.4), plus a small bump for volume at the pivots.
  const totalVol = vols.reduce((s, v) => s + v, 0) || 1
  const levels = clusters.map(c => {
    const touches = c.members.length
    const recencyW = c.members.reduce((s, m) => s + (0.4 + 0.6 * (m.idx / n)), 0)
    const volW = c.members.reduce((s, m) => s + m.vol, 0) / totalVol
    return {
      price: +c.price.toFixed(2),
      touches,
      lastTouch: Math.max(...c.members.map(m => m.idx)),
      strength: +(recencyW + volW * 3).toFixed(2),   // composite score
    }
  })

  const near = arr => arr.length ? arr.reduce((a, b) => Math.abs(b.price - last) < Math.abs(a.price - last) ? b : a) : null
  const strong = arr => arr.length ? arr.reduce((a, b) => b.strength > a.strength ? b : a) : null
  const withDist = lvl => lvl && { ...lvl, distancePct: +(((lvl.price - last) / last) * 100).toFixed(1) }

  // A level within ~0.5% of price is effectively "at" price; treat by side of the cluster mid.
  const resistance = levels.filter(l => l.price > last * 1.001)
  const support    = levels.filter(l => l.price < last * 0.999)

  return {
    price: last,
    nearestResistance: withDist(near(resistance)),
    strongestResistance: withDist(strong(resistance)),
    nearestSupport: withDist(near(support)),
    strongestSupport: withDist(strong(support)),
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

  // Shooting star (bearish)
  if (c2.close < c2.open && (c2.high > c2.open + 2 * body2)) {
    patterns.push({ name: 'Shooting Star', type: 'bearish' })
  }

  // Bullish engulfing
  if (c1.close < c1.open && c2.close > c2.open &&
      c2.open < c1.close && c2.close > c1.open) {
    patterns.push({ name: 'Bullish Engulfing', type: 'bullish' })
  }

  // Bearish engulfing
  if (c1.close > c1.open && c2.close < c2.open &&
      c2.open > c1.close && c2.close < c1.open) {
    patterns.push({ name: 'Bearish Engulfing', type: 'bearish' })
  }

  return patterns
}

function avg(arr) {
  const valid = arr.filter(v => v != null)
  return valid.length ? valid.reduce((s, v) => s + v, 0) / valid.length : null
}


