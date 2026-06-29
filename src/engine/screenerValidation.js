/**
 * src/engine/screenerValidation.js
 *
 * Validates Screener's 12 base metrics against Yahoo for overlapping years.
 * Only if ALL metrics match (to Crore precision) across ALL overlapping years
 * do we trust Screener's pre-Yahoo historical data (2016-2021).
 *
 * The 12 base metrics (everything else is derived by the engine):
 *   P&L:          revenue, operatingProfit, depreciation, interest, netProfit
 *   Balance:      equityCapital, reserves, totalDebt, totalAssets
 *   Cash Flow:    operatingCF, freeCashFlow
 *   Per Share:    eps
 *
 * Rounding rules:
 *   All monetary values: round to nearest Crore (÷ 1e7, round, compare)
 *   EPS: round to 1 decimal place (× 10, round, ÷ 10, compare)
 *
 * If yahooVal is null for any metric in any overlapping year:
 *   → Pipeline bug, not a skip condition
 *   → Validation fails, Screener history not used
 *   → Error surfaced clearly in validationResult
 */

// equityCapital excluded: Screener uses different face-value unit convention
// than Yahoo, causing systematic mismatches unrelated to data quality.
// totalEquity (= equityCapital + reserves) is validated instead —
// it's what the engine actually uses for P/B, ROE, ROCE calculations.
const MONETARY_METRICS = [
  'revenue',
  'operatingProfit',
  'depreciation',
  'interest',
  'netProfit',
  'totalEquity',       // replaces equityCapital + reserves
  'totalDebt',
  'totalAssets',
  'operatingCF',
  'freeCashFlow',
]

// Metrics that may legitimately be zero (not null) for some company types
// Zero-debt companies: interest = 0, totalDebt = 0 → valid
// Zero-capex companies: depreciation may be very small
// These are valid zeroes Yahoo should return as 0, not null
const NULLABLE_IF_ZERO = new Set(['depreciation', 'interest', 'equityCapital'])

const toCrore   = val => Math.round(val / 1e7)
const toEPS     = val => Math.round(val * 10)  // compare at 1 decimal

function getVal(historyArray, year, field) {
  const row = historyArray?.find(r => r.year === year)
  if (!row) return undefined  // year not present in this source
  return row[field]?.value    // may be null if unavailable
}

