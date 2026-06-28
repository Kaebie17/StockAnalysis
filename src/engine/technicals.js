// technicals.js
// All technical indicator calculations from raw OHLCV data
// Pure functions — no external dependencies

// ── Moving Averages ───────────────────────────────────────

export function calcSMA(closes, period) {
  if (closes.length < period) return []
  const result = new Array(period - 1).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const sum = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)
    result.push(sum / period)
  }
  return result
}

export function calcEMA(closes, period) {
  if (closes.length < period) return []
  const k      = 2 / (period + 1)
  const result = new Array(period - 1).fill(null)
  let ema      = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  result.push(ema)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
    result.push(ema)
  }
  return result
}

// ── RSI ───────────────────────────────────────────────────

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return []
  const result = new Array(period).fill(null)

  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains  += diff
    else          losses -= diff
  }

  let avgGain = gains  / period
  let avgLoss = losses / period

  const rsi0 = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  result.push(rsi0)

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain    = (avgGain * (period - 1) + gain) / period
    avgLoss    = (avgLoss * (period - 1) + loss) / period
    const rsi  = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    result.push(rsi)
  }

  return result
}

// ── MACD ──────────────────────────────────────────────────

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast   = calcEMA(closes, fast)
  const emaSlow   = calcEMA(closes, slow)
  const macdLine  = emaFast.map((v, i) =>
    v != null && emaSlow[i] != null ? v - emaSlow[i] : null
  )
  const validMACD   = macdLine.filter(v => v != null)
  const signalRaw   = calcEMA(validMACD, signal)

  // Align signal line with full array length
  const sigOffset   = macdLine.length - signalRaw.length
  const signalLine  = new Array(sigOffset).fill(null).concat(signalRaw)

  const histogram   = macdLine.map((v, i) =>
    v != null && signalLine[i] != null ? v - signalLine[i] : null
  )

  return { macdLine, signalLine, histogram }
}

// ── Bollinger Bands ───────────────────────────────────────

export function calcBollingerBands(closes, period = 20, stdDev = 2) {
  const sma    = calcSMA(closes, period)
  const upper  = []
  const lower  = []

  for (let i = 0; i < closes.length; i++) {
    if (sma[i] == null) { upper.push(null); lower.push(null); continue }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean  = sma[i]
    const std   = Math.sqrt(slice.reduce((a, v) => a + Math.pow(v - mean, 2), 0) / period)
    upper.push(mean + stdDev * std)
    lower.push(mean - stdDev * std)
  }

  return { upper, middle: sma, lower }
}

// ── OBV ───────────────────────────────────────────────────

export function calcOBV(closes, volumes) {
  const obv = [0]
  for (let i = 1; i < closes.length; i++) {
    const prev = obv[obv.length - 1]
    if (closes[i] > closes[i - 1])      obv.push(prev + volumes[i])
    else if (closes[i] < closes[i - 1]) obv.push(prev - volumes[i])
    else                                 obv.push(prev)
  }
  return obv
}

// ── Volume analysis ───────────────────────────────────────

export function calcVolumeMetrics(priceHistory, period = 20) {
  const vols    = priceHistory.map(d => d.volume)
  const recent  = vols.slice(-period)
  const avgVol  = recent.reduce((a, b) => a + b, 0) / recent.length
  const lastVol = vols[vols.length - 1]

  // OBV trend: compare last 5 days vs 5 days before that
  const obv     = calcOBV(priceHistory.map(d => d.close), vols)
  const obvLast5Avg  = avg(obv.slice(-5))
  const obvPrior5Avg = avg(obv.slice(-10, -5))
  const obvTrend = obvLast5Avg > obvPrior5Avg ? 'RISING' : 'FALLING'

  return {
    avgVolume:    avgVol,
    lastVolume:   lastVol,
    volumeRatio:  lastVol / avgVol,   // >1.2 = above average
    obvTrend,
    volumeSignal: lastVol > avgVol * 1.2 ? 'ABOVE_AVG'
                : lastVol < avgVol * 0.8 ? 'BELOW_AVG'
                : 'NORMAL',
  }
}

