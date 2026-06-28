// valuation.js
// All valuation model calculations
// Each model returns { value, applicable, reason } so UI can show/hide/flag

export const DEFAULT_ASSUMPTIONS = {
  wacc:              10,    // %
  terminalGrowth:    3.5,   // %
  projectionYears:   5,
  revenueGrowthYr1:  null,  // null = use historical CAGR
  marginImprovement: 0,     // % per year EBITDA margin improvement
  sectorPE:          20,
  sectorEVEBITDA:    12,
  sectorPB:          2.5,
  sectorPS:          3,
  sectorEVGP:        10,
  marginOfSafety:    20,    // %
  // DCF weights per model for consensus
  modelWeights: {
    dcf:          30,
    peValuation:  20,
    evEbitda:     20,
    pbValuation:  10,
    psValuation:  10,
    grahamNumber: 10,
  }
}

// ── DCF ───────────────────────────────────────────────────

export function runDCF(data, ratios, assumptions) {
  const { latest } = data
  const { fcf, sharesOut } = latest
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions }

  if (!fcf || fcf <= 0) {
    // Try using CFO - capex as FCF proxy
    const proxyFCF = (latest.cfo ?? 0) + (latest.capex ?? 0) // capex is negative
    if (proxyFCF <= 0) {
      return { value: null, applicable: false, reason: 'Negative or unavailable FCF' }
    }
  }

  const baseFCF     = fcf > 0 ? fcf : ((latest.cfo ?? 0) + (latest.capex ?? 0))
  const growthRate  = (a.revenueGrowthYr1 ?? 10) / 100
  const wacc        = a.wacc / 100
  const tGrowth     = a.terminalGrowth / 100
  const shares      = sharesOut ?? (latest.marketCap / latest.price)

  if (!shares || shares <= 0) {
    return { value: null, applicable: false, reason: 'Share count unavailable' }
  }

  // Project FCF for N years
  let pvSum = 0
  let fcfT  = baseFCF

  for (let t = 1; t <= a.projectionYears; t++) {
    // Growth tapers linearly from growthRate to tGrowth
    const yr    = growthRate - ((growthRate - tGrowth) * (t / a.projectionYears))
    fcfT        = fcfT * (1 + yr)
    pvSum      += fcfT / Math.pow(1 + wacc, t)
  }

  // Terminal value
  const terminalFCF = fcfT * (1 + tGrowth)
  const terminalVal = terminalFCF / (wacc - tGrowth)
  const pvTerminal  = terminalVal / Math.pow(1 + wacc, a.projectionYears)

  const totalEquityVal = pvSum + pvTerminal
  const intrinsicValue = totalEquityVal / shares

  return {
    value:       intrinsicValue,
    applicable:  true,
    reason:      null,
    breakdown: {
      pvFCF:         pvSum / shares,
      pvTerminal:    pvTerminal / shares,
      terminalShare: (pvTerminal / (pvSum + pvTerminal)) * 100,
    }
  }
}

// ── P/E Valuation ─────────────────────────────────────────

export function runPEValuation(data, ratios, assumptions) {
  const a   = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const eps = data.latest.eps

  if (!eps || eps <= 0) {
    return { value: null, applicable: false, reason: 'Negative or unavailable EPS' }
  }

  return {
    value:      eps * a.sectorPE,
    applicable: true,
    reason:     null,
  }
}

// ── EV/EBITDA Valuation ───────────────────────────────────

export function runEVEBITDA(data, ratios, assumptions) {
  const a      = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const { ebitda, totalDebt, cash } = data.latest
  const shares = data.latest.sharesOut ?? (data.latest.marketCap / data.latest.price)

  if (!ebitda || ebitda <= 0) {
    return { value: null, applicable: false, reason: 'Negative or unavailable EBITDA' }
  }
  if (!shares) {
    return { value: null, applicable: false, reason: 'Share count unavailable' }
  }

  const impliedEV       = ebitda * a.sectorEVEBITDA
  const impliedEquity   = impliedEV - (totalDebt ?? 0) + (cash ?? 0)
  const valuePerShare   = impliedEquity / shares

  return {
    value:      valuePerShare,
    applicable: true,
    reason:     null,
  }
}

// ── P/B Valuation ─────────────────────────────────────────

export function runPBValuation(data, ratios, assumptions) {
  const a    = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const bvps = data.latest.bookValuePerShare

  if (!bvps || bvps <= 0) {
    return { value: null, applicable: false, reason: 'Book value unavailable' }
  }

  return {
    value:      bvps * a.sectorPB,
    applicable: true,
    reason:     null,
  }
}

// ── P/S Valuation ─────────────────────────────────────────

export function runPSValuation(data, ratios, assumptions) {
  const a      = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const { revenue } = data.latest
  const shares = data.latest.sharesOut ?? (data.latest.marketCap / data.latest.price)

  if (!revenue || !shares) {
    return { value: null, applicable: false, reason: 'Revenue or share count unavailable' }
  }

  const revenuePerShare = revenue / shares

  return {
    value:      revenuePerShare * a.sectorPS,
    applicable: true,
    reason:     null,
  }
}

