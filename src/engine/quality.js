// quality.js
// Fundamental quality scoring — fully configurable
// Each predictor has: id, label, formula, condition, weight, evaluate(data, ratios, histRatios)

import { revenueCAGR } from './ratios.js'

// ── Default predictor definitions ─────────────────────────

export const DEFAULT_FUNDAMENTAL_PREDICTORS = [
  {
    id:       'revenue_growth',
    label:    'Revenue Growth',
    desc:     '5-year revenue CAGR',
    weight:   15,
    threshold:10,    // %
    direction:'higher',
    evaluate: (data, ratios, hist) => {
      const cagr = revenueCAGR(data.incomeHistory, 5)
      return { value: cagr, unit: '%', pass: cagr != null && cagr >= 10 }
    }
  },
  {
    id:       'gross_margin',
    label:    'Gross Margin',
    desc:     'Latest gross margin (or net margin if gross unavailable)',
    weight:   15,
    threshold:30,
    direction:'higher',
    evaluate: (data, ratios) => {
      // Yahoo often lacks grossProfit; fall back to ebitdaMargin or netMargin
      const gm = ratios.grossMargin ?? ratios.ebitdaMargin ?? ratios.netMargin
      const threshold = ratios.grossMargin != null ? 30
                      : ratios.ebitdaMargin != null ? 15
                      : 8   // net margin threshold
      return { value: gm, unit: '%', pass: gm != null && gm >= threshold }
    }
  },
  {
    id:       'fcf_conversion',
    label:    'FCF Conversion',
    desc:     'FCF as % of Net Income',
    weight:   20,
    threshold:60,
    direction:'higher',
    evaluate: (data, ratios) => {
      const fc = ratios.fcfConversion
      return { value: fc, unit: '%', pass: fc != null && fc >= 60 }
    }
  },
  {
    id:       'debt_trajectory',
    label:    'Debt Trend',
    desc:     'D/E ratio falling or stable (uses TTM D/E when history unavailable)',
    weight:   15,
    threshold:null,
    direction:'lower',
    evaluate: (data, ratios, hist) => {
      const currentDE = ratios.deRatio
      // If we have multi-year D/E history, check trend
      const validHist = (hist ?? []).filter(h => h.deRatio != null)
      if (validHist.length >= 2) {
        const latest = validHist[validHist.length - 1].deRatio
        const prior  = validHist[validHist.length - 2].deRatio
        const falling = latest <= prior * 1.05
        return { value: currentDE, unit: 'x', pass: falling }
      }
      // Fallback: if only TTM D/E available, pass if D/E < 1.0 (reasonable threshold)
      if (currentDE != null) {
        return { value: currentDE, unit: 'x', pass: currentDE < 1.0 }
      }
      return { value: null, unit: 'x', pass: false }
    }
  },
  {
    id:       'roce',
    label:    'ROCE / ROE',
    desc:     'Return on Capital Employed (ROE used as fallback)',
    weight:   15,
    threshold:15,
    direction:'higher',
    evaluate: (data, ratios) => {
      const r = ratios.roce ?? ratios.roe  // ROE from TTM when ROCE unavailable
      const threshold = ratios.roce != null ? 15 : 10  // lower bar for ROE
      return { value: r, unit: '%', pass: r != null && r >= threshold }
    }
  },
  {
    id:       'earnings_consistency',
    label:    'Earnings Consistency',
    desc:     'Profitable for 3+ of last 5 years',
    weight:   10,
    threshold:3,
    direction:'higher',
    evaluate: (data) => {
      const profitable = data.incomeHistory.filter(y => y.netIncome > 0).length
      return { value: profitable, unit: 'yrs', pass: profitable >= 3 }
    }
  },
  {
    id:       'margin_trend',
    label:    'Margin Trend',
    desc:     'Operating/net margin stable or expanding over available history',
    weight:   10,
    threshold:null,
    direction:'higher',
    evaluate: (data, ratios, hist) => {
      // Try EBITDA margin first, then net margin from history
      const pick = (arr, key) => arr.filter(h => h[key] != null)
      const ebitdaH = pick(hist ?? [], 'ebitdaMargin')
      const netH    = pick(hist ?? [], 'netMargin')

      let value = ratios.ebitdaMargin ?? ratios.netMargin
      let pass  = false

      if (ebitdaH.length >= 2) {
        const latest = ebitdaH[ebitdaH.length - 1].ebitdaMargin
        const prior  = ebitdaH[0].ebitdaMargin
        pass  = latest >= prior - 2  // allow 2pp deterioration
        value = ratios.ebitdaMargin
      } else if (netH.length >= 2) {
        const latest = netH[netH.length - 1].netMargin
        const prior  = netH[0].netMargin
        pass  = latest >= prior - 1
        value = ratios.netMargin
      } else if (value != null) {
        // Only TTM available — pass if margin is positive and reasonable
        pass = value > 5
      }

      return { value, unit: '%', pass }
    }
  },
]