// ── RSI Divergence ────────────────────────────────────────

export function detectRSIDivergence(closes, rsiValues, lookback = 14) {
  const n      = closes.length
  if (n < lookback * 2) return { bullish: false, bearish: false }

  const recentCloses = closes.slice(-lookback)
  const recentRSI    = rsiValues.slice(-lookback).filter(v => v != null)

  if (recentRSI.length < lookback / 2) return { bullish: false, bearish: false }

  const priceDown = recentCloses[recentCloses.length - 1] < recentCloses[0]
  const rsiUp     = recentRSI[recentRSI.length - 1]   > recentRSI[0]
  const priceUp   = recentCloses[recentCloses.length - 1] > recentCloses[0]
  const rsiDown   = recentRSI[recentRSI.length - 1]   < recentRSI[0]

  return {
    bullish: priceDown && rsiUp,   // price falling, RSI rising → hidden strength
    bearish: priceUp   && rsiDown, // price rising,  RSI falling → hidden weakness
  }
}

// ── Candlestick Patterns ──────────────────────────────────

export function detectCandlestickPatterns(priceHistory) {
  const patterns = []
  const n        = priceHistory.length
  if (n < 3) return patterns

  const last3 = priceHistory.slice(-3)
  const [d2, d1, d0] = last3  // d0 = most recent

  const body0  = Math.abs(d0.close - d0.open)
  const range0 = d0.high - d0.low
  const body1  = Math.abs(d1.close - d1.open)

  // Doji: body is very small relative to range
  if (range0 > 0 && body0 / range0 < 0.1) {
    patterns.push({ name: 'Doji', signal: 'NEUTRAL', desc: 'Indecision — potential reversal' })
  }

  // Hammer (bullish): small body at top, long lower shadow
  const lowerShadow0 = Math.min(d0.open, d0.close) - d0.low
  const upperShadow0 = d0.high - Math.max(d0.open, d0.close)
  if (lowerShadow0 > body0 * 2 && upperShadow0 < body0 * 0.5) {
    patterns.push({ name: 'Hammer', signal: 'BULLISH', desc: 'Bullish reversal at support' })
  }

  // Shooting Star (bearish): small body at bottom, long upper shadow
  if (upperShadow0 > body0 * 2 && lowerShadow0 < body0 * 0.5) {
    patterns.push({ name: 'Shooting Star', signal: 'BEARISH', desc: 'Bearish reversal at resistance' })
  }

  // Bullish Engulfing
  if (d1.close < d1.open && d0.close > d0.open &&
      d0.open < d1.close && d0.close > d1.open) {
    patterns.push({ name: 'Bullish Engulfing', signal: 'BULLISH', desc: 'Strong bullish reversal' })
  }

  // Bearish Engulfing
  if (d1.close > d1.open && d0.close < d0.open &&
      d0.open > d1.close && d0.close < d1.open) {
    patterns.push({ name: 'Bearish Engulfing', signal: 'BEARISH', desc: 'Strong bearish reversal' })
  }

  // Morning Star (3-candle bullish reversal)
  if (n >= 3) {
    const body2 = Math.abs(d2.close - d2.open)
    if (d2.close < d2.open && body1 < body2 * 0.3 && d0.close > d0.open &&
        d0.close > (d2.open + d2.close) / 2) {
      patterns.push({ name: 'Morning Star', signal: 'BULLISH', desc: '3-candle bullish reversal' })
    }
  }

  return patterns
}

// ── Run all technicals ────────────────────────────────────