// ── EV/Gross Profit ───────────────────────────────────────

export function runEVGrossProfit(data, ratios, assumptions) {
  const a      = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const { grossProfit, totalDebt, cash } = data.latest
  const shares = data.latest.sharesOut ?? (data.latest.marketCap / data.latest.price)

  if (!grossProfit || grossProfit <= 0 || !shares) {
    return { value: null, applicable: false, reason: 'Gross profit unavailable' }
  }

  const impliedEV     = grossProfit * a.sectorEVGP
  const impliedEquity = impliedEV - (totalDebt ?? 0) + (cash ?? 0)

  return {
    value:      impliedEquity / shares,
    applicable: true,
    reason:     null,
  }
}

// ── Graham Number ─────────────────────────────────────────

export function runGrahamNumber(data, ratios) {
  const gn = ratios.grahamNumber
  if (!gn) {
    return { value: null, applicable: false, reason: 'Requires positive EPS and book value' }
  }
  return { value: gn, applicable: true, reason: null }
}

// ── Reverse DCF ───────────────────────────────────────────
// Given current price, what growth rate is already priced in?

export function runReverseDCF(data, ratios, assumptions) {
  const a      = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  const { fcf, price } = data.latest
  const shares = data.latest.sharesOut ?? (data.latest.marketCap / price)

  if (!fcf || fcf <= 0 || !price || !shares) {
    return { value: null, applicable: false, reason: 'Requires positive FCF and price' }
  }

  const wacc    = a.wacc / 100
  const tGrowth = a.terminalGrowth / 100
  const mktEV   = price * shares

  // Binary search for implied growth rate
  let lo = -0.5, hi = 2.0
  for (let iter = 0; iter < 60; iter++) {
    const g   = (lo + hi) / 2
    const val = computeDCFValue(fcf, g, wacc, tGrowth, a.projectionYears)
    if (val > mktEV) hi = g
    else lo = g
  }

  const impliedGrowth = ((lo + hi) / 2) * 100

  return {
    value:      impliedGrowth,   // % growth rate implied by current price
    applicable: true,
    reason:     null,
    isGrowthRate: true,          // flag so UI knows to render as % not currency
  }
}

function computeDCFValue(baseFCF, growthRate, wacc, tGrowth, years) {
  let pv = 0, fcfT = baseFCF
  for (let t = 1; t <= years; t++) {
    const yr = growthRate - ((growthRate - tGrowth) * (t / years))
    fcfT     = fcfT * (1 + yr)
    pv      += fcfT / Math.pow(1 + wacc, t)
  }
  const tv = (fcfT * (1 + tGrowth)) / (wacc - tGrowth)
  return pv + tv / Math.pow(1 + wacc, years)
}

// ── Run all models ────────────────────────────────────────

export function runAllModels(data, ratios, assumptions) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions }

  const models = {
    dcf:          runDCF(data, ratios, a),
    peValuation:  runPEValuation(data, ratios, a),
    evEbitda:     runEVEBITDA(data, ratios, a),
    pbValuation:  runPBValuation(data, ratios, a),
    psValuation:  runPSValuation(data, ratios, a),
    evGrossProfit:runEVGrossProfit(data, ratios, a),
    grahamNumber: runGrahamNumber(data, ratios),
    reverseDCF:   runReverseDCF(data, ratios, a),
  }

  // Weighted consensus from applicable models with values
  const applicable = Object.entries(models)
    .filter(([k, m]) => m.applicable && m.value != null && !m.isGrowthRate)

  const weights     = a.modelWeights
  let totalWeight   = 0
  let weightedSum   = 0

  applicable.forEach(([key, m]) => {
    const w  = weights[key] ?? 10
    weightedSum  += m.value * w
    totalWeight  += w
  })

  const consensusValue  = totalWeight > 0 ? weightedSum / totalWeight : null
  const currentPrice    = data.latest.price

  const upside = consensusValue && currentPrice
    ? ((consensusValue - currentPrice) / currentPrice) * 100
    : null

  const signal = deriveValuationSignal(upside, a)

  return { models, consensusValue, upside, signal }
}

export function deriveValuationSignal(upside, assumptions) {
  const a = { ...DEFAULT_ASSUMPTIONS, ...assumptions }
  if (upside == null) return 'UNKNOWN'
  if (upside > (a.upsideBracket  ?? 15))  return 'UNDERVALUED'
  if (upside < -(a.downsideBracket ?? 10)) return 'OVERVALUED'
  return 'FAIRLY_VALUED'
}

export const MODEL_LABELS = {
  dcf:           'DCF',
  peValuation:   'P/E Based',
  evEbitda:      'EV/EBITDA',
  pbValuation:   'P/B Based',
  psValuation:   'P/S Based',
  evGrossProfit: 'EV/Gross Profit',
  grahamNumber:  'Graham Number',
  reverseDCF:    'Reverse DCF',
}