export const DEFAULT_TECHNICAL_PREDICTORS = [
  {
    id:       'price_vs_sma200',
    label:    'Price vs SMA200',
    desc:     'Price above 200-day moving average',
    weight:   20,
    evaluate: (tech) => {
      const above = tech.latest.price != null && tech.latest.sma200 != null
        && tech.latest.price > tech.latest.sma200
      return { value: tech.latest.sma200, unit: '', pass: above, signal: above ? 'BULLISH' : 'BEARISH' }
    }
  },
  {
    id:       'price_vs_sma50',
    label:    'Price vs SMA50',
    desc:     'Price above 50-day moving average',
    weight:   15,
    evaluate: (tech) => {
      const above = tech.latest.price != null && tech.latest.sma50 != null
        && tech.latest.price > tech.latest.sma50
      return { value: tech.latest.sma50, unit: '', pass: above, signal: above ? 'BULLISH' : 'BEARISH' }
    }
  },
  {
    id:       'rsi',
    label:    'RSI (14)',
    desc:     'RSI between 40–70 = healthy momentum',
    weight:   20,
    evaluate: (tech) => {
      const rsi  = tech.latest.rsi
      const pass = rsi != null && rsi >= 40 && rsi <= 70
      const signal = rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : rsi >= 40 ? 'BULLISH' : 'BEARISH'
      return { value: rsi, unit: '', pass, signal }
    }
  },
  {
    id:       'macd',
    label:    'MACD',
    desc:     'MACD line above signal line',
    weight:   20,
    evaluate: (tech) => {
      const pass = tech.latest.macd != null && tech.latest.macdSignal != null
        && tech.latest.macd > tech.latest.macdSignal
      return { value: tech.latest.macdHist, unit: '', pass, signal: pass ? 'BULLISH' : 'BEARISH' }
    }
  },
  {
    id:       'volume',
    label:    'Volume',
    desc:     'Volume above 20-day average',
    weight:   15,
    evaluate: (tech) => {
      const pass = tech.latest.volumeRatio != null && tech.latest.volumeRatio > 1.0
      return { value: tech.latest.volumeRatio, unit: 'x avg', pass, signal: pass ? 'BULLISH' : 'NEUTRAL' }
    }
  },
  {
    id:       'obv',
    label:    'OBV Trend',
    desc:     'On-Balance Volume rising = accumulation',
    weight:   10,
    evaluate: (tech) => {
      const pass = tech.latest.obvTrend === 'RISING'
      return { value: null, unit: '', pass, signal: pass ? 'BULLISH' : 'BEARISH' }
    }
  },
]

// ── Scoring engine ────────────────────────────────────────

export function scoreFundamentals(data, ratios, historicalRatios, predictors) {
  const active = predictors ?? DEFAULT_FUNDAMENTAL_PREDICTORS
  const totalWeight = active.reduce((s, p) => s + p.weight, 0)

  const results = active.map(predictor => {
    try {
      const result = predictor.evaluate(data, ratios, historicalRatios)
      return { ...predictor, ...result, score: result.pass ? predictor.weight : 0 }
    } catch {
      return { ...predictor, value: null, pass: false, score: 0 }
    }
  })

  const rawScore    = results.reduce((s, r) => s + r.score, 0)
  const normalised  = totalWeight > 0 ? (rawScore / totalWeight) * 10 : 0

  return {
    score:    normalised,
    label:    fundamentalLabel(normalised),
    results,
  }
}

export function scoreTechnicals(technicals, predictors) {
  if (!technicals || technicals.error) {
    return { score: null, label: 'INSUFFICIENT DATA', results: [] }
  }

  const active      = predictors ?? DEFAULT_TECHNICAL_PREDICTORS
  const totalWeight = active.reduce((s, p) => s + p.weight, 0)

  const results = active.map(predictor => {
    try {
      const result = predictor.evaluate(technicals)
      return { ...predictor, ...result, score: result.pass ? predictor.weight : 0 }
    } catch {
      return { ...predictor, value: null, pass: false, score: 0 }
    }
  })

  const rawScore   = results.reduce((s, r) => s + r.score, 0)
  const normalised = totalWeight > 0 ? (rawScore / totalWeight) * 10 : 0

  return {
    score:   normalised,
    label:   technicalLabel(normalised),
    results,
    patterns: technicals.latest.patterns,
    divergence: technicals.latest.divergence,
    recentCross: technicals.latest.recentCross,
  }
}

// ── Signal labels ─────────────────────────────────────────