export function runAllTechnicals(priceHistory, config = {}) {
  if (!priceHistory || priceHistory.length < 30) {
    return { error: 'Insufficient price history (need 30+ days)' }
  }

  const closes  = priceHistory.map(d => d.close)
  const volumes = priceHistory.map(d => d.volume)

  const rsiPeriod  = config.rsiPeriod  ?? 14
  const smaPeriods = config.smaPeriods ?? [50, 200]
  const emaPeriods = config.emaPeriods ?? [20]

  const rsiValues  = calcRSI(closes, rsiPeriod)
  const macdResult = calcMACD(closes, config.macdFast ?? 12, config.macdSlow ?? 26, config.macdSignal ?? 9)
  const bollinger  = calcBollingerBands(closes, config.bbPeriod ?? 20)
  const volMetrics = calcVolumeMetrics(priceHistory, config.volPeriod ?? 20)
  const patterns   = detectCandlestickPatterns(priceHistory)
  const divergence = detectRSIDivergence(closes, rsiValues, config.divergenceLookback ?? 14)

  // Latest values
  const lastRSI    = lastVal(rsiValues)
  const lastMACD   = lastVal(macdResult.macdLine)
  const lastSig    = lastVal(macdResult.signalLine)
  const lastHist   = lastVal(macdResult.histogram)
  const lastClose  = closes[closes.length - 1]

  // SMAs
  const smas = {}
  smaPeriods.forEach(p => {
    const vals = calcSMA(closes, p)
    smas[`sma${p}`] = { values: vals, last: lastVal(vals) }
  })

  // EMAs
  const emas = {}
  emaPeriods.forEach(p => {
    const vals = calcEMA(closes, p)
    emas[`ema${p}`] = { values: vals, last: lastVal(vals) }
  })

  // Cross signals
  const sma50last  = smas['sma50']?.last
  const sma200last = smas['sma200']?.last
  const goldenCross = sma50last != null && sma200last != null && sma50last > sma200last
  const deathCross  = sma50last != null && sma200last != null && sma50last < sma200last

  // Detect recent cross (last 30 bars)
  const recentCross = detectRecentCross(smas['sma50']?.values ?? [], smas['sma200']?.values ?? [], 30)

  return {
    // Raw series (for charts)
    series: {
      closes, volumes,
      rsi:       rsiValues,
      macdLine:  macdResult.macdLine,
      signalLine:macdResult.signalLine,
      histogram: macdResult.histogram,
      bollinger,
      ...smas,
      ...emas,
    },
    // Latest snapshot (for signals)
    latest: {
      rsi:           lastRSI,
      macd:          lastMACD,
      macdSignal:    lastSig,
      macdHist:      lastHist,
      price:         lastClose,
      sma50:         sma50last,
      sma200:        sma200last,
      ema20:         emas['ema20']?.last,
      volume:        volMetrics.lastVolume,
      avgVolume:     volMetrics.avgVolume,
      volumeRatio:   volMetrics.volumeRatio,
      obvTrend:      volMetrics.obvTrend,
      volumeSignal:  volMetrics.volumeSignal,
      goldenCross,
      deathCross,
      recentCross,
      patterns,
      divergence,
    }
  }
}

// ── Helpers ───────────────────────────────────────────────

function lastVal(arr) {
  if (!arr || arr.length === 0) return null
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i]
  }
  return null
}

function avg(arr) {
  const valid = arr.filter(v => v != null)
  if (!valid.length) return 0
  return valid.reduce((a, b) => a + b, 0) / valid.length
}

function detectRecentCross(sma50arr, sma200arr, lookback) {
  const n   = Math.min(sma50arr.length, sma200arr.length)
  const end = n - 1
  const start = Math.max(0, end - lookback)
  for (let i = end; i > start; i--) {
    const curr50  = sma50arr[i],    curr200  = sma200arr[i]
    const prev50  = sma50arr[i-1],  prev200  = sma200arr[i-1]
    if (curr50 == null || curr200 == null || prev50 == null || prev200 == null) continue
    if (prev50 <= prev200 && curr50 > curr200) return { type: 'GOLDEN', daysAgo: end - i }
    if (prev50 >= prev200 && curr50 < curr200) return { type: 'DEATH',  daysAgo: end - i }
  }
  return null
}