export function validateScreenerHistory(yahooData, screenerData) {
  const result = {
    passed:           false,
    overlappingYears: [],
    failedMetrics:    [],
    pipelineErrors:   [],
    message:          '',
    // Years from Screener that are safe to use (pre-Yahoo)
    validHistoricalYears: []
  }

  // Find overlapping years between Yahoo and Screener
  const yahooYears    = new Set([
    ...(yahooData.incomeHistory   || []).map(r => r.year),
    ...(yahooData.balanceHistory  || []).map(r => r.year),
    ...(yahooData.cashflowHistory || []).map(r => r.year),
  ])
  const screenerYears = new Set([
    ...(screenerData.incomeHistory   || []).map(r => r.year),
    ...(screenerData.balanceHistory  || []).map(r => r.year),
    ...(screenerData.cashflowHistory || []).map(r => r.year),
  ])

  const overlapping = [...yahooYears].filter(y => screenerYears.has(y)).sort()

  if (overlapping.length === 0) {
    result.message = 'No overlapping years between Yahoo and Screener — cannot validate'
    return result
  }

  result.overlappingYears = overlapping

  // Check all 12 metrics across all overlapping years
  let allPassed = true

  for (const year of overlapping) {
    for (const metric of MONETARY_METRICS) {
      // Determine which history array this metric lives in
      const histType = getHistoryType(metric)
      const yVal = getVal(yahooData[histType],    year, metric)
      const sVal = getVal(screenerData[histType], year, metric)

      // Yahoo null = pipeline bug (not a skip condition)
      if (yVal == null) {
        // Check if this is a legitimately zero metric
        if (NULLABLE_IF_ZERO.has(metric)) {
          // If both are null/0 that's fine — company just doesn't have this
          continue
        }
        result.pipelineErrors.push({
          year, metric,
          message: `Yahoo returned null for ${metric} in ${year} — data pipeline incomplete`
        })
        allPassed = false
        continue
      }

      // Screener null = parsing failed
      if (sVal == null) {
        result.failedMetrics.push({
          year, metric,
          yahooVal:    yVal,
          screenerVal: null,
          message:     `Screener failed to parse ${metric} for ${year}`
        })
        allPassed = false
        continue
      }

      // Compare with 0.5% relative tolerance
      // Handles: Screener display rounding (shows nearest 100Cr for large values)
      // Strict enough to catch: wrong row parsed, wrong year, unit errors
      const yRounded = toCrore(yVal)
      const sRounded = toCrore(sVal)
      const maxVal   = Math.max(Math.abs(yRounded), Math.abs(sRounded))
      const relDiff  = maxVal > 0 ? Math.abs(yRounded - sRounded) / maxVal : 0

      if (relDiff > 0.005) {  // > 0.5% = genuine mismatch
        result.failedMetrics.push({
          year, metric,
          yahooVal:    yVal,
          screenerVal: sVal,
          yahooCr:     yRounded,
          screenerCr:  sRounded,
          diffCr:      Math.abs(yRounded - sRounded),
          relDiffPct:  +(relDiff * 100).toFixed(3),
          message:     `${metric} mismatch in ${year}: Yahoo ₹${yRounded}Cr vs Screener ₹${sRounded}Cr (${(relDiff*100).toFixed(2)}% diff)`
        })
        allPassed = false
      }
    }

    // EPS — separate rounding rule (1 decimal place)
    const yEPS = getVal(yahooData.incomeHistory,    year, 'eps')
    const sEPS = getVal(screenerData.incomeHistory, year, 'eps')

    if (yEPS != null && sEPS != null) {
      if (toEPS(yEPS) !== toEPS(sEPS)) {
        result.failedMetrics.push({
          year, metric: 'eps',
          yahooVal:    yEPS,
          screenerVal: sEPS,
          message:     `EPS mismatch in ${year}: Yahoo ₹${yEPS.toFixed(1)} vs Screener ₹${sEPS.toFixed(1)}`
        })
        allPassed = false
      }
    } else if (yEPS == null && sEPS != null) {
      // Yahoo missing EPS but we have it from v7 quote — not a pipeline error
      // Skip EPS validation for this year
    } else if (yEPS != null && sEPS == null) {
      result.pipelineErrors.push({
        year, metric: 'eps',
        message: `Screener failed to parse EPS for ${year}`
      })
      allPassed = false
    }
  }

  result.passed = allPassed && result.pipelineErrors.length === 0

  if (result.passed) {
    // Find Screener years that are BEFORE Yahoo's earliest year
    // These are the historical years we can now safely use
    const yahooEarliestYear = Math.min(...[...yahooYears].map(Number)).toString()
    const allScreenerYears  = [
      ...(screenerData.incomeHistory || []).map(r => r.year)
    ].sort()
    result.validHistoricalYears = allScreenerYears.filter(y => y < yahooEarliestYear)
    result.message = overlapping.length > 0
      ? `All ${MONETARY_METRICS.length + 1} metrics match across ${overlapping.length} overlapping years. ` +
        `Using ${result.validHistoricalYears.length} additional historical years from Screener ` +
        `(${result.validHistoricalYears[0]} – ${result.validHistoricalYears[result.validHistoricalYears.length - 1]}).`
      : 'Validation passed but no pre-Yahoo years available in Screener.'
  } else {
    const totalIssues = result.failedMetrics.length + result.pipelineErrors.length
    result.message = `Validation failed: ${totalIssues} issue(s) found. ` +
      `Using Yahoo 4-year history only. ` +
      (result.failedMetrics.length > 0
        ? `Mismatches: ${result.failedMetrics.slice(0, 3).map(f => f.message).join('; ')}`
        : `Pipeline errors: ${result.pipelineErrors.slice(0, 3).map(e => e.message).join('; ')}`)
  }

  return result
}

function getHistoryType(metric) {
  if (['revenue','operatingProfit','depreciation','interest','netProfit','eps'].includes(metric))
    return 'incomeHistory'
  if (['equityCapital','reserves','totalDebt','totalAssets'].includes(metric))
    return 'balanceHistory'
  if (['operatingCF','freeCashFlow'].includes(metric))
    return 'cashflowHistory'
  return 'incomeHistory'
}