function fundamentalLabel(score) {
  if (score >= 8) return 'EXCELLENT'
  if (score >= 5) return 'HEALTHY'
  if (score >= 3) return 'CONCERNS'
  return 'WEAK'
}

function technicalLabel(score) {
  if (score >= 7) return 'BULLISH'
  if (score >= 4) return 'NEUTRAL'
  return 'BEARISH'
}

// ── Combined verdict ──────────────────────────────────────

const VERDICT_MATRIX = {
  UNDERVALUED: {
    BULLISH:  { EXCELLENT: 'Strong buy — undervalued, bullish momentum, and excellent fundamentals.',
                HEALTHY:   'Good buy candidate — undervalued with bullish technicals and healthy business quality.',
                CONCERNS:  'Speculative buy — undervalued and bullish but business quality needs monitoring.',
                WEAK:      'High risk — undervalued and bullish but weak fundamentals. Tread carefully.' },
    NEUTRAL:  { EXCELLENT: 'Worth accumulating — undervalued with excellent fundamentals despite neutral momentum.',
                HEALTHY:   'Patient buy — undervalued with healthy fundamentals. Wait for technical confirmation.',
                CONCERNS:  'Cautious — undervalued but momentum neutral and quality concerns exist.',
                WEAK:      'Avoid — undervalued on paper but weak fundamentals and no momentum.' },
    BEARISH:  { EXCELLENT: 'Value trap risk — undervalued with great fundamentals but bearish momentum. Wait.',
                HEALTHY:   'Hold off — undervalued with decent quality but bearish technicals.',
                CONCERNS:  'Avoid for now — undervalued but bearish momentum and quality concerns.',
                WEAK:      'Strong avoid — undervalued but everything else is against it.' },
  },
  FAIRLY_VALUED: {
    BULLISH:  { EXCELLENT: 'Worth holding — fairly valued with excellent fundamentals and bullish momentum.',
                HEALTHY:   'Hold or accumulate on dips — fairly priced with healthy quality and good momentum.',
                CONCERNS:  'Neutral — fair value but quality concerns temper the bullish signals.',
                WEAK:      'Reduce on strength — fair value with bullish momentum but poor fundamentals.' },
    NEUTRAL:  { EXCELLENT: 'Hold — fairly valued with excellent fundamentals. No urgency either way.',
                HEALTHY:   'Hold — fairly priced and healthy business. Watch for directional catalyst.',
                CONCERNS:  'Neutral — fair value, neutral momentum, and quality concerns. Monitor closely.',
                WEAK:      'Reduce — fair price but weak fundamentals and no momentum to support it.' },
    BEARISH:  { EXCELLENT: 'Wait — fairly valued with great fundamentals but bearish momentum. Better entry ahead.',
                HEALTHY:   'Wait — fair value, decent quality, but bearish technicals suggest patience.',
                CONCERNS:  'Avoid — fair value but bearish momentum and quality concerns compound the risk.',
                WEAK:      'Exit — fair value today but bearish signals and weak fundamentals are red flags.' },
  },
  OVERVALUED: {
    BULLISH:  { EXCELLENT: 'Momentum play — overvalued but excellent fundamentals may justify premium. High risk.',
                HEALTHY:   'Caution — overvalued with healthy fundamentals. Momentum may extend but risk is high.',
                CONCERNS:  'Avoid — overvalued, quality concerns, despite bullish momentum.',
                WEAK:      'Strong avoid — overvalued with weak fundamentals despite bullish momentum.' },
    NEUTRAL:  { EXCELLENT: 'Reduce — overvalued despite excellent fundamentals. Neutral momentum offers no cushion.',
                HEALTHY:   'Trim — overvalued with decent quality but nothing to justify the premium.',
                CONCERNS:  'Exit — overvalued, quality concerns, and momentum offers no support.',
                WEAK:      'Exit immediately — overvalued with weak fundamentals and neutral momentum.' },
    BEARISH:  { EXCELLENT: 'Reduce significantly — overvalued and bearish despite excellent fundamentals.',
                HEALTHY:   'Exit — overvalued with bearish technicals. Healthy fundamentals offer no cushion here.',
                CONCERNS:  'Strong sell — overvalued, bearish momentum, and quality concerns.',
                WEAK:      'Strong sell — everything points against this stock.' },
  },
}

export function buildVerdict(valuationSignal, technicalScore, fundamentalScore) {
  const techLabel  = technicalScore.label   ?? 'NEUTRAL'
  const fundLabel  = fundamentalScore.label ?? 'CONCERNS'
  const valSignal  = valuationSignal        ?? 'FAIRLY_VALUED'

  const text = VERDICT_MATRIX[valSignal]?.[techLabel]?.[fundLabel]
    ?? 'Insufficient data for a combined verdict. Review individual signals.'

  return { text, valSignal, techLabel, fundLabel }
}
